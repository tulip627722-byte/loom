import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeStore } from './store.ts';
import { MemoryService } from './memory.ts';

test('memory search remains project scoped', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-memory-'));
  const store = new RuntimeStore(root);
  const memory = new MemoryService(store, root, join(root, 'backups'));
  memory.write({ projectId: 'alpha', name: 'Decision', content: 'Use SQLite event sourcing' });
  memory.write({ projectId: 'beta', name: 'Decision', content: 'Use Postgres event sourcing' });
  assert.equal(memory.search('SQLite', 'alpha').length, 1);
  assert.equal(memory.search('SQLite', 'beta').length, 0);
  store.close();
  rmSync(root, { recursive: true, force: true });
});
