import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Row = { id: string; [key: string]: any };
export const kinds = ['projects', 'tasks', 'runs', 'todos', 'schedules', 'notifications', 'plans', 'artifacts', 'drafts', 'discussions', 'workItems', 'previews', 'settings'] as const;
export type Kind = typeof kinds[number];
export class Store {
  db: DatabaseSync;
  constructor(root: string) {
    mkdirSync(join(root, 'state'), { recursive: true });
    this.db = new DatabaseSync(join(root, 'state', 'tulip.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS triggers(schedule_id TEXT NOT NULL, due TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(schedule_id,due));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, json TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  list(kind: Kind): Row[] {
    return (this.db.prepare('SELECT json FROM records WHERE kind=? ORDER BY rowid DESC').all(kind) as any[]).map(r => JSON.parse(r.json));
  }
  get(kind: Kind, id: string): Row | undefined {
    const row = this.db.prepare('SELECT json FROM records WHERE kind=? AND id=?').get(kind, id) as any;
    return row ? JSON.parse(row.json) : undefined;
  }
  put(kind: Kind, input: Record<string, any>): Row {
    const id = input.id || randomUUID();
    const before = this.get(kind, id);
    const row = { ...before, ...input, id, createdAt: before?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind, id, JSON.stringify(row));
    return row;
  }
  remove(kind: Kind, id: string) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  event(event: unknown) {
    return Number(this.db.prepare('INSERT INTO events(time,json) VALUES(?,?)').run(new Date().toISOString(), JSON.stringify(event)).lastInsertRowid);
  }
  events(after = 0) { return (this.db.prepare('SELECT seq,json FROM events WHERE seq>? ORDER BY seq LIMIT 500').all(after) as any[]).map(r => ({ seq: r.seq, ...JSON.parse(r.json) })); }
  latestEventSequence() {return Number((this.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as any)?.seq||0);}
  claim(scheduleId: string, due: string, runId: string) {
    return this.db.prepare('INSERT OR IGNORE INTO triggers VALUES(?,?,?)').run(scheduleId, due, runId).changes === 1;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
