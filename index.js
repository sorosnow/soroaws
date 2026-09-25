const {
  clients,
  fetchInstances,
  fetchStaticIps,
  detachStaticIp,
  releaseStaticIp,
  allocateStaticIp,
  attachStaticIp,
  cleanupUnattachedIps,
} = require("./lightsail");
const { pingHost } = require("./checker");
const { notifyIpChange } = require("./notifier");
const { log } = require("./logger");
const config = require("./config");

// ============================================================
// 换 IP 并发控制（按区域独立限流）
// ============================================================

/**
 * 创建并发限制器：同一时间最多执行 max 个任务，其余排队等待
 * @param {number} max - 最大并发数
 * @returns {Function} run - (fn) => Promise，fn 的结果/异常原样透传
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    const task = queue.shift();
    active++;
    task.fn()
      .then(task.resolve, task.reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

// 每个区域（client）一个独立的限制器：大量实例同时不可达时，
// 换 IP 操作排队执行，避免并发 AWS 调用触发限流
const regionLimiters = new Map();
function getRegionLimiter(client) {
  if (!regionLimiters.has(client)) {
    regionLimiters.set(client, createLimiter(config.rotateConcurrency));
  }
  return regionLimiters.get(client);
}

// ============================================================
// 业务流程编排
// ============================================================

/**
 * 并发获取所有区域的实例列表，失败区域记录错误日志
 * @returns {Promise<{instances: Array, failures: number}>} instances: [{region, client, server}]
 */
async function fetchAllInstances() {
  const results = await Promise.all(
    clients.map(async ({ region, client }) => {
      try {
        return { region, client, ok: true, servers: await fetchInstances(client) };
      } catch (err) {
        log("ERROR", `获取实例列表失败 (${region}): ${err.message}`);
        return { region, ok: false };
      }
    })
  );

  const instances = [];
  let failures = 0;

  for (const result of results) {
    if (result.ok) {
      for (const server of result.servers) {
        instances.push({ region: result.region, client: result.client, server });
      }
    } else {
      failures++;
    }
  }

  return { instances, failures };
}

// 防重入：上一轮未完成时跳过本轮，避免并发检测与重复通知
let roundRunning = false;

/**
 * 获取所有 Lightsail 实例并逐个检查链路，不可达的自动更换 IP
 */
async function getInstances() {
  if (roundRunning) {
    log("WARN", "上一轮检查尚未完成，跳过本轮");
    return;
  }
  roundRunning = true;

  try {
    // 清理放在轮次开头：此刻没有在途换 IP，与换 IP 天然互斥（理由见 maybeCleanup）
    await maybeCleanup();

    log("INFO", "开始新一轮 IP 检查");

    const { instances, failures } = await fetchAllInstances();

    if (instances.length === 0) {
      log("WARN", "未获取到任何实例");
    }

    // 逐个检测，不可达的自动更换
    const checkResults = await Promise.allSettled(
      instances.map(({ region, client, server }) => checkIp(region, client, server))
    );

    const stats = { reachable: 0, changed: 0, failed: 0, skipped: 0 };
    for (const r of checkResults) {
      if (r.status === "fulfilled") {
        stats[r.value.status]++;
      } else {
        stats.failed++;
      }
    }

    const failureNote = failures > 0 ? `, ${failures} 个区域拉取失败` : "";
    log(
      "INFO",
      `本轮检查完成: ${stats.reachable} 个可达, ${stats.changed} 个已更换, ${stats.failed} 个失败, ${stats.skipped} 个跳过${failureNote}`
    );
  } finally {
    roundRunning = false;
  }
}

/**
 * 检测指定实例链路，不可达时自动更换 IP
 * @param {string} region - 区域
 * @param {object} client - 该区域的 AWS 客户端
 * @param {object} server - 实例对象
 * @returns {Promise<{server: object, status: "reachable"|"changed"|"failed"|"skipped"}>}
 */
