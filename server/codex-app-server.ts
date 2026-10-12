import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio, SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { EngineBinding, EngineDriver, ExecutionContext, NativeActivityKind, NativeApproval, NativeApprovalDecision, NativeRecovery } from '../shared/types.ts';
import { codexEnvironment } from './codex-adapter.ts';
import { JsonRpcPeer } from './json-rpc.ts';
import type { RpcId } from './json-rpc.ts';

type RecordValue = Record<string, unknown>;
type SpawnProcess = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
type VersionProbe = (executable: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string; error?: unknown; signal?: string | null };
export interface CodexAppServerOptions {
  executable: string;
  workspace: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  requestTimeoutMs?: number;
  interruptTimeoutMs?: number;
  killGraceMs?: number;
  stopConfirmationMs?: number;
  maxOutputBytes?: number;
  /** Local operator option only. Never accepted from a browser or persisted approval. */
  environmentAccess?: boolean;
  /** Internal offline test ports. */
  spawnProcess?: SpawnProcess;
  versionProbe?: VersionProbe;
}

/** A native turn may have been accepted. Recovery must inspect its exact ID, never resubmit. */
export class NativeOutcomeUnknownError extends Error {}

const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'image_generation', 'multi_agent', 'multi_agent_v2', 'hooks', 'skill_mcp_dependency_install', 'tool_suggest', 'workspace_dependencies', 'memories', 'shell_snapshot', 'shell_snapshot_v2'];
const restrictions: RecordValue = {
  web_search: 'disabled', project_doc_max_bytes: 0, history: { persistence: 'none' }, notify: [],
  shell_environment_policy: { inherit: 'none' }, forced_login_method: 'chatgpt',
  agents: { enabled: false }, approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'read-only', allow_login_shell: false, model_provider: 'openai',
  openai_base_url: '', chatgpt_base_url: 'https://chatgpt.com/backend-api/',
};
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const rpcKey = (id: RpcId) => `${typeof id}:${id}`;
const safeFailure = 'Codex 原生协议请求失败；请在本机检查 CLI 配置、登录、模型与网络。';
const uncertain = '无法确认 Codex 原生任务结果；请查询原会话状态，不要自动重新提交消息。';
const activityNotifications: Readonly<Record<string, NativeActivityKind>> = {
  'item/reasoning/summaryTextDelta': 'reasoning',
  'item/reasoning/summaryPartAdded': 'reasoning',
  'item/reasoning/textDelta': 'reasoning',
  'item/commandExecution/outputDelta': 'command',
  'item/commandExecution/terminalInteraction': 'command',
  'item/fileChange/outputDelta': 'file-change',
};

export function codexAppServerArguments(disabledMcpNames: string[] = []): string[] {
  // 0.162.1 splits override paths on literal dots; it does not parse quoted TOML keys.
  if (disabledMcpNames.some(name => !/^[A-Za-z0-9_-]{1,256}$/.test(name))) throw new Error('MCP 名称无法安全用于本机临时配置，原生驱动已暂停。');
  const config = [
    'web_search="disabled"', 'project_doc_max_bytes=0', 'history.persistence="none"', 'notify=[]',
    'shell_environment_policy.inherit="none"', 'forced_login_method="chatgpt"', 'agents.enabled=false',
    'approval_policy="on-request"', 'approvals_reviewer="user"', 'sandbox_mode="read-only"', 'allow_login_shell=false', 'model_provider="openai"',
    'openai_base_url=""', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
  ];
  return [...disabled.flatMap(feature => ['--disable', feature]), ...config.flatMap(value => ['-c', value]), ...disabledMcpNames.flatMap(name => ['-c', `mcp_servers.${name}.enabled=false`]), 'app-server', '--strict-config', '--listen', 'stdio://'];
}

interface PendingApproval {
  view: NativeApproval;
  fingerprint: string;
  replied: boolean;
  writing?: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}
