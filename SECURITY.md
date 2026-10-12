# Local development security

RelayDesk v0.1 is a single-user local prototype. It binds to `127.0.0.1`, validates HTTP Host and Origin, and provides no public authentication or remote deployment configuration. Do not expose its port through a tunnel or reverse proxy before adding device/user authentication and reviewed authorization.

All executable adapters are simulations. The server does not spawn AI CLIs, run user-provided commands, access message accounts, or send replies. API requests cannot choose a filesystem working directory. Provider and connector names describe integration boundaries, not connected services.

Conversation data is stored unencrypted in `.data/` on the local machine. Protect it using your operating system's permissions and disk encryption. Do not upload that folder, `.env`, logs, or real message samples. This repository only includes synthetic test inputs and a secret-free `.env.example`.

Remote integration needs explicit identity, scoped device pairing, transport encryption, replay protection, rate and storage limits, audit retention, and exact-action approvals. A local demo approval must not be reused as approval for future external actions.

To report a vulnerability, use the repository's private vulnerability reporting feature if enabled. Do not put secrets or private conversation data into public issues.
