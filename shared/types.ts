export type AdapterId = 'mock-codex' | 'mock-claude' | 'codex' | 'claude';
export type TaskStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'cancelled' | 'failed';
export type TaskMode = 'chat' | 'approval-demo';
export interface AdapterInfo { id: AdapterId; name: string; description: string; available: boolean; kind: 'mock' | 'cli'; reason?: string }
export interface ChannelInfo { id: string; name: string; status: 'local' | 'planned'; description: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; taskId: string }
export interface Task { id: string; sessionId: string; adapterId: AdapterId; prompt: string; mode: TaskMode; status: TaskStatus; createdAt: string; updatedAt: string; error?: string; approval?: { title: string; description: string }; events: { status: TaskStatus; at: string; detail: string }[] }
export interface Session { id: string; title: string; adapterId: AdapterId; createdAt: string; updatedAt: string; messages: Message[]; tasks: Task[] }
export interface SessionSummary { id: string; title: string; adapterId: AdapterId; createdAt: string; updatedAt: string; lastMessage: string; status: TaskStatus | 'idle' }
export interface Bootstrap { adapters: AdapterInfo[]; channels: ChannelInfo[]; runtime: { mode: 'local'; agent: string; gateway: 'local'; version: string } }

// Future adapters consume structured inputs; never accept a shell command from a browser.
export interface ExecutionContext { task: Task; history: Message[]; signal: AbortSignal; emit: (chunk: string) => void }
export interface ExecutionAdapter { info: AdapterInfo; execute(context: ExecutionContext): Promise<void> }
// Incoming messages are untrusted data. No connector is allowed to execute an action on receipt.
export interface ChannelEnvelope { channelId: string; externalId: string; receivedAt: string; text: string; trust: 'untrusted'; replyAllowed: false }
export interface ChannelAdapter { id: string; normalize(input: unknown): ChannelEnvelope }
