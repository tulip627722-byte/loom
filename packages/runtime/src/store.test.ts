import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimeStore } from './store.ts';

test('store persists records and ordered events', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-store-'));
  const store = new RuntimeStore(root);
  const row = store.put('tasks', { title: 'test', status: 'queued' });
  assert.equal(store.get('tasks', row.id)?.title, 'test');
  const first = store.event('task.created', row, row.id);
  const second = store.event('task.changed', { status: 'running' }, row.id);
  assert.equal(first.seq + 1, second.seq);
  assert.equal(store.events(first.seq).length, 1);
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test('store marks interrupted side effects for manual recovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-recovery-'));
  let store = new RuntimeStore(root);
  const run = store.put('runs', { taskId: 'task', role: 'executor', status: 'executing-tool' });
  store.close();
  store = new RuntimeStore(root);
  assert.equal(store.get('runs', run.id)?.status, 'interrupted');
  store.close();
  rmSync(root, { recursive: true, force: true });
});
