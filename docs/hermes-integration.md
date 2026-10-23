# Hermes 接入

## 范围与证据

本轮实现默认关闭的本机 HTTP 驱动与离线协议检查，**没有启动真实 Hermes API、使用真实模型或验收文件 / 桌面操作**。此文为配置和验收说明，不是远程部署已完成的证明。

协议核对依据 [官方 API 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)，以及 Hermes 官方仓库源码提交 `bf0203a794a07aac3ff764972ab9087baa4e4f4e`：

- [API 能力](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/gateway/platforms/api_server.py)
- [Runs 与幂等](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/gateway/platforms/api_server_runs.py)
- [权威运行状态与控制](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/gateway/platforms/api_server_authority_runs.py)
- [具体审批提示](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/gateway/session_pending_controls.py)

在线文档可能随版本变化；本驱动使用明确的能力探测和严格解析，不宣称适配任意 Hermes 版本。能力探测通过只表示协议支持，不证明模型、账号、工具和审批策略可用。

## 配置位置

日本端操作者在 Hermes 自身配置中开启 API、设置独立的 `API_SERVER_KEY` 并保持 loopback 监听。启动方法按所安装版本的官方文档操作。本轮不自动更改 Hermes 配置、不安装常驻服务、不启动网关。

RelayDesk 启动进程需要：

| 环境变量 | 含义 |
| --- | --- |
| `RELAYDESK_ENABLE_HERMES=1` | 显式启用驱动，默认禁用 |
| `RELAYDESK_HERMES_URL=http://127.0.0.1:8642` | API origin，只允许本机 HTTP |
| `RELAYDESK_HERMES_API_KEY` | 操作者提供的独立 API key，对应 Hermes 的 `API_SERVER_KEY` |

`.env.example` 仅作示例，服务不自动加载 `.env`。密钥不交给浏览器、不放进 URL、不提交仓库。不会读取、复制或转换 ChatGPT / Codex 的登录凭据。Hermes 自己使用的模型服务登录，与 RelayDesk 调用 Hermes API 的密钥是两件事。

不要将 RelayDesk 或 Hermes 端口直接公开。浏览器只调用 RelayDesk，不能直接访问 Hermes，不能覆盖模型、工作目录或工具配置。API 主机就是实际执行主机；loopback 连接不是执行沙箱。

## 驱动使用的协议

| 动作 | Hermes 接口 | RelayDesk 处理 |
| --- | --- | --- |
| 探测 | `GET /v1/capabilities` | 检查 run 提交、状态、停止、审批响应与持久幂等能力 |
| 创建 | `POST /v1/runs` | 仅传结构化输入与已有 session ID，幂等 key 使用本地 task ID |
| 查询 / 核对 | `GET /v1/runs/{run_id}` | 校验原生身份、保存 session/run 对应关系，读取权威状态 |
| 停止 | `POST /v1/runs/{run_id}/stop` | 接收停止请求后仍继续核对终态 |
| 审批 | `POST /v1/runs/{run_id}/approval` | 使用当前 prompt ID、执行代次和单次决定 |

本轮使用轮询读取 Hermes 状态，浏览器仍由 RelayDesk SSE 获取快照。没有实现 Hermes 工具事件的完整流式转发，也不把工具输出作为待执行命令返回浏览器。活动列表只提供有限状态元数据，不展示隐藏推理、原始诊断或完整工具参数。

会话绑定保存 Hermes session ID，任务保存 run ID；同一会话续接该 API 会话，不接管 CLI/TUI 现有聊天。只提交新输入，不用名称模糊匹配或“最近一条 run”恢复。

## 不确定结果与停止

本地幂等防止同一提交在 RelayDesk 中重复创建任务；提供方幂等有保留范围，不构成永久 exactly-once 保证。任何网络、解析或身份异常都不能自动重放输入。

`completed`、`failed`、`cancelled` 以 Hermes 回执确认；`interrupted` 显示中断失败。`stopping` 或停止请求成功只表示正在停止；须等工作退出的终态。断线、重启或缺少终态进入 `unknown` 并阻止新的真实任务。

恢复只读原 run。缺少持久 run ID、查询不到原任务、API key / profile 变化或上游 unknown 都保留待确认。本轮不自动调用上游 `resolve-unknown`，不通过新 key 重新发任务，也没有 HTTP 解锁未知任务的捷径。创建响应丢失后的人工核对与恢复流程仍待实现。上游将旧会话续接到新 session ID 时，本轮严格绑定校验也会保持 unknown；须先实现可验证的会话谱系再支持迁移，不能直接放松身份校验。

## 单次审批

本轮支持 canonical `pending_controls` 中受支持的具体审批提示的单次批准或拒绝，绑定 `prompt_id` 和 `execution_generation`，映射到 `choice: once / deny`。不完整或无法明确预览的权限请求不放行。

当前仅支持有具体 command/description 的普通工具审批。文件编辑审批（edit）缺少完整差异预览时进入 unknown，不提供接受按钮。API key 必须至少 16 个可打印字符且不能使用占位示例。

不支持永久批准、批量批准、旧式 SSE 审批和 clarification。若上游要求未支持的控制，任务应停留待处理或未知；由操作者核对，而不是降级为自动执行。模拟批准接口不授权任何真实动作。

审批意图先持久化，发送结果不确定时不重发。即使用户批准一次，也不能保证外部动作能够撤销。Hermes 的 API 和工具权限由本机配置决定，RelayDesk 不是通用权限隔离层。审批端点存在不证明每项工具都被审批；启用前需日本端操作者检查实际工具策略。自然语言任务范围不是操作系统沙箱，本轮不依赖内部 hosted_room 字段限制目录或工具。

## 真实验收与停止点

先按 [路线图第一阶段](roadmap.md)准备指定无害测试目录、恢复备份和记录模板，再做真实任务、拒绝与批准、停止、断线重连、服务重启及重复提交测试。

每项记录版本、task/session/run ID、实际输出和最终状态，标记 `passed / failed / blocked / not_run`。遇到未知结果、身份无法对应、重复副作用、审批预览不完整或密钥泄漏就停在该项，不把协议夹具的通过当作真实验收。

只有日本本机闭环通过，才进入远程认证与国内网络验收。桌面、截图、文件下载、锁屏和重启后的工作分别测试，不从文本对话成功推断。
