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
const { checkConnectivity } = require("./checker");
const { sendMsgByServerChan } = require("./notifier");
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
 * 获取所有 Lightsail 实例并逐个检查 IP 连通性
 */
async function getInstances() {
  log("INFO", "开始新一轮 IP 检查");

  // 并发获取所有区域的实例列表
  const results = await Promise.allSettled(
    clients.map(async (client) => {
      const servers = await fetchInstances(client);
      return { client, servers };
    })
  );

  const allChecks = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      const { client, servers } = result.value;
      for (const server of servers) {
        allChecks.push(checkIp(client, server));
      }
    } else {
      log("ERROR", `获取实例列表失败: ${result.reason.message}`);
    }
  }

  // 等待所有检测完成并输出汇总
  const checkResults = await Promise.allSettled(allChecks);
  const stats = { reachable: 0, changed: 0, failed: 0, skipped: 0 };

  for (const r of checkResults) {
    if (r.status === "fulfilled") {
      stats[r.value.status]++;
    } else {
      stats.failed++;
    }
  }

  log("INFO", `本轮检查完成: ${stats.reachable} 个可达, ${stats.changed} 个已更换, ${stats.failed} 个失败, ${stats.skipped} 个跳过`);
}

/**
 * 检测指定实例 IP 连通性，不可达时自动更换
 * @returns {Promise<{server: object, status: "reachable"|"changed"|"failed"|"skipped"}>}
 */
function checkIp(client, server) {
  return new Promise((resolve) => {
    const host = server.publicIpAddress;
    const state = server.state?.name || "未知";

    // 已停止/无公网 IP 的实例 Ping 必然失败，直接跳过，不触发换 IP
    if (!host || state !== "running") {
      log("INFO", `${server.name} 状态为 ${state}${host ? "" : "、无公网 IP"}，跳过检测`);
      return resolve({ server, status: "skipped" });
    }

    log("INFO", `正在检查 ${server.name} (${host}) 连通性`);

    checkConnectivity(
      host,
      // 可达
      () => resolve({ server, status: "reachable" }),
      // 不可达
      async () => {
        log("INFO", `${server.name} (${host}) IP不可达，开始更换`);
        try {
          // 换 IP 操作经区域限制器排队执行，控制同时进行的更换数量
          const runRotate = getRegionLimiter(client);
          await runRotate(async () => {
            if (server.isStaticIp) {
              await rotateStaticIp(client, server);
            } else {
              await allocateAndAttach(client, server);
            }
          });
          resolve({ server, status: "changed" });
        } catch (err) {
          log("ERROR", `${server.name} (${host}) IP更换失败: ${err.message}`);
          resolve({ server, status: "failed" });
        }
      }
    );
  });
}

/**
 * 处理已有静态 IP 的实例：解绑旧 IP → 释放旧 IP → 分配新 IP → 绑定新 IP
 */
async function rotateStaticIp(client, server) {
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

  await allocateAndAttach(client, server);
}

/**
 * 分配新静态 IP 并绑定到实例
 * 成功返回 { oldIp, newIp }，失败抛出异常（并发送失败告警通知）
 */
async function allocateAndAttach(client, server) {
  const oldIp = server.publicIpAddress;
  const staticIpName = `${server.name}-${Date.now()}`;

  log("INFO", `正在创建新的静态 IP`);
  try {
    await allocateStaticIp(client, staticIpName);
  } catch (err) {
    log("ERROR", `创建静态 IP 失败: ${err.message}`);
    await sendMsgByServerChan({
      instanceName: server.name,
      region: server.location?.regionName || "未知",
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
    await sendMsgByServerChan({
      instanceName: server.name,
      region: server.location?.regionName || "未知",
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

  await sendMsgByServerChan({
    instanceName: server.name,
    region: server.location?.regionName || "未知",
    oldIp,
    newIp,
  });
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
// 优雅退出
// ============================================================

let shuttingDown = false;
let timer;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log("INFO", `收到 ${signal} 信号，正在停止...`);
  clearInterval(timer);

  // 等待进行中的操作完成后退出
  setTimeout(() => {
    log("INFO", "程序已退出");
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// 启动
// ============================================================

async function main() {
  log("INFO", `SwapX 启动，检测间隔: ${config.interval} 分钟`);

  // 启动时先清理一次未附加静态 IP
  log("INFO", "正在检查未附加的静态 IP...");
  for (const client of clients) {
    try {
      await cleanupUnattachedIps(client);
    } catch (err) {
      log("ERROR", `清理未附加 IP 异常: ${err.message}`);
    }
  }

  getInstances();
  timer = setInterval(() => {
    getInstances();
  }, config.interval * 60 * 1000);

  // 每 30 分钟清理一次未附加静态 IP
  setInterval(async () => {
    log("INFO", "开始检查未附加静态 IP");
    for (const client of clients) {
      try {
        await cleanupUnattachedIps(client);
      } catch (err) {
        log("ERROR", `清理未附加 IP 异常: ${err.message}`);
      }
    }
  }, 30 * 60 * 1000);
}

main();
