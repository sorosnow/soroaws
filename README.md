# Soroaws

定时检测 AWS Lightsail 实例 IP 连通性，当 IP 被阻断时自动更换。

> 请部署在国内服务器上，放在国外无法有效检测 IP 连通性。

## 工作原理

1. 获取所有 Lightsail 实例列表
2. 对每个实例，从本机**持续 Ping 实例公网 IP**（`PING_TIMEOUT` 秒内，有任一回复即视为可达）；已停止或无公网 IP 的实例自动跳过
3. 如果持续 Ping 始终无回复，判定该 IP 已被阻断，自动执行更换流程：
   - **已有静态 IP** → 解绑旧 IP → 释放旧 IP → 分配新 IP → 绑定新 IP
   - **无静态 IP** → 直接分配新静态 IP → 绑定
4. 每 1 分钟循环检测（可配置）
5. **自动清理未附加静态 IP** — 启动时和每 30 分钟自动扫描并释放未被任何实例绑定的静态 IP，避免产生闲置费用

### 关于探测方式

在部署主机（国内服务器）上**持续 Ping 实例的公网 IP**：`PING_TIMEOUT` 秒内不断探测，有任一次回复即判定链路正常，全部无回复才判定被阻断。

> 该方式依赖 ICMP。请确保实例侧放行 ICMP、且本机网络不屏蔽 ICMP，否则会出现误判。

## 前置要求

- Node.js 20 LTS+
- AWS 账号及 [IAM 访问密钥](https://console.aws.amazon.com/iam/home?region=ap-northeast-1#/security_credentials)
- 实例防火墙放行 ICMP（否则 Ping 探测会误判为被阻断）
- pm2（推荐生产使用）

## 安装

```bash
# 1. 安装 Node.js（推荐使用 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | sh
# 安装完成后重新加载配置文件，使 nvm 命令生效（无需重启）
source ~/.bashrc
nvm install --lts
npm i pm2 -g

# 2. 下载项目
git clone https://github.com/soroice/soroaws.git
cd soroaws

# 3. 安装依赖
npm install

# 4. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 AWS 凭证和配置
```

## 配置

通过环境变量配置，支持 `.env` 文件：

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `AWS_ACCESS_KEY_ID` | 是 | - | AWS 访问密钥 ID |
| `AWS_SECRET_ACCESS_KEY` | 是 | - | AWS 秘密访问密钥 |
| `AWS_REGIONS` | 否 | `ap-northeast-1` | AWS 区域，多个用逗号分隔 |
| `PING_TIMEOUT` | 否 | `15` | 探测总时长（秒），期间持续 Ping，全部无回复才算不通 |
| `CHECK_INTERVAL_MIN` | 否 | `1` | 检测间隔（分钟） |
| `ROTATE_CONCURRENCY` | 否 | `2` | 同一区域并行更换 IP 的最大并发数 |
| `SHUTDOWN_GRACE_SEC` | 否 | `120` | 退出前等待在途换 IP 等操作完成的最长时间（秒） |
| `SERVER_CHAN_TOKEN` | 否 | - | Server酱 推送 Token（留空不推送） |

## 通知

通过 **Server酱** 推送 IP 更换结果。未配置 `SERVER_CHAN_TOKEN` 时程序照常运行，仅不推送，启动日志会以 `WARN` 提示。

| 通知类型 | 触发时机 |
|----------|----------|
| AWS Lightsail IP 更换 | 本程序自动更换成功 / 失败（失败时标题带 `【失败】` 并附原因） |

> 推送请求带 10 秒超时：Server酱 接口挂起时不会永久占住区域并发限制器槽位、卡死该区域后续换 IP。

## 运行

```bash
# 开发模式（nodemon 热重载）
npm start

# 生产模式（pm2 守护进程）
npm run build
```

PM2 管理命令：

```bash
pm2 list                # 查看进程列表
pm2 logs soroaws        # 查看日志
pm2 restart soroaws     # 重启
pm2 stop soroaws        # 停止
```

> ⚠️ 若之前用旧进程名（`pulsex`）跑过，务必先 `pm2 delete pulsex` 再按上面的命令启动，否则新旧两个进程会同时运行、互相干扰地换 IP。

## 日志

所有日志统一写入项目根目录的 `soroaws.log` 文件，同时输出到控制台。
IP 更换事件（`CHANGE` 级别）会额外单独记录到 `changes.log` 文件，便于快速检索更换历史。

### 日志级别

| 级别 | 用途 | 筛选命令 |
|------|------|----------|
| `INFO` | 正常流程信息（检测开始、操作成功、汇总报告等） | `grep "\[INFO\]" soroaws.log` |
| `WARN` | 警告（Ping 不通、AWS 限流重试等） | `grep "\[WARN\]" soroaws.log` |
| `CHANGE` | IP 更换事件（记录实例名和 IP 变更） | `grep "\[CHANGE\]" soroaws.log` |
| `ERROR` | 异常错误（API 调用失败等） | `grep "\[ERROR\]" soroaws.log` |

### 日志示例

```
[2026/6/3 12:00:00] [INFO] soroaws 启动，检测间隔: 1 分钟
[2026/6/3 12:00:00] [INFO] 探测方式: 本机持续 Ping 实例公网 IP，最长 15 秒，有任一回复即视为可达
[2026/6/3 12:00:00] [INFO] 开始新一轮 IP 检查
[2026/6/3 12:00:01] [INFO] 正在检查 my-instance (1.2.3.4) 连通性
[2026/6/3 12:00:03] [INFO] my-instance (1.2.3.4) Ping 通，跳过本轮检测
[2026/6/3 12:02:30] [WARN] my-instance-2 (5.6.7.8) 持续 15 秒 Ping 无回复
[2026/6/3 12:02:30] [INFO] my-instance-2 (5.6.7.8) 判定为不可达，开始更换 IP
[2026/6/3 12:02:31] [INFO] 正在解绑静态 IP: my-instance-2-1685765000000 (5.6.7.8)
[2026/6/3 12:02:33] [CHANGE] my-instance-2 IP已更换 5.6.7.8 → 9.10.11.12
[2026/6/3 12:02:34] [INFO] 本轮检查完成: 1 个可达, 1 个已更换, 0 个失败, 0 个跳过
```

## 项目结构

```
soroaws/
├── index.js       # 入口文件，业务流程编排
├── config.js      # 配置管理（环境变量读取）
├── lightsail.js   # AWS Lightsail API 操作封装
├── checker.js     # 本机 Ping 连通性检测
├── notifier.js    # 消息通知（Server酱）
├── logger.js      # 本地日志记录
├── .env.example   # 环境变量模板
├── package.json
└── README.md
```

## 支持的区域

- us-east-2, us-east-1, us-west-2
- ap-south-1, ap-northeast-2, ap-southeast-1, ap-southeast-2, ap-northeast-1
- ca-central-1
- eu-central-1, eu-west-1, eu-west-2, eu-west-3, eu-north-1
