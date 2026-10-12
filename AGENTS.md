# RelayDesk development

- Keep this project independent of other local repositories.
- Node.js 24.15+ (24 LTS) or 26+; run `npm run check` for changes to app behavior.
- Keep the default server loopback-only and real providers disabled until explicitly implemented and verified.
- Never load, copy, or publish CLI credentials, account tokens, `.env`, `.data`, or personal messages.
- No shell commands from browser requests. External actions require an explicit scoped approval flow.
- Use official upstream docs for provider capabilities. Distinguish mock, implemented, verified, and planned states.
- Keep public documentation free of machine-specific paths and user data.
