// Electron main process: owns one ACP agent process per (project, member) and streams its events to the UI.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AcpAgent, AcpError, isRateLimit, type McpServerStdio, type PermissionOutcome } from './acp.ts';
import { deleteSkill, listSkills, projectDir, readSkill, saveSkill } from './skills.ts';

const appSkillsDir = () => path.join(app.getPath('userData'), 'skills');

// ---------- team tools: agent harness → mcp-bridge.mjs → this localhost endpoint → UI ----------
const bridgeToken = randomBytes(16).toString('hex');
let bridgePort = 0;
let callSeq = 0;
const mcpCalls = new Map<string, (r: { text: string; isError?: boolean }) => void>();

const bridgeServer = createServer((req, res) => {
  const reply = (status: number, body: object) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST' || req.url !== '/call' || req.headers['x-standlink-token'] !== bridgeToken) return reply(403, { text: 'forbidden', isError: true });
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 64_000) req.destroy(); });
  req.on('end', () => {
    let call: { projectId: string; memberId: string; tool: string; args: object };
    try { call = JSON.parse(raw); } catch { return reply(400, { text: 'bad json', isError: true }); }
    // `skill` is answered here from disk; board/assign/ask need team state, which lives in the UI.
    if (call.tool === 'skill') {
      const name = String((call.args as { name?: unknown }).name ?? '').trim();
      const cwd = slots.get(`${call.projectId}/${call.memberId}`)?.cwd;
      readSkill(appSkillsDir(), cwd, name)
        .then(body => reply(200, body ? { text: body } : { text: `Không có skill "${name}".`, isError: true }))
        .catch(e => reply(500, { text: String(e), isError: true }));
      return;
    }
    const callId = `mcp-${++callSeq}`;
    const timer = setTimeout(() => { mcpCalls.delete(callId); reply(504, { text: 'Standlink không phản hồi kịp.', isError: true }); }, 30_000);
    mcpCalls.set(callId, r => { clearTimeout(timer); reply(200, r); });
    win?.webContents.send('mcp:call', { callId, ...call });
  });
});

ipcMain.handle('mcp:reply', (_e, a: { callId: string; text: string; isError?: boolean }) => {
  mcpCalls.get(a.callId)?.({ text: a.text, isError: a.isError });
  mcpCalls.delete(a.callId);
});

/** MCP server entry handed to every agent session, so its own harness gains board/assign/ask. */
const teamTools = (projectId: string, memberId: string): McpServerStdio[] => bridgePort ? [{
  name: 'standlink',
  command: process.execPath, // Electron itself runs the bridge as plain Node: no separate Node install needed
  args: [path.join(__dirname, 'mcp-bridge.mjs')],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'STANDLINK_URL', value: `http://127.0.0.1:${bridgePort}/call` },
    { name: 'STANDLINK_TOKEN', value: bridgeToken },
    { name: 'STANDLINK_PROJECT', value: projectId },
    { name: 'STANDLINK_MEMBER', value: memberId },
  ],
}] : [];

interface Slot { agent: AcpAgent; ready: Promise<void>; queue: Promise<unknown>; cmd: string; cwd: string }
/** Saved choices for this member (model, reasoning effort…), keyed by ACP config option id. */
type Prefs = Record<string, string>;
interface StartArgs { projectId: string; memberId: string; cmd: string; cwd: string; prefs?: Prefs }
interface PromptArgs extends StartArgs { text: string }

const slots = new Map<string, Slot>();
const permissions = new Map<string, { key: string; resolve: (o: PermissionOutcome) => void }>();
let win: BrowserWindow | null = null;
let permSeq = 0;

const emit = (projectId: string, memberId: string, msg: object) =>
  win?.webContents.send('acp:event', { projectId, memberId, msg });

const errText = (err: unknown) =>
  err instanceof AcpError ? `${err.message}${err.data ? ` · ${String(typeof err.data === 'string' ? err.data : JSON.stringify(err.data)).slice(-600)}` : ''}` : String(err);

/** Reuse the running agent for this member, or start a new one (new command or folder = new process). */
function slotFor({ projectId, memberId, cmd, cwd, prefs = {} }: StartArgs): Slot {
  const key = `${projectId}/${memberId}`;
  const old = slots.get(key);
  if (old && old.cmd === cmd && old.cwd === cwd) return old;
  old?.agent.kill();

  const agent = new AcpAgent({
    onUpdate: update => emit(projectId, memberId, { type: 'update', update }),
    onPermission: req => new Promise(resolve => {
      const reqId = `perm-${++permSeq}`;
      permissions.set(reqId, { key, resolve });
      emit(projectId, memberId, { type: 'permission', reqId, title: req.toolCall?.title ?? req.toolCall?.kind ?? 'một thao tác', options: req.options });
    }),
    onExit: (code, stderr) => {
      if (slots.get(key)?.agent === agent) slots.delete(key);
      emit(projectId, memberId, { type: 'exit', code, stderr: stderr.slice(-1500) });
    },
  });
  agent.start(cmd, cwd);
  const ready = (async () => {
    await agent.initialize();
    await agent.newSession(cwd, teamTools(projectId, memberId));
    // re-apply the member's saved model / effort; skip anything this agent does not offer
    for (const [configId, value] of Object.entries(prefs)) {
      const opt = agent.configOptions.find(o => o.id === configId);
      if (opt && opt.currentValue !== value) await agent.setConfigOption(configId, value).catch(() => undefined);
    }
    emit(projectId, memberId, { type: 'config', options: agent.configOptions });
  })();
  ready.catch(() => { if (slots.get(key)?.agent === agent) { slots.delete(key); agent.kill(); } });
  const slot: Slot = { agent, ready, queue: Promise.resolve(), cmd, cwd };
  slots.set(key, slot);
  return slot;
}