async function checkIp(region, client, server) {
  const host = server.publicIpAddress;
  const instanceState = server.state?.name || "未知";

  // 已停止/无公网 IP 的实例 Ping 必然失败，直接跳过，不触发换 IP
  if (!host || instanceState !== "running") {
    log("INFO", `${server.name} 状态为 ${instanceState}${host ? "" : "、无公网 IP"}，跳过检测`);
    return { server, status: "skipped" };
  }

  log("INFO", `正在检查 ${server.name} (${host}) 连通性`);

  let reachable;
  try {
    reachable = await pingHost(host, config.pingTimeout);
  } catch (err) {
    log("ERROR", `${server.name} (${host}) 连通性检测异常: ${err.message}`);
    return { server, status: "failed" };
  }

  if (reachable) {
    log("INFO", `${server.name} (${host}) Ping 通，跳过本轮检测`);
    return { server, status: "reachable" };
  }

  log("WARN", `${server.name} (${host}) 持续 ${config.pingTimeout} 秒 Ping 无回复`);
  log("INFO", `${server.name} (${host}) 判定为不可达，开始更换 IP`);

  try {
    // 换 IP 操作经区域限制器排队执行，控制同时进行的更换数量
    const runRotate = getRegionLimiter(client);
    await runRotate(async () => {
      if (server.isStaticIp) {
        await rotateStaticIp(region, client, server);
      } else {
        await allocateAndAttach(region, client, server);
      }
    });
    return { server, status: "changed" };
  } catch (err) {
    log("ERROR", `${server.name} (${host}) IP更换失败: ${err.message}`);
    return { server, status: "failed" };
  }
}

/**
 * 处理已有静态 IP 的实例：解绑旧 IP → 释放旧 IP → 分配新 IP → 绑定新 IP
 */
async function rotateStaticIp(region, client, server) {
  log("INFO", "正在获取区域所有静态 IP 列表");
  const staticIps = await fetchStaticIps(client);
  log("INFO", "获取区域所有静态 IP 列表成功");

  const oldIp = server.publicIpAddress;
  const activeStaticIpItem = staticIps.find(
    (item) => item.ipAddress === oldIp
  );

  if (activeStaticIpItem) {
    log("INFO", `正在解绑静态 IP: ${activeStaticIpItem.name} (${activeStaticIpItem.ipAddress})`);
    await detachStaticIp(client, activeStaticIpItem.name);
    log("INFO", "解绑成功");

    log("INFO", `正在释放静态 IP: ${activeStaticIpItem.name} (${activeStaticIpItem.ipAddress})`);
    await releaseStaticIp(client, activeStaticIpItem.name);
    log("INFO", "释放静态 IP 成功");
  } else {
    log("INFO", `${oldIp} 未找到对应静态 IP，直接分配新 IP`);
  }

  await allocateAndAttach(region, client, server);
}

/**
 * 分配新静态 IP 并绑定到实例
 * 成功返回 { oldIp, newIp }，失败抛出异常（并发送失败告警通知）
 */
async function allocateAndAttach(region, client, server) {
  const oldIp = server.publicIpAddress;
  const staticIpName = `${server.name}-${Date.now()}`;

  log("INFO", `正在创建新的静态 IP`);
  try {
    await allocateStaticIp(client, staticIpName);
  } catch (err) {
    log("ERROR", `创建静态 IP 失败: ${err.message}`);
    await notifyIpChange({
      instanceName: server.name,
      region,
      oldIp,
      newIp: "-",
      success: false,
      reason: err.message,
    });
    throw err;
  }
  log("INFO", "创建静态 IP 成功！");

  log("INFO", `正在绑定静态 IP ${staticIpName} 到实例 ${server.name}`);
  try {
    await attachStaticIp(client, server.name, staticIpName);
  } catch (err) {
    log("ERROR", `绑定静态 IP 失败: ${err.message}`);
    // 回滚：释放刚分配但未绑定的静态 IP，避免产生闲置费用
    try {
      await releaseStaticIp(client, staticIpName);
      log("INFO", `已回滚释放未绑定的静态 IP: ${staticIpName}`);
    } catch (releaseErr) {
      log("ERROR", `回滚释放静态 IP ${staticIpName} 失败: ${releaseErr.message}`);
    }
    await notifyIpChange({
      instanceName: server.name,
      region,
      oldIp,
      newIp: "-",
      success: false,
      reason: err.message,
    });
    throw err;
  }

  log("INFO", "绑定新 IP 成功！");

  // 获取新 IP 的实际地址（查询实例最新公网 IP），失败时以 "-" 兜底
  let newIp = "-";
  try {
    const servers = await fetchInstances(client);
    const matched = servers.find((s) => s.name === server.name);
    if (matched && matched.publicIpAddress) {
      newIp = matched.publicIpAddress;
    }
  } catch (err) {
    log("WARN", `获取新 IP 地址失败，请到 AWS 控制台确认: ${err.message}`);
  }

  await notifyIpChange({
    instanceName: server.name,
    region,
    oldIp,
    newIp,
  });
}

