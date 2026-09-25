const {
  LightsailClient,
  GetInstancesCommand,
  AttachStaticIpCommand,
  DetachStaticIpCommand,
  ReleaseStaticIpCommand,
  GetStaticIpsCommand,
  AllocateStaticIpCommand,
} = require("@aws-sdk/client-lightsail");
const config = require("./config");
const { log } = require("./logger");

// 每个区域一个客户端，连同区域名一起导出
// （日志与告警需要区域名，而 AWS SDK v3 的 client.config.region 是 provider 函数，取不到字符串）
// 客户端自身配置 SDK 内置重试（最多 3 次，指数退避）
const clients = config.regions.map((region) => ({
  region,
  client: new LightsailClient({
    region,
    credentials: config.credentials,
    maxAttempts: 3,
  }),
}));

// 单个 API 调用的最大尝试次数（首次 + 重试），重试采用指数退避
const MAX_ATTEMPTS = 3;
const MAX_RETRIES = MAX_ATTEMPTS - 1;

/**
 * 带重试的 API 调用包装（在 AWS SDK 内置重试之上增加日志）
 */
async function withRetry(operation, context) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err.name === "ThrottlingException" ||
        err.name === "RequestLimitExceeded" ||
        err.name === "ServiceUnavailableException" ||
        err.code === "ECONNRESET" ||
        err.code === "ENETUNREACH" ||
        err.code === "ETIMEDOUT" ||
        err.$metadata?.httpStatusCode === 429;

      // 不可重试，或重试次数已用尽（attempt 从 1 起算，所以最后一次 attempt 不再重试）
      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        log("ERROR", `${context} 失败: ${err.message}`);
        throw err;
      }

      const delay = Math.pow(2, attempt) * 1000;
      log("WARN", `${context} 限流，${delay / 1000}s 后发起第 ${attempt} 次重试（最多 ${MAX_RETRIES} 次）`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function fetchInstances(client) {
  const instances = [];
  let pageToken;

  do {
    const response = await withRetry(async () => {
      const command = new GetInstancesCommand(pageToken ? { pageToken } : {});
      return await client.send(command);
    }, "获取实例列表");
    instances.push(...(response.instances || []));
    pageToken = response.nextPageToken;
  } while (pageToken);

  return instances;
}

async function fetchStaticIps(client) {
  const staticIps = [];
  let pageToken;

  do {
    const response = await withRetry(async () => {
      const command = new GetStaticIpsCommand(pageToken ? { pageToken } : {});
      return await client.send(command);
    }, "获取静态 IP 列表");
    staticIps.push(...(response.staticIps || []));
    pageToken = response.nextPageToken;
  } while (pageToken);

  return staticIps;
}

async function detachStaticIp(client, staticIpName) {
  return withRetry(async () => {
    const command = new DetachStaticIpCommand({ staticIpName });
    await client.send(command);
  }, `解绑静态 IP ${staticIpName}`);
}

async function releaseStaticIp(client, staticIpName) {
  return withRetry(async () => {
    const command = new ReleaseStaticIpCommand({ staticIpName });
    await client.send(command);
  }, `释放静态 IP ${staticIpName}`);
}

async function allocateStaticIp(client, staticIpName) {
  return withRetry(async () => {
    const command = new AllocateStaticIpCommand({ staticIpName });
    await client.send(command);
  }, `创建静态 IP ${staticIpName}`);
}

async function attachStaticIp(client, instanceName, staticIpName) {
  return withRetry(async () => {
    const command = new AttachStaticIpCommand({ instanceName, staticIpName });
    await client.send(command);
  }, `绑定静态 IP ${staticIpName} 到 ${instanceName}`);
}

/**
 * 清理所有未附加的静态 IP
 */
async function cleanupUnattachedIps(client) {
  let staticIps;
  try {
    staticIps = await fetchStaticIps(client);
  } catch (err) {
    log("ERROR", `获取静态 IP 列表失败，跳过清理: ${err.message}`);
    return 0;
  }

  let cleaned = 0;

  for (const ip of staticIps) {
    if (!ip.isAttached) {
      log("WARN", `发现未附加静态 IP: ${ip.name} (${ip.ipAddress})，正在释放`);
      try {
        await releaseStaticIp(client, ip.name);
        log("INFO", `已释放未附加静态 IP: ${ip.name}`);
        cleaned++;
      } catch (err) {
        log("ERROR", `释放未附加静态 IP ${ip.name} 失败: ${err.message}`);
      }
    }
  }

  if (cleaned > 0) {
    log("INFO", `本轮清理完成，共释放 ${cleaned} 个未附加静态 IP`);
  }

  return cleaned;
}

module.exports = {
  clients,
  fetchInstances,
  fetchStaticIps,
  detachStaticIp,
  releaseStaticIp,
  allocateStaticIp,
  attachStaticIp,
  cleanupUnattachedIps,
};
