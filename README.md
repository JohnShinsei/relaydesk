# RelayDesk

让人在国内，通过任务控制台使用日本电脑上的 AI 执行器。第一版服务**一个用户、一台日本 Windows 电脑、同一时间一个真实任务**。

**当前是本地原型，尚未完成远程部署。** 本次重整保留 Codex 与模拟功能，新增默认关闭的 Hermes HTTP 和 Claude Agent SDK 驱动，并把主流程收敛到任务、状态、结果和下一步。真实 Hermes API、国内到日本的连接、Windows 桌面操作与锁屏恢复均未验收。

## 第一版的分工

```text
国内浏览器
  → 经身份验证的远程访问层（待实现 / 验收）
  → 日本电脑上的 RelayDesk 单服务
  → 本机执行器（Hermes API / Claude Agent SDK / Codex）
  → 文件、浏览器或桌面任务（逐项验收）
```

RelayDesk 负责提交、记录任务、展示状态、单次审批和停止。各执行器负责执行与提供真实状态。连接程序先放在 RelayDesk 服务内；需要中转时再增加只负责转发的 Hub。

服务固定监听 `127.0.0.1:4317`，没有远程用户认证。**不要直接公开端口或接入公网隧道。** Host/Origin 校验不等于远程身份验证。

## 能力与证据

| 范围 | 当前状态 | 证据边界 |
| --- | --- | --- |
| 模拟聊天、审批演示、失败与停止 | mock / 已实现 | 确定性数据，不调用模型或操作电脑 |
| SQLite、SSE 快照、任务动态 | 已实现 | 本地记录；重连读取状态，不重新执行 |
| 执行器接口与 Hermes HTTP 驱动 | 已实现，默认关闭 | 离线协议测试不能代替真实 Hermes 验收 |
| Hermes 模型、工具、文件操作、原生审批 | 本轮未验收 | 配置或能力探测成功不代表执行成功 |
| Codex App Server 与旧 exec | 保留 | 既有验证属于历史记录，本轮不声称重验真实账号与模型 |
| 远程入口、认证、跨境连接 | planned | 本轮不部署、不开放端口 |
| Windows 桌面控制、截图与文件下载 | planned | 没有端到端成品交付链路 |
| 微信工作收件箱 | mock / 保留演示 | 合成消息与模拟发送，没有真实微信连接 |
| Claude Agent SDK | 可选接入，默认关闭 | SDK / CLI 安装不证明 Code 已登录；真实任务、审批与恢复须独立验证 |
| 邮件、消息机器人、多设备 | planned | 不属于第一版主流程 |

[历史验证记录](docs/verification.md)中的 Codex `0.162.1`、特定模型、macOS 环境和测试数量属于原有记录，不能作为当前 Windows / Hermes / 跨境链路的通过证据。

## 本地启动

需要 Node.js **24.15 以上的 24 LTS，或 26 以上**。在仓库根目录运行：

```sh
npm ci
npm run build
npm start
```

打开 [本地控制台](http://127.0.0.1:4317)。默认只提供模拟执行器，不需要模型密钥。

开发时运行 `npm run dev`，打开 [开发页面](http://127.0.0.1:5173)。Vite 转发至 API 端口 `4317`；不要同时运行开发服务与 `npm start`，开发模式不要修改 `PORT`。

数据保存在 Git 忽略的 `.data/relaydesk.sqlite`，包含会话和任务正文，没有应用层加密。升级或迁移前，先停服务并备份整个 `.data/`，保留可恢复的代码版本。

## 先试一个模拟任务

1. 新建会话，选择标注“模拟”的执行器。
2. 输入任务，查看状态与结果；可用 `/fail` 检查失败提示。
3. 用审批演示检查等待、批准或停止；它只放行预定义模拟动作。
4. 刷新页面，确认仍显示同一个任务。重连不会再次发送提交或审批。

真实任务必须等执行器确认终态才显示完成或已停止。`unknown` 表示结果待核实，应查询原任务，不应换一个 key 再提交。停止不撤销已经发生的文件修改或外部操作。

## 可选 Hermes 接入

配置与验收见 [Hermes 接入](docs/hermes-integration.md)。`.env.example` 只是示例，本服务不会自动加载 `.env`。

日本端操作者需为 Hermes API 单独配置密钥，再在启动 RelayDesk 的进程中设置：

```powershell
$env:RELAYDESK_ENABLE_HERMES = '1'
$env:RELAYDESK_HERMES_URL = 'http://127.0.0.1:8642'
# 从日本端受控秘密配置设置 RELAYDESK_HERMES_API_KEY；不要写入仓库。
npm start
```

缺少独立 API 密钥或协议能力不足时，不提供真实 Hermes 执行。驱动只接受 loopback HTTP origin。浏览器不能指定 Hermes 地址、密钥、模型、工作目录或任意 RPC 方法；模型与工具权限由日本端配置。**不读取、复制或把 ChatGPT / Codex CLI 登录凭据转换成 API 密钥。**

Codex 接入继续按 [原生驱动文档](docs/native-driver.md)使用；旧模式见 [原有集成设计](docs/real-integration-design.md)。真实执行器都需要本机显式启用。

## 可选 Claude 接入

RelayDesk 通过官方 Claude Agent SDK 调用 Code 执行任务，不自动点击或接管 Claude Desktop。日常仍可使用 Desktop；执行任务时按需启动 CLI 子进程，任务结束后关闭，无需为 RelayDesk 保持 Desktop 常驻。实际内存差异需在相同任务下测量，本轮没有内存对比，也不会关闭已有桌面进程。

Desktop 登录不等于独立 Code 已登录。按 [Claude 接入说明](docs/claude-integration.md)检查官方 CLI 登录状态；需要时由本人完成浏览器登录。默认禁用，固定工作目录 `.data/claude-native-workspace`；模型和环境访问由本机操作者配置，凭据不交给网页。当前套餐、认证路径和实际扣费应独立核对，不从一次响应推断订阅额度或 API 账单。

## 检查与下一步

本次 [本地重整验证记录](docs/current-verification.md)：加入 Claude 后的 177 项自动化测试、类型检查、lint、构建全部通过，依赖审计为 0 已知漏洞；官方 Claude CLI 隔离预检、独立登录与最小无工具真实文本回合通过。首次重整已完成桌面浏览器模拟任务验收；追加 Claude 界面由 DOM 测试覆盖。真实工具、手机、跨境连接与桌面操作另行验收。

```sh
npm run check
```

运行类型检查、lint、自动化测试和前端构建。离线协议测试使用受控夹具；全绿也不能证明真实模型登录、文件审批、桌面点击、常驻、锁屏或跨境网络可用。

下一步先在日本电脑的指定测试目录完成真实文件任务，核对输出、停止及重启后的原任务状态；通过后再增加远程身份验证与连接，并在国内真实网络验收。见 [路线图](docs/roadmap.md)。

## 项目导航

- [架构与状态语义](docs/architecture.md)
- [Hermes 接入与真实验收](docs/hermes-integration.md)
- [Claude 接入与登录边界](docs/claude-integration.md)
- [分阶段路线图](docs/roadmap.md)
- [API 契约](docs/api-contract.md)
- [历史验证记录](docs/verification.md)
- [安全边界](SECURITY.md)
- [消息演示设计](docs/messaging-design.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

`client/` 是 React 界面，`server/` 是 HTTP/SSE、执行器和存储，`shared/` 是契约，`tests/` 是测试。旧调研与 ADR 保留为历史背景，当前方向以本文、架构和路线图为准。

MIT 许可。RelayDesk 为独立项目，与模型和消息服务提供方无隶属关系。
