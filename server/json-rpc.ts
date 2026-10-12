import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export type RpcId = string | number;

export interface JsonRpcOptions {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxOutputBytes?: number;
  onRequest: (id: RpcId, method: string, params: unknown) => void;
  onNotification: (method: string, params: unknown) => void;
  onFailure: (error: Error) => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingWrite {
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PENDING = 32;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const messages = {
  closed: 'RPC transport is closed.',
  io: 'RPC transport connection failed.',
  protocol: 'RPC transport received an invalid message.',
  limit: 'RPC transport exceeded a safety limit.',
  timeout: 'RPC request timed out.',
  remote: 'RPC request was rejected by the server.',
  callback: 'RPC message handler failed.',
  encode: 'RPC message could not be encoded.',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is RpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid RPC transport limit.');
  return value;
}

/** A bounded JSONL peer. The owner alone is responsible for starting/stopping the child. */
export class JsonRpcPeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: JsonRpcOptions;
  private readonly timeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxOutputBytes: number;
  private readonly decoder = new StringDecoder('utf8');
  private readonly idPrefix = `rd-${randomUUID()}-`;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly pendingWrites = new Set<PendingWrite>();
  private requestIndex = 0;
  private outputBytes = 0;
  // Only an unfinished protocol line is retained, never stdout/stderr logs.
  private unfinishedLine = '';
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams, options: JsonRpcOptions) {
    this.child = child;
    this.options = options;
    this.timeoutMs = positiveLimit(options.requestTimeoutMs, 30_000);
    if (this.timeoutMs > 2_147_483_647) throw new Error('Invalid RPC transport limit.');
    this.maxLineBytes = positiveLimit(options.maxLineBytes, 256 * 1024);
    this.maxOutputBytes = positiveLimit(options.maxOutputBytes, 1024 * 1024);
    child.stdout.on('data', this.onStdout);
    child.stderr.on('data', this.onStderr);
    child.stdout.on('end', this.onStdoutEnd);
    child.stdin.on('error', this.onIoError);
    child.stdout.on('error', this.onIoError);
    child.stderr.on('error', this.onIoError);
    child.on('error', this.onIoError);
    child.on('close', this.onClose);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(messages.closed));
    if (this.pending.size >= MAX_PENDING || this.requestIndex >= Number.MAX_SAFE_INTEGER) {
      this.fail(messages.limit);
      return Promise.reject(new Error(messages.limit));
    }
    if (typeof method !== 'string' || method.length === 0) {
      this.fail(messages.protocol);
      return Promise.reject(new Error(messages.protocol));
    }
    const id = `${this.idPrefix}${++this.requestIndex}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(messages.timeout), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    if (typeof method !== 'string' || method.length === 0) {
      this.fail(messages.protocol);
      return;
    }
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error(messages.closed));
    if (!isId(id) || result === undefined) {
      this.fail(messages.protocol);
      return Promise.reject(new Error(messages.protocol));
    }
    if (this.pendingWrites.size >= MAX_PENDING) {
      this.fail(messages.limit);
      return Promise.reject(new Error(messages.limit));
    }
    return new Promise((resolve, reject) => {
      const pending: PendingWrite = {
        reject,
        timer: setTimeout(() => this.fail(messages.timeout), this.timeoutMs),
      };
      this.pendingWrites.add(pending);
      this.write({ id, result }, () => {
        if (!this.pendingWrites.delete(pending)) return;
        clearTimeout(pending.timer);
        resolve();
      });
    });
  }

  rejectRequest(id: RpcId): void {
    if (this.closed) return;
    if (!isId(id)) {
      this.fail(messages.protocol);
      return;
    }
    this.write({ id, error: { code: -32601, message: 'Unsupported RPC request.' } });
  }

  dispose(_error?: Error): void {
    // Caller errors are deliberately never propagated: they may contain raw diagnostics.
    void _error;
    this.shutdown(new Error(messages.closed));
  }

  private readonly onStdout = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (!this.countOutput(buffer.byteLength)) return;
    this.unfinishedLine += this.decoder.write(buffer);
    let newline: number;
    while (!this.closed && (newline = this.unfinishedLine.indexOf('\n')) !== -1) {
      const line = this.unfinishedLine.slice(0, newline);
      this.unfinishedLine = this.unfinishedLine.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.fail(messages.limit);
        return;
      }
      this.receive(line);
    }
    if (!this.closed && Buffer.byteLength(this.unfinishedLine, 'utf8') > this.maxLineBytes) this.fail(messages.limit);
  };

  private readonly onStderr = (chunk: Buffer | string): void => {
    if (this.closed) return;
    this.countOutput(typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength);
  };

  private readonly onStdoutEnd = (): void => {
    if (this.closed) return;
    this.unfinishedLine += this.decoder.end();
    // JSONL records must be newline-terminated; truncation is never accepted as a reply.
    this.fail(this.unfinishedLine.length > 0 ? messages.protocol : messages.io);
  };

  private readonly onIoError = (): void => { this.fail(messages.io); };

  private readonly onClose = (): void => {
    this.fail(messages.io);
    this.removeErrorGuards();
  };

  private countOutput(bytes: number): boolean {
    this.outputBytes += bytes;
    if (this.outputBytes > this.maxOutputBytes) {
      this.fail(messages.limit);
      return false;
    }
    return true;
  }

  private receive(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.fail(messages.protocol); return; }
    if (!isRecord(message) || ('jsonrpc' in message && message.jsonrpc !== '2.0')) {
      this.fail(messages.protocol);
      return;
    }
    if ('method' in message) {
      if (typeof message.method !== 'string' || message.method.length === 0 || 'result' in message || 'error' in message) {
        this.fail(messages.protocol);
        return;
      }
      try {
        if ('id' in message) {
          if (!isId(message.id)) { this.fail(messages.protocol); return; }
          this.options.onRequest(message.id, message.method, message.params);
        } else {
          this.options.onNotification(message.method, message.params);
        }
      } catch { this.fail(messages.callback); }
      return;
    }
    const hasResult = 'result' in message;
    const hasError = 'error' in message;
    if (!isId(message.id) || hasResult === hasError || 'params' in message) {
      this.fail(messages.protocol);
      return;
    }
    if (hasError && (!isRecord(message.error) || !Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string')) {
      this.fail(messages.protocol);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      if (!this.wasIssued(message.id)) this.fail(messages.protocol);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (hasError) pending.reject(new Error(messages.remote));
    else pending.resolve(message.result);
  }

  private wasIssued(id: RpcId): boolean {
    if (typeof id !== 'string' || !id.startsWith(this.idPrefix)) return false;
    const suffix = id.slice(this.idPrefix.length);
    const index = Number(suffix);
    return Number.isSafeInteger(index) && index > 0 && index <= this.requestIndex && String(index) === suffix;
  }

  private write(message: Record<string, unknown>, onWritten?: () => void): void {
    if (this.closed) return;
    let line: string;
    try { line = `${JSON.stringify(message)}\n`; } catch { this.fail(messages.encode); return; }
    if (Buffer.byteLength(line, 'utf8') > MAX_WRITE_BYTES || this.child.stdin.writableLength > MAX_QUEUED_BYTES) {
      this.fail(messages.limit);
      return;
    }
    // JSON.stringify can silently omit a function/symbol or a toJSON() result.
    if ('result' in message && !Object.hasOwn(JSON.parse(line) as object, 'result')) {
      this.fail(messages.encode);
      return;
    }
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded || !this.child.stdin.writable) {
      this.fail(messages.io);
      return;
    }
    try {
      let writeReturned = false;
      let callbackSucceeded = false;
      this.child.stdin.write(line, error => {
        if (error) { this.fail(messages.io); return; }
        callbackSucceeded = true;
        if (writeReturned && !this.closed) onWritten?.();
      });
      if (this.child.stdin.writableLength > MAX_QUEUED_BYTES) this.fail(messages.limit);
      writeReturned = true;
      // Also handle synchronous callbacks without accepting before post-write limits.
      if (callbackSucceeded && !this.closed) onWritten?.();
    } catch { this.fail(messages.io); }
  }

  private fail(message: string): void {
    if (this.closed) return;
    const error = new Error(message);
    this.shutdown(error);
    try { this.options.onFailure(error); } catch { /* Failure reporting cannot revive or crash the peer. */ }
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.unfinishedLine = '';
    this.decoder.end();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const pending of this.pendingWrites) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingWrites.clear();
    this.child.stdout.off('data', this.onStdout);
    this.child.stderr.off('data', this.onStderr);
    this.child.stdout.off('end', this.onStdoutEnd);
    // Keep inert error guards until child close, so delayed pipe errors cannot escape.
    // The owner is responsible for terminating its child after a failure or disposal.
    if (this.child.exitCode !== null || this.child.signalCode !== null) this.removeErrorGuards();
  }

  private removeErrorGuards(): void {
    this.child.stdin.off('error', this.onIoError);
    this.child.stdout.off('error', this.onIoError);
    this.child.stderr.off('error', this.onIoError);
    this.child.off('error', this.onIoError);
    this.child.off('close', this.onClose);
  }
}
