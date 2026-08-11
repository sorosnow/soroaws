# SailX

定时检测 AWS Lightsail 实例 IP 连通性，当 IP 被阻断时自动更换。

> 请部署在国内服务器上，放在国外无法有效检测 IP 连通性。

## 工作原理

1. 获取所有 Lightsail 实例列表
2. 对每个实例的 IP 进行持续 Ping 检测（15 秒内，有任一回复即视为可达）
3. 如果 IP 不可达，自动执行更换流程：
   - **已有静态 IP** → 解绑旧 IP → 释放旧 IP → 分配新 IP → 绑定新 IP
   - **无静态 IP** → 直接分配新静态 IP → 绑定
4. 每 1 分钟循环检测（可配置）
5. **自动清理未附加静态 IP** — 启动时和每 30 分钟自动扫描并释放未被任何实例绑定的静态 IP，避免产生闲置费用

## 前置要求

- Node.js 20 LTS+
- AWS 账号及 [IAM 访问密钥](https://console.aws.amazon.com/iam/home?region=ap-northeast-1#/security_credentials)
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
git clone https://github.com/sororain/sailx.git
cd sailx

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
| `PING_TIMEOUT` | 否 | `15` | Ping 检测时长（秒），持续发包，全丢才算不通 |
| `CHECK_INTERVAL_MIN` | 否 | `1` | 检测间隔（分钟） |
| `SERVER_CHAN_TOKEN` | 否 | - | Server酱 推送 Token（更换成功/失败都会收到通知） |

## 运行

```bash
# 开发模式（nodemon 热重载）
npm start

# 生产模式（pm2 守护进程）
npm run build
```

PM2 管理命令：

```bash
pm2 list               # 查看进程列表
pm2 logs sailx         # 查看日志
pm2 restart sailx      # 重启
pm2 stop sailx         # 停止
```

## 日志

所有日志统一写入项目根目录的 `lightsail.log` 文件，同时输出到控制台。
IP 更换事件（`CHANGE` 级别）会额外单独记录到 `changes.log` 文件，便于快速检索更换历史。

### 日志级别

| 级别 | 用途 | 筛选命令 |
|------|------|----------|
| `INFO` | 正常流程信息（检测开始、操作成功、汇总报告等） | `grep "\[INFO\]" lightsail.log` |
| `WARN` | 警告（Ping 不通、AWS 限流重试等） | `grep "\[WARN\]" lightsail.log` |
| `CHANGE` | IP 更换事件（记录实例名和 IP 变更） | `grep "\[CHANGE\]" lightsail.log` |
| `ERROR` | 异常错误（API 调用失败等） | `grep "\[ERROR\]" lightsail.log` |

### 日志示例

```
[2026/6/3 12:00:00] [INFO] SailX 启动，检测间隔: 1 分钟
[2026/6/3 12:00:00] [INFO] 开始新一轮 IP 检查
[2026/6/3 12:00:01] [INFO] 正在持续 Ping 1.2.3.4（最长 15 秒）
[2026/6/3 12:00:02] [INFO] 1.2.3.4 Ping 通，跳过本轮检测
[2026/6/3 12:02:30] [WARN] 5.6.7.8 持续 15 秒 Ping 无回复，判定为不通
[2026/6/3 12:02:31] [INFO] 正在解绑静态 IP: my-instance-1685765000000 (5.6.7.8)
[2026/6/3 12:02:33] [CHANGE] my-instance IP已更换 5.6.7.8 → 9.10.11.12
[2026/6/3 12:02:34] [INFO] 本轮检查完成: 1 个可达, 1 个已更换, 0 个失败
```

## 项目结构

```
sailx/
├── index.js       # 入口文件，业务流程编排
├── config.js      # 配置管理（环境变量读取）
├── lightsail.js   # AWS Lightsail API 操作封装
├── checker.js     # IP 连通性检测（系统 Ping）
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
