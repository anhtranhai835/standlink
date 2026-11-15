// One git worktree per worker agent, so agents working in parallel never edit the same files.
// Worktrees live in <repo>/.standlink/worktrees/<member>, each on its own branch standlink/<member>.
// The leader stays in the project folder and merges those branches back.
import { execFile } from 'node:child_process';
import { appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim();

export interface Workspace { cwd: string; branch?: string }

/** A git repo with at least one commit: the only kind of folder a worktree can branch from. */
export async function canIsolate(dir: string): Promise<boolean> {
  try { await git(dir, 'rev-parse', '--verify', 'HEAD'); return true; } catch { return false; }
}

/** Branch-safe name for a member id. */
const safe = (id: string) => id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'agent';

/**
 * The folder this member's agent should run in. Outside a git repo (or before the first commit) that is just `dir`.
 * Otherwise a worktree on branch standlink/<member>, created from the current HEAD the first time, reused after that.
 */
export async function ensureWorktree(dir: string, memberId: string): Promise<Workspace> {
  if (!(await canIsolate(dir))) return { cwd: dir };
  const root = path.resolve(await git(dir, 'rev-parse', '--show-toplevel'));
  const sub = path.relative(root, path.resolve(dir)); // the project may be a subfolder of the repo
  const name = safe(memberId);
  const branch = `standlink/${name}`;
  const wt = path.join(root, '.standlink', 'worktrees', name);

  const exists = await stat(wt).then(() => true, () => false);
  if (!exists) {
    await git(root, 'worktree', 'prune'); // forget worktrees whose folder was deleted by hand
    const hasBranch = await git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);
    await git(root, 'worktree', 'add', ...(hasBranch ? [wt, branch] : ['-b', branch, wt, 'HEAD']));
  }
  await ignoreLocally(root);
  return { cwd: path.join(wt, sub), branch };
}

/** Keep the worktrees out of `git status` without touching the user's .gitignore (info/exclude is never committed). */
async function ignoreLocally(root: string) {
  const common = path.resolve(root, await git(root, 'rev-parse', '--git-common-dir'));
  const file = path.join(common, 'info', 'exclude');
  const line = '.standlink/worktrees/';
  const cur = await readFile(file, 'utf8').catch(() => '');
  if (!cur.split(/\r?\n/).includes(line)) await appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
}
