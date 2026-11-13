import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface LoomPaths {
  root: string;
  source: string;
  data: string;
  worktrees: string;
  artifacts: string;
  previews: string;
  backups: string;
  logs: string;
}

export function createPaths(root = process.env.LOOM_ROOT || 'E:\\Loom'): LoomPaths {
  const absoluteRoot = resolve(root);
  const paths = {
    root: absoluteRoot,
    source: join(absoluteRoot, 'source'),
    data: join(absoluteRoot, 'data'),
    worktrees: join(absoluteRoot, 'worktrees'),
    artifacts: join(absoluteRoot, 'artifacts'),
    previews: join(absoluteRoot, 'previews'),
    backups: join(absoluteRoot, 'backups'),
    logs: join(absoluteRoot, 'logs'),
  };
  for (const value of Object.values(paths)) mkdirSync(value, { recursive: true });
  return paths;
}

export function safePath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径超出授权目录');
  return resolved;
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
