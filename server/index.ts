import { resolve } from 'node:path';
import { createApp } from './app.ts';
import { createCodexAdapterFromEnvironment } from './codex-adapter.ts';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const codex = createCodexAdapterFromEnvironment(process.env, resolve('.data/codex-workspace'));
const app = createApp({
  dbPath: resolve('.data/relaydesk.sqlite'), staticDir: resolve('dist'), codex,
  acknowledgeInterruptedCodex: process.env.RELAYDESK_CODEX_ACK_INTERRUPTED === '1',
});
app.server.listen(port, '127.0.0.1', () => {
  console.log(`RelayDesk local server: http://127.0.0.1:${port}`);
  console.log(codex ? 'Official Codex CLI configured for restricted read-only conversations. Check the UI for availability or restart isolation. Account rules and limits apply.' : 'Mock adapters only. Enable Codex explicitly in local startup configuration.');
  console.log('No external messaging connector or public listener is enabled.');
});
app.server.on('error', error => { console.error(error.message); process.exitCode = 1; void app.close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
