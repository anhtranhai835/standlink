// Checks the MCP bridge end to end against a stub Standlink endpoint.
//   node electron/mcp-bridge-check.ts            → protocol check only (no agent, no tokens)
//   node electron/mcp-bridge-check.ts "<agent>"  → also asks a real ACP agent to call board() (spends a few tokens)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AcpAgent } from './acp.ts';

const bridgePath = path.join(import.meta.dirname, 'mcp-bridge.mjs');
const token = 'test-token';
const calls: { tool: string; memberId: string }[] = [];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.headers['x-standlink-token'] !== token) { res.writeHead(403); res.end('{}'); return; }
    const call = JSON.parse(raw);
    calls.push(call);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: 'codex | Codex | chỉ huy | Chờ lệnh\nkimi | Kimi | Đang làm | T-101 0/1 running: Sửa login' }));
  });
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const env = { STANDLINK_URL: `http://127.0.0.1:${port}/call`, STANDLINK_TOKEN: token, STANDLINK_PROJECT: 'p-test', STANDLINK_MEMBER: 'codex' };

// 1. Protocol check: initialize, tools/list, tools/call straight over stdio
const proc = spawn(process.execPath, [bridgePath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = new Map<number, any>();
createInterface({ input: proc.stdout! }).on('line', l => { const m = JSON.parse(l); replies.set(m.id, m); });
const rpc = (id: number, method: string, params: object = {}) => proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } });
rpc(2, 'tools/list');
rpc(3, 'tools/call', { name: 'board', arguments: {} });
await new Promise(r => setTimeout(r, 1500));
proc.kill();
console.assert(replies.get(1)?.result?.serverInfo?.name === 'standlink', 'initialize failed');
console.assert(replies.get(2)?.result?.tools?.map((t: { name: string }) => t.name).join() === 'board,assign,ask,skill', 'tools/list wrong');
console.assert(String(replies.get(3)?.result?.content?.[0]?.text).includes('chỉ huy'), 'tools/call did not reach the app');
console.assert(calls[0]?.memberId === 'codex' && calls[0]?.tool === 'board', 'call identity wrong');
console.log('protocol check ok:', replies.size === 3 && calls.length === 1);

// 2. Optional: a real agent harness loads the bridge from ACP mcpServers and calls the tool
const agentCmd = process.argv[2];
if (agentCmd) {
  const before = calls.length;
  let text = '';
  const tools: string[] = [];
  const agent = new AcpAgent({
    onUpdate: u => {
      if (u.sessionUpdate === 'agent_message_chunk') text += (u.content as { text?: string })?.text ?? '';
      if (u.sessionUpdate === 'tool_call') tools.push(String(u.title));
    },
    onPermission: async req => {
      const allow = req.options.find(o => o.kind === 'allow_once');
      return allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' };
    },
    onExit: (code, err) => { if (code) console.log('agent exited', code, err.slice(-400)); },
  });
  agent.start(agentCmd, process.cwd());
  await agent.initialize();
  await agent.newSession(process.cwd(), [{
    name: 'standlink', command: process.execPath, args: [bridgePath],
    env: Object.entries(env).map(([name, value]) => ({ name, value })),
  }]);
  const stop = await agent.prompt('Call the standlink MCP tool "board" once, then reply with one short line naming the members it lists. Do nothing else.');
  console.log('agent stop:', stop, '| tool calls seen:', tools.join(' ; '), '| reply:', text.trim().slice(0, 200));
  console.log('bridge reached by agent:', calls.length > before);
  agent.kill();
}
server.close();
process.exit(0);
