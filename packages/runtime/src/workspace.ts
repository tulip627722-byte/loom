import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { LoomPaths } from './paths.ts';
import { safePath } from './paths.ts';

const execFileAsync = promisify(execFile);

export class WorkspaceService {
  private readonly paths: LoomPaths;

  constructor(paths: LoomPaths) {
    this.paths = paths;
  }

  async createWorktree(projectPath: string, taskId: string): Promise<{ path: string; branch: string }> {
    const root = realpathSync(projectPath);
    await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeout: 15_000 });
    const target = safePath(this.paths.worktrees, taskId);
    const branch = `loom/${taskId.slice(0, 12)}`;
    if (existsSync(target)) return { path: target, branch };
    mkdirSync(dirname(target), { recursive: true });
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '-b', branch, target, 'HEAD'], { timeout: 60_000 });
    return { path: target, branch };
  }

  listFiles(root: string, directory = '.'): string[] {
    const target = this.authorize(root, directory);
    const output: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (['.git', 'node_modules', 'target', 'dist'].includes(entry.name)) continue;
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(path);
        else output.push(relative(root, path).replaceAll('\\', '/'));
        if (output.length >= 500) return;
      }
    };
    walk(target);
    return output;
  }

  readFile(root: string, path: string): string {
    const target = this.authorize(root, path);
    if (lstatSync(target).isSymbolicLink()) throw new Error('不允许读取符号链接');
    const content = readFileSync(target, 'utf8');
    if (Buffer.byteLength(content) > 1_000_000) throw new Error('文件超过 1 MB');
    return content;
  }

  writeFile(root: string, path: string, content: string): void {
    const target = this.authorize(root, path, false);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('不允许写入符号链接');
    if (Buffer.byteLength(content) > 1_000_000) throw new Error('单次写入超过 1 MB');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  async diff(root: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', root, 'diff', '--no-ext-diff', '--stat', '--', '.', ':(exclude)package-lock.json'], { timeout: 30_000, maxBuffer: 2_000_000 });
    const full = await execFileAsync('git', ['-C', root, 'diff', '--no-ext-diff'], { timeout: 30_000, maxBuffer: 2_000_000 });
    return `${stdout}\n${full.stdout}`.slice(0, 200_000);
  }

  async runApprovedCommand(root: string, command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const allowed = new Set(['npm', 'node', 'npx', 'git', 'cargo', 'rustc']);
    if (!allowed.has(command.toLowerCase())) throw new Error(`命令不在允许列表：${command}`);
    try {
      const result = await execFileAsync(command, args, { cwd: root, timeout: 120_000, maxBuffer: 2_000_000, windowsHide: true });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout || '', stderr: failure.stderr || failure.message, exitCode: Number(failure.code || 1) };
    }
  }

  async mergeWorktree(projectPath: string, branch: string): Promise<string> {
    const status = await execFileAsync('git', ['-C', projectPath, 'status', '--porcelain'], { timeout: 15_000 });
    if (status.stdout.trim()) throw new Error('源项目存在未提交改动，无法安全合并工作树');
    const result = await execFileAsync('git', ['-C', projectPath, 'merge', '--no-ff', '--no-edit', branch], { timeout: 120_000, maxBuffer: 2_000_000 });
    return result.stdout;
  }

  private authorize(root: string, path: string, requireExists = true): string {
    const authorizedRoot = realpathSync(root);
    const target = safePath(authorizedRoot, path);
    if (requireExists && !existsSync(target)) throw new Error('文件不存在');
    const nearest = existsSync(target) ? realpathSync(target) : realpathSync(dirname(target));
    if (relative(authorizedRoot, nearest).startsWith('..')) throw new Error('路径经过了未授权链接');
    return resolve(target);
  }
}
