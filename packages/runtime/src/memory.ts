import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimeStore } from './store.ts';
import { safePath } from './paths.ts';

export interface MemoryDocument {
  id: string;
  projectId?: string;
  name: string;
  content: string;
  revision: string;
  sourceTaskId?: string;
  sensitivity: 'normal' | 'sensitive';
  createdAt: string;
  updatedAt: string;
}

export const revision = (content: string): string => createHash('sha256').update(content).digest('hex');

export class MemoryService {
  private readonly root: string;
  private readonly store: RuntimeStore;
  private readonly backupsRoot: string;

  constructor(store: RuntimeStore, dataRoot: string, backupsRoot: string) {
    this.store = store;
    this.backupsRoot = backupsRoot;
    this.root = join(dataRoot, 'memory');
    mkdirSync(this.root, { recursive: true });
  }

  list(projectId?: string): MemoryDocument[] {
    const rows = this.store.db.prepare(`SELECT id,project_id,name,content,revision,source_task_id,sensitivity,created_at,updated_at
      FROM memory_documents WHERE project_id IS ? ORDER BY updated_at DESC`).all(projectId || null) as Array<Record<string, unknown>>;
    return rows.map(row => this.toDocument(row));
  }

  search(query: string, projectId?: string, limit = 8): MemoryDocument[] {
    if (!query.trim()) return this.list(projectId).slice(0, limit);
    const rows = this.store.db.prepare(`SELECT d.id,d.project_id,d.name,d.content,d.revision,d.source_task_id,d.sensitivity,d.created_at,d.updated_at
      FROM memory_fts f JOIN memory_documents d ON d.id=f.id
      WHERE memory_fts MATCH ? AND d.project_id IS ? ORDER BY rank LIMIT ?`).all(this.ftsQuery(query), projectId || null, limit) as Array<Record<string, unknown>>;
    return rows.map(row => this.toDocument(row));
  }

  write(input: { id?: string; projectId?: string; name: string; content: string; expectedRevision?: string; sourceTaskId?: string; sensitivity?: 'normal' | 'sensitive' }): MemoryDocument {
    const id = input.id || crypto.randomUUID();
    const existing = this.store.db.prepare('SELECT * FROM memory_documents WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (existing && input.expectedRevision && existing.revision !== input.expectedRevision) throw new Error('记忆已被修改，请重新加载后合并');
    const now = new Date().toISOString();
    const document: MemoryDocument = {
      id,
      projectId: input.projectId,
      name: input.name.trim().slice(0, 120),
      content: input.content,
      revision: revision(input.content),
      sourceTaskId: input.sourceTaskId,
      sensitivity: input.sensitivity || 'normal',
      createdAt: existing ? String(existing.created_at) : now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO memory_documents(id,project_id,name,content,revision,source_task_id,sensitivity,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,name=excluded.name,content=excluded.content,
        revision=excluded.revision,source_task_id=excluded.source_task_id,sensitivity=excluded.sensitivity,updated_at=excluded.updated_at`)
        .run(document.id, document.projectId || null, document.name, document.content, document.revision, document.sourceTaskId || null, document.sensitivity, document.createdAt, document.updatedAt);
      this.store.db.prepare('DELETE FROM memory_fts WHERE id=?').run(document.id);
      this.store.db.prepare('INSERT INTO memory_fts(id,project_id,name,content) VALUES(?,?,?,?)').run(document.id, document.projectId || '', document.name, document.content);
    });
    this.writeMarkdown(document, existing ? String(existing.content) : undefined);
    return document;
  }

  remove(id: string): void {
    const existing = this.store.db.prepare('SELECT * FROM memory_documents WHERE id=?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return;
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM memory_documents WHERE id=?').run(id);
      this.store.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id);
    });
  }

  private writeMarkdown(document: MemoryDocument, previous?: string): void {
    const relativePath = document.projectId ? join('projects', document.projectId, `${document.id}.md`) : join('personal', `${document.id}.md`);
    const target = safePath(this.root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    if (previous !== undefined && existsSync(target)) {
      const backup = safePath(this.backupsRoot, join('memory', `${document.id}-${Date.now()}.md`));
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, readFileSync(target));
    }
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, `# ${document.name}\n\n${document.content}`, 'utf8');
    renameSync(temporary, target);
  }

  private ftsQuery(query: string): string {
    const terms = query.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
    return terms.slice(0, 8).map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ') || '""';
  }

  private toDocument(row: Record<string, unknown>): MemoryDocument {
    return {
      id: String(row.id),
      projectId: row.project_id ? String(row.project_id) : undefined,
      name: String(row.name),
      content: String(row.content),
      revision: String(row.revision),
      sourceTaskId: row.source_task_id ? String(row.source_task_id) : undefined,
      sensitivity: row.sensitivity === 'sensitive' ? 'sensitive' : 'normal',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
