import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LoomPaths } from './paths.ts';
import type { RuntimeStore } from './store.ts';
import type { MemoryService } from './memory.ts';

interface MigrationResult { source: string; backup: string; files: number; records: number; skipped: string[] }

export function migrateLegacy(paths: LoomPaths, store: RuntimeStore, memory: MemoryService, source = join(homedir(), 'LoomData')): MigrationResult {
  if (!existsSync(source)) throw new Error(`旧 LoomData 不存在：${source}`);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const backup = join(paths.backups, `legacy-${stamp}`);
  mkdirSync(backup, { recursive: true });
  cpSync(source, backup, { recursive: true, errorOnExist: true });
  let files = 0;
  let records = 0;
  const skipped: string[] = [];
  const memoryRoot = join(source, 'memory');
  if (existsSync(memoryRoot)) {
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && /\.md$/i.test(entry.name) && statSync(path).size <= 2_000_000) {
          const legacyRelative = relative(memoryRoot, path).replaceAll('\\', '/');
          const projectMatch = legacyRelative.match(/^projects\/([^/]+)\//);
          memory.write({ id: createHash('sha256').update(legacyRelative).digest('hex').slice(0, 32), projectId: projectMatch?.[1], name: basename(entry.name, '.md'), content: readFileSync(path, 'utf8'), sourceTaskId: 'legacy-import' });
          files += 1;
        }
      }
    };
    walk(memoryRoot);
  }
  const legacyDatabase = join(source, 'state', 'loom.sqlite');
  if (existsSync(legacyDatabase)) {
    const old = new DatabaseSync(legacyDatabase, { readOnly: true });
    try {
      const rows = old.prepare("SELECT kind,json FROM records WHERE kind IN ('projects','todos','plans','schedules','artifacts')").all() as Array<{ kind: string; json: string }>;
      for (const row of rows) {
        try {
          const value = JSON.parse(row.json) as Record<string, unknown>;
          if (row.kind === 'projects') store.put('projects', value);
          else store.put('audit', { id: randomUUID(), type: `legacy.${row.kind}`, payload: value, importedAt: new Date().toISOString() });
          records += 1;
        } catch { skipped.push(`${row.kind}:invalid-json`); }
      }
    } finally { old.close(); }
  }
  return { source, backup, files, records, skipped };
}
