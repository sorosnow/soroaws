const axios = require("axios").default;
const config = require("./config");
const { log } = require("./logger");

/**
 * 通过 Server酱 发送 IP 更换通知（成功/失败均可）
 * @param {object} details - 通知详情
 * @param {string} details.instanceName - 实例名称
 * @param {string} details.region - 区域
 * @param {string} details.oldIp - 旧 IP
 * @param {string} details.newIp - 新 IP
 * @param {boolean} details.success - 是否成功（默认 true）
 * @param {string} details.reason - 失败原因
 */
async function sendMsgByServerChan(details = {}) {
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

  if (!config.serverChanToken) return;

  const desp = [
    `实例: ${instanceName}`,
    `区域: ${region}`,
    `旧 IP: ${oldIp}`,
    `新 IP: ${newIp}`,
    success ? "" : `失败原因: ${reason}`,
    `时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await axios.request({
      method: "POST",
      url: `https://sctapi.ftqq.com/${config.serverChanToken}.send`,
      headers: { "Content-Type": "application/json" },
      data: {
        title: success
          ? `AWS Lightsail IP 更换 - ${instanceName}`
          : `【失败】AWS Lightsail IP 更换 - ${instanceName}`,
        desp,
      },
    });
    log("INFO", "Server酱 通知发送成功");
  } catch (err) {
    log("ERROR", `Server酱 通知发送失败: ${err.message}`);
  }
}

module.exports = { sendMsgByServerChan };
