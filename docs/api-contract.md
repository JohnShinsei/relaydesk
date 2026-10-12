# Local v0.2 API contract

Only binds 127.0.0.1. Same origin JSON APIs. All JSON errors: `{ error: string }`.

- `GET /api/bootstrap` → Bootstrap from shared/types.ts. Mock providers available; real Codex is available only when explicitly configured at server startup. Claude remains disabled. Availability means configured, not successful provider verification.
- `GET /api/sessions` → `{ sessions: SessionSummary[] }`, newest updated first.
- `POST /api/sessions` body `{ adapterId, title? }` → `{ session: Session }`, status 201. Reject unavailable/unknown adapter.
- `GET /api/sessions/:id` → `{ session }`.
- `GET /api/sessions/:id/events` → SSE `event: snapshot`, `data: { session }`; initial snapshot immediately; subsequent task changes and chunks. Native EventSource auto reconnect refreshes snapshot. Heartbeat comments.
- `POST /api/sessions/:id/tasks` body `{ prompt, mode?: 'chat' | 'approval-demo' }` → `{ task }`, 202. Prompt 1–8000 chars. Only one active task (queued/running/cancelling/awaiting_approval) per session, conflict 409. Real adapters reject approval-demo before creating any task or message. UI keeps polling session list and obtains full selected session through SSE.
- `POST /api/tasks/:id/cancel` body `{}` → `{ task }`. Abort queued/running/waiting only; other transitions conflict 409. Running real CLI tasks first enter cancelling and hold the session lock until process termination is confirmed; an unconfirmed stop becomes failed and quarantines the adapter across restarts.
- `POST /api/tasks/:id/approve` body `{}` → `{ task }`, 202. Only awaiting_approval; continue a clearly labeled local simulated action. Never send messages or execute commands.

Default mocks produce deterministic Chinese simulated replies with streaming and contextual turn count. `/fail` intentionally returns a failed task for demo and verification. `approval-demo` pauses before executing a simulated local plan, explicit approve/cancel required. Persist sessions/messages/tasks in SQLite, mark interrupted queued/running tasks failed at startup, retain awaiting_approval. Store DB under `.data/` (gitignored).

Opt-in Codex uses a fixed local executable, workspace, model and environment supplied only by the server operator. HTTP bodies cannot override them. Each task starts an ephemeral process, submits session text history through stdin, and publishes completed assistant messages through SSE. Only one real Codex process runs at a time across all sessions; a concurrent request becomes a failed task with a retry-later message, without spawning. CLI diagnostic text never enters the public error response. Existing real sessions remain readable after disabling Codex, but cannot submit tasks.

Interrupted real tasks become failed with `stopUnconfirmed: true` on restart; a restart cannot prove an old process is gone. This marker keeps real execution quarantined across subsequent restarts. Only the local startup environment may acknowledge a manual process check through `RELAYDESK_CODEX_ACK_INTERRUPTED=1`, never an HTTP request. A storage write failure stops active execution and makes subsequent mutation requests return 503 until storage is repaired and the service restarted. Any in-memory failure snapshot explicitly indicates it may not have been saved.

Frontend: React + TypeScript + CSS. User-facing language Chinese, RelayDesk brand. Mobile friendly navigation. Initial no fake seeded user sessions. Empty state prompt cards, mock labels prominent, errors visible. Adapter selector available when creating a new conversation, adapters immutable per conversation. Task list/current status and approval cards. Channel view shows all planned connectors honestly.
