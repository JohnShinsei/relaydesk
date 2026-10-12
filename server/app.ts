import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { Bootstrap, ExecutionAdapter, TaskMode } from '../shared/types.ts';
import { adapterCatalog } from './adapters.ts';
import { HttpError, TaskEngine } from './engine.ts';
import { InboxService } from './inbox.ts';
import type { PrepareInboxReply, SendInboxReply } from '../shared/inbox.ts';

const maxBodyBytes = 32 * 1024;
const loopbackNames = new Set(['localhost', '127.0.0.1', '[::1]']);
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const bootstrap: Bootstrap = {
  adapters: adapterCatalog,
  channels: [
    { id: 'web', name: 'RelayDesk Web', status: 'local', description: '当前本地网页聊天入口；仅监听本机回环地址。' },
    { id: 'wechat', name: '微信', status: 'planned', description: '真实微信未接入；工作收件箱仅使用合成演示消息与本地模拟发送。' },
    { id: 'slack', name: 'Slack', status: 'planned', description: '未来通过官方 API 按授权接收消息，回复需明确批准。' },
    { id: 'email', name: 'Email', status: 'planned', description: '未来按邮箱提供商的官方授权方式接收；尚未读取或发送邮件。' },
  ],
  runtime: { mode: 'local', agent: 'Mac 本地模拟执行器', gateway: 'local', version: '0.3.0' },
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function secureRequest(request: IncomingMessage) {
  const host = request.headers.host;
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host)) throw new HttpError(403, '仅接受本机 Host。');
  let hostUrl: URL;
  try { hostUrl = new URL(`http://${host}`); } catch { throw new HttpError(403, '无效的本机 Host 端口。'); }
  const allowedPorts = new Set([String(request.socket.localPort), '5173']);
  if (!allowedPorts.has(hostUrl.port || '80')) throw new HttpError(403, '不支持此本地端口。');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '拒绝跨站请求。');
  const origin = request.headers.origin;
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(403, '无效请求来源。'); }
    if (parsed.protocol !== 'http:' || !loopbackNames.has(parsed.hostname) || !allowedPorts.has(parsed.port || '80') || parsed.origin !== origin) {
      throw new HttpError(403, '仅允许本机前端来源。');
    }
  }
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, '请求必须使用 application/json。');
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > maxBodyBytes) { request.resume(); throw new HttpError(413, '请求正文过大。'); }
  const raw = await new Promise<string>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) { reject(new HttpError(413, '请求正文过大。')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
    request.on('aborted', () => reject(new HttpError(400, '请求已中断。')));
  });
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, '请求正文不是有效 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '请求正文必须是 JSON 对象。');
  return parsed as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, '请求包含不支持的字段。');
}