interface ActiveRun {
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  closed: boolean;
  closedPromise: Promise<void>;
  queue: Promise<void>;
  context?: ExecutionContext;
  threadId?: string;
  turnId?: string;
  turnActive: boolean;
  turnResponseVerified: boolean;
  pendingActivities: NativeActivityKind[];
  activityQueue: Promise<void>;
  submitted: boolean;
  terminal?: NativeRecovery;
  failure?: Error;
  finished: Promise<NativeRecovery>;
  finish: (result: NativeRecovery) => void;
  fail: (error: Error) => void;
  approvals: Map<string, PendingApproval>;
  messages: Map<string, string>;
  completedMessages: Set<string>;
  fileChanges: Map<string, { path: string; diff: string }[]>;
  commands: Map<string, { command: string; cwd: string }>;
  interrupted: boolean;
  interruptSent: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  interruptTimeout?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  stopping?: Promise<void>;
}

/** Native JSON-RPC over private stdio, with one bounded process per turn or recovery. */
export function createCodexAppServerDriver(options: CodexAppServerOptions): EngineDriver {
  if (!isAbsolute(options.executable) || !isAbsolute(options.workspace)) throw new Error('Codex App Server paths must be absolute.');
  if (options.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.model)) throw new Error('Invalid local Codex model identifier.');
  accessSync(options.executable, constants.X_OK);
  mkdirSync(options.workspace, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(options.workspace);
  const env = { ...codexEnvironment(options.env ?? process.env), CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' };
  try {
    const version = (options.versionProbe ?? spawnSync)(options.executable, ['--version'], { cwd: workspace, env, encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: 4096, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    if (version.status !== 0 || version.error || version.signal || version.stdout.trim() !== 'codex-cli 0.162.1') throw new Error();
  } catch { throw new Error('原生驱动仅支持已验证的 Codex CLI 0.162.1；无法确认当前本地版本。'); }
  const spawnProcess = options.spawnProcess ?? ((file, args, settings) => spawn(file, args, { ...settings, stdio: 'pipe' }));
  const approvals = new Map<string, { active: ActiveRun; pending: PendingApproval }>();
  let active: ActiveRun | undefined;
  let busy = false;
  let closing = false;
  let quarantined = false;

  function insideWorkspace(path: string): boolean {
    const absolute = resolve(workspace, path);
    const contained = (candidate: string) => { const suffix = relative(workspace, candidate); return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix); };
    if (!contained(absolute)) return false;
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
    try { return contained(realpathSync(existing)); } catch { return false; }
  }
  function validateBinding(binding: EngineBinding) {
    if (binding.driverId !== 'codex-app-server' || binding.version !== '0.162.1' || !identifier(binding.threadId) || resolve(binding.workspace) !== workspace) throw new Error('原生会话绑定与本地驱动配置不匹配。');
  }
  function fail(run: ActiveRun, message = safeFailure) {
    if (run.failure || run.terminal) return;
    run.failure = run.submitted ? new NativeOutcomeUnknownError(message === safeFailure ? uncertain : message) : new Error(message);
    run.fail(run.failure);
  }
  function enqueue(run: ActiveRun, operation: () => Promise<void>) {
    run.queue = run.queue.then(operation).catch(() => { fail(run, run.submitted ? uncertain : safeFailure); });
  }
  async function activity(context: ExecutionContext | undefined, kind: NativeActivityKind) {
    // Only fixed metadata crosses this callback; native reasoning and tool payloads stay out.
    try { await context?.native?.onActivity?.(kind); }
    catch { throw new Error(safeFailure); }
  }
  async function turnActivity(run: ActiveRun, kind: NativeActivityKind) {
    if (run.failure) throw run.failure;
    if (!run.turnResponseVerified) {
      // Native notifications may precede the response proving which turn was submitted.
      if (run.pendingActivities.length === 16) run.pendingActivities.shift();
      run.pendingActivities.push(kind);
      return;
    }
    run.activityQueue = run.activityQueue.then(() => activity(run.context, kind));
    await run.activityQueue;
  }
  async function verifyTurnActivities(run: ActiveRun) {
    if (run.failure) throw run.failure;
    run.turnResponseVerified = true;
    for (const kind of run.pendingActivities.splice(0)) run.activityQueue = run.activityQueue.then(() => activity(run.context, kind));
    try { await run.activityQueue; }
    catch { throw new NativeOutcomeUnknownError(uncertain); }
  }
  function eventScope(run: ActiveRun, params: RecordValue): boolean {
    return params.threadId === run.threadId && identifier(params.turnId) && (!run.turnId || params.turnId === run.turnId);
  }
  async function bindTurn(run: ActiveRun, turnId: unknown, activeEvidence = false) {
    if (!identifier(turnId) || (run.turnId && run.turnId !== turnId)) throw new Error('Unexpected turn identity');
    if (activeEvidence) run.turnActive = true;
    if (!run.turnId) { run.turnId = turnId; await run.context?.native?.onTurn(turnId); }
    if (run.interrupted && activeEvidence) void interrupt(run);
  }
  async function resolveApproval(run: ActiveRun, pending: PendingApproval) {
    clearTimeout(pending.timer);
    approvals.delete(pending.view.id);
    await run.context?.native?.onApprovalResolved(pending.view.id);
  }
  async function expireApprovals(run: ActiveRun) {
    await Promise.all([...run.approvals.values()].flatMap(pending => pending.writing ? [pending.writing] : []));
    for (const pending of run.approvals.values()) if (approvals.has(pending.view.id)) await resolveApproval(run, pending);
  }
  async function upsert(run: ActiveRun, itemId: string, text: string, complete: boolean) {
    if (Buffer.byteLength(text) > 128 * 1024) throw new Error('Assistant output bound');
    const total = [...run.messages].reduce((bytes, [id, content]) => bytes + (id === itemId ? 0 : Buffer.byteLength(content)), Buffer.byteLength(text));
    if (total > 256 * 1024) throw new Error('Assistant output bound');
    if (run.messages.get(itemId) !== text || !run.messages.has(itemId)) {
      run.messages.set(itemId, text);
      await run.context?.native?.upsertMessage(itemId, text);
    }
    if (complete) run.completedMessages.add(itemId);
  }
  function changes(value: unknown): { path: string; diff: string }[] {
    if (!Array.isArray(value) || value.length > 50) throw new Error('Invalid file changes');
    return value.map(change => {
      if (!record(change) || typeof change.path !== 'string' || typeof change.diff !== 'string' || change.path.length > 4096 || Buffer.byteLength(change.diff) > 128 * 1024 || (record(change.kind) && change.kind.move_path != null)) throw new Error('Invalid or unsupported moved change');
      return { path: change.path, diff: change.diff };
    });
  }
  async function item(run: ActiveRun, value: unknown, completed: boolean) {
    if (!record(value) || !identifier(value.id) || typeof value.type !== 'string') throw new Error('Invalid item');
    if (value.type === 'agentMessage') {
      if (typeof value.text !== 'string') throw new Error('Invalid message');
      await turnActivity(run, 'answering');
      if (completed || !run.messages.has(value.id)) await upsert(run, value.id, value.text, completed);
    } else if (value.type === 'fileChange') {
      run.fileChanges.set(value.id, changes(value.changes));
      await turnActivity(run, 'file-change');
    } else if (value.type === 'commandExecution') {
      if (typeof value.command !== 'string' || typeof value.cwd !== 'string') throw new Error('Invalid command');
      run.commands.set(value.id, { command: value.command, cwd: value.cwd });
      await turnActivity(run, 'command');
    } else if (value.type === 'reasoning') await turnActivity(run, 'reasoning');
    else if (!['userMessage', 'plan', 'contextCompaction', 'sleep'].includes(value.type)) throw new Error('Unsupported native tool');
  }
  async function notification(run: ActiveRun, method: string, value: unknown) {
    if (run.failure || run.terminal) return;
    if (!record(value)) throw new Error('Invalid notification');
    if (method === 'remoteControl/status/changed') {
      if (value.status !== 'disabled') throw new Error('Remote control must remain disabled');
      return;
    }
    if (method === 'account/updated') {
      if (value.authMode !== 'chatgpt') throw new Error('Only the existing ChatGPT login is supported');
      return;
    }
    if (method === 'configWarning' || method === 'deprecationNotice') {
      if (typeof value.summary !== 'string') throw new Error('Invalid diagnostic notification');
      return;
    }
    if (method === 'thread/goal/cleared' || method === 'thread/goal/updated') {
      if (!identifier(value.threadId) || (method === 'thread/goal/updated' && (!record(value.goal) || value.goal.threadId !== value.threadId || (value.turnId != null && !identifier(value.turnId))))) throw new Error('Invalid goal metadata');
      return;
    }
    if (method === 'thread/environment/connected' || method === 'thread/environment/disconnected') {
      if (!options.environmentAccess || !identifier(value.threadId) || !identifier(value.environmentId)) throw new Error('Unexpected environment lifecycle');
      return;
    }
    if (method === 'serverRequest/resolved') {
      if (value.threadId !== run.threadId || (typeof value.requestId !== 'string' && typeof value.requestId !== 'number')) return;
      const pending = run.approvals.get(rpcKey(value.requestId));
      if (pending && approvals.has(pending.view.id)) await resolveApproval(run, pending);
      return;
    }
    if (method === 'turn/started') {
      if (value.threadId === run.threadId && run.submitted && record(value.turn)) {
        await bindTurn(run, value.turn.id, true);
        await turnActivity(run, 'turn-started');
      }
      return;
    }
    if (method === 'turn/completed') {
      if (value.threadId !== run.threadId || !run.submitted || !record(value.turn)) return;
      const turn = value.turn;
      await bindTurn(run, turn.id);
      if (!['completed', 'interrupted', 'failed'].includes(String(turn.status))) throw new Error('Invalid terminal');
      if (Array.isArray(turn.items)) for (const entry of turn.items) await item(run, entry, true);
      await expireApprovals(run);
      const status = turn.status === 'interrupted' ? 'cancelled' : turn.status as 'completed' | 'failed';
      await run.context?.native?.onTerminal(status, turn.status === 'failed' ? safeFailure : run.timedOut ? '原生任务等待超时，已收到回合停止确认。' : undefined);
      run.terminal = { turnId: run.turnId, status, messages: [...run.messages].map(([itemId, text]) => ({ itemId, text })), ...(turn.status === 'failed' ? { error: safeFailure } : {}) };
      run.finish(run.terminal);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      if (!eventScope(run, value) || !run.submitted) return;
      await bindTurn(run, value.turnId, true);
      if (!identifier(value.itemId) || typeof value.delta !== 'string') throw new Error('Invalid delta');
      await turnActivity(run, 'answering');
      if (!run.completedMessages.has(value.itemId)) await upsert(run, value.itemId, (run.messages.get(value.itemId) ?? '') + value.delta, false);
      return;
    }
    const activityKind = Object.hasOwn(activityNotifications, method) ? activityNotifications[method] : undefined;
    if (activityKind) {
      if (!eventScope(run, value) || !run.submitted) return;
      if (!identifier(value.itemId)) throw new Error('Invalid activity identity');
      await bindTurn(run, value.turnId, true);
      await turnActivity(run, activityKind);
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (eventScope(run, value) && run.submitted) { await bindTurn(run, value.turnId, true); await item(run, value.item, method === 'item/completed'); }
      return;
    }
    if (method === 'item/fileChange/patchUpdated') {
      if (!eventScope(run, value) || !run.submitted || !identifier(value.itemId)) return;
      await bindTurn(run, value.turnId, true);
      const updated = changes(value.changes);
      for (const pending of run.approvals.values()) if (!pending.replied && pending.view.itemId === value.itemId && pending.view.kind === 'file-change' && JSON.stringify(updated) !== JSON.stringify(pending.view.changes)) {
        pending.replied = true; await run.peer.respond(pending.view.requestId, { decision: 'decline' }); await resolveApproval(run, pending);
      }
      run.fileChanges.set(value.itemId, updated);
      await turnActivity(run, 'file-change');
      return;
    }
    // These notifications carry lifecycle/diagnostic data, never permissions or final results.
    if (['error', 'warning', 'guardianWarning', 'skills/changed', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'thread/name/updated', 'thread/compacted', 'turn/diff/updated', 'turn/plan/updated', 'item/plan/delta', 'account/rateLimits/updated', 'model/rerouted', 'model/verification', 'model/safetyBuffering/updated'].includes(method)) return;
    throw new Error('Unsupported notification');
  }
  async function serverRequest(run: ActiveRun, requestId: RpcId, method: string, value: unknown) {
    if (run.failure || run.terminal) { run.peer.rejectRequest(requestId); return; }
    if (!record(value) || !run.submitted || !eventScope(run, value) || !identifier(value.turnId) || !identifier(value.itemId)) { run.peer.rejectRequest(requestId); throw new Error('Approval identity mismatch'); }
    await bindTurn(run, value.turnId, true);
    if (method === 'item/permissions/requestApproval') { await run.peer.respond(requestId, { permissions: {}, scope: 'turn' }); return; }
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') { run.peer.rejectRequest(requestId); throw new Error('Unsupported request'); }
    const key = rpcKey(requestId);
    const fingerprint = JSON.stringify([method, value]);
    const duplicate = run.approvals.get(key);
    if (duplicate) { if (duplicate.fingerprint !== fingerprint) throw new Error('Changed approval request'); return; }
    const kind = method === 'item/commandExecution/requestApproval' ? 'command' : 'file-change';
    const command = typeof value.command === 'string' ? value.command : run.commands.get(value.itemId)?.command;
    const cwd = typeof value.cwd === 'string' ? value.cwd : run.commands.get(value.itemId)?.cwd;
    const fileChanges = kind === 'file-change' ? run.fileChanges.get(value.itemId) : undefined;
    const unsafeExtras = ['additionalPermissions', 'networkApprovalContext', 'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments', 'grantRoot'].some(key => value[key] != null);
    const completePreview = kind === 'command'
      ? !!command && !!cwd && resolve(cwd) === workspace && insideWorkspace(cwd) && (value.kind == null || value.kind === 'command')
      : !!fileChanges?.length && fileChanges.every(change => insideWorkspace(change.path));
    const supported: NativeApprovalDecision[] = ['accept', 'decline', 'cancel'];
    const allowedDecisions = supported.filter(decision => (!Array.isArray(value.availableDecisions) || value.availableDecisions.includes(decision)) && (decision !== 'accept' || (options.environmentAccess === true && completePreview && !unsafeExtras)));
    if (!allowedDecisions.length) { run.peer.rejectRequest(requestId); throw new Error('No supported decision'); }
    const timestamp = Date.now();
    const view: NativeApproval = {
      id: randomUUID(), kind, requestId, threadId: run.threadId!, turnId: run.turnId!, itemId: value.itemId,
      operation: kind === 'command' ? value.kind === 'writeStdin' ? '向运行中的进程输入内容（本版仅支持拒绝或取消）' : command ?? '命令预览不完整（不能批准）' : '原生文件变更',
      ...(cwd ? { cwd } : {}), ...(fileChanges ? { changes: structuredClone(fileChanges) } : {}),
      allowedDecisions, status: 'pending', createdAt: new Date(timestamp).toISOString(), expiresAt: new Date(timestamp + (options.approvalTimeoutMs ?? 120_000)).toISOString(),
    };
    const pending: PendingApproval = { view, fingerprint, replied: false, timer: setTimeout(() => {
      enqueue(run, async () => {
        if (!approvals.has(view.id) || pending.replied) return;
        pending.replied = true;
        await run.peer.respond(requestId, { decision: allowedDecisions.includes('cancel') ? 'cancel' : 'decline' });
        await resolveApproval(run, pending);
        run.timedOut = true; await interrupt(run);
      });
    }, options.approvalTimeoutMs ?? 120_000) };
    run.approvals.set(key, pending); approvals.set(view.id, { active: run, pending });
    await run.context!.native!.onApproval(structuredClone(view));
  }
  function connect(context?: ExecutionContext, disabledMcpNames: string[] = []): ActiveRun {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnProcess(options.executable, codexAppServerArguments(disabledMcpNames), { cwd: workspace, env, shell: false, detached: process.platform !== 'win32', windowsHide: true }); }
    catch { throw new Error('无法启动本地 Codex App Server。'); }
    let markClosed!: () => void;
    let finish!: (result: NativeRecovery) => void;
    let reject!: (error: Error) => void;
    const run = {
      child, closed: false, closedPromise: new Promise<void>(resolve => { markClosed = resolve; }),
      queue: Promise.resolve(), context, submitted: false, turnActive: false,
      turnResponseVerified: false, pendingActivities: [] as NativeActivityKind[], activityQueue: Promise.resolve(),
      finished: new Promise<NativeRecovery>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; }),
      finish: (result: NativeRecovery) => finish(result), fail: (error: Error) => reject(error),
      approvals: new Map(), messages: new Map(), completedMessages: new Set(), fileChanges: new Map(), commands: new Map(),
      interrupted: false, interruptSent: false, timedOut: false,
    } as ActiveRun;
    void run.finished.catch(() => {});
    child.once('close', () => { run.closed = true; markClosed(); });
    run.peer = new JsonRpcPeer(child, {
      requestTimeoutMs: options.requestTimeoutMs ?? 20_000, maxOutputBytes: options.maxOutputBytes ?? 2 * 1024 * 1024,
      onRequest: (id, method, params) => enqueue(run, () => serverRequest(run, id, method, params)),
      onNotification: (method, params) => enqueue(run, () => notification(run, method, params)),
      onFailure: () => enqueue(run, async () => { fail(run); }),
    });
    return run;
  }
  async function initialize(run: ActiveRun, disabledMcpNames?: string[]): Promise<string[]> {
    await run.peer.request('initialize', { clientInfo: { name: 'relaydesk', title: 'RelayDesk', version: '0.3.0' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
    run.peer.notify('initialized');
    const result = await run.peer.request('config/read', { cwd: workspace, includeLayers: false });
    // Config can include credentials: inspect structure only; never log, persist or expose it.
    if (!record(result) || !record(result.config)) throw new Error('无法验证原生驱动的本机配置。');
    const config = result.config;
    if (config.mcp_servers != null && !record(config.mcp_servers)) throw new Error('无法核验本机 MCP 配置，原生驱动已暂停。');
    const servers = record(config.mcp_servers) ? config.mcp_servers : {};
    const names = Object.keys(servers);
    if (names.length > 64 || names.some(name => !/^[A-Za-z0-9_-]{1,256}$/.test(name))) throw new Error('本机 MCP 名称超出安全临时覆盖范围，原生驱动已暂停。');
    if (disabledMcpNames && names.some(name => !disabledMcpNames.includes(name) || !record(servers[name]) || servers[name].enabled !== false)) throw new Error('当前进程的 MCP 禁用配置未完全生效，已停止启动会话。');
    const flagOff = (value: unknown) => value === false || (record(value) && value.enabled === false);
    if (!record(config.features) || disabled.some(feature => !flagOff((config.features as RecordValue)[feature])) || !Array.isArray(config.notify) || config.notify.length || !record(config.agents) || config.agents.enabled !== false || !record(config.shell_environment_policy) || config.shell_environment_policy.inherit !== 'none' || (config.shell_environment_policy.set != null && (!record(config.shell_environment_policy.set) || Object.keys(config.shell_environment_policy.set).length)) || config.forced_login_method !== 'chatgpt' || config.model_provider !== 'openai' || (config.openai_base_url != null && config.openai_base_url !== '') || config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/' || config.web_search !== 'disabled' || config.allow_login_shell !== false) throw new Error('本机原生驱动隔离配置未生效，已停止启动会话。');
    await run.queue;
    if (run.failure) throw run.failure;
    return names;
  }
  async function prepare(run: ActiveRun, context?: ExecutionContext): Promise<ActiveRun> {
    const names = await initialize(run);
    if (!names.length) return run;
    await stop(run);
    const isolated = connect(context, names);
    active = isolated;
    try { await initialize(isolated, names); return isolated; }
    catch (error) { await stop(isolated); throw error; }
  }
  function verifyThread(value: unknown, expectedId?: string): string {
    if (!record(value) || !record(value.thread) || !identifier(value.thread.id) || (expectedId && value.thread.id !== expectedId) || value.cwd !== workspace || value.approvalPolicy !== 'on-request' || value.approvalsReviewer !== 'user' || !record(value.sandbox) || value.sandbox.type !== 'readOnly' || value.sandbox.networkAccess === true) throw new Error('原生会话的有效权限或身份与本地限制不符。');
    if (options.model && value.model !== options.model) throw new Error('原生会话使用的模型与本地配置不符。');
    if (value.thread.ephemeral === true) throw new Error('原生会话未持久化，无法安全恢复。');
    if (record(value.thread.status) && value.thread.status.type === 'active') throw new NativeOutcomeUnknownError('原生会话仍有执行中的任务；请先查询并确认已有回合状态。');
    return value.thread.id;
  }
  async function interrupt(run: ActiveRun) {
    run.interrupted = true;
    if (!run.submitted || run.terminal || run.failure) return;
    // A turn/start response allocates an ID; only native activity proves it is interruptible.
    // The same bounded deadline also covers cancellation before that activity is observed.
    run.interruptTimeout ??= setTimeout(() => fail(run, uncertain), options.interruptTimeoutMs ?? 10_000);
    if (!run.turnActive || !run.turnId || !run.threadId || run.interruptSent) return;
    run.interruptSent = true;
    try { await run.peer.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }); }
    catch { fail(run, uncertain); }
  }
  function stop(run: ActiveRun): Promise<void> {
    run.stopping ??= stopOnce(run);
    return run.stopping;
  }
  async function stopOnce(run: ActiveRun) {
    clearTimeout(run.timeout); clearTimeout(run.interruptTimeout);
    for (const pending of run.approvals.values()) { clearTimeout(pending.timer); approvals.delete(pending.view.id); }
    run.peer.dispose();
    if (!run.closed) run.child.stdin.end();
    const exited = async (ms: number) => { await Promise.race([run.closedPromise, delay(ms)]); return run.closed; };
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && run.child.pid) process.kill(-run.child.pid, signal); else run.child.kill(signal); }
      catch { try { run.child.kill(signal); } catch { /* Confirm via close only. */ } }
    };
    if (!run.closed && !await exited(options.killGraceMs ?? 250)) {
      kill('SIGTERM');
      if (!await exited(options.killGraceMs ?? 250)) { kill('SIGKILL'); await exited(options.stopConfirmationMs ?? 1000); }
    }
    if (!run.closed) { quarantined = true; throw new NativeOutcomeUnknownError('无法确认 Codex App Server 已停止；原生驱动已暂停，请检查本机进程。'); }
  }
  function available() {
    if (closing || quarantined) throw new Error('原生驱动已关闭或暂停；请检查本机进程。');
    if (busy) throw new Error('已有原生任务或恢复查询正在执行，请稍后重试。');
  }
  return {
    info: { id: 'codex-app-server', name: 'Codex App Server', kind: 'cli', available: true, description: '官方原生会话与审批协议；本地受限配置，实际可用性取决于当前登录与模型权限。' },
    async execute(context) {
      available();
      if (!context.native || context.task.mode !== 'chat') throw new Error('原生驱动仅接受具有持久会话绑定的聊天任务。');
      if (context.signal.aborted) throw new Error('原生任务已取消。');
      if (context.native.binding) validateBinding(context.native.binding);
      busy = true;
      let run: ActiveRun | undefined;
      const abort = () => { if (run) void interrupt(run); };
      try {
        await activity(context, 'connecting');
        if (context.signal.aborted) throw new Error('原生任务已取消。');
        run = connect(context); active = run;
        context.signal.addEventListener('abort', abort, { once: true });
        run = await prepare(run, context); active = run;
        if (context.signal.aborted) throw new Error('原生任务已取消。');
        const binding = context.native.binding;
        const settings = { cwd: workspace, model: options.model, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', config: restrictions };
        const response = await run.peer.request(binding ? 'thread/resume' : 'thread/start', {
          ...settings,
          ...(binding ? { threadId: binding.threadId } : { ephemeral: false, historyMode: 'legacy', ...(!options.environmentAccess ? { environments: [] } : {}) }),
        });
        await run.queue;
        if (run.failure) throw run.failure;
        run.threadId = verifyThread(response, binding?.threadId);
        try { await context.native.onBinding({ driverId: 'codex-app-server', threadId: run.threadId, workspace, version: '0.162.1' }); }
        catch { throw new Error('无法保存原生会话绑定，尚未提交消息。'); }
        await run.queue;
        if (run.failure) throw run.failure;
        await activity(context, 'thread-ready');
        await run.queue;
        if (run.failure) throw run.failure;
        if (context.signal.aborted) throw new Error('原生任务已取消。');
        run.timeout = setTimeout(() => { run!.timedOut = true; void interrupt(run!); }, options.timeoutMs ?? 120_000);
        run.submitted = true;
        const started = await run.peer.request('turn/start', {
          threadId: run.threadId, input: [{ type: 'text', text: context.task.prompt }], clientUserMessageId: context.task.id,
          cwd: workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false },
          ...(!options.environmentAccess ? { environments: [] } : {}),
        });
        if (!record(started) || !record(started.turn)) throw new Error('Invalid turn response');
        await bindTurn(run, started.turn.id);
        await verifyTurnActivities(run);
        await run.finished;
        await run.queue;
      } catch (error) {
        if (run?.submitted && !run.terminal) throw error instanceof NativeOutcomeUnknownError ? error : new NativeOutcomeUnknownError(uncertain);
        throw error instanceof Error ? error : new Error(safeFailure);
      } finally {
        context.signal.removeEventListener('abort', abort);
        try { if (run) await stop(run); } finally { active = undefined; busy = false; }
      }
    },
    async decideApproval(id, decision) {
      const entry = approvals.get(id);
      if (!entry || entry.active !== active || entry.pending.replied || entry.active.terminal || entry.active.failure) throw new Error('原生审批已失效，不能重放决定。');
      const { active: run, pending } = entry;
      if (!pending.view.allowedDecisions.includes(decision)) throw new Error('此原生审批不允许该决定。');
      pending.replied = true; clearTimeout(pending.timer);
      try {
        pending.writing = run.peer.respond(pending.view.requestId, { decision });
        await pending.writing;
        if (decision === 'cancel') void interrupt(run);
      } catch { fail(run, uncertain); throw new NativeOutcomeUnknownError('审批响应写出状态不明，不会自动重放决定。'); }
    },
    async recover(binding, turnId) {
      available(); validateBinding(binding);
      if (!identifier(turnId)) return { status: 'unknown', messages: [], error: uncertain };
      busy = true;
      let run: ActiveRun | undefined;
      try {
        run = connect(); active = run;
        run = await prepare(run); active = run;
        const response = await run.peer.request('thread/read', { threadId: binding.threadId, includeTurns: true });
        if (!record(response) || !record(response.thread) || response.thread.id !== binding.threadId || !Array.isArray(response.thread.turns)) throw new Error('Invalid recovery');
        const turn = response.thread.turns.find(turn => record(turn) && turn.id === turnId);
        if (!record(turn) || !Array.isArray(turn.items)) return { turnId, status: 'unknown', messages: [], error: uncertain };
        const messages = turn.items.filter(item => record(item) && item.type === 'agentMessage' && identifier(item.id) && typeof item.text === 'string').map(item => ({ itemId: item.id as string, text: item.text as string }));
        const status = turn.status === 'interrupted' ? 'cancelled' : turn.status === 'inProgress' ? 'running' : turn.status === 'completed' || turn.status === 'failed' ? turn.status : 'unknown';
        return { turnId, status, messages, ...(status === 'failed' ? { error: safeFailure } : status === 'unknown' ? { error: uncertain } : {}) };
      } catch { return { turnId, status: 'unknown', messages: [], error: uncertain }; }
      finally { try { if (run) await stop(run); } finally { active = undefined; busy = false; } }
    },
    async close() {
      closing = true;
      if (active) { fail(active, uncertain); await stop(active); }
    },
  };
}

export function createCodexAppServerDriverFromEnvironment(env: NodeJS.ProcessEnv, workspace: string): EngineDriver | undefined {
  if (env.RELAYDESK_ENABLE_CODEX_APP_SERVER !== '1') return undefined;
  const executable = env.RELAYDESK_CODEX_PATH;
  if (!executable) throw new Error('RELAYDESK_CODEX_PATH is required for the native driver.');
  return createCodexAppServerDriver({ executable, workspace, model: env.RELAYDESK_CODEX_MODEL, env, environmentAccess: env.RELAYDESK_CODEX_NATIVE_ENVIRONMENT === '1' });
}
