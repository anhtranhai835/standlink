// Team skills: markdown playbooks any agent can load on demand through the `skill` MCP tool.
// Two places, project first: <project>/.standlink/skills/<name>.md (versioned with the code)
// and the app library (userData/skills) shared by every project.
// Agents only see names + one-line descriptions until they ask for a skill, which keeps token cost low.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SkillInfo { name: string; description: string; scope: 'project' | 'app'; file: string }

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/; // file-safe, no path tricks
export const validSkillName = (n: string) => NAME.test(n);

/** `--- name / description ---` frontmatter, then the body. */
function parse(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

async function scan(dir: string, scope: SkillInfo['scope']): Promise<SkillInfo[]> {
  let files: string[] = [];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.md')); } catch { return []; }
  const out: SkillInfo[] = [];
  for (const f of files) {
    const name = f.slice(0, -3);
    if (!validSkillName(name)) continue;
    const { meta } = parse(await readFile(path.join(dir, f), 'utf8').catch(() => ''));
    out.push({ name, description: meta.description ?? '', scope, file: path.join(dir, f) });
  }
  return out;
}

export const projectDir = (cwd: string) => path.join(cwd, '.standlink', 'skills');

/** All skills visible in a project; a project skill wins over an app skill of the same name. */
export async function listSkills(appDir: string, cwd?: string): Promise<SkillInfo[]> {
  const project = cwd ? await scan(projectDir(cwd), 'project') : [];
  const app = (await scan(appDir, 'app')).filter(s => !project.some(p => p.name === s.name));
  return [...project, ...app].sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(appDir: string, cwd: string | undefined, name: string): Promise<string | null> {
  if (!validSkillName(name)) return null;
  const skill = (await listSkills(appDir, cwd)).find(s => s.name === name);
  if (!skill) return null;
  return parse(await readFile(skill.file, 'utf8')).body.trim();
}

export async function saveSkill(dir: string, name: string, description: string, body: string) {
  if (!validSkillName(name)) throw new Error('Tên skill chỉ gồm chữ thường, số và gạch ngang.');
  await mkdir(dir, { recursive: true });
  const oneLine = description.replace(/\s+/g, ' ').trim();
  await writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${oneLine}\n---\n\n${body.trim()}\n`, 'utf8');
}

export async function deleteSkill(dir: string, name: string) {
  if (!validSkillName(name)) return;
  await rm(path.join(dir, `${name}.md`), { force: true });
}
