# Soroaws 优化计划

## 📁 代码结构

### 1. 拆分模块  ✅ 已完成
将 `index.js` 拆分为以下模块，避免单文件过于臃肿：

| 文件 | 职责 |
|------|------|
| `config.js` | 配置读取（环境变量、常量） |
| `lightsail.js` | AWS Lightsail API 操作封装 |
| `checker.js` | IP 连通性检测 |
| `notifier.js` | 消息通知（Server酱等） |
| `index.js` | 入口文件，组织调度逻辑 |

### 2. 引入 `.env` 配置管理  ✅ 已完成
- 使用 `dotenv` 包管理环境变量
- 创建 `.env.example` 文件列出所有配置项
- 不再在源码中直接引用 `process.env`

---

## 🛡 健壮性

### 3. `detachStaticIp` 缺少 try/catch  ✅ 已修复
解绑静态 IP 时如果 AWS API 调用失败（如 IP 已被其他实例占用），会导致整个流程崩溃。需要增加错误处理。
- 已在 `index.js` 编排层增加 try/catch，失败时记录日志

### 4. `releaseStaticIp` 缺少 try/catch  ✅ 已修复
释放静态 IP 时同样缺少错误处理，应统一增加 try/catch 并记录错误日志。
- 已在 `index.js` 编排层增加 try/catch

### 5. TCP 连接超时后资源清理  ✅ 已修复
`netClient.destroy()` 后应调用 `netClient.unref()`，确保 TCP socket 不会阻止 Node.js 进程退出。
- 已改用系统 Ping 命令，不再使用 TCP 连接

---

## 🚀 功能增强

### 6. 优雅退出  ✅ 已完成
监听 `SIGINT` / `SIGTERM` 信号，在程序退出前：
- 等待正在进行的 IP 更换操作完成
- 关闭定时器
- 打印退出日志

```js
process.on("SIGINT", async () => {
  console.log("正在优雅退出...");
  clearInterval(timer);
  // 等待进行中的操作
  process.exit(0);
});
```

### 7. 更换成功通知增强  ✅ 已完成
Server酱 通知内容应包含更多有用信息：
- 实例名称
- 旧 IP 地址
- 新 IP 地址
- 更换时间

### 8. 并发 TCP 检测  ✅ 已完成
当前多个实例的 TCP 检测是串行执行的，可以使用 `Promise.allSettled()` 并行检测所有实例的 IP，提高效率。

### 9. 更换记录日志  ✅ 已完成
将每次 IP 更换记录到文件（如 `history.log`），包含：
- 时间戳
- 实例名称/区域
- 旧 IP → 新 IP
- 更换结果

---

## 📝 文档

### 10. 更新 README  ✅ 已完成
当前 README 还是旧版本的说明，需要更新为：
- 新的项目名称和仓库地址
- 环境变量配置方式
- 安装和使用步骤
- 运行原理说明

### 11. 添加 `.env.example`  ✅ 已完成
```env
# AWS 凭证
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key

# AWS 区域（多个用逗号分隔）
AWS_REGIONS=ap-northeast-1

# IP 检测配置
PING_TIMEOUT=15
CHECK_INTERVAL_MIN=1

# Server酱 通知（可选）
SERVER_CHAN_TOKEN=your_token
```

---

## 🎯 小优化

### 12. IP 名称可读性增强  ✅ 已完成
当前静态 IP 名称格式：
```
StaticIp-${crypto.randomUUID()}-${Date.now()}
```
建议改为包含实例名前缀，便于在 AWS 控制台中识别：
```
${server.name}-${Date.now()}
```

### 13. `request()` 函数风格统一  ✅ 已完成
将 `.then()/.catch()` 的 Promise 链改为统一的 `async/await` 风格，保持代码一致性。

### 14. 按实例配置端口  🔒 已弃用
~~不同实例可能需要检测不同端口（SSH=22, RDP=3389, HTTP=80）~~
现已改用 Ping 检测，不依赖端口，此项不再需要。

---

## 🐛 问题修复（2026-08-11）

### 15. 绑定失败被误统计为"已更换"  ✅ 已修复
`allocateAndAttach` 在创建/绑定静态 IP 失败时只是 `return`（不抛错），导致 `checkIp` 的 try/catch 捕获不到，最终仍被计为 `changed`。
- 失败时改为抛出异常，`checkIp` 正确标记为 `failed`
- 绑定失败时自动回滚释放刚分配但未绑定的静态 IP，避免产生闲置费用

