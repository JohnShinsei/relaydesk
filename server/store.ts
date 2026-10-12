import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session } from '../shared/types.ts';

/** A session snapshot commits messages and task state together, including each streamed chunk. */
export class SessionStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL,
      snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
    ); PRAGMA user_version = 1;`);
  }

  all(): Session[] {
    return this.db.prepare('SELECT snapshot FROM sessions ORDER BY updated_at DESC, id').all()
      .map(row => JSON.parse(String(row.snapshot)) as Session);
  }

  save(session: Session): void {
    this.db.prepare(`INSERT INTO sessions (id, updated_at, snapshot) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, snapshot = excluded.snapshot`)
      .run(session.id, session.updatedAt, JSON.stringify(session));
  }

  close(): void { this.db.close(); }
}
