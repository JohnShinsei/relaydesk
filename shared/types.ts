export type AdapterId = 'mock-codex' | 'mock-claude' | 'codex' | 'codex-app-server' | 'claude';
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'unknown';
export type TaskMode = 'chat' | 'approval-demo';
export interface AdapterInfo { id: AdapterId; name: string; description: string; available: boolean; kind: 'mock' | 'cli'; reason?: string }
export interface ChannelInfo { id: string; name: string; status: 'local' | 'planned'; description: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; taskId: string; nativeItemId?: string }
export type NativeApprovalDecision = 'accept' | 'decline' | 'cancel';
export interface NativeApproval {
  id: string; kind: 'command' | 'file-change'; requestId: string | number;
  threadId: string; turnId: string; itemId: string; operation: string; cwd?: string;
  changes?: { path: string; diff: string }[];
  allowedDecisions: NativeApprovalDecision[];
  status: 'pending' | 'responding' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'resolved' | 'unknown';
  createdAt: string; expiresAt: string; decidedAt?: string; decision?: NativeApprovalDecision;
}
export interface EngineBinding { driverId: 'codex-app-server'; threadId: string; workspace: string; version: '0.162.1' }
export interface Task { id: string; sessionId: string; adapterId: AdapterId; prompt: string; mode: TaskMode; status: TaskStatus; createdAt: string; updatedAt: string; error?: string; stopUnconfirmed?: boolean; nativeTurnId?: string; nativeApprovals?: NativeApproval[]; approval?: { title: string; description: string }; events: { status: TaskStatus; at: string; detail: string }[] }
export interface Session { id: string; title: string; adapterId: AdapterId; createdAt: string; updatedAt: string; messages: Message[]; tasks: Task[]; engineBinding?: EngineBinding }
export interface SessionSummary { id: string; title: string; adapterId: AdapterId; createdAt: string; updatedAt: string; lastMessage: string; status: TaskStatus | 'idle' }
export interface Bootstrap { adapters: AdapterInfo[]; channels: ChannelInfo[]; runtime: { mode: 'local'; agent: string; gateway: 'local'; version: string } }

// Future adapters consume structured inputs; never accept a shell command from a browser.
export interface NativeExecutionContext {
  binding?: EngineBinding;
  onBinding: (binding: EngineBinding) => void | Promise<void>;
  onTurn: (turnId: string) => void | Promise<void>;
  upsertMessage: (itemId: string, text: string) => void | Promise<void>;
  onApproval: (approval: NativeApproval) => void | Promise<void>;
  onApprovalResolved: (approvalId: string) => void | Promise<void>;
  onTerminal: (status: 'completed' | 'cancelled' | 'failed', error?: string) => void | Promise<void>;
}
export interface ExecutionContext { task: Task; history: Message[]; signal: AbortSignal; emit: (chunk: string) => void; native?: NativeExecutionContext }
export interface ExecutionAdapter { info: AdapterInfo; execute(context: ExecutionContext): Promise<void> }
export interface NativeRecovery { turnId?: string; status: 'completed' | 'cancelled' | 'failed' | 'running' | 'unknown'; messages: { itemId: string; text: string }[]; error?: string }
/** Native protocol boundary: no browser-supplied commands, cwd, model or native IDs. */
export interface EngineDriver extends ExecutionAdapter {
  decideApproval(approvalId: string, decision: NativeApprovalDecision): Promise<void>;
  recover(binding: EngineBinding, turnId?: string): Promise<NativeRecovery>;
  close(): Promise<void>;
}
// Incoming messages are untrusted data. No connector is allowed to execute an action on receipt.
export interface ChannelEnvelope { channelId: string; externalId: string; receivedAt: string; text: string; trust: 'untrusted'; replyAllowed: false }
export interface ChannelAdapter { id: string; normalize(input: unknown): ChannelEnvelope }
