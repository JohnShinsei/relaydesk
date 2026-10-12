# RelayDesk 集成核验

核验日期：2026-10-12。以下区分**官方文档已确认**与**本机尚未实测**；运行结果以本项目 README 和测试记录为准。未登录新账户、读取或复制密钥、安装渠道插件、发送外部消息或部署 VPS。

## 本轮选择

首版只要求打通本地手机友好界面 → 会话/任务服务 → 执行适配器 → 状态/结果的完整链路。模拟适配器必须明确标识。真实模型接口和真实消息渠道分别启用，不能因为命令存在就显示“已连接”。

后续优先评估 OpenClaw 的渠道与 Codex 执行组件，保留 RelayDesk 的薄适配边界。VPS 只作为未来的身份校验、排队和消息转发入口；Mac 执行代理主动建立出站连接，在指定工作目录内运行。模型凭据由官方客户端或经用户批准的凭据管理方式持有，不进入前端、任务正文或项目源码。这是本项目设计选择，不代表已完成远程接入。

## Codex：本地 CLI、SDK 与 app-server

| 路线 | 官方已确认 | RelayDesk 的取舍与验证边界 |
| --- | --- | --- |
| `codex exec --json` | 非交互执行返回 JSONL 事件；支持以会话 ID 继续；默认只读沙箱，并复用 CLI 已保存的登录。 | 适合首个受限本地适配器。进程使用参数数组、固定工作目录和显式权限，不把用户输入拼接为 shell 命令。CLI 检测成功仍不等于模型请求成功。 |
| Codex SDK | TypeScript SDK 可启动/继续/恢复本地线程；官方将 SDK 定位于任务自动化和 CI。 | 可以减少子进程协议代码；首版不必为此安装额外运行时。 |
| `codex app-server` | 官方面向自定义客户端，覆盖会话历史、认证、审批和流式事件；默认 stdio，双向 JSON-RPC。 | 长期比单次 `exec` 更适合手机审批与原生会话。优先由 Mac 代理用 stdio 连接，再转换为 RelayDesk 事件；不直接把 app-server 暴露到公网。 |