/** Codex is an optional internal startup dependency, never an HTTP-provided executable. */
export function createApp({ dbPath, delayMs = 65, staticDir = resolve('dist'), codex, acknowledgeInterruptedCodex = false }: { dbPath: string; delayMs?: number; staticDir?: string; codex?: ExecutionAdapter; acknowledgeInterruptedCodex?: boolean }) {
  const engine = new TaskEngine(dbPath, delayMs, codex, { acknowledgeInterruptedCodex });
  const inbox = new InboxService(dbPath, { delayMs });
  const runtimeBootstrap: Bootstrap = { ...bootstrap, adapters: engine.catalog(), runtime: { ...bootstrap.runtime, agent: codex ? 'Mac 本地执行器 · Codex CLI 已配置' : bootstrap.runtime.agent } };
  const listeners = new Map<string, Set<ServerResponse>>();
  const staticFiles = new Map<string, { bytes: Buffer; type: string }>();
  if (existsSync(staticDir)) {
    for (const entry of readdirSync(staticDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !contentTypes[extname(entry.name)]) continue;
      const path = join(entry.parentPath, entry.name);
      staticFiles.set('/' + relative(staticDir, path).split('\\').join('/'), { bytes: readFileSync(path), type: contentTypes[extname(entry.name)] });
    }
  }
  engine.onChange = session => {
    for (const response of listeners.get(session.id) ?? []) {
      // An unread stream cannot grow memory without bound; reconnect receives a fresh snapshot.
      if (response.writableLength > 1024 * 1024) { response.destroy(); continue; }
      response.write(`event: snapshot\ndata: ${JSON.stringify({ session })}\n\n`);
    }
  };
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    void (async () => {
      secureRequest(request);
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); }
      catch { throw new HttpError(400, '无效的请求路径。'); }
      const method = request.method ?? 'GET';
      if (method === 'GET' && pathname === '/api/bootstrap') return json(response, 200, { ...runtimeBootstrap, adapters: engine.catalog() });
      if (method === 'GET' && pathname === '/api/inbox') return json(response, 200, { inbox: inbox.snapshot() });
      if (method === 'POST' && pathname === '/api/inbox/demo') {
        keys(await body(request), []);
        return json(response, 200, { inbox: inbox.seed() });
      }
      if (method === 'POST' && pathname === '/api/inbox/replies') {
        const data = await body(request);
        keys(data, ['threadId', 'sourceMessageId', 'content', 'idempotencyKey', 'demoOutcome']);
        const result = inbox.prepare(data as unknown as PrepareInboxReply);
        return json(response, result.created ? 201 : 200, { reply: result.reply });
      }
      const sendRoute = pathname.match(/^\/api\/inbox\/replies\/([^/]+)\/send$/);
      if (method === 'POST' && sendRoute) {
        const data = await body(request);
        keys(data, ['intent', 'confirmReview']);
        const result = inbox.send(sendRoute[1], data as unknown as SendInboxReply);
        return json(response, result.started ? 202 : 200, { reply: result.reply });
      }
      if (method === 'GET' && pathname === '/api/sessions') return json(response, 200, { sessions: engine.list() });
      if (method === 'POST' && pathname === '/api/sessions') {
        const data = await body(request);
        keys(data, ['adapterId', 'title']);
        if (typeof data.adapterId !== 'string') throw new HttpError(400, '请选择执行适配器。');
        if (data.title !== undefined && (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 80)) throw new HttpError(400, '会话名称必须为 1–80 个字符。');
        return json(response, 201, { session: engine.create(data.adapterId, typeof data.title === 'string' ? data.title.trim() : undefined) });
      }
      const sessionRoute = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(tasks|events))?$/);
      if (sessionRoute) {
        const [, id, suffix] = sessionRoute;
        if (method === 'GET' && !suffix) return json(response, 200, { session: engine.get(id) });
        if (method === 'GET' && suffix === 'events') {
          const session = engine.get(id);
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify({ session })}\n\n`);
          const clients = listeners.get(id) ?? new Set<ServerResponse>();
          clients.add(response);
          listeners.set(id, clients);
          const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
          heartbeat.unref();
          response.on('close', () => { clearInterval(heartbeat); clients.delete(response); if (clients.size === 0) listeners.delete(id); });
          return;
        }
        if (method === 'POST' && suffix === 'tasks') {
          const data = await body(request);
          keys(data, ['prompt', 'mode']);
          if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 8000) throw new HttpError(400, '消息必须为 1–8000 个字符。');
          if (data.mode !== undefined && data.mode !== 'chat' && data.mode !== 'approval-demo') throw new HttpError(400, '不支持此任务模式。');
          return json(response, 202, { task: engine.submit(id, data.prompt.trim(), (data.mode ?? 'chat') as TaskMode) });
        }
      }
      const taskRoute = pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|approve)$/);
      if (method === 'POST' && taskRoute) {
        keys(await body(request), []);
        const [, id, action] = taskRoute;
        return json(response, action === 'approve' ? 202 : 200, { task: action === 'approve' ? engine.approve(id) : engine.cancel(id) });
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'API 路径或请求方法不存在。');
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '不支持此请求方法。');
      const file = staticFiles.get(pathname) ?? (!extname(pathname) ? staticFiles.get('/index.html') : undefined);
      if (!file) throw new HttpError(404, '页面尚未构建或文件不存在。请先运行 npm run build。');
      response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.byteLength, 'Cache-Control': 'no-cache' });
      response.end(method === 'HEAD' ? undefined : file.bytes);
    })().catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      json(response, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : '本地服务遇到错误。' });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      closing ??= (async () => {
        for (const clients of listeners.values()) for (const response of clients) response.end();
        await new Promise<void>((resolveClose, reject) => {
          if (!server.listening) { resolveClose(); return; }
          server.close(error => error ? reject(error) : resolveClose());
          server.closeIdleConnections();
        });
        await inbox.close();
        await engine.close();
      })();
      return closing;
    },
  };
}