/**
 * 清理所有区域的未附加静态 IP
 */
async function cleanupAllRegions() {
  log("INFO", "开始检查未附加静态 IP");
  for (const { region, client } of clients) {
    try {
      await cleanupUnattachedIps(client);
    } catch (err) {
      log("ERROR", `清理未附加 IP 异常 (${region}): ${err.message}`);
    }
  }
}

// 清理周期。清理会把区域内所有「未附加」的静态 IP 当垃圾释放，而换 IP 在
// 「分配 → 绑定」之间存在短暂的新 IP 未附加窗口 —— 两者并发会让刚分配的新 IP
// 被清理掉，绑定随即失败，实例最终失去静态 IP。
//
// 因此清理不再用独立定时器，而是放进轮次开头（见 getInstances）：
// 轮次内的换 IP 都会被 await 完，下一轮开始时必然没有在途换 IP，天然互斥。
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

// 启动时已清理过一次，故以启动时刻作为周期起点
let lastCleanupAt = Date.now();

/**
 * 距上次清理超过 CLEANUP_INTERVAL_MS 时执行一次清理
 */
async function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  await cleanupAllRegions();
}

// ============================================================
// 启动校验
// ============================================================

const configErrors = config.validateConfig();
if (configErrors.length > 0) {
  log("ERROR", "配置校验失败:");
  configErrors.forEach((err) => log("ERROR", `  - ${err}`));
  log("ERROR", "请检查 .env 文件或环境变量后重试");
  process.exit(1);
}

// ============================================================
// 在途操作跟踪 + 优雅退出
// ============================================================

// 在途异步操作（检查轮次、换 IP、清理任务）。退出前等待其全部完成，
// 避免把"解绑→释放→分配→绑定"流程截断在半截，留下已分配未附加的静态 IP
const pendingOps = new Set();

function track(promise) {
  pendingOps.add(promise);
  const done = () => pendingOps.delete(promise);
  promise.then(done, done);
  return promise;
}

let shuttingDown = false;
let timer;

async function shutdown(signal) {
  if (shuttingDown) {
    log("ERROR", "再次收到退出信号，强制退出");
    process.exit(1);
  }
  shuttingDown = true;

  clearInterval(timer);

  const ops = [...pendingOps];
  if (ops.length > 0) {
    log("INFO", `收到 ${signal} 信号，等待 ${ops.length} 个在途操作完成（最长 ${config.shutdownGraceSec} 秒）...`);
    // 超过宽限期强制退出，防止个别操作挂死导致进程停不下来
    await Promise.race([
      Promise.allSettled(ops),
      new Promise((r) => setTimeout(r, config.shutdownGraceSec * 1000).unref()),
    ]);
  } else {
    log("INFO", `收到 ${signal} 信号，无在途操作，正在退出...`);
  }

  log("INFO", "程序已退出");
  // 留 100ms 让日志写入队列落盘
  setTimeout(() => process.exit(0), 100);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// 启动
// ============================================================

/**
 * 打印通知渠道配置状态（未配置时提醒）
 */
function logChannels() {
  if (!config.serverChanToken) {
    log("WARN", "未配置 SERVER_CHAN_TOKEN，IP 变更将不会推送");
  } else {
    log("INFO", "通知渠道: Server酱");
  }
}

async function main() {
  log("INFO", `soroaws 启动，检测间隔: ${config.interval} 分钟`);
  log("INFO", `探测方式: 本机持续 Ping 实例公网 IP，最长 ${config.pingTimeout} 秒，有任一回复即视为可达`);
  logChannels();

  // 启动时先清理一次未附加静态 IP
  await track(cleanupAllRegions());
  if (shuttingDown) return;

  track(getInstances());
  timer = setInterval(() => {
    track(getInstances());
  }, config.interval * 60 * 1000);
}

main();
