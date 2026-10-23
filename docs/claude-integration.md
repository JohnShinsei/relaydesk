# Claude 接入

## Desktop 与自动执行的分工

日常继续使用 Claude Desktop。RelayDesk 的自动任务通过独立的官方 Claude Agent SDK / Code CLI 执行，不依赖 Desktop 窗口、UI 点击或私有接口。官方对比将脚本自动化列在 CLI / SDK 一侧，Desktop 是交互入口。[官方功能对比](https://code.claude.com/docs/en/desktop#feature-comparison)

SDK 按需加载并启动任务子进程，结束后关闭查询和进程；不要求 Desktop 常驻，也不会关闭用户现有桌面进程或接管桌面聊天。**这不等于已证明更省内存。** 本轮已观察一个最小文本任务的 CLI 工作集，见[验证记录](current-verification.md)；同等任务下与 Desktop 的空闲、峰值及结束后对比尚未进行。

本仓库使用官方 `@anthropic-ai/claude-agent-sdk` `0.3.309`，当前安装的独立 CLI 为 `2.1.309`。安装或版本输出仅证明程序存在，**不证明已登录、模型可用、权限正确或任务成功**。SDK 是执行 Claude Code agent 的库，不是 Claude Desktop 的远程控制 API。[官方 SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)

## 登录与使用额度

Desktop 已登录不代表独立 Code 登录可用。日本端操作者应使用配置的官方 CLI 运行 `claude auth status`；若未登录，再由本人用 `claude auth login` 的官方流程完成浏览器认证。不要把凭据贴到聊天、仓库或网页中。

RelayDesk 不读取或复制 Desktop cookie、OAuth token、账号令牌或登录文件，不从已有进程提取认证，也不提供 token broker。SDK / CLI 自己通过官方支持的流程使用认证。登录状态检查不是模型响应测试；真实模型回合需另行验收。

官方帮助中心当前说明 SDK 和 `claude -p` 可以使用订阅限额，并说明部分套餐的 API credits。本驱动只接受官方第一方订阅登录，发送输入前核对 SDK 账户信息；不转用 API key、Bearer 覆盖或云平台认证。具体账户可用性和最终扣费必须核对账号记录；不会从一次成功响应或 SDK 的费用估计判断这次消耗了哪类额度。[官方套餐说明](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

## 本地配置

Claude 适配器默认关闭，只有日本端启动进程能启用和配置。浏览器无法指定 CLI、模型、目录或环境变量。配置示例见仓库 `.env.example`；该文件只作说明，服务不会自动加载 `.env`。

| 环境变量 | 含义 |
| --- | --- |
| `RELAYDESK_ENABLE_CLAUDE=1` | 显式启用，默认关闭 |
| `RELAYDESK_CLAUDE_PATH` | 可选，本机官方 CLI 的绝对 `.exe` 路径 |
| `RELAYDESK_CLAUDE_MODEL` | 可选，本机已验证可用的模型 |
| `RELAYDESK_CLAUDE_AUTH_MODE` | 可选，仅接受 `subscription`，默认订阅 |
| `RELAYDESK_CLAUDE_ENVIRONMENT=1` | 可选工具配置，仍逐次审批；默认没有工具 |

驱动使用环境白名单，不接收 API key / Bearer 或云认证覆盖。默认 `tools: []` 只能对话；显式启用环境访问时只承诺 Read、Glob、Grep，并且每一次都需工具回调中的单次审批。Edit / Write 因缺少完整原子差异绑定而拒绝。此版本明确禁用 Bash：尚不能可靠确认 Windows shell 选择、目录转换与派生进程停止。后续若开放命令执行，须另行核对这些边界。

未指定 CLI 路径时使用 SDK 自带的 native CLI，不自动搜索或升级 `.tools` 中的另一份安装。不允许工具请求绕过权限限制或申请 background；关闭查询也不意味着已有外部副作用被回滚。

驱动使用官方 safe-mode、禁用 slash commands / bundled skills，并显式关闭固定 CLI 版本的内置插件；空 `plugins` 数组本身不能禁用这些插件。发送输入前通过公开 SDK 方法检查插件、技能与 MCP 均为空，否则拒绝；运行初始化回执仍重复核对，不放行未知扩展。

真实执行前核对登录、固定目录、权限策略和模型。工具限制与固定工作目录不是完整 OS 隔离。SDK 的 hooks 禁用配置不能屏蔽组织 managed hooks，仍需本机策略验收，不承诺未知组织配置下的完整隔离。不要用环境开关绕过登录失败或 unknown；文本成功不证明桌面已接通。

## 会话、停止与恢复

RelayDesk 保存真实 SDK session ID、固定 `.data/claude-native-workspace` 和驱动版本，后续输入续接该会话，不接管 Desktop 聊天，不通过显示名称匹配。新任务仅提交新输入。发送前保存 SDK 用户消息 UUID 作为回合身份，结果须与该身份及 session 对应，并取得子进程零退出码才确认 completed；审批和历史核对不能用“最近一条回复”替代。

任务结束关闭当前查询，持久会话可以用于后续任务；会话存在不等于有后台进程一直运行。停止先显示 `cancelling`，执行和进程结束证据足够才更新终态。无法确认、断线或异常重启进入 `unknown`，阻止后续真实任务，不自动重发 prompt。

当前恢复先校验保存的 session / 用户消息 UUID，再仅调用对应会话的 SDK 只读消息查询；不启动 resume 推理，也不声称已从历史定位到该回合的终态。SDK 历史不能证明原生执行终态，所以此版本仍返回 unknown，**不能用历史中的最后一条助手回复解除阻塞**。缺失身份或未确认进程退出同样保持待确认，不会通过新 session 或新 key 重新执行。持久终态回执和受控人工恢复流程仍待补齐；旧 Codex 启动 ACK 不能解除 Claude 未知任务。

## 真实验收

按顺序记录版本、任务 ID、SDK session / turn ID、实际结果与状态，并标记 `passed / failed / blocked / not_run`：

1. CLI 官方登录状态与最小无工具文本回合分别检查，不把 Desktop 登录当作通过证据。
2. 续接同一 SDK 会话，确认上下文和身份不混入另一个会话。
3. 指定测试目录验证支持的读取单次审批、拒绝无副作用、重复和过期响应被拒绝；Bash 与 Edit / Write 不作可用工具验收。
4. 停止等待执行退出；确认任务结束后 SDK 查询和任务进程释放。
5. 浏览器重连与 RelayDesk 重启后核对原回合；缺失终态时保持 unknown，不再次发输入。
6. 如需评估内存，在同等任务下分别测 Desktop 和 SDK，记录空闲、执行峰值、结束后数值。

自动化夹具不代替真实模型、Windows 权限、账单、内存或桌面验收。真实检查结果以独立验证记录为准；本文不预先标为通过。远程认证、跨境连接、文件下载、截图和锁屏恢复继续按 [路线图](roadmap.md)分阶段推进。
