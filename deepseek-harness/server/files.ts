import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'yaml';

export function safePath(root: string, name: string) {
  if (!name || name.includes('\\') || name.includes('\0') || name.split('/').some(s => !s || s === '.' || s === '..') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error('无效的相对路径');
  const base = resolve(root), target = resolve(base, name);
  if (relative(base, target).startsWith('..')) throw new Error('路径越界');
  let cursor = base;
  for (const segment of ['', ...name.split('/')]) {
    if (segment) cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('不能通过符号链接访问工作台数据');
  }
  return target;
}
export const revision = (content: string) => createHash('sha256').update(content).digest('hex');
export class MemoryFiles {
  root: string;
  constructor(dataRoot: string) { this.root = join(dataRoot, 'memory'); mkdirSync(this.root, { recursive: true }); }
  path(name: string) { if (!/\.md$/.test(name)) throw new Error('只支持 Markdown 记忆'); return safePath(this.root, name); }
  read(name: string) { const path = this.path(name); const content = existsSync(path) ? readFileSync(path, 'utf8') : ''; return { name, content, revision: revision(content) }; }
  write(name: string, content: string, expected: string) {
    if (typeof content !== 'string' || content.length > 200_000) throw new Error('记忆内容过大');
    const current = this.read(name);
    if (current.revision !== expected) throw new Error('文件已被其他操作修改，请重新加载后合并');
    const path = this.path(name); mkdirSync(dirname(path), { recursive: true });
    if (current.content) {
      const backups = join(this.root, '.history'); mkdirSync(backups, { recursive: true });
      writeFileSync(join(backups, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(current), { mode: 0o600 });
    }
    const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, content, { mode: 0o600 }); renameSync(temp, path);
    return this.read(name);
  }
  list() { return walk(this.root).filter(p => p.endsWith('.md') && !p.startsWith('.history/')); }
  context(projectId?: string) {
    const names = ['MEMORY.md', ...(projectId ? [`projects/${projectId}/overview.md`, `projects/${projectId}/decisions.md`, `projects/${projectId}/progress.md`] : [])];
    return names.map(name => { const {content} = this.read(name); return content ? `## ${name}\n${content.slice(0, 12000)}` : ''; }).filter(Boolean).join('\n\n');
  }
}
export function walk(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, {withFileTypes:true}).flatMap(d => d.isSymbolicLink() ? [] : d.isDirectory() ? walk(join(root, d.name), `${prefix}${d.name}/`) : [`${prefix}${d.name}`]);
}
export function validateSkill(content: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(content);
  if (!match || content.length > 100_000) throw new Error('Skill 需要 YAML 元信息和正文');
  const meta = parse(match[1]);
  if (!meta || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 63 || typeof meta.description !== 'string' || !meta.description.trim()) throw new Error('Skill 名称或描述无效');
  return {name: meta.name as string, description: meta.description as string, category: meta.metadata?.category === 'product' ? 'product' : 'development'};
}
export function listSkills(roots: string[]) {
  const entries: any[] = []; const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const item of readdirSync(root, {withFileTypes:true})) {
      if (item.name.startsWith('.') || item.isSymbolicLink()) continue;
      const relativeName = item.isDirectory() ? `${item.name}/SKILL.md` : item.name;
      if (!relativeName.endsWith('.md')) continue;
      try {
        const path = safePath(root, relativeName); if (!existsSync(path) || statSync(path).size > 100_000) continue;
        const content = readFileSync(path, 'utf8'); const meta = validateSkill(content);
        if (!seen.has(meta.name)) { seen.add(meta.name); entries.push({...meta, content, path, status:'saved'}); }
      } catch { /* malformed entries are not advertised as loadable */ }
    }
  }
  return entries;
}
