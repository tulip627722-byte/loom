import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@loom/shared';

export type RecordKind = 'projects' | 'tasks' | 'messages' | 'plans' | 'approvals' | 'runs' | 'settings' | 'models' | 'memories' | 'audit';
export type StoredRecord = { id: string; createdAt: string; updatedAt: string; [key: string]: unknown };

export class RuntimeStore {
  readonly db: DatabaseSync;

  constructor(dataRoot: string) {
    mkdirSync(join(dataRoot, 'state'), { recursive: true });
    this.db = new DatabaseSync(join(dataRoot, 'state', 'loom.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(kind, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        task_id TEXT,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_documents (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        revision TEXT NOT NULL,
        source_task_id TEXT,
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, project_id UNINDEXED, name, content, tokenize='unicode61');
      PRAGMA user_version=2;
    `);
    this.recoverInterruptedRuns();
  }

  list<T extends StoredRecord>(kind: RecordKind): T[] {
    return (this.db.prepare('SELECT json FROM records WHERE kind=? ORDER BY updated_at DESC').all(kind) as Array<{ json: string }>).map(row => JSON.parse(row.json) as T);
  }

  get<T extends StoredRecord>(kind: RecordKind, id: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM records WHERE kind=? AND id=?').get(kind, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }

  put<T extends StoredRecord>(kind: RecordKind, value: Omit<Partial<T>, 'createdAt' | 'updatedAt'> & Record<string, unknown>): T {
    const id = typeof value.id === 'string' ? value.id : randomUUID();
    const previous = this.get<T>(kind, id);
    const now = new Date().toISOString();
    const next = { ...previous, ...value, id, createdAt: previous?.createdAt || now, updatedAt: now } as T;
    this.db.prepare(`INSERT INTO records(kind,id,json,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at`)
      .run(kind, id, JSON.stringify(next), next.createdAt, next.updatedAt);
    return next;
  }

  remove(kind: RecordKind, id: string): void {
    this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id);
  }

  event(type: string, data: unknown, taskId?: string): RuntimeEvent {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(type,task_id,json,created_at) VALUES(?,?,?,?)').run(type, taskId || null, JSON.stringify(data), createdAt);
    return { seq: Number(result.lastInsertRowid), type, taskId, data, createdAt };
  }

  events(after = 0): RuntimeEvent[] {
    return (this.db.prepare('SELECT seq,type,task_id,json,created_at FROM events WHERE seq>? ORDER BY seq LIMIT 500').all(after) as Array<Record<string, unknown>>).map(row => ({
      seq: Number(row.seq),
      type: String(row.type),
      taskId: row.task_id ? String(row.task_id) : undefined,
      data: JSON.parse(String(row.json)),
      createdAt: String(row.created_at),
    }));
  }

  latestSequence(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }).seq);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private recoverInterruptedRuns(): void {
    for (const run of this.list<StoredRecord>('runs')) {
      if (!['running', 'executing-tool', 'awaiting-tool'].includes(String(run.status))) continue;
      this.put('runs', { id: run.id, status: 'interrupted', error: 'Loom 重启后未自动重放副作用步骤，请人工确认恢复。' });
    }
  }

  close(): void {
    this.db.close();
  }
}
