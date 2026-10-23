import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { mkdirSync, realpathSync, accessSync, constants, statSync, readdirSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountInfo, Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SpawnOptions, SpawnedProcess, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { EngineDriver, ExecutionContext, NativeApproval, NativeApprovalDecision } from '../shared/types.ts';
import { NativeOutcomeUnknownError } from './execution.ts';

const version = '2.1.309';
const unknownText = 'Claude 原任务结果或停止状态尚未确认；不会自动重发，请在本机核验。';
const deniedText = '此工具请求未获本次单次授权。';
const environmentNames = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const;
const readTools = ['Read', 'Glob', 'Grep'];
// Bash remains unavailable until Windows shell/cwd/descendant-stop behavior is verified.
const permittedTools = readTools;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const builtinAgents = new Set(['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup']);
const subscriptionTypes = new Set(['pro', 'max', 'team', 'enterprise', 'claude pro', 'claude max', 'claude team', 'claude enterprise']);
type QueryPort = Pick<Query, 'interrupt' | 'close' | 'initializationResult' | 'accountInfo' | 'reloadPlugins' | 'reloadSkills'> & AsyncIterable<SDKMessage>;
export interface ClaudeSdkPort {
  query: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryPort;
  getSessionMessages: typeof getSessionMessages;
}
export interface ClaudeOptions {
  workspace: string;
  executablePath?: string;
  model?: string;
  environment?: boolean;
  /** Only subscription authentication is implemented. No API-key fallback. */
  authMode?: 'subscription';
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
  stopConfirmationMs?: number;
  sdk?: ClaudeSdkPort;
  spawnProcess?: (options: SpawnOptions) => SpawnedProcess;
  versionProbe?: (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => { status: number | null; stdout: string; error?: unknown; signal?: NodeJS.Signals | null };
}

/** Runtime locations only. Credentials are read by the official CLI, never this application. */
export function claudeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(environmentNames.filter(name => env[name] !== undefined).map(name => [name, env[name]])),
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false', CLAUDE_CODE_USE_POWERSHELL_TOOL: '0',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'relaydesk/0.3.0',
  };
}
function defaultExecutable(): string {
  const require = createRequire(import.meta.url);
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try { return join(dirname(require.resolve(`${name}/package.json`)), process.platform === 'win32' ? 'claude.exe' : 'claude'); }
  catch { throw new Error('SDK 配套 Claude CLI 不可用；请检查固定版本的本机安装。'); }
}
function subscription(account: AccountInfo): boolean {
  // The pinned CLI omits both source fields for a stored subscription login.
  // Never infer authentication from an absent source without a subscription type.
  return account.apiProvider === 'firstParty' && (account.apiKeySource === undefined || account.apiKeySource === 'none') &&
    (account.tokenSource === undefined || account.tokenSource === 'claude.ai') &&
    typeof account.subscriptionType === 'string' && subscriptionTypes.has(account.subscriptionType.toLowerCase());
}
function safeLocalPath(value: string): boolean {
  if (value.includes('\0') || value.startsWith('\\\\') || value.replace(/^[A-Za-z]:/, '').includes(':')) return false;
  return !value.split(/[\\/]/).some(segment => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment));
}
function searchTreeIsPlain(directory: string): boolean {
  const queue = [{ path: directory, depth: 0 }]; let entries = 0;
  try {
    while (queue.length) {
      const current = queue.pop()!;
      if (current.depth > 32) return false;
      for (const entry of readdirSync(current.path, { withFileTypes: true })) {
        if (++entries > 5000 || entry.isSymbolicLink()) return false;
        const child = join(current.path, entry.name); const stat = lstatSync(child);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || realpathSync(child) !== child) return false;
        if (stat.isDirectory()) queue.push({ path: child, depth: current.depth + 1 });
      }
    }
    return true;
  } catch { return false; }
}
function scopedRead(name: string, input: Record<string, unknown>, workspace: string): Record<string, unknown> | undefined {
  const allowed = name === 'Read' ? ['file_path', 'offset', 'limit', 'pages', 'allow_large'] : name === 'Glob' ? ['pattern', 'path'] : ['pattern', 'path', 'glob', 'output_mode', '-B', '-A', '-C', 'context', '-n', '-i', 'type', 'head_limit', 'offset', 'multiline'];
  if (Object.keys(input).some(key => !allowed.includes(key))) return;
  if (name !== 'Read' && (typeof input.pattern !== 'string' || !input.pattern || input.pattern.length > 4096 || input.pattern.includes('\0'))) return;
  if (name === 'Glob' && (isAbsolute(String(input.pattern)) || String(input.pattern).includes('..') || String(input.pattern).includes(':') || String(input.pattern).startsWith('\\\\'))) return;
  const pathField = name === 'Read' ? 'file_path' : 'path';
  const path = input[pathField] ?? (name === 'Read' ? undefined : workspace);
  if (typeof path !== 'string' || !path || !safeLocalPath(path) || (name === 'Read' && !isAbsolute(path))) return;
  let canonical: string;
  try {
    canonical = realpathSync(resolve(workspace, path));
    const rel = relative(workspace, canonical);
    if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) return;
    if (name === 'Read' && !statSync(canonical).isFile()) return;
    if (name === 'Glob' && !statSync(canonical).isDirectory()) return;
    if (name !== 'Read' && statSync(canonical).isDirectory() && !searchTreeIsPlain(canonical)) return;
  } catch { return; }
  for (const key of ['offset', 'limit', '-B', '-A', '-C', 'context', 'head_limit']) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > 100_000)) return;
  for (const key of ['allow_large', '-n', '-i', 'multiline']) if (input[key] !== undefined && typeof input[key] !== 'boolean') return;
  if (input.pages !== undefined && (typeof input.pages !== 'string' || !/^[0-9,-]{1,100}$/.test(input.pages))) return;
  if (input.output_mode !== undefined && !['content', 'files_with_matches', 'count'].includes(String(input.output_mode))) return;
  for (const key of ['glob', 'type']) if (input[key] !== undefined && (typeof input[key] !== 'string' || String(input[key]).length > 256 || String(input[key]).includes('\0'))) return;
  return { ...input, [pathField]: canonical };
}
function unknown() { return new NativeOutcomeUnknownError(unknownText); }
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(unknown()), ms); })]).finally(() => clearTimeout(timer));
}
const denied = (): PermissionResult => ({ behavior: 'deny', message: deniedText, decisionClassification: 'user_reject' });
interface PendingApproval { decision?: NativeApprovalDecision; resolve: (result: PermissionResult) => void; settled: boolean; result: PermissionResult; expiresAt: number; cleanup: () => void; validate: () => boolean }