### 16. 失败路径发送 Server酱 告警  ✅ 已修复
原先只在成功时发送通知，更换失败用户无感知。
- `sendMsgByServerChan` 新增 `success` / `reason` 参数
- 失败时标题带 `【失败】` 前缀、正文含失败原因，记录 `[ERROR]` 日志

### 17. API 未分页  ✅ 已修复
`fetchInstances` / `fetchStaticIps` 只取单页响应，超过 AWS 单页上限（100 条）会漏检。
- 改为通过 `nextPageToken` 循环拉取全部数据

### 18. `newIp` 兜底逻辑  ✅ 已修复
原先获取新 IP 失败时用静态 IP 名称代替地址推送，可读性差。
- 改为重新查询实例最新公网 IP，地址更准确
- 仍失败时提示"请到 AWS 控制台确认"

### 19. 日志写入串行化  ✅ 已修复
`logger.js` 每次独立 `appendFile`，高并发下日志可能乱序。
- 引入写入队列，串行落盘

### 20. 遗留注释与代码不符  ✅ 已修复
- `checker.js` 注释写"150 秒/60 秒"，实际是 `PING_TIMEOUT`（默认 15 秒）
- `index.js` 存在重复的 JSDoc 注释块

### 21. 依赖安全漏洞  ✅ 已修复
`npm audit` 检出 3 个高危漏洞（`nodemon@2.0.20` → `simple-update-notifier` → `semver` ReDoS）。
- 升级 `nodemon` 至 `3.1.14`，`npm audit` 结果为 0 漏洞

### 22. 补充说明
- `.env.example` 确认已存在且完整（此前误判缺失）
- 模块语法检查、加载验证全部通过
- 真实 AWS 端到端验证已通过（国内服务器 + 真实凭证 + 现有实例）

---

## 🐛 问题修复（2026-08-23）

### 23. 已停止/无公网 IP 的实例触发无意义换 IP  ✅ 已修复
已停止或非运行状态的实例没有（有效的）公网 IP，Ping 必然失败，会触发一次注定失败的换 IP 操作。
- `checkIp` 前置检查实例状态与公网 IP，非 `running` 或无 IP 时直接跳过
- 新增 `skipped` 统计项，汇总日志同步输出

### 24. 失败通知中 newIp 传的是静态 IP 名称  ✅ 已修复
创建/绑定静态 IP 失败的告警里，`newIp` 传的是 `${server.name}-${Date.now()}` 这样的资源名称而非 IP 地址，可读性差。
- 失败通知统一改为 `-`

### 25. 大量实例同时不可达时换 IP 全并发  ✅ 已修复
同一区域大量实例同时被判定不可达时，换 IP 的 AWS API 调用全部并发执行，容易触发限流。
- 新增按区域的并发限制器，换 IP 操作超并发时自动排队
- 新增配置项 `ROTATE_CONCURRENCY`（默认 2），超出部分排队等待

### 26. 绑定成功但获取新 IP 失败时兜底值仍为名称  ✅ 已修复
绑定成功后查询新 IP 失败时，通知里 `newIp` 兜底为静态 IP 名称，现改为 `-`（日志仍提示到 AWS 控制台确认）。

---

## 🐛 问题修复（2026-08-29）

### 27. 优雅退出为固定 5 秒等待，可能截断换 IP 流程  ✅ 已修复
原 `shutdown` 固定等 5 秒后 `process.exit`，并不真正等待在途操作；且 pm2 默认 `kill_timeout` 仅 1.6 秒，`pm2 restart` 可能把"解绑→释放→分配→绑定"截断在半截，留下已分配未附加的静态 IP（产生闲置费用）。
- 新增在途操作跟踪（`pendingOps`），退出前等待所有检查/换 IP/清理操作完成
- 等待上限 `SHUTDOWN_GRACE_SEC`（默认 120 秒），防止个别操作挂死导致进程停不下来
- 第二次退出信号强制立即退出；退出前留 100ms 让日志写入队列落盘
- pm2 启动参数增加 `--kill-timeout 150000`，与宽限期匹配
- 30 分钟清理任务的 interval 句柄现在会被正确清除；两处重复的清理循环合并为 `cleanupAllRegions`

### 28. Server酱 请求无超时，可卡死换 IP 队列  ✅ 已修复
axios 请求未设超时，sctapi 挂起时 `sendMsgByServerChan` 永不返回，会永久占住区域并发限制器槽位，该区域后续所有换 IP 全部排队卡死。
- `notifier.js` 请求增加 `timeout: 10000`
