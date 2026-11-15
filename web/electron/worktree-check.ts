// Self-check for worktree.ts against a throwaway repo: node electron/worktree-check.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canIsolate, ensureWorktree } from './worktree.ts';

const dir = mkdtempSync(path.join(os.tmpdir(), 'standlink-wt-'));
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
try {
  assert.equal(await canIsolate(dir), false); // not a repo
  assert.deepEqual(await ensureWorktree(dir, 'codex'), { cwd: dir });

  git('init', '-q');
  assert.equal(await canIsolate(dir), false); // repo without a commit
  writeFileSync(path.join(dir, 'a.txt'), 'hi');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');

  const a = await ensureWorktree(dir, 'Codex #2');
  assert.equal(a.branch, 'standlink/codex-2');
  assert.equal(readFileSync(path.join(a.cwd, 'a.txt'), 'utf8'), 'hi');
  assert.deepEqual(await ensureWorktree(dir, 'Codex #2'), a); // reused, not recreated
  assert.notEqual((await ensureWorktree(dir, 'claude')).cwd, a.cwd); // each member its own folder
  assert.equal(git('status', '--porcelain'), ''); // worktrees stay out of git status
  console.log('worktree ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