/** Per-turn local SDK processes; no desktop daemon, credential extraction or prompt retries. */
export function createClaudeDriver(options: ClaudeOptions): EngineDriver {
  if (!isAbsolute(options.workspace) || (options.executablePath !== undefined && !isAbsolute(options.executablePath))) throw new Error('Claude 路径与工作目录必须是本机绝对路径。');
  if (options.authMode !== undefined && options.authMode !== 'subscription') throw new Error('本版本只支持 Claude 订阅登录。');
  if (options.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.model)) throw new Error('Claude 模型标识无效。');
  mkdirSync(options.workspace, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(options.workspace);
  const executable = options.executablePath ?? defaultExecutable();
  accessSync(executable, constants.X_OK);
  const env = claudeEnvironment(options.env ?? process.env);
  let detected: ReturnType<NonNullable<ClaudeOptions['versionProbe']>>;
  try { detected = (options.versionProbe ?? spawnSync)(executable, ['--version'], { env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096 }); }
  catch { throw new Error('无法核验本机 Claude CLI 固定版本。'); }
  if (detected.status !== 0 || detected.error || detected.signal || detected.stdout.trim() !== `${version} (Claude Code)`) throw new Error(`仅支持 Claude Code ${version}；不会自动更新 CLI。`);
  let sdk: ClaudeSdkPort | undefined = options.sdk;
  const sdkPort = async (): Promise<ClaudeSdkPort> => sdk ??= await import('@anthropic-ai/claude-agent-sdk');
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000;
  const stopConfirmationMs = options.stopConfirmationMs ?? 10_000;
  for (const ms of [timeoutMs, requestTimeoutMs, approvalTimeoutMs, stopConfirmationMs]) if (!Number.isFinite(ms) || ms < 1 || ms > 2_147_483_647) throw new Error('Claude 超时配置无效。');
  let closed = false;
  let quarantined = false;
  let active: { query?: QueryPort; requestStop: () => void; done: Promise<void> } | undefined;
  const pending = new Map<string, PendingApproval>();

  const driver: EngineDriver = {
    info: { id: 'claude', name: 'Claude Agent · 独立进程', kind: 'cli', available: true, description: options.environment ? '按需启动官方 SDK；读取逐次审批，Bash/Edit/Write 尚未启用。' : '按需启动官方 SDK；默认仅文本，无工具。' },
    async execute(context: ExecutionContext) {
      if (closed || active || quarantined) throw new Error('Claude 已关闭、正在执行或有未知结果；请先核验原任务。');
      if (!context.native || context.task.mode !== 'chat' || context.signal.aborted) throw new Error('Claude 任务上下文无效或已取消。');
      const native = context.native;
      const binding = native.binding;
      if (binding && (binding.driverId !== 'claude' || binding.workspace !== workspace || binding.version !== version || !uuidPattern.test(binding.threadId))) throw new Error('Claude 会话绑定与本机工作目录或版本不符。');
      const turnId = randomUUID();
      let sent = false; let initAccepted = false; let sessionId: string | undefined;
      let stopRequested = false; let interruptAcknowledged = false; let failure: Error | undefined;
      let result: Extract<SDKMessage, { type: 'result' }> | undefined;
      let child: SpawnedProcess | undefined; let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let resolveExit!: () => void; const exit = new Promise<void>(resolve => { resolveExit = resolve; });
      let releaseInput!: () => void; let rejectInput!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { releaseInput = resolve; rejectInput = reject; });
      // The SDK eagerly starts pumping input; attach a rejection handler immediately.
      void ready.catch(() => {});
      let q: QueryPort | undefined;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const resolveAll = () => { for (const item of pending.values()) { if (!item.settled) { item.settled = true; item.resolve(denied()); } item.cleanup(); } };
      const requestStop = () => {
        if (stopRequested) return;
        stopRequested = true; resolveAll();
        rejectInput(unknown());
        if (q && sent) {
          void bounded(q.interrupt(), requestTimeoutMs).then(receipt => {
            if (!receipt || !Array.isArray(receipt.still_queued) || receipt.still_queued.length) { failure = unknown(); return; }
            interruptAcknowledged = true;
          }).catch(() => { failure = unknown(); });
        }
        stopTimer = setTimeout(() => { failure = unknown(); q?.close(); }, stopConfirmationMs);
      };
      const state = { query: undefined as QueryPort | undefined, requestStop, done: Promise.resolve() };
      active = state;
      const input = async function* (): AsyncGenerator<SDKUserMessage> {
        await ready;
        if (stopRequested || context.signal.aborted) return;
        await native.onTurn(turnId); // Durable intent before stdin delivery.
        if (stopRequested || context.signal.aborted) return;
        sent = true;
        yield { type: 'user', uuid: turnId, parent_tool_use_id: null, client_composed: true,
          message: { role: 'user', content: context.task.prompt }, ...(binding ? { session_id: binding.threadId } : {}) };
      };
      const execute = async () => {
        let executionError: Error | undefined;
        const onAbort = () => requestStop();
        context.signal.addEventListener('abort', onAbort, { once: true });
        const taskTimer = setTimeout(requestStop, timeoutMs);
        try {
          await native.onActivity?.('connecting');
          const tools = options.environment ? permittedTools : [];
          const sdkOptions: Options = {
            pathToClaudeCodeExecutable: executable, cwd: workspace, env,
            ...(binding ? { resume: binding.threadId } : {}), ...(options.model ? { model: options.model } : {}),
            settingSources: [], settings: { disableAllHooks: true, hooks: {},
              syncClaudeAiSkills: false, syncClaudeAiPlugins: false, autoMemoryEnabled: false, disableBundledSkills: true,
              // Pinned CLI built-ins are additive to Options.plugins. Explicitly
              // disable their documented plugin IDs; never waive a nonempty result.
              enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-telemetry@builtin': false,
                'cc-plugin-plugin-authoring@builtin': false, 'agents-md@builtin': false,
                'telemetry@builtin': false, 'plugin-authoring@builtin': false },
              permissions: { defaultMode: 'default', allow: [], ask: permittedTools, deny: ['Bash', 'Edit', 'Write', 'Agent', 'Task', 'Skill'], disableBypassPermissionsMode: 'disable', blockReadsOutsideWorkingDirectories: true } },
            extraArgs: { 'safe-mode': null, 'disable-slash-commands': null },
            tools, allowedTools: [], disallowedTools: ['Bash', 'Edit', 'Write', 'Agent', 'Task', 'Skill'],
            permissionMode: 'default', permissionPrompts: 'host', allowDangerouslySkipPermissions: false,
            strictMcpConfig: true, mcpServers: {}, agents: {}, plugins: [], skills: [], hooks: {},
            persistSession: true, forkSession: false, continue: false, promptSuggestions: false,
            includePartialMessages: false, enableFileCheckpointing: false, agentProgressSummaries: false,
            maxTurns: options.environment ? 20 : 1, stderr: () => {},
            canUseTool: async (name, rawInput, request) => {
              if (!initAccepted || !options.environment || !permittedTools.includes(name) || request.mcpServer || request.agentID || request.signal.aborted || stopRequested || failure || !request.requestId || !request.toolUseID) return denied();
              // Never forward SDK permission suggestions: every allow is for one frozen call.
              let fixed: Record<string, unknown>;
              try { fixed = JSON.parse(JSON.stringify(rawInput)) as Record<string, unknown>; } catch { return denied(); }
              if (JSON.stringify(fixed).length > 32_768) return denied();
              const checked = scopedRead(name, fixed, workspace);
              if (!checked) return denied();
              fixed = checked;
              const id = `claude:${turnId}:${request.requestId}`;
              if (pending.has(id)) return denied();
              const now = Date.now();
              const approval: NativeApproval = {
                id, kind: 'tool', requestId: request.requestId,
                threadId: sessionId!, turnId, itemId: request.toolUseID,
                operation: `${name}\n${JSON.stringify(fixed, null, 2)}`,
                cwd: workspace, allowedDecisions: ['accept', 'decline'], status: 'pending',
                createdAt: new Date(now).toISOString(), expiresAt: new Date(now + approvalTimeoutMs).toISOString(),
              };
              let settle!: (result: PermissionResult) => void;
              const answer = new Promise<PermissionResult>(resolve => { settle = resolve; });
              const cancel = () => { const item = pending.get(id); if (item && !item.settled) { item.settled = true; item.resolve(denied()); } };
              const timer = setTimeout(cancel, approvalTimeoutMs);
              request.signal.addEventListener('abort', cancel, { once: true });
              pending.set(id, { resolve: settle, result: { behavior: 'allow', updatedInput: fixed, toolUseID: request.toolUseID, decisionClassification: 'user_temporary' }, settled: false, expiresAt: now + approvalTimeoutMs,
                validate: () => JSON.stringify(scopedRead(name, fixed, workspace)) === JSON.stringify(fixed),
                cleanup: () => { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); } });
              try { await native.onApproval(approval); return await answer; }
              catch { cancel(); failure = unknown(); return denied(); }
              finally { pending.get(id)?.cleanup(); await native.onApprovalResolved(id); }
            },
            spawnClaudeCodeProcess: spawnOptions => {
              if (child || spawnOptions.command !== executable || spawnOptions.cwd !== workspace) throw new Error('Claude 进程启动契约不匹配。');
              const actual = options.spawnProcess ? options.spawnProcess(spawnOptions) : spawn(spawnOptions.command, spawnOptions.args, { cwd: workspace, env: spawnOptions.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, signal: spawnOptions.signal });
              child = actual;
              actual.on('exit', (code, signal) => { exited = { code, signal }; resolveExit(); });
              actual.on('error', () => { failure = unknown(); });
              if (actual.exitCode !== null || actual.signalCode) { exited = { code: actual.exitCode, signal: actual.signalCode ?? null }; resolveExit(); }
              return actual;
            },
          };
          q = (await sdkPort()).query({ prompt: input(), options: sdkOptions }); state.query = q;
          const handshake = await bounded(q.initializationResult(), requestTimeoutMs);
          const account = await bounded(q.accountInfo(), requestTimeoutMs);
          if (handshake.claude_code_version !== version || !subscription(handshake.account) || !subscription(account) || handshake.agents.some(agent => !builtinAgents.has(agent.name))) throw new Error('Claude 订阅身份或隔离配置未通过核验；未提交任务。');
          const pluginState = await bounded(q.reloadPlugins(), requestTimeoutMs);
          const skillState = await bounded(q.reloadSkills(), requestTimeoutMs);
          if (pluginState.plugins.length || pluginState.mcpServers.length || pluginState.error_count || pluginState.agents.some(agent => !builtinAgents.has(agent.name)) || skillState.skills.length) throw new Error('Claude 插件或技能隔离未通过核验；未提交任务。');
          if (context.signal.aborted || stopRequested) throw new Error('Claude 任务提交前已取消。');
          releaseInput();
          const consume = async () => {
            // Do not invoke iterator.return() on the result frame. Let the CLI
            // consume its input EOF and exit, retaining an independent exit witness.
            const iterator = q![Symbol.asyncIterator]();
            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              const message = next.value;
              if (failure) throw failure;
              if (message.type === 'system' && message.subtype === 'init') {
                if (initAccepted || !uuidPattern.test(message.session_id) || message.claude_code_version !== version || realpathSync(message.cwd) !== workspace || message.permissionMode !== 'default' || message.apiKeySource !== 'none' || message.mcp_servers.length || message.plugins.length || message.skills.length || message.agents?.some(agent => !builtinAgents.has(agent)) || message.tools.some(tool => !tools.includes(tool)) || (binding && message.session_id !== binding.threadId)) throw unknown();
                sessionId = message.session_id;
                await native.onBinding({ driverId: 'claude', threadId: sessionId, workspace, version });
                initAccepted = true; await native.onActivity?.('thread-ready'); await native.onActivity?.('turn-started');
              } else if (message.type === 'result') {
                if (!initAccepted || result || message.session_id !== sessionId || message.user_message_uuid !== turnId || message.resume_reason || (message.queued_turn_count ?? 0) !== 0) throw unknown();
                result = message; break;
              } else if (message.type === 'assistant') {
                if (!initAccepted || message.session_id !== sessionId || message.parent_tool_use_id) throw unknown();
                // Final text is committed from the matching result, never inferred from an assistant frame.
                await native.onActivity?.('answering');
              } else if (message.type === 'system' && (message.subtype === 'task_started' || message.subtype === 'task_notification')) throw unknown();
            }
          };
          await bounded(consume(), timeoutMs + stopConfirmationMs + requestTimeoutMs);
          if (!result || failure) throw unknown();
          if (!child) throw unknown();
          await bounded(exit, stopConfirmationMs);
          if (!exited || failure) throw unknown();
          const cancelled = stopRequested && interruptAcknowledged && ['aborted_streaming', 'aborted_tools'].includes(result.terminal_reason ?? '');
          if (cancelled) await native.onTerminal('cancelled');
          else if (result.subtype === 'success' && !result.is_error && (!result.terminal_reason || result.terminal_reason === 'completed') && exited.code === 0 && !exited.signal) {
            if (result.result) await native.upsertMessage(`${turnId}:answer`, result.result);
            await native.onTerminal('completed');
          } else if (stopRequested) throw unknown();
          else await native.onTerminal('failed', 'Claude 返回任务失败或未完成的明确回执，请核验结果。');
        } catch (error) {
          if (sent) { quarantined = true; executionError = unknown(); }
          else executionError = error instanceof Error && !(error instanceof NativeOutcomeUnknownError) ? new Error('Claude 启动或订阅身份核验失败；未提交任务。') : new Error('Claude 启动未通过核验；未提交任务。');
        } finally {
          clearTimeout(taskTimer); clearTimeout(stopTimer); resolveAll();
          rejectInput(unknown());
          try { q?.close(); } catch { quarantined = true; executionError = unknown(); }
          if (child && !exited) {
            try { await bounded(exit, stopConfirmationMs); } catch { quarantined = true; executionError = unknown(); }
          }
          pending.clear(); context.signal.removeEventListener('abort', onAbort); active = undefined;
        }
        if (executionError) throw executionError;
      };
      state.done = execute(); await state.done;
    },
    async decideApproval(id, decision) {
      const item = pending.get(id);
      if (!item || !active || item.settled || item.decision || Date.now() >= item.expiresAt || !['accept', 'decline'].includes(decision)) throw new Error('Claude 单次审批无效、过期或已处理。');
      if (decision === 'accept' && !item.validate()) { item.settled = true; item.resolve(denied()); throw new Error('Claude 读取范围已变化，本次批准未发送。'); }
      item.decision = decision; item.settled = true;
      item.resolve(decision === 'accept' ? item.result : denied());
    },
    async recover(binding, turnId) {
      if (!binding || binding.driverId !== 'claude' || binding.version !== version || binding.workspace !== workspace || !uuidPattern.test(binding.threadId) || !turnId || !uuidPattern.test(turnId)) return { status: 'unknown', messages: [], error: unknownText };
      // The public transcript API returns user/assistant/system, not authoritative
      // per-turn result receipts. Inspect only the exact session and remain unknown.
      try { await bounded((await sdkPort()).getSessionMessages(binding.threadId, { dir: workspace, limit: 1 }), requestTimeoutMs); } catch { /* No terminal proof can be inferred. */ }
      return { status: 'unknown', turnId, messages: [], error: unknownText };
    },
    async close() { closed = true; const state = active; if (state) { state.requestStop(); await state.done.catch(() => {}); } },
  };
  return driver;
}

export function createClaudeDriverFromEnvironment(env: NodeJS.ProcessEnv, workspace: string): EngineDriver | undefined {
  if (env.RELAYDESK_ENABLE_CLAUDE !== '1') return undefined;
  if (env.RELAYDESK_CLAUDE_AUTH_MODE && env.RELAYDESK_CLAUDE_AUTH_MODE !== 'subscription') throw new Error('本版本只支持 Claude 订阅登录，不能切换到 API 计费。');
  return createClaudeDriver({ workspace, executablePath: env.RELAYDESK_CLAUDE_PATH, model: env.RELAYDESK_CLAUDE_MODEL, environment: env.RELAYDESK_CLAUDE_ENVIRONMENT === '1', authMode: 'subscription', env });
}
