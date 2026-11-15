// Electron main process: owns one ACP agent process per (project, member) and streams its events to the UI.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { AcpAgent, AcpError, isRateLimit, type McpServerStdio, type PermissionOutcome } from './acp.ts';

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
interface PromptArgs { projectId: string; memberId: string; cmd: string; cwd: string; text: string }

const slots = new Map<string, Slot>();
const permissions = new Map<string, { key: string; resolve: (o: PermissionOutcome) => void }>();
let win: BrowserWindow | null = null;
let permSeq = 0;

const emit = (projectId: string, memberId: string, msg: object) =>
  win?.webContents.send('acp:event', { projectId, memberId, msg });

const errText = (err: unknown) =>
  err instanceof AcpError ? `${err.message}${err.data ? ` · ${String(typeof err.data === 'string' ? err.data : JSON.stringify(err.data)).slice(-600)}` : ''}` : String(err);

/** Reuse the running agent for this member, or start a new one (new command or folder = new process). */
function slotFor(projectId: string, memberId: string, cmd: string, cwd: string): Slot {
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
  const ready = agent.initialize().then(() => agent.newSession(cwd, teamTools(projectId, memberId))).then(() => undefined);
  ready.catch(() => { if (slots.get(key)?.agent === agent) { slots.delete(key); agent.kill(); } });
  const slot: Slot = { agent, ready, queue: Promise.resolve(), cmd, cwd };
  slots.set(key, slot);
  return slot;
}

function cancelPermissions(key: string) {
  for (const [id, p] of permissions) if (p.key === key) { p.resolve({ outcome: 'cancelled' }); permissions.delete(id); }
}

ipcMain.handle('acp:prompt', (_e, a: PromptArgs) => {
  const slot = slotFor(a.projectId, a.memberId, a.cmd, a.cwd);
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
