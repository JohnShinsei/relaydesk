# 真实执行适配器：调用边界

核验日期：2026-10-12。核验本机官方 CLI `0.142.2` 的帮助、生成的协议 schema 及厂商文档。文档研究不读取认证文件、不登录或安装软件；另行进行的受限模型连通探测及结果见 [验证记录](verification.md)。

## 当前结论

首个 Codex 适配器可尝试**受限只读调用**，不能据此宣传为“没有任何工具”“无法读取其他目录”或“会员兼容已验证”。`read-only` 限制写入；固定 `cwd` 限制工作起点，两者都不等于文件读取隔离。零工具模式仍缺少已验证的统一约束。

模型输入只由本会话的结构化文本历史构成。服务端使用固定二进制路径、固定空工作目录、参数数组和 stdin；浏览器不能指定程序、目录、环境变量、模型配置或附加参数。不要使用 shell 拼接、现有会话恢复、`--last`、凭据复制或认证文件解析。

## Codex CLI 的可核验能力

本机 `exec --help` 确认：`--ignore-user-config` 不载入用户 `config.toml`，认证仍使用原 `CODEX_HOME`；`--ephemeral` 不保存会话文件；支持 JSONL、stdin 和只读沙箱。`--strict-config` 可拒绝该版本不认识的配置，但不能证明已接受的旧开关仍有效。保留现有 execpolicy 规则，不传 `--ignore-rules`。来源：[官方命令参考](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。

下面是供受控冒烟测试评审的调用基线，**尚不是经实测证明的零工具沙箱**。`CODEX_BIN` 应由本机操作者指定为已核验的官方二进制；`RELAYDESK_EXEC_DIR` 是项目创建的空目录。两者均不接受 HTTP 请求中的值。调用前逐项检查安装版本支持的 feature，遇到未知或被移除项应停止。

```sh
"$CODEX_BIN" exec \
  --ignore-user-config --ephemeral --json --color never --strict-config \
  --skip-git-repo-check --sandbox read-only --cd "$RELAYDESK_EXEC_DIR" \
  --disable shell_tool --disable unified_exec --disable shell_snapshot \
  --disable hooks --disable apps --disable plugins --disable remote_plugin \
  --disable browser_use --disable browser_use_external \
  --disable browser_use_full_cdp_access --disable computer_use \
  --disable in_app_browser --disable image_generation --disable multi_agent \
  --disable memories --disable skill_mcp_dependency_install \
  --disable tool_suggest --disable workspace_dependencies \
  -c 'approval_policy="never"' \
  -c 'forced_login_method="chatgpt"' \
  -c 'project_doc_max_bytes=0' \
  -c 'web_search="disabled"' \
  -c 'history.persistence="none"' \
  -c 'shell_environment_policy.inherit="none"' \
  -c 'notify=[]' \
  -
```

上述参数关闭一组能力并避免请求提权；`approval_policy="never"` 的含义是无法请求额外批准，并非拒绝所有工具。首次仅发送无文件或网络需求的合成短提示，检查是否得到已知助手输出和正常退出。不要以模型自称“没有工具”作为安全证据。登录状态、真实返回和具体订阅计费是不同验证项。

CLI 进程环境采用明确白名单，排除 API key、provider endpoint 覆盖、外部工具配置等注入入口；只保留正常官方登录所需的已有定位信息，不读取或打印它们指向的凭据内容。认证失败时停止，不自动登录，也不回退到可能计费的 API key。

## 不能用来作保证的配置

- 本机 feature 列表将 `apply_patch_freeform`、`js_repl` 标为 removed；不要依赖 `false` 值关闭文件编辑或执行能力。
- 官方页面仍列 `tools.view_image`，但当日官方 JSON schema 的 `ToolsToml` 未包含此键。`tools=[]` 也不是所列配置形状，不能套用其他厂商的工具空列表语义。
- `mcp_servers.<id>.enabled=false` 是逐服务器禁用。没有核实 `mcp_servers={}` 是否清除所有继承层，不能将空表当总开关。
- `--ignore-user-config` 不代表完全清空系统、受管理要求、插件、skills 或其他上下文来源。`project_doc_max_bytes=0` 限制项目说明注入，不是文件读取沙箱；不得为隔离而更改用户 `HOME`、搬移认证目录或绕过组织策略。

单项开关来源：[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)、[官方配置 schema](https://learn.chatgpt.com/docs/config-schema.json)。配置存在多层，受管理要求可以约束命令行覆盖；遇到冲突应报错而非放宽。来源：[配置优先级](https://learn.chatgpt.com/docs/config-file/config-basic)。Hooks 的全局开关为 `features.hooks=false`，但管理员可以强制启用；不使用跳过 hook 信任的危险参数。来源：[Hooks](https://learn.chatgpt.com/docs/hooks)。

## App Server 的后续路线

本机通过 `app-server generate-json-schema --experimental --out <临时目录>` 生成的 `v2/ThreadStartParams.json` 和 `v2/TurnStartParams.json` 均包含 `environments`：空数组明确关闭环境访问。它是线程/轮次协议字段；没有证据表明 `exec -c 'environments=[]'` 有效。后续若使用它，应在每轮保持空环境，不允许前端覆盖。

同一 schema 中没有全局 `tools`、`toolConfig`、`toolChoice` 或 `allowedTools` 参数；`dynamicTools` 表示客户端提供的自定义工具，空数组不会证明其他内置工具或 MCP 已关闭。`ConfigReadResponse` 的 `ToolsV2` 也没有总工具白名单。来源：本机 CLI 生成 schema；协议定位参见 [App Server](https://learn.chatgpt.com/docs/app-server)。

本机 `app-server --help` 没有 `--ignore-user-config`。因此即使使用空环境，也需在初始化前审查并禁用继承的 hooks、MCP、apps、插件和通知命令。未来通过 stdio 使用短生命周期进程、`ephemeral: true`、空环境及受限 RPC 白名单；不要直接向浏览器开放完整协议。未收到真实事件证明前不显示“已连接”。

## 执行器应有的失败边界

这些是 RelayDesk 的设计要求，并非厂商保证：仅允许识别的文本输出进入聊天；工具执行事件、未知协议、超长行或输出超限均使任务失败并终止进程。检查事件只能检测异常，不能替代执行前的权限限制。取消/超时先终止子进程，再确认退出；未确认停止时不能显示“已停止”。不自动重试可能已成功的请求，以免重复消耗额度。原始 stderr 和认证错误需脱敏，不能回传个人路径、令牌或完整环境。

## Claude 的当前边界

当前规则允许在符合条件的产品/基础设施中运行**未修改的 Claude Code 官方二进制**；用户必须自行通过官方流程认证并承担用量，不能限制二进制原有认证方式、代售或替用户中转用量。这不等于第三方自有聊天后端可提供 Claude.ai 登录或自动代理 Free/Pro/Max 凭据。应区分原生 CLI 托管与 RelayDesk 的自有服务封装；后者优先选 API key / 官方云提供商，或先取得适用范围确认。来源：[运行 Claude Code 的条件与认证边界](https://code.claude.com/docs/en/legal-and-compliance)。

Agent SDK 文档仍说明，未经预先批准，第三方产品不能提供 Claude.ai 登录或其额度。当前不读取、导出或复用 Claude token，也不将“本机 CLI 支持个人订阅”写成 RelayDesk 的会员兼容承诺。来源：[Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)。
