# Local development security

RelayDesk v0.2 is a single-user local prototype. It binds to `127.0.0.1`, validates HTTP Host and Origin, and provides no public authentication or remote deployment configuration. Do not expose its port through a tunnel or reverse proxy before adding device/user authentication and reviewed authorization.

Default execution adapters are simulations. The explicitly enabled Codex adapter launches a configured official CLI directly (no shell), with fixed arguments and a fixed project working directory. It sends the selected conversation history through stdin and uses the CLI's normal ChatGPT login. It does not read or copy credentials or accept executable paths, model names, environment variables, or extra arguments over HTTP. Other providers and message connectors remain unimplemented.

The Codex adapter disables shell, plugins, browser and related capabilities and requests a read-only sandbox. These controls are not a complete file-read isolation boundary. It is restricted to a trusted local operator; do not forward untrusted channel content or expose this API remotely. Authentication/compatibility errors fail closed without API-key fallback, automatic login, update, or retry. Output limits, timeouts and process-exit confirmation constrain the subprocess lifecycle. Raw provider diagnostics are not returned to the browser.

A detached CLI may survive an abrupt server crash. Interrupted real tasks and unconfirmed stops quarantine real execution across restarts. After manually verifying the old process has stopped, the local operator may acknowledge that check with `RELAYDESK_CODEX_ACK_INTERRUPTED=1` for one startup; never leave that acknowledgement permanently enabled. No HTTP route can acknowledge it, and stored PIDs are not used to kill processes. Persistent storage failures stop active execution, reject further writes, and require storage repair followed by restart; an in-memory status is not a guarantee it was saved.

Conversation data is stored unencrypted in `.data/` on the local machine. Protect it using your operating system's permissions and disk encryption. Do not upload that folder, `.env`, logs, or real message samples. This repository only includes synthetic test inputs and a secret-free `.env.example`.

Remote integration needs explicit identity, scoped device pairing, transport encryption, replay protection, rate and storage limits, audit retention, and exact-action approvals. A local demo approval must not be reused as approval for future external actions.

To report a vulnerability, use the repository's private vulnerability reporting feature if enabled. Do not put secrets or private conversation data into public issues.
