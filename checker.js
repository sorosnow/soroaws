const { exec } = require("child_process");
const os = require("os");

/**
 * 调用系统 ping 命令检测指定主机（单次）
 * @param {string} host - 目标 IP 地址
 * @param {number} timeout - 单次超时秒数
 * @returns {Promise<boolean>} 是否有回复
 */
function systemPing(host, timeout) {
  return new Promise((resolve) => {
    // 跨平台兼容
    const isWin = os.platform() === "win32";
    const cmd = isWin
      ? `ping -n 1 -w ${timeout * 1000} ${host}`
      : `ping -c 1 -W ${timeout} ${host}`;

    exec(cmd, (error) => {
      // error 非空表示 ping 不通（退出码非0）
      resolve(!error);
    });
  });
}

/**
 * 在给定时间窗口内持续 Ping 主机，有任一次回复即视为可达
 * @param {string} host - 目标 IP 地址
 * @param {number} seconds - 检测总时长（秒）
 * @returns {Promise<boolean>} 是否有回复
 */
async function pingHost(host, seconds) {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    if (await systemPing(host, 5)) {
      return true; // 有回复立即结束，不等到期
    }

    // 还没到截止时间，等 1 秒再试
    if (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return false;
}

module.exports = { systemPing, pingHost };