来源：[非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)、[App Server](https://learn.chatgpt.com/docs/app-server)。

订阅和 API 必须分开：Codex 支持 ChatGPT 登录的订阅访问，也支持 API key 按量付费；API key 请求不会自动使用 ChatGPT 包含额度。本机只应通过 `codex login status` 这样的受支持命令检查状态，不打开认证文件。[认证说明](https://learn.chatgpt.com/docs/auth)

app-server 当前文档允许已有本地/开源应用继续使用其认证，同时明确商业或托管服务不能采用该认证方式。其 WebSocket 传输仍标为实验性；本项目不把它当公网生产接口。[App Server：认证与传输](https://learn.chatgpt.com/docs/app-server)

另有专门的 **Sign in with ChatGPT** 路线：开源/本地应用可另行申请用户许可，为符合条件的 Responses 请求使用 ChatGPT plan；官方也提供自托管 VM 指引。这需要应用注册/授权与独立主机标识，并且有预览期模型、接口和工具限制；不授予 ChatGPT 历史对话读取权。它与复用现有 Codex 登录不是同一件事，不能直接承诺本项目已支持会员。未来 VPS 方案应先对照这一路线及其适用范围，不在本轮创建凭据或搬运登录状态。[使用范围](https://developers.openai.com/siwc/token-sharing-open-source)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、[自托管 VM](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)

## Claude：保留三种不同边界

| 路线 | 官方已确认 | RelayDesk 的取舍与验证边界 |
| --- | --- | --- |
| Claude Code 非交互 CLI / Agent SDK | `claude -p` 属于官方编程调用方式，支持结构化输出和继续会话；Python/TypeScript SDK 提供工具审批等能力。 | 作为真实适配器候选，但不自动承诺订阅凭据可用于自建产品。`--bare` 会跳过用户配置发现，且不使用订阅登录，需 API 或受支持云提供商认证。 |
| 官方 Remote Control | 手机/浏览器可以继续本机 Claude Code 会话；执行和文件访问留在本机，网络经 Anthropic API，Mac 不需要入站端口。 | 适合用户直接远程使用原生 Claude；不是走用户 VPS 的统一聊天后端。本轮未启用。 |
| 官方 Channels | MCP stdio 通道可把自有服务器事件推入正在运行的原生 Claude Code；可实现双向回复及单次工具审批转发。 | 值得单独试验的原生扩展路线。仍为研究预览，自定义通道受 allowlist/开发标志限制；账号可用性、稳定性和自建平台适用范围均未验证。本轮不绕过 allowlist，也不更改配置。 |

来源：[编程调用](https://code.claude.com/docs/en/headless)、[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)、[Remote Control](https://code.claude.com/docs/en/remote-control)、[Channels](https://code.claude.com/docs/en/channels)、[Channels 协议与审批转发](https://code.claude.com/docs/en/channels-reference)。

Anthropic 当前规则区分原生 CLI 托管与第三方自有认证代理：在符合其条件、使用未修改官方二进制、让最终用户自行官方登录并承担用量的情况下，可以在产品中运行 Claude Code；这不授权 RelayDesk 自行提供 Claude.ai 登录或中转 Free/Pro/Max 凭据。Agent SDK 第三方额度规则仍要求事先获准。当前尚未发现本机 Claude CLI，也没有验证本项目封装是否满足该路径；不承诺会员已接入。[认证与原生托管规则](https://code.claude.com/docs/en/legal-and-compliance)、[Agent SDK 的认证限制](https://code.claude.com/docs/en/agent-sdk/overview)

## 消息连接器：机器人入口与工作消息监控分别处理

| 渠道 | 可核验的接入方式 | 当前范围 |
| --- | --- | --- |
| 微信 | OpenClaw 官方文档声明外部 `@tencent-weixin/openclaw-weixin` 插件由 Tencent Weixin 团队维护，使用 iLink；插件能力只声明直聊和媒体，未声明群聊。 | 候选机器人入口；不是“读取个人微信所有会话”的证据。尚未安装或扫码，腾讯发布页未独立核验。OpenClaw 文档记录插件 2.4.8 的配对/撤销限制，试接前必须复查修复版本与发送者校验。 |
| QQ | 腾讯机器人平台提供 API/webhook，面向频道、群与单聊；主体类型、沙箱、审核与使用范围影响可用能力。 | 仅保留既往调研，本轮 QQ 暂不接入。该路线可用于正式机器人连接器，不等于登录个人 QQ 接管所有聊天；尚未创建机器人或申请权限。 |
| Slack | Events API；Socket Mode 可通过 WebSocket 收事件，不需公开 HTTP 回调。官方 Bolt/SDK 可处理连接细节。`message.channels` 需要 `channels:history`，只看提及可使用 `app_mention`。 | 优先采用最小范围读取、指定频道/发送者；需用户批准创建/安装 app、授权和令牌。首版不申请 `chat:write`，不发送消息。 |
| Gmail | `watch` + Cloud Pub/Sub 接收变化提示，再通过 `history.list`/邮件读取补取内容；watch 至少每 7 天续订。 | 未来只读连接器；先确认邮箱供应商和 OAuth。`gmail.readonly` 属于 restricted scope，服务端处理需评估相应验证要求，不默认申请发送/删除能力。 |
| Outlook | Microsoft Graph 可订阅邮件变化；读取正文需要相应读取权限，订阅需要续期及丢失通知恢复。 | 未来采用用户委托的最小读取权限，按选定邮箱/文件夹接入，不默认申请全租户权限。 |

来源：[OpenClaw 微信通道](https://docs.openclaw.ai/channels/wechat)、[QQ 官方接入指南](https://bot.q.qq.com/wiki/)、[Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)、[Slack 消息事件](https://docs.slack.dev/reference/events/message.channels/)、[Gmail 推送](https://developers.google.com/workspace/gmail/api/guides/push)、[Gmail 权限](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Outlook 通知](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview)。

微信公众号接收消息与企业微信会话存档是需要分别核实的其他路线。本次网页抓取未能取得对应腾讯文档正文，不将其权限、费用或对个人微信的覆盖范围写成已验证结论。待具体选定账户类型后再核验；本轮仅保留连接器边界。[公众号文档入口](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)、[企业微信文档入口](https://developer.work.weixin.qq.com/document/path/91774)

设计上，连接器只产生带来源、会话、发送者、时间和外部 ID 的事件。工作消息先进入“待读 → 摘要/建议 → 用户确认”流程；消息正文是外部数据，不能直接成为执行权限。读取、总结、起草和实际发送是四项独立能力。去重、断线补偿、授权范围和审批审计应由核心服务统一处理。

## 已讨论组件的定位

下列均是候选；没有因为本次研究而安装、选为唯一底座或承诺兼容。

| 组件 | 可复用部分 | 本项目建议 |
| --- | --- | --- |
| OpenClaw | Gateway、WebChat、设备节点、渠道协议；已有以 Codex app-server 为底层的 Codex harness，保留原生线程恢复和工具执行。 | 下一阶段优先做小范围对接验证，可能取代大量自行编写的渠道代码。其接入文档不能覆盖模型厂商的认证规则。 |
| n8n | Webhook 触发工作流、外部系统编排。 | 放在后续消息整理/定时流程层；不会自动提供原生 Codex/Claude 会话、目录隔离和手机审批。采用前按目标部署方式检查许可证。 |
| Chatwoot | 客服多渠道收件箱、会话分配和客户上下文。 | 若后续变成多人客服台再评估；当前个人 AI 执行台不需要把客服模型作为核心。 |
| Open WebUI | 自托管模型界面，支持 Ollama/OpenAI-compatible 接口；生态另有 Open Terminal/Computer 执行能力。 | 可作为界面或模型 API 入口候选；不因“兼容 API”就获得会员调用权。采用源码时核对其当前品牌/许可条款。 |
| Open-LLM-VTuber | 语音交互、打断、Live2D；仓库含 `gpt_sovits_tts`，通过独立 HTTP TTS 服务生成音频。 | 保留为可选语音/角色模块，不作为任务与渠道平台的主架构。爱音音色、权重来源、内存占用和实时性能尚未验证；本轮不下载模型。 |

来源：[OpenClaw 架构](https://docs.openclaw.ai/concepts/architecture)、[Codex harness](https://docs.openclaw.ai/plugins/codex-harness)、[n8n Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook)、[n8n 许可证](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)、[Chatwoot 功能](https://www.chatwoot.com/features)、[Open WebUI](https://docs.openwebui.com/)、[Open WebUI 许可](https://docs.openwebui.com/license/)、[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)、[GPT-SoVITS 适配源码](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/tts/gpt_sovits_tts.py)。

## 开启真实能力前还需要什么

1. 明确第一个真实 AI 路线：受支持的本地 Codex、单独授权的 Sign in with ChatGPT，或 Claude API/原生扩展；检查版本、账户资格和预算，但不暴露凭据。
2. 选择第一个渠道及读取范围。微信先确认用户需要“给 AI 发消息”还是“监控既有工作群”，两者覆盖范围不同。
3. VPS 阶段提供主机系统、域名和预期访问者；先评审登录、设备配对、TLS、出站代理、离线恢复和日志保留，再授权部署与持久凭据创建。
4. 语音作为独立实验，先测资源和延迟，再决定是否接入 GPT-SoVITS；不作为文本第一版的前置条件。
