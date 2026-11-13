import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createPaths, safePath } from './paths.ts';
import { WorkspaceService } from './workspace.ts';

test('safePath rejects traversal outside an authorized root', () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-path-'));
  assert.throws(() => safePath(root, '..\\outside.txt'), /超出授权目录/);
  rmSync(root, { recursive: true, force: true });
});

test('write tasks receive an isolated loom branch worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loom-workspace-'));
  const loomRoot = join(root, 'Loom');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  execFileSync('git', ['init'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'loom-test@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: project });
  writeFileSync(join(project, 'README.md'), '# Project\n');
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: project });
  const workspace = new WorkspaceService(createPaths(loomRoot));
  const result = await workspace.createWorktree(project, '1234567890abcdef');
  assert.equal(result.branch, 'loom/1234567890ab');
  assert.equal(result.path.startsWith(join(loomRoot, 'worktrees')), true);
  assert.equal(workspace.readFile(result.path, 'README.md').replaceAll('\r\n', '\n'), '# Project\n');
  execFileSync('git', ['worktree', 'remove', '--force', result.path], { cwd: project });
  rmSync(root, { recursive: true, force: true });
});
