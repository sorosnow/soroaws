const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "lightsail.log");
const CHANGE_LOG = path.join(__dirname, "changes.log");

// ANSI 颜色代码
const colors = {
  INFO: "\x1b[36m",    // 青色
  WARN: "\x1b[33m",    // 黄色
  CHANGE: "\x1b[32m",  // 绿色
  ERROR: "\x1b[31m",   // 红色
  RESET: "\x1b[0m",    // 重置
};

// 写入队列：串行落盘，避免并发 appendFile 导致日志乱序
const writeQueue = [];
let draining = false;

function enqueueWrite(file, line) {
  writeQueue.push({ file, line });
  drainQueue();
}

function drainQueue() {
  if (draining) return;
  draining = true;

  const next = () => {
    const item = writeQueue.shift();
    if (!item) {
      draining = false;
      return;
    }
    fs.appendFile(item.file, item.line, (err) => {
      if (err) {
        console.error(`${colors.ERROR}写入日志文件失败: ${err.message}${colors.RESET}`);
      }
      next();
    });
  };

  next();
}

/**
 * 写入本地日志文件
 * @param {string} level - 日志级别 (INFO / WARN / CHANGE / ERROR)
 * @param {string} message - 日志内容
 */
function log(level, message) {
  const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
  const line = `[${timestamp}] [${level}] ${message}`;
  const color = colors[level] || "";

  // 控制台输出：带颜色的标签
  console.log(`[${timestamp}] ${color}[${level}]${colors.RESET} ${message}`);

  // 文件写入纯文本（不带颜色），通过队列串行落盘
  enqueueWrite(LOG_FILE, `${line}\n`);

  // 更换事件单独记一份到 changes.log
  if (level === "CHANGE") {
    enqueueWrite(CHANGE_LOG, `${line}\n`);
  }
}

module.exports = { log };
