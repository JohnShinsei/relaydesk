# 本地重整验证记录

日期：2026-10-24（Asia/Tokyo）。基线：`18bbb97428e66981d28a217a53cb761cedf52c77`。

本记录只覆盖本次执行器重整及其本地检查，不替代旧 Codex 账号验证，也不表示已完成跨国远程部署。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| TypeScript、ESLint | passed | 当前源码、测试与 React 组件 |
| 自动化测试 | passed | 154/154，0 failed、0 skipped；Windows x64 / Node.js 26.12.1 |
| 前端构建 | passed | Vite 8.3.5 生产构建 |
| npm audit | passed | 当前依赖树 0 已知漏洞；原 Vite 高危公告通过升级修复 |
| Hermes 协议测试 | passed | 18 个离线场景：持久 ID、回包丢失、绑定窗口、审批竞态、停止确认、恢复及凭据保护 |
| 执行内核测试 | passed | 多驱动分发、全局真实任务互斥、未知隔离和只读恢复 |
| HTTP 整体链路 | passed | RelayDesk HTTP → 本机合成 Hermes HTTP 服务，核对任务 ID、重复提交、状态投影及停止终态；未连接真实 Hermes |
| React DOM | passed | 原 Codex/模拟流程、Hermes 标识、常显任务摘要及无初始 binding 的原 run 查询 |
| 桌面浏览器 | passed | 本机生产构建，真实执行器全部关闭；模拟任务从提交到完成，任务/状态/结果/下一步可见 |
| 移动浏览器与国内网络 | not_run | DOM 测试不代替手机显示与跨境可达性 |
| 真实 Hermes API / 模型 / 工具审批 | not_run | 未启动真实 API，未读取或转换已有模型凭据 |
| 文件变更、桌面控制、后台常驻 | not_run | 仍需受控目录、用户会话、锁屏、重启及停止副作用验收 |

## 特别核对的语义

- 提交回包丢失后保留 unknown，不自动创建另一个任务。
- 已接收的 run ID 先持久化；随后即使 session 绑定查询失败，也只查询该 run。
- `stopping` 不等于已停止；实际终态确认后才结束本地任务。
- 原生审批 `already_resolved` 不证明本次决定已应用，必须保持 unknown；仅明确 `resolved` 视作本次决定送达。
- 文件编辑审批、澄清及不完整审批预览均拒绝继续，不用宽泛授权代替所缺的具体操作内容。
- 上游会话迁移到新 session ID 尚不支持；严格身份校验会保持 unknown，不能直接放宽验证。

## Windows 测试适配

既有 Unix 路径与符号链接夹具改为跨平台路径、Windows junction。POSIX `0700` 权限断言保留在 POSIX；Windows ACL 权限隔离未由该断言验证。没有跳过整项测试或放松执行器的实际权限检查。

## 后续验收

按 [Hermes 接入](hermes-integration.md)和[路线图](roadmap.md)推进。真实模型、文件审批、远程身份验证、跨境断线恢复和桌面操作均有独立验收门槛。本次源码完成与自动化通过，不授权公网暴露或默认启用真实执行。
