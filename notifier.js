const axios = require("axios").default;
const config = require("./config");
const { log } = require("./logger");

// 统一超时：请求挂起会永久占住区域并发限制器槽位，卡死该区域后续换 IP
const REQUEST_TIMEOUT_MS = 10000;

/**
 * 通过 Server酱 发送通知（未配置 Token 时静默跳过）
 * @param {string} title - 通知标题
 * @param {string} desp - 通知正文
 */
async function sendByServerChan(title, desp) {
  if (!config.serverChanToken) return;

  try {
    await axios.request({
      method: "POST",
      url: `https://sctapi.ftqq.com/${config.serverChanToken}.send`,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      data: { title, desp },
    });
    log("INFO", "Server酱 通知发送成功");
  } catch (err) {
    log("ERROR", `Server酱 通知发送失败: ${err.message}`);
  }
}

function nowText() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

/**
 * IP 更换通知（本程序触发的更换，成功/失败均可）
 * @param {object} details - 通知详情
 * @param {string} details.instanceName - 实例名称
 * @param {string} details.region - 区域
 * @param {string} details.oldIp - 旧 IP
 * @param {string} details.newIp - 新 IP
 * @param {boolean} details.success - 是否成功（默认 true）
 * @param {string} details.reason - 失败原因
 */
async function notifyIpChange(details = {}) {
  const {
    instanceName = "",
    region = "",
    oldIp = "",
    newIp = "",
    success = true,
    reason = "",
  } = details;

  if (success) {
    log("CHANGE", `${instanceName} IP已更换 ${oldIp} → ${newIp}`);
  } else {
    log("ERROR", `${instanceName} IP更换失败 ${oldIp} → ${newIp}: ${reason}`);
  }

  const desp = [
    `实例: ${instanceName}`,
    `区域: ${region}`,
    `旧 IP: ${oldIp}`,
    `新 IP: ${newIp}`,
    success ? "" : `失败原因: ${reason}`,
    `时间: ${nowText()}`,
  ]
    .filter(Boolean)
    .join("\n");

  await sendByServerChan(
    success
      ? `AWS Lightsail IP 更换 - ${instanceName}`
      : `【失败】AWS Lightsail IP 更换 - ${instanceName}`,
    desp
  );
}

module.exports = { notifyIpChange };
