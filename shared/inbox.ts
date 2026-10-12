/** Synthetic inbox only. A future connector must provide stable native account/thread/message IDs. */
export interface InboxProject {
  id: string;
  name: string;
  requirements: { text: string; sourceMessageId: string }[];
  deadlines: { text: string; sourceMessageId: string }[];
  questions: { text: string; sourceMessageId: string }[];
  todos: { text: string; sourceMessageId: string }[];
  summaryKind: 'deterministic-demo';
}
export interface InboxMessage {
  id: string;
  externalId: string;
  threadId: string;
  /** Fixed confirmed associations in the synthetic demo; never inferred from the thread title. */
  projectIds: string[];
  sender: string;
  text: string;
  receivedAt: string;
  trust: 'untrusted';
  risk: 'normal' | 'sensitive' | 'high-impact';
}
export interface InboxThread {
  id: string;
  channelId: 'mock-wechat';
  accountId: 'demo-work-wechat';
  externalThreadId: string;
  title: string;
  projectIds: string[];
  messages: InboxMessage[];
}
export type DeliveryStatus = 'draft' | 'sending' | 'succeeded' | 'failed' | 'unknown';
export type DemoDeliveryOutcome = 'succeeded' | 'failed' | 'unknown';
export interface InboxReply {
  id: string;
  threadId: string;
  sourceMessageId: string;
  accountId: 'demo-work-wechat';
  externalThreadId: string;
  targetTitle: string;
  content: string;
  idempotencyKey: string;
  demoOutcome: DemoDeliveryOutcome;
  reviewRequired: boolean;
  reviewReason?: string;
  status: DeliveryStatus;
  createdAt: string;
  updatedAt: string;
  receiptId?: string;
  error?: string;
}
export interface InboxSnapshot {
  mode: 'mock';
  projects: InboxProject[];
  threads: InboxThread[];
  replies: InboxReply[];
}
export interface PrepareInboxReply {
  threadId: string;
  sourceMessageId: string;
  content: string;
  idempotencyKey: string;
  demoOutcome: DemoDeliveryOutcome;
}
export interface SendInboxReply {
  intent: 'send-reply';
  confirmReview?: boolean;
}
