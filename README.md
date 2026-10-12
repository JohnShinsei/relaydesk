# RelayDesk

A local-first workspace for AI conversations and approval-driven tasks.

用一个手机友好的界面整理多个 AI 的会话、回复与任务。目标是让手机经自己的 VPS 连接 Mac 上的执行代理；**v0.1 目前是仅在本机运行、可验证的演示版本**。

## 现在可以做什么

- 在两个明确标记的模拟适配器之间创建独立会话。
- 发送问题，查看流式回复、任务进度和状态时间线。
- 中止任务；体验「提出计划 → 等待确认 → 继续执行」的演示流程。
- 刷新或重启后恢复 SQLite 中的会话、消息和任务。
- 查看真实 AI、VPS、消息渠道与语音服务的接入状态。

模拟回复是固定规则生成，不使用大模型，也不消耗会员或 API 额度。真实 Codex / Claude、远程网关、微信 / QQ / Slack / 邮件、TTS 均未连接。确认按钮只继续本地模拟任务，不执行系统命令或发送消息。

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

## 检查

```sh
npm run check
```

包含 TypeScript、ESLint、后端集成测试与前端构建。UI 验证与已知限制见 [验证记录](docs/verification.md)。

## 架构和范围

- [架构与阶段计划](docs/architecture.md)
- [官方集成调查](docs/integrations.md)
- [API 契约](docs/api-contract.md)
- [依赖许可说明](THIRD_PARTY_NOTICES.md)
- [安全边界](SECURITY.md)

`client/` 是 React 界面；`server/` 提供 HTTP、SSE、任务执行与 SQLite 存储；`shared/` 定义执行适配器和渠道边界；`tests/` 是回归测试。

后续优先验证官方本地 AI 集成和成熟开源渠道组件。会员额度是否可用于某条集成路径，必须按官方认证方式和产品边界分别确认；本项目不会提取会员登录凭据作为通用 API 密钥。

MIT License. This project is independent and is not affiliated with OpenAI, Anthropic, or any messaging provider.
