# RelayDesk

A local-first workspace for AI conversations and approval-driven tasks.

用一个手机友好的界面整理多个 AI 的会话、回复与任务。目标是让手机经自己的 VPS 连接 Mac 上的执行代理；**v0.2 仅在本机运行：默认模拟体验，另提供显式启用的受限 Codex CLI 适配器**。

## 现在可以做什么

- 在两个明确标记的模拟适配器之间创建独立会话。
- 发送问题，查看流式回复、任务进度和状态时间线。
- 中止任务；体验「提出计划 → 等待确认 → 继续执行」的演示流程。
- 刷新或重启后恢复 SQLite 中的会话、消息和任务。
- 查看真实 AI、VPS、消息渠道与语音服务的接入状态。

模拟回复是固定规则生成，不使用大模型，也不消耗会员或 API 额度。Codex CLI 适配器已实现，但当前本机模型请求被官方服务以模型不支持拒绝，尚未取得成功回复。Claude、远程网关、微信 / QQ / Slack / 邮件、TTS 均未连接。模拟确认按钮只继续本地模拟任务；真实 Codex 会话不提供模拟审批。

## 本地运行

需要 Node.js **24.15+（24 LTS）或 26+**（原生 TypeScript、SQLite 与开发依赖支持）。

```sh
npm ci
npm run build
npm start
```

打开 **http://127.0.0.1:4317**。服务固定绑定回环地址，手机暂时不能直接访问。数据保存在项目内 `.data/relaydesk.sqlite`，该目录不进入 Git。

开发模式：

```sh
npm run dev
```

打开 **http://127.0.0.1:5173**。Vite 将 API 请求代理到 `127.0.0.1:4317`。开发模式使用默认 API 端口，不要同时运行生产服务。

## 体验完整链路

1. 新建会话，选择任一模拟助手。
2. 发送一条消息，观察任务开始、回复逐步出现并完成。
3. 使用确认演示入口，等待任务进入「等待确认」，点击批准或取消。
4. 刷新页面，再次打开该会话，查看保留的消息和状态。
5. 发送 `/fail` 可验证错误展示；回复进行中可取消。

## 显式启用受限 Codex CLI

默认启动不会调用真实 AI。先在官方 CLI 中确认自己的正常 ChatGPT 登录和可用模型，再由本机操作者配置：

```sh
RELAYDESK_ENABLE_CODEX=1 \
RELAYDESK_CODEX_PATH="/Applications/Codex.app/Contents/Resources/codex" \
RELAYDESK_CODEX_MODEL="<已验证可用的模型名>" \
npm start
```

HTTP 请求不能指定二进制、目录、参数、模型或环境。适配器通过 stdin 发送当前会话历史，使用新临时 CLI 进程、固定 `.data/codex-workspace` 和只读沙箱，并关闭 shell、插件、浏览器等能力。不复制登录凭据，不回退到 API key。只读与固定目录不是完整的文件读取隔离，因此当前仍只适用于本机操作者，不能直接暴露给远程用户或不可信渠道。

CLI JSONL 按完整助手消息返回；真实适配器不承诺逐 token 流式输出。SSE 持续传递任务状态与已经收到的消息。全局同时只启动一个真实 Codex 任务，其他会话会收到稍后重试提示。取消会先显示「正在停止」，确认进程退出后才显示「已取消」。

如果服务崩溃或无法确认进程停止，真实适配器会暂停，并跨重启保留此状态。先在本机核对旧 Codex 进程已停止，再在一次启动中附加 `RELAYDESK_CODEX_ACK_INTERRUPTED=1` 解除隔离；不要把此确认长期保存在启动环境里。项目不会根据旧 PID 自动杀进程。数据库写入故障会停止任务并拒绝后续写入，需先修复本机存储再重启。

安装新 CLI 或重新登录应由使用者明确批准。`.tools/` 可存放项目内官方 CLI，已从 Git 排除；仓库不会自动安装、升级或登录。已知兼容性问题与官方边界见 [真实集成设计](docs/real-integration-design.md) 和 [验证记录](docs/verification.md)。

## 检查

```sh
npm run check
```

包含 TypeScript、ESLint、React DOM 流程测试、后端集成测试、CLI 协议测试与前端构建。UI 验证与已知限制见 [验证记录](docs/verification.md)。

## 架构和范围

- [架构与阶段计划](docs/architecture.md)
- [官方集成调查](docs/integrations.md)
- [API 契约](docs/api-contract.md)
- [依赖许可说明](THIRD_PARTY_NOTICES.md)
- [安全边界](SECURITY.md)

`client/` 是 React 界面；`server/` 提供 HTTP、SSE、任务执行与 SQLite 存储；`shared/` 定义执行适配器和渠道边界；`tests/` 是回归测试。

后续优先验证官方本地 AI 集成和成熟开源渠道组件。会员额度是否可用于某条集成路径，必须按官方认证方式和产品边界分别确认；本项目不会提取会员登录凭据作为通用 API 密钥。

MIT License. This project is independent and is not affiliated with OpenAI, Anthropic, or any messaging provider.
