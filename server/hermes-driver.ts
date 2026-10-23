import { setTimeout as delay } from 'node:timers/promises';
import type { EngineBinding, EngineDriver, ExecutionContext, NativeApproval, NativeApprovalDecision, NativeRecovery } from '../shared/types.ts';
import { NativeOutcomeUnknownError } from './execution.ts';

/** Operator-only configuration. Never construct this object from HTTP request data. */
export interface HermesOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  stopConfirmationMs?: number;
}

const protocol = 'hermes-runs-v1';
const unknownMessage = 'Hermes 执行结果未能确认；请核验原任务，不会自动重发。';
const configurationMessage = 'Hermes API 不可用或协议能力不足；请在日本端检查本地配置。';
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unknown = () => new NativeOutcomeUnknownError(unknownMessage);

function checkedOrigin(value: string): string {
  // Validate the original spelling too: URL normalization accepts shorthand IPs and userinfo.
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/i.test(value)) throw new Error('Hermes URL 必须是无路径的本机 HTTP 地址。');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Hermes URL 必须是无路径的本机 HTTP 地址。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Hermes URL 必须是无路径的本机 HTTP 地址。');
  return url.origin;
}

interface Run {
  runId: string; sessionId: string; status: string; output?: string;
  controls?: unknown[]; generation?: number;
}
function readRun(value: Record<string, unknown>, runId: string, binding?: EngineBinding): Run {
  if (value.run_id !== runId || !identifier(value.session_id) || typeof value.status !== 'string') throw unknown();
  if (binding && (binding.driverId !== 'hermes' || binding.version !== protocol || binding.threadId !== value.session_id)) throw unknown();
  if (!['started', 'queued', 'running', 'waiting_for_approval', 'stopping', 'completed', 'cancelled', 'failed', 'interrupted', 'unknown'].includes(value.status)) throw unknown();
  if (value.output !== undefined && typeof value.output !== 'string') throw unknown();
  return {
    runId, sessionId: value.session_id, status: value.status, output: value.output as string | undefined,
    controls: Array.isArray(value.pending_controls) ? value.pending_controls : undefined,
    generation: Number.isSafeInteger(value.execution_generation) ? value.execution_generation as number : undefined,
  };
}
function terminal(run: Run): 'completed' | 'cancelled' | 'failed' | undefined {
  if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') return run.status;
  // An interrupted turn is not a successful result or a confirmed user cancellation.
  if (run.status === 'interrupted') return 'failed';
}
function bindingFor(run: Run): Extract<EngineBinding, { driverId: 'hermes' }> { return { driverId: 'hermes', threadId: run.sessionId, version: protocol }; }
interface Pending {
  approval: NativeApproval; generation: number; runId: string;
  attempted: boolean; decision?: NativeApprovalDecision; result?: Promise<void>;
}

/** Runs API adapter, verified against upstream bf0203a (api_server*_runs.py).
 * No credentials, CLI state, model settings, working directory or local history are read.
 */
