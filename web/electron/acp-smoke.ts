// Smoke test against a real ACP agent: node electron/acp-smoke.ts "<agent command>" [cwd]
// Sends one tiny prompt and prints which session/update kinds arrive. Spends a few tokens of your quota.
import { AcpAgent } from './acp.ts';

const cmd = process.argv[2] ?? 'npx -y @agentclientprotocol/codex-acp';
const cwd = process.argv[3] ?? process.cwd();
const seen: Record<string, number> = {};
let text = '';

const agent = new AcpAgent({
  onUpdate: u => {
    seen[u.sessionUpdate] = (seen[u.sessionUpdate] ?? 0) + 1;
    if (u.sessionUpdate === 'agent_message_chunk') text += (u.content as { text?: string })?.text ?? '';
    if (u.sessionUpdate === 'usage_update') console.log('usage', JSON.stringify(u));
  },
  onPermission: async req => {
    console.log('permission asked:', req.toolCall?.title, '→ rejecting');
    const reject = req.options.find(o => o.kind.startsWith('reject'));
    return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
  },
  onExit: (code, err) => console.log('agent exited', code, err.slice(-500)),
});

agent.start(cmd, cwd);
const init = await agent.initialize();
console.log('initialize →', JSON.stringify(init).slice(0, 400));
const sid = await agent.newSession(cwd);
console.log('session', sid);
const stop = await agent.prompt('Reply with exactly the word OK and nothing else. Do not run tools.');
console.log('stopReason', stop, '| reply:', JSON.stringify(text.trim()), '| updates:', JSON.stringify(seen));
console.assert(stop === 'end_turn', 'expected end_turn');
agent.kill();
process.exit(0);
