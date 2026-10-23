# 本地重整验证记录

日期：2026-10-24（Asia/Tokyo）。基线：`18bbb97428e66981d28a217a53cb761cedf52c77`。

本记录只覆盖本次执行器重整及其本地检查，不替代旧 Codex 账号验证，也不表示已完成跨国远程部署。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| TypeScript、ESLint | passed | 当前源码、测试与 React 组件 |
| 自动化测试 | passed | 177/177，0 failed、0 skipped；Windows x64 / Node.js 26.12.1；包含追加的 Claude 接入 |
| 前端构建 | passed | Vite 8.3.5 生产构建 |
| npm audit | passed | 当前依赖树 0 已知漏洞；原 Vite 高危公告通过升级修复 |
| Hermes 协议测试 | passed | 18 个离线场景：持久 ID、回包丢失、绑定窗口、审批竞态、停止确认、恢复及凭据保护 |
| Claude 协议测试 | passed | 17 个离线场景：发送前持久身份、取消窗口、订阅门槛、插件/技能预检、精确终态、退出确认、单次审批、路径/链接越界和只读 unknown 恢复 |
| Claude 本机启动与握手 | passed | 官方 SDK 0.3.309 / CLI 2.1.309；默认关闭、实际 native CLI 版本探测与无输入初始化通过；插件、技能、MCP 均核验为空 |
| Claude 独立登录与模型回合 | passed | 本人完成官方第一方订阅登录；独立无工具文本回合返回 PASS，session / 用户消息 UUID 匹配，明确 completed、队列为 0、进程 exit 0；仅覆盖直接驱动调用，不代替浏览器完整任务与工具验收 |
| 执行内核测试 | passed | 多驱动分发、全局真实任务互斥、未知隔离和只读恢复 |
| HTTP 整体链路 | passed | RelayDesk HTTP → 本机合成 Hermes HTTP 服务，核对任务 ID、重复提交、状态投影及停止终态；未连接真实 Hermes |
| React DOM | passed | 原 Codex/模拟流程、Hermes/Claude 独立标签、常显任务摘要、单次 Claude 审批与失回包仅查询、无初始 binding 的原 Hermes run 查询 |
| 桌面浏览器 | passed | 首次 Hermes 重整的本机生产构建，真实执行器全部关闭；模拟任务提交到完成可见；追加 Claude 界面由本轮 DOM 测试覆盖，未重复真实浏览器验收 |
| 移动浏览器与国内网络 | not_run | DOM 测试不代替手机显示与跨境可达性 |
| 真实 Hermes API / 模型 / 工具审批 | not_run | 未启动真实 API，未读取或转换已有模型凭据 |
| 真实 Claude 工具审批与取消 | not_run | 文本正常完成与退出不代替真实工具、等待审批或执行中取消的 Windows 验收 |
| Claude 内存观察 | passed | 上述单个最小文本任务约 2.67 秒，500 ms 周期共 5 次采样，CLI 观察峰值工作集约 236 MiB、私有提交约 391 MiB；进程随后退出。不是整体服务内存，也不是 Desktop 对照或复杂任务上限 |
| GPT / Claude 双代理讨论 | not_run | 仅列入路线图，尚未实现轮流转发与讨论控制 |
| 文件变更、桌面控制、后台常驻 | not_run | 仍需受控目录、用户会话、锁屏、重启及停止副作用验收 |

## 特别核对的语义

- 提交回包丢失后保留 unknown，不自动创建另一个任务。
- 已接收的 run ID 先持久化；随后即使 session 绑定查询失败，也只查询该 run。
- `stopping` 不等于已停止；实际终态确认后才结束本地任务。
- 原生审批 `already_resolved` 不证明本次决定已应用，必须保持 unknown；仅明确 `resolved` 视作本次决定送达。
- 文件编辑审批、澄清及不完整审批预览均拒绝继续，不用宽泛授权代替所缺的具体操作内容。
- 上游会话迁移到新 session ID 尚不支持；严格身份校验会保持 unknown，不能直接放宽验证。
- Claude SDK 按需加载，每轮创建查询；只在匹配 session / 用户消息 UUID 的明确结果和进程退出证据齐全时结束任务。无输入握手实际返回内置代理清单；这不代表允许调用 Agent 工具。
- 官方 CLI 即使传入空插件列表仍可能加载内置插件；驱动通过公开配置禁用，并在输入前调用 SDK 插件/技能检查。已验证本机空列表；未知插件或技能仍拒绝执行，不把它们当成工具配置成功。
- Claude 默认无工具，可选 Read / Glob / Grep 逐次审批；目录搜索拒绝链接及超出有界检查预算的树，Bash / Edit / Write 禁用。工具限制不构成 OS 沙箱。
- Claude 消息历史不包含足够的权威终态证据，当前只读恢复保持 unknown，不能因此重发或解除全局真实任务隔离。

## Windows 测试适配

既有 Unix 路径与符号链接夹具改为跨平台路径、Windows junction。POSIX `0700` 权限断言保留在 POSIX；Windows ACL 权限隔离未由该断言验证。没有跳过整项测试或放松执行器的实际权限检查。

## 后续验收

按 [Hermes 接入](hermes-integration.md)、[Claude 接入](claude-integration.md)和[路线图](roadmap.md)推进。真实模型、文件审批、远程身份验证、跨境断线恢复和桌面操作均有独立验收门槛。本次源码完成与自动化通过，不授权公网暴露或默认启用真实执行。
