require("dotenv").config();

const config = {
  // AWS 区域（多个用逗号分隔，如 "ap-northeast-1,us-east-1"）
  // 去重并剔除空项：尾随逗号、连续逗号（如 "ap-northeast-1,"）会产生空字符串，
  // 而空区域名会让 LightsailClient 构造时抛 "Region is missing"，
  // 使进程在校验之前就崩掉；重复区域则会生成两个同区域客户端，
  // 导致同一实例被重复检查、甚至并发换 IP（限流器按客户端而非区域隔离，挡不住）
  regions: [
    ...new Set(
      (process.env.AWS_REGIONS || "ap-northeast-1")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
    ),
  ],

  // AWS 凭证
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },

  // 本机 Ping 实例公网 IP 的检测总时长（秒），默认 15（期间持续 Ping，有任一回复即视为可达）
  pingTimeout: parseInt(process.env.PING_TIMEOUT || "15", 10),

  // 检测间隔（分钟），默认 1
  interval: parseFloat(process.env.CHECK_INTERVAL_MIN || "1"),

  // 同一区域并行更换 IP 的最大并发数，默认 2（避免触发 AWS 限流）
  rotateConcurrency: parseInt(process.env.ROTATE_CONCURRENCY || "2", 10),

  // 退出前等待在途操作完成的最长时间（秒），默认 120
  shutdownGraceSec: parseInt(process.env.SHUTDOWN_GRACE_SEC || "120", 10),

  // Server酱 推送 Token（可选，留空不推送）
  serverChanToken: process.env.SERVER_CHAN_TOKEN || "",
};

/**
 * 校验配置是否完整
 * @returns {string[]} 错误信息数组，为空则配置正常
 */
function validateConfig() {
  const errors = [];

  if (!config.credentials.accessKeyId) {
    errors.push("AWS_ACCESS_KEY_ID 未设置");
  }
  if (!config.credentials.secretAccessKey) {
    errors.push("AWS_SECRET_ACCESS_KEY 未设置");
  }
  if (config.regions.length === 0) {
    errors.push("AWS_REGIONS 未设置或格式不正确");
  }
  // 区域名格式校验：挡掉大小写错误、下划线、缺段等手误（如 ap_northeast_1、ap-northeast）
  const invalidRegion = config.regions.find((r) => !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(r));
  if (invalidRegion) {
    errors.push(`AWS_REGIONS 含无效区域名 "${invalidRegion}"，应形如 ap-northeast-1`);
  }
  if (Number.isNaN(config.pingTimeout) || config.pingTimeout < 1) {
    errors.push("PING_TIMEOUT 不是有效的数字");
  }
  if (Number.isNaN(config.interval) || config.interval < 1) {
    errors.push("CHECK_INTERVAL_MIN 必须大于 0");
  }
  if (Number.isNaN(config.rotateConcurrency) || config.rotateConcurrency < 1) {
    errors.push("ROTATE_CONCURRENCY 必须是不小于 1 的整数");
  }
  if (Number.isNaN(config.shutdownGraceSec) || config.shutdownGraceSec < 1) {
    errors.push("SHUTDOWN_GRACE_SEC 必须是不小于 1 的整数");
  }

  return errors;
}

module.exports = config;
module.exports.validateConfig = validateConfig;
