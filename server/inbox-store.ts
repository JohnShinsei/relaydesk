import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InboxReply, InboxSnapshot } from '../shared/inbox.ts';

export interface InboxAuthorization {
  replyId: string;
  sourceMessageId: string;
  externalSourceMessageId: string;
  accountId: InboxReply['accountId'];
  externalThreadId: string;
  threadId: string;
  targetTitle: string;
  content: string;
  intent: 'send-reply';
  confirmReview: boolean;
  authorizedAt: string;
}
export interface StoredInbox {
  snapshot: InboxSnapshot;
  keys: Record<string, { fingerprint: string; replyId: string }>;
  authorizations: Record<string, InboxAuthorization>;
}
export interface InboxPersistence {
  load(): StoredInbox | undefined;
  save(state: StoredInbox): void;
  close(): void;
}

/** Inbox state shares the database file but never reads or changes conversation tables. */
export class InboxStore implements InboxPersistence {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox_state (
      slot INTEGER PRIMARY KEY CHECK(slot = 1),
      snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
    );`);
  }
  load(): StoredInbox | undefined {
    const row = this.db.prepare('SELECT snapshot FROM inbox_state WHERE slot = 1').get();
    return row ? JSON.parse(String(row.snapshot)) as StoredInbox : undefined;
  }
  save(state: StoredInbox): void {
    this.db.prepare(`INSERT INTO inbox_state (slot, snapshot) VALUES (1, ?)
      ON CONFLICT(slot) DO UPDATE SET snapshot = excluded.snapshot`).run(JSON.stringify(state));
  }
  close(): void { this.db.close(); }
}