function cancelPermissions(key: string) {
  for (const [id, p] of permissions) if (p.key === key) { p.resolve({ outcome: 'cancelled' }); permissions.delete(id); }
}

/** Start the agent without prompting (no tokens), so its model / effort choices show up in the UI. */
ipcMain.handle('acp:start', (_e, a: StartArgs) => {
  const slot = slotFor(a);
  slot.ready
    .then(() => emit(a.projectId, a.memberId, { type: 'config', options: slot.agent.configOptions }))
    .catch(err => emit(a.projectId, a.memberId, { type: 'error', message: errText(err), rateLimit: false }));
});

ipcMain.handle('acp:config', async (_e, a: { projectId: string; memberId: string; configId: string; value: string }) => {
  const slot = slots.get(`${a.projectId}/${a.memberId}`);
  if (!slot) return;
  try {
    await slot.ready;
    emit(a.projectId, a.memberId, { type: 'config', options: await slot.agent.setConfigOption(a.configId, a.value) });
  } catch (err) {
    emit(a.projectId, a.memberId, { type: 'error', message: `Không đổi được ${a.configId}: ${errText(err)}`, rateLimit: false });
  }
});

ipcMain.handle('skills:list', (_e, cwd?: string) => listSkills(appSkillsDir(), cwd || undefined));
ipcMain.handle('skills:save', (_e, a: { name: string; description: string; body: string; cwd?: string }) =>
  saveSkill(a.cwd ? projectDir(a.cwd) : appSkillsDir(), a.name, a.description, a.body));
ipcMain.handle('skills:delete', (_e, a: { name: string; cwd?: string }) =>
  deleteSkill(a.cwd ? projectDir(a.cwd) : appSkillsDir(), a.name));

ipcMain.handle('acp:prompt', (_e, a: PromptArgs) => {
  const slot = slotFor(a);
  // An ACP session runs one prompt turn at a time: queue the rest behind it.
  slot.queue = slot.queue
    .then(() => slot.ready)
    .then(() => slot.agent.prompt(a.text))
    .then(stopReason => emit(a.projectId, a.memberId, { type: 'turn-end', stopReason }))
    .catch(err => emit(a.projectId, a.memberId, { type: 'error', message: errText(err), rateLimit: isRateLimit(err) }));
  return null; // results stream back as acp:event
});

ipcMain.handle('acp:cancel', (_e, a: { projectId: string; memberId: string }) => {
  const key = `${a.projectId}/${a.memberId}`;
  cancelPermissions(key);
  slots.get(key)?.agent.cancel();
});

ipcMain.handle('acp:permission', (_e, a: { reqId: string; optionId: string | null }) => {
  const p = permissions.get(a.reqId);
  if (!p) return;
  permissions.delete(a.reqId);
  p.resolve(a.optionId ? { outcome: 'selected', optionId: a.optionId } : { outcome: 'cancelled' });
});

ipcMain.handle('acp:stop', (_e, a: { projectId: string; memberId: string }) => {
  const key = `${a.projectId}/${a.memberId}`;
  cancelPermissions(key);
  slots.get(key)?.agent.kill();
  slots.delete(key);
});

/**
 * Optional user config: ~/.standlink/providers.json = [{ "id", "name", "cmd" }].
 * Lets you keep your agent list in a file (and in dotfiles) instead of typing it in the UI.
 * Nothing here is built in: a missing or broken file just means no extra providers.
 */
ipcMain.handle('config:providers', async () => {
  try {
    const raw = JSON.parse(await readFile(path.join(os.homedir(), '.standlink', 'providers.json'), 'utf8'));
    return Array.isArray(raw)
      ? raw.filter(p => p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.cmd === 'string')
      : [];
  } catch {
    return [];
  }
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: 'Standlink', backgroundColor: '#0b0612', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (process.argv.includes('--dev')) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  // localhost only, random port, token-checked: other machines and other local apps cannot drive the team
  bridgeServer.listen(0, '127.0.0.1', () => {
    const addr = bridgeServer.address();
    bridgePort = typeof addr === 'object' && addr ? addr.port : 0;
  });
  createWindow();
});
app.on('window-all-closed', () => {
  for (const s of slots.values()) s.agent.kill();
  app.quit();
});
