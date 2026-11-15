// Standlink's MCP server, started by each agent's own harness over stdio (ACP session/new → mcpServers).
// It only forwards tool calls to the Standlink app over localhost; all team logic lives in the app.
// Tool descriptions are deliberately short: every agent pays for them in context on every turn.
import { createInterface } from 'node:readline';

const { STANDLINK_URL, STANDLINK_TOKEN, STANDLINK_PROJECT, STANDLINK_MEMBER } = process.env;

const TOOLS = [
  {
    name: 'board',
    description: 'Team members, their state and current tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'assign',
    description: 'Give a task to a team member. Keep the brief short.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'member id from board' },
        task: { type: 'string', description: 'one-line task title' },
        brief: { type: 'string', description: 'what to do, files, done criteria' },
        skills: { type: 'array', items: { type: 'string' }, description: 'skill names the member should load first' },
        effort: { type: 'string', description: 'reasoning effort for this task, e.g. low for chores, high for hard work' },
      },
      required: ['member', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask',
    description: 'Send a short question to a member; their answer comes back to you.',
    inputSchema: {
      type: 'object',
      properties: { member: { type: 'string' }, message: { type: 'string' } },
      required: ['member', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill',
    description: 'Load the full instructions of a team skill by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function callApp(tool, args) {
  const res = await fetch(STANDLINK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-standlink-token': STANDLINK_TOKEN ?? '' },
    body: JSON.stringify({ projectId: STANDLINK_PROJECT, memberId: STANDLINK_MEMBER, tool, args }),
  });
  const body = await res.json().catch(() => ({ text: `Standlink trả về HTTP ${res.status}` }));
  return { text: String(body.text ?? ''), isError: !res.ok || !!body.isError };
}

createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no answer

  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'standlink', version: '0.1.0' } } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    try {
      const r = await callApp(params?.name, params?.arguments ?? {});
      send({ id, result: { content: [{ type: 'text', text: r.text }], isError: r.isError } });
    } catch (e) {
      send({ id, result: { content: [{ type: 'text', text: `Không gọi được Standlink: ${e.message}` }], isError: true } });
    }
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