export function createHermesDriver(options: HermesOptions): EngineDriver {
  const origin = checkedOrigin(options.baseUrl);
  const loweredKey = options.apiKey.toLowerCase();
  // Mirror upstream has_usable_secret(min_length=16), plus reject whitespace/header injection.
  if (!/^[\x21-\x7e]{16,4096}$/.test(options.apiKey) ||
    ['changeme', 'your_api_key', 'your_api_key_here', 'your-api-key', 'placeholder', 'example', 'dummy', 'null', 'none'].includes(loweredKey) ||
    /^(your[-_]|replace[-_]|change[-_]?me(?:$|[-_]))/.test(loweredKey) || /^(sk-|ghp_|hf_)x+$/.test(loweredKey) || /^x+$/.test(loweredKey.replace(/[-_]/g, ''))) throw new Error('请配置至少 16 字符、非占位符的独立 RELAYDESK_HERMES_API_KEY。');
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const stopConfirmationMs = options.stopConfirmationMs ?? 30_000;
  for (const duration of [requestTimeoutMs, pollIntervalMs, timeoutMs, stopConfirmationMs]) {
    if (!Number.isFinite(duration) || duration < 1 || duration > 2_147_483_647) throw new Error('Hermes 超时配置无效。');
  }
  let active: { controller: AbortController; done: Promise<void>; runId?: string; failure?: Error } | undefined;
  let closed = false;
  let unboundUnknown = false;
  const uncertainRuns = new Set<string>();
  const approvals = new Map<string, Pending>();

  async function request(path: string, body?: Record<string, unknown>, key?: string, limitMs = requestTimeoutMs): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchRequest(origin + path, {
            method: body ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
            headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          if (!response.ok || response.redirected || (response.url && !response.url.startsWith(origin + '/'))) {
            await response.body?.cancel(); throw new Error(configurationMessage);
          }
          if (!response.body) throw new Error(configurationMessage);
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 1024 * 1024) { await reader.cancel(); throw new Error(configurationMessage); }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(configurationMessage);
          return value as Record<string, unknown>;
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(configurationMessage)); }, Math.max(1, Math.min(requestTimeoutMs, limitMs))); }),
      ]);
    } catch { throw new Error(configurationMessage); }
    finally { clearTimeout(timer); }
  }

  async function capabilities() {
    const value = await request('/v1/capabilities');
    const features = record(value.features); const idempotency = record(features.runs_idempotency);
    if (value.object !== 'hermes.api_server.capabilities' || value.platform !== 'hermes-agent' ||
      record(value.auth).type !== 'bearer' || record(value.auth).required !== true ||
      ['run_submission', 'run_status', 'run_stop', 'run_approval_response'].some(name => features[name] !== true) ||
      idempotency.supported !== true || idempotency.durable !== true) throw new Error(configurationMessage);
  }

  async function poll(runId: string, binding?: EngineBinding, remaining?: number) {
    try { return readRun(await request(`/v1/runs/${runId}`, undefined, undefined, remaining), runId, binding); }
    catch { throw unknown(); }
  }

  async function syncApprovals(run: Run, context: ExecutionContext) {
    const native = context.native!;
    if (run.status === 'waiting_for_approval' && (!run.controls?.length || run.generation === undefined)) throw unknown();
    const seen = new Set<string>();
    for (const value of run.controls ?? []) {
      const control = record(value);
      if (control.kind !== 'approval' || !identifier(control.prompt_id) || run.generation === undefined ||
        control.execution_generation !== run.generation || !Array.isArray(control.choices) ||
        !control.choices.includes('once') || !control.choices.includes('deny')) throw unknown();
      // Full native operation text, already redacted by Hermes. Do not invent approval details.
      const command = typeof control.command === 'string' ? control.command : '';
      const description = typeof control.description === 'string' ? control.description : '';
      if (!(command || description).trim() || command.length + description.length > 32_768 || control.edit !== undefined) throw unknown();
      const id = `hermes:${run.runId}:${run.generation}:${control.prompt_id}`;
      seen.add(id);
      if (approvals.has(id)) continue;
      const created = Date.now();
      const ttl = typeof control.timeout_s === 'number' && Number.isFinite(control.timeout_s) && control.timeout_s > 0 ? Math.min(control.timeout_s * 1000, timeoutMs) : timeoutMs;
      const approval: NativeApproval = {
        id, kind: 'tool', requestId: control.prompt_id, threadId: run.sessionId, turnId: run.runId,
        itemId: control.prompt_id, operation: [description, command].filter(Boolean).join('\n'),
        allowedDecisions: ['accept', 'decline'], status: 'pending',
        createdAt: new Date(created).toISOString(), expiresAt: new Date(created + ttl).toISOString(),
      };
      approvals.set(id, { approval, generation: run.generation, runId: run.runId, attempted: false });
      await native.onApproval(approval);
    }
    for (const [id, pending] of approvals) {
      if (pending.runId === run.runId && !seen.has(id)) {
        await native.onApprovalResolved(id); approvals.delete(id);
      }
    }
  }

  const driver: EngineDriver = {
    info: { id: 'hermes', name: 'Hermes · 本机 API', kind: 'http', available: true, description: '本机 Hermes Runs API：任务状态、单次审批、停止确认与只读核验；模型和工具由日本端 Hermes 配置。' },
    async execute(context) {
      if (closed || active || unboundUnknown || uncertainRuns.size) throw new Error('Hermes 有未确认执行或正在执行的任务；请先核验原任务。');
      if (!context.native || context.task.mode !== 'chat') throw new Error('Hermes 需要原生任务上下文，且仅支持真实任务。');
      if (context.signal.aborted) throw new Error('Hermes 任务尚未提交，已取消。');
      const initialBinding = context.native.binding;
      if (initialBinding && (initialBinding.driverId !== 'hermes' || initialBinding.version !== protocol || !identifier(initialBinding.threadId))) throw new Error('Hermes 会话绑定无效。');
      if (!/^[\x21-\x7e]{1,255}$/.test(context.task.id)) throw new Error('Hermes 任务身份无效。');
      const state = { controller: new AbortController(), done: Promise.resolve(), runId: undefined as string | undefined, failure: undefined as Error | undefined };
      active = state;
      const onAbort = () => state.controller.abort();
      context.signal.addEventListener('abort', onAbort, { once: true });
      let submissionAttempted = false;
      const execute = async () => {
        const native = context.native!;
        try {
          await native.onActivity?.('connecting');
          await capabilities();
          if (context.signal.aborted || state.controller.signal.aborted) throw new Error('Hermes 任务尚未提交，已取消。');
          submissionAttempted = true;
          const admission = await request('/v1/runs', { input: context.task.prompt, ...(initialBinding ? { session_id: initialBinding.threadId } : {}) }, context.task.id);
          if (!identifier(admission.run_id)) throw unknown();
          state.runId = admission.run_id;
          await native.onTurn(state.runId);
          await native.onActivity?.('turn-started');
          let binding = initialBinding;
          const deadline = Date.now() + timeoutMs;
          let stopDeadline: number | undefined;
          while (true) {
            if (state.failure) throw state.failure;
            if (state.controller.signal.aborted && stopDeadline === undefined) {
              stopDeadline = Date.now() + stopConfirmationMs;
              const receipt = await request(`/v1/runs/${state.runId}/stop`, {}, undefined, stopConfirmationMs);
              if ((receipt.run_id !== undefined && receipt.run_id !== state.runId) || !['stopping', 'cancelled', 'completed', 'failed', 'interrupted'].includes(String(receipt.status))) throw unknown();
            }
            const remaining = (stopDeadline ?? deadline) - Date.now();
            if (remaining <= 0) throw unknown();
            const run = await poll(state.runId, binding, remaining);
            if (state.failure) throw state.failure;
            if (!binding) { binding = bindingFor(run); await native.onBinding(binding); await native.onActivity?.('thread-ready'); }
            if (run.status === 'unknown') throw unknown();
            const outcome = terminal(run);
            if (outcome) {
              if (run.output) { await native.onActivity?.('answering'); await native.upsertMessage(`${state.runId}:answer`, run.output); }
              await syncApprovals({ ...run, controls: [] }, context);
              await native.onTerminal(outcome, outcome === 'failed' ? 'Hermes 报告任务失败或执行被中断，请核验结果。' : undefined);
              return;
            }
            // A cancellation arriving during GET must reach the stop path, even when
            // that response contains an approval the engine no longer accepts.
            if (state.controller.signal.aborted && !stopDeadline) continue;
            if (!state.controller.signal.aborted) await syncApprovals(run, context);
            if (Date.now() >= deadline && !stopDeadline) throw unknown();
            await delay(Math.min(pollIntervalMs, remaining));
          }
        } catch (error) {
          if (submissionAttempted) {
            if (state.runId) uncertainRuns.add(state.runId); else unboundUnknown = true;
            throw unknown();
          }
          throw error;
        } finally {
          for (const [id, pending] of approvals) if (pending.runId === state.runId) approvals.delete(id);
          context.signal.removeEventListener('abort', onAbort);
          active = undefined;
        }
      };
      state.done = execute();
      await state.done;
    },
    async decideApproval(id, decision) {
      const pending = approvals.get(id);
      if (!pending || !active || active.runId !== pending.runId || !['accept', 'decline'].includes(decision) || Date.now() >= Date.parse(pending.approval.expiresAt)) throw new Error('Hermes 审批无效、已过期或不支持此决定。');
      if (pending.attempted) {
        if (pending.decision !== decision) throw new Error('Hermes 审批决定已提交，不能更改或重发。');
        await pending.result; return;
      }
      pending.attempted = true; pending.decision = decision;
      pending.result = (async () => {
        try {
          const receipt = await request(`/v1/runs/${pending.runId}/approval`, {
            request_id: pending.approval.requestId, execution_generation: pending.generation,
            choice: decision === 'accept' ? 'once' : 'deny',
          });
          // already_resolved means this write did not resolve the prompt: another
          // viewer or a native timeout may have settled it with a different choice.
          if (receipt.run_id !== pending.runId || receipt.prompt_id !== pending.approval.requestId || receipt.status !== 'resolved') throw unknown();
        } catch {
          if (active?.runId === pending.runId) active.failure = unknown();
          uncertainRuns.add(pending.runId); throw unknown();
        }
      })();
      await pending.result;
    },
    async recover(binding, turnId): Promise<NativeRecovery> {
      if (!identifier(turnId) || (binding && (binding.driverId !== 'hermes' || binding.version !== protocol))) return { status: 'unknown', messages: [], error: unknownMessage };
      try {
        const run = await poll(turnId, binding);
        const status = terminal(run);
        if (!status) { uncertainRuns.add(turnId); return { turnId, status: 'unknown', messages: [], binding: bindingFor(run), error: run.status === 'unknown' ? unknownMessage : 'Hermes 原任务尚未确认终止；继续保留未知状态。' }; }
        uncertainRuns.delete(turnId);
        return { turnId, status, binding: bindingFor(run), messages: run.output ? [{ itemId: `${turnId}:answer`, text: run.output }] : [], ...(status === 'failed' ? { error: 'Hermes 报告任务失败或执行被中断，请核验结果。' } : {}) };
      } catch { return { turnId, status: 'unknown', messages: [], error: unknownMessage }; }
    },
    async close() {
      closed = true;
      const state = active;
      if (state) { state.controller.abort(); await state.done.catch(() => {}); }
    },
  };
  return driver;
}

export function createHermesDriverFromEnvironment(env: NodeJS.ProcessEnv): EngineDriver | undefined {
  if (env.RELAYDESK_ENABLE_HERMES !== '1') return undefined;
  if (!env.RELAYDESK_HERMES_API_KEY) throw new Error('请配置独立的 RELAYDESK_HERMES_API_KEY。');
  return createHermesDriver({ baseUrl: env.RELAYDESK_HERMES_URL ?? 'http://127.0.0.1:8642', apiKey: env.RELAYDESK_HERMES_API_KEY });
}
