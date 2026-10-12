# Local v0 API contract

Only binds 127.0.0.1. Same origin JSON APIs. All JSON errors: `{ error: string }`.

- `GET /api/bootstrap` → Bootstrap from shared/types.ts. Mock providers available; real Codex and Claude disabled with reasons.
- `GET /api/sessions` → `{ sessions: SessionSummary[] }`, newest updated first.
- `POST /api/sessions` body `{ adapterId, title? }` → `{ session: Session }`, status 201. Reject unavailable/unknown adapter.
- `GET /api/sessions/:id` → `{ session }`.
- `GET /api/sessions/:id/events` → SSE `event: snapshot`, `data: { session }`; initial snapshot immediately; subsequent task changes and chunks. Native EventSource auto reconnect refreshes snapshot. Heartbeat comments.
- `POST /api/sessions/:id/tasks` body `{ prompt, mode?: 'chat' | 'approval-demo' }` → `{ task }`, 202. Prompt 1–8000 chars. Only one active task (queued/running/awaiting_approval) per session, conflict 409. UI keeps polling session list and obtains full selected session through SSE.
- `POST /api/tasks/:id/cancel` body `{}` → `{ task }`. Abort queued/running/waiting only; other transitions conflict 409.
- `POST /api/tasks/:id/approve` body `{}` → `{ task }`, 202. Only awaiting_approval; continue a clearly labeled local simulated action. Never send messages or execute commands.

Default mocks produce deterministic Chinese simulated replies with streaming and contextual turn count. `/fail` intentionally returns a failed task for demo and verification. `approval-demo` pauses before executing a simulated local plan, explicit approve/cancel required. Persist sessions/messages/tasks in SQLite, mark interrupted queued/running tasks failed at startup, retain awaiting_approval. Store DB under `.data/` (gitignored).

Frontend: React + TypeScript + CSS. User-facing language Chinese, RelayDesk brand. Mobile friendly navigation. Initial no fake seeded user sessions. Empty state prompt cards, mock labels prominent, errors visible. Adapter selector available when creating a new conversation, adapters immutable per conversation. Task list/current status and approval cards. Channel view shows all planned connectors honestly.
