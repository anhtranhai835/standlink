// A scripted ACP agent for trying Standlink without spending real quota.
// Register it as a provider with the command:  node <path-to>/electron/fake-agent.mjs
// Any prompt containing "limit" fails with a rate-limit error, to exercise the handoff.
import { createInterface } from 'node:readline';

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pending = new Map();
let nextId = 1000;
let used = 2000;

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise(resolve => pending.set(id, resolve));
}

async function promptTurn(id, { sessionId, prompt }) {
  const text = prompt.map(b => b.text ?? '').join(' ');
  const plan = ['Đọc code liên quan', 'Sửa file', 'Chạy test'];
  const entries = done => plan.map((content, i) => ({ content, priority: 'medium', status: i < done ? 'completed' : 'pending' }));

  update(sessionId, { sessionUpdate: 'plan', entries: entries(0) });
  await sleep(700);
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Đọc src/auth/refresh.ts', kind: 'read', status: 'completed', locations: [{ path: 'src/auth/refresh.ts' }] });
  update(sessionId, { sessionUpdate: 'plan', entries: entries(1) });
  await sleep(700);

  if (/limit/i.test(text)) {
    used += 9000;
    update(sessionId, { sessionUpdate: 'usage_update', used, size: 200000 });
    send({ id, error: { code: -32000, message: 'Rate limit reached: usage limit for this plan, resets in 4h12m' } });
    return;
  }

  const res = await ask('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 't2', title: 'Sửa src/auth/refresh.ts', kind: 'edit' },
    options: [
      { optionId: 'allow', name: 'Cho phép', kind: 'allow_once' },
      { optionId: 'reject', name: 'Từ chối', kind: 'reject_once' },
    ],
  });
  const allowed = res?.outcome?.outcome === 'selected' && res.outcome.optionId === 'allow';
  if (allowed) update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Sửa src/auth/refresh.ts', kind: 'edit', status: 'completed', locations: [{ path: 'src/auth/refresh.ts' }] });
  update(sessionId, { sessionUpdate: 'plan', entries: entries(allowed ? 3 : 1) });

  const reply = allowed ? `Xong: đã xử lý "${text.slice(0, 60)}".` : 'Bạn từ chối quyền sửa file nên mình dừng ở bước đọc code.';
  for (const word of reply.split(' ')) { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: word + ' ' } }); await sleep(60); }
  used += 3000;
  update(sessionId, { sessionUpdate: 'usage_update', used, size: 200000 });
  send({ id, result: { stopReason: 'end_turn' } });
}

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) { pending.get(msg.id)?.(msg.result); pending.delete(msg.id); return; }
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-agent', version: '0.1.0' }, agentCapabilities: {} } });
  else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: `fake-${Date.now()}` } });
  else if (msg.method === 'session/prompt') promptTurn(msg.id, msg.params);
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});
