const { exec } = require("child_process");
const os = require("os");
const config = require("./config");
const { log } = require("./logger");

/**
 * 调用系统 ping 命令检测指定主机
 * @param {string} host - 目标 IP 地址
 * @param {number} timeout - 单次超时秒数
 * @returns {Promise<{alive: boolean}>}
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
      resolve({ alive: !error });
    });
  });
}

/**
 * 检测指定主机 IP 连通性（PING_TIMEOUT 秒内持续 Ping，有一次回复即判定为通）
 * @param {string} host - 目标 IP 地址
 * @param {Function} onReachable - IP 可达时的回调
 * @param {Function} onUnreachable - IP 不可达时的回调函数
 */
async function checkConnectivity(host, onReachable, onUnreachable) {
  log("INFO", `正在持续 Ping ${host}（最长 ${config.pingTimeout} 秒）`);

  try {
    const deadline = Date.now() + config.pingTimeout * 1000;

    while (Date.now() < deadline) {
      const result = await systemPing(host, 5);

      if (result.alive) {
        log("INFO", `${host} Ping 通，跳过本轮检测`);
        if (onReachable) onReachable();
        return; // 有回复立即结束，不等到期
      }

      // 还没到截止时间，等 1 秒再试
      if (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    log("WARN", `${host} 持续 ${config.pingTimeout} 秒 Ping 无回复，判定为不通`);
    onUnreachable();
  } catch (err) {
    log("ERROR", `${host} Ping 检测异常: ${err.message}`);
    onUnreachable();
  }
}

module.exports = { checkConnectivity };
