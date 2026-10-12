import { resolve } from 'node:path';
import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
const app = createApp({ dbPath: resolve('.data/relaydesk.sqlite'), staticDir: resolve('dist') });
app.server.listen(port, '127.0.0.1', () => {
  console.log(`RelayDesk local mock server: http://127.0.0.1:${port}`);
  console.log('Mock adapters only. No AI provider, external connector, or public listener is enabled.');
});
app.server.on('error', error => { console.error(error.message); process.exitCode = 1; void app.close(); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
