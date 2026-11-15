// UI state driven by events. The demo script below emits the same event shapes the
// ACP backend will emit later, so the UI does not change when real agents are wired in.

export type ProviderId = string;

/** A coding-agent CLI the user registered. cmd = the command that speaks ACP over stdio. */
export interface Provider { id: ProviderId; name: string; cmd: string }

export const slug = (name: string) =>
  name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';

/** One agent session in the team. Several members can share a provider (sub-agents). */
export interface Member { id: string; provider: ProviderId; label: string }
export type AgentId = string;

export const MIN_TEAM = 4; // orchestrator + 3 workers: only the offline demo script needs this many
export const MAX_TEAM = 8;

/** Next member for a provider: "Codex", then "Codex #2", "Codex #3"... */
export function newMember(team: Member[], provider: Provider): Member {
  const same = team.filter(m => m.provider === provider.id).length;
  let n = same + 1, id = same ? `${provider.id}-${n}` : provider.id;
  while (team.some(m => m.id === id)) id = `${provider.id}-${++n}`;
  return { id, provider: provider.id, label: same ? `${provider.name} #${n}` : provider.name };
}

export type AgentState = 'idle' | 'working' | 'blocked' | 'limited';

export interface Agent {
  state: AgentState;
  quota: number;
  tokens: number;
  task?: string;
  label?: string;
  file?: string;
  resetIn?: string;
  draft?: string; // reply being streamed right now
  config?: ConfigOption[]; // what this agent lets you choose (from ACP session/new)
  ctx?: number; // % of the context window used (from ACP usage_update)
  act?: { kind: 'special' | 'finisher'; key: number };
}
export interface Checkpoint { tokens: number; replay: number; notes: string[] }
export interface Task {
  id: string; title: string; total: number; done: number;
  owner: AgentId | null; status: 'running' | 'paused' | 'done'; cp?: Checkpoint; hit: number;
  // Recorded by Standlink from ACP events, so a handoff note costs the tired agent zero tokens.
  request?: string; steps?: string[]; files?: string[]; last?: string;
  by?: AgentId; // who assigned it (gets a one-line report when it finishes)
}
export interface LogItem { key: number; kind: 'narrate' | 'say' | 'step' | 'sfx' | 'user'; agent?: AgentId; to?: AgentId; text: string; sfx?: string }
export interface Fx { kind: 'title' | 'timestop' | 'tbc' | 'handoff' | 'clear'; text: string; sub?: string; key: number }
/** An ACP session config option (model, reasoning effort…) as the agent advertises it. */
export interface ConfigOption {
  id: string; name: string; category?: string; currentValue?: string;
  options?: ({ value: string; name: string } | { name?: string; options: { value: string; name: string }[] })[];
}
export interface PermOption { optionId: string; name: string; kind: string }
export interface Flight { from: AgentId; to: AgentId; text: string; kind: 'say' | 'scroll'; key: number }

export type Ev =
  | { t: 'narrate'; text: string }
  | { t: 'task.new'; id: string; title: string; total: number; to: AgentId; by?: AgentId; request?: string }
  | { t: 'step'; agent: AgentId; label: string; file: string; tokens: number; quota: number }
  | { t: 'say'; from: AgentId; to: AgentId; text: string }
  | { t: 'permission'; agent: AgentId; text: string; reqId?: string; options?: PermOption[] }
  | { t: 'limited'; agent: AgentId; resetIn: string }
  | { t: 'checkpoint'; agent: AgentId; tokens: number; replay: number; notes: string[] }
  | { t: 'handoff'; from: AgentId; to: AgentId }
  | { t: 'done'; agent: AgentId }
  // Real ACP sessions (mapped from session/update and prompt results)
  | { t: 'user.msg'; to: AgentId; text: string }
  | { t: 'turn.start'; agent: AgentId; text: string; quiet?: boolean } // quiet: a message, not new work
  | { t: 'stream'; agent: AgentId; text: string }
  | { t: 'activity'; agent: AgentId; label: string; file?: string }
  | { t: 'plan'; agent: AgentId; total: number; done: number }
  | { t: 'usage'; agent: AgentId; used: number; size: number }
  | { t: 'turn.end'; agent: AgentId; stopReason: string }
  | { t: 'agent.error'; agent: AgentId; text: string }
  | { t: 'config'; agent: AgentId; options: ConfigOption[] };
export type Action = Ev
  | { t: 'perm.answer'; ok: boolean } | { t: 'land'; key: number }
  | { t: 'start'; mission: string } | { t: 'orch'; orch: AgentId }
  | { t: 'member.add'; member: Member } | { t: 'member.remove'; id: AgentId } | { t: 'fx.done' } | { t: 'quiet' }
  | { t: 'access'; agent: AgentId; mode: Access } | { t: 'ask'; to: AgentId; text: string };

/** Orca-style access mode per agent: 'ask' = permission requests wait for you, 'full' = auto-approve. */
export type Access = 'ask' | 'full';

export interface World {
  team: Member[];
  agents: Record<AgentId, Agent>;
  tasks: Record<string, Task>;
  log: LogItem[];
  fx: Fx | null;
  flights: Flight[];
  perm: { agent: AgentId; text: string; reqId?: string; options?: PermOption[] } | null;
  saved: number;
  part: number;
  orch: AgentId;
  mission: string;
  access: Record<AgentId, Access>;
}

let seq = 0;
const k = () => ++seq;

const freshAgent = (_m: Member): Agent => ({ state: 'idle', quota: 100, tokens: 0 });

export const initialWorld = (team: Member[], orch: AgentId = team[0]?.id ?? ''): World => ({
  team, orch, mission: '',
  access: Object.fromEntries(team.map(m => [m.id, 'ask' as Access])),
  agents: Object.fromEntries(team.map(m => [m.id, freshAgent(m)])),
  tasks: {}, log: [], fx: null, flights: [], perm: null, saved: 0, part: 0,
});

export function reduce(w: World, a: Action): World {
  const log = (item: Omit<LogItem, 'key'>) => [{ ...item, key: k() }, ...w.log].slice(0, 120);
  const patch = (agents: Record<AgentId, Agent>, id: AgentId, p: Partial<Agent>) => ({ ...agents, [id]: { ...agents[id], ...p } });
  const NAME = (id: AgentId) => w.team.find(m => m.id === id)?.label ?? id;

  switch (a.t) {
    case 'orch': return { ...w, orch: a.orch };
    case 'fx.done': return { ...w, fx: null };
    case 'access': return { ...w, access: { ...w.access, [a.agent]: a.mode } };
    case 'ask': // you message one agent directly from its pane
      return {
        ...w,
        log: ([
          { key: k(), kind: 'say', agent: a.to, to: undefined, text: w.agents[a.to]?.task ? 'Đã nhận. Mình làm xong bước hiện tại rồi xử lý.' : 'Đã nhận. Đang rảnh, làm ngay.' },
          { key: k(), kind: 'user', to: a.to, text: a.text },
          ...w.log,
        ] as LogItem[]).slice(0, 120),
      };
    case 'user.msg': return { ...w, log: log({ kind: 'user', to: a.to, text: a.text }) };
    case 'turn.start': {
      const cur = w.agents[a.agent].task ? w.tasks[w.agents[a.agent].task!] : undefined;
      if (a.quiet && (!cur || cur.status === 'done')) {
        return { ...w, agents: patch(w.agents, a.agent, { state: 'working', label: 'Đọc tin…', draft: '' }) };
      }
      if (cur && cur.status !== 'done') {
        return { ...w, agents: patch(w.agents, a.agent, { state: 'working', label: 'Đang nghĩ…', draft: '' }), tasks: { ...w.tasks, [cur.id]: { ...cur, status: 'running' } } };
      }
      let n = 101 + Object.keys(w.tasks).length;
      while (w.tasks[`T-${n}`]) n++;
      const id = `T-${n}`, part = w.part + 1;
      const title = a.text.length > 60 ? `${a.text.slice(0, 57)}…` : a.text;
      return {
        ...w, part,
        tasks: { ...w.tasks, [id]: { id, title, total: 1, done: 0, owner: a.agent, status: 'running', hit: 0, request: a.text, steps: [], files: [] } },
        agents: patch(w.agents, a.agent, { state: 'working', task: id, label: 'Đang nghĩ…', file: '', draft: '' }),
        fx: { kind: 'title', text: `PART ${part}`, sub: `${id} · ${title}`, key: k() },
      };
    }
    case 'stream': return { ...w, agents: patch(w.agents, a.agent, { draft: (w.agents[a.agent].draft ?? '') + a.text, label: 'Đang trả lời…' }) };
    case 'activity': {
      const tid = w.agents[a.agent].task, t = tid ? w.tasks[tid] : undefined;
      const tasks = t ? {
        ...w.tasks,
        [t.id]: { ...t, hit: t.hit + 1, steps: [...(t.steps ?? []), a.label].slice(-20), files: a.file && !(t.files ?? []).includes(a.file) ? [...(t.files ?? []), a.file] : t.files },
      } : w.tasks;
      return { ...w, tasks, agents: patch(w.agents, a.agent, { label: a.label, file: a.file ?? '' }), log: log({ kind: 'step', agent: a.agent, text: a.label }) };
    }
    case 'plan': {
      const tid = w.agents[a.agent].task, t = tid ? w.tasks[tid] : undefined;
      return t ? { ...w, tasks: { ...w.tasks, [t.id]: { ...t, total: Math.max(1, a.total), done: a.done, hit: t.hit + 1 } } } : w;
    }
    case 'usage': return { ...w, agents: patch(w.agents, a.agent, { tokens: a.used, ctx: a.size ? Math.round((a.used / a.size) * 100) : undefined }) };
    case 'turn.end': {
      const ag = w.agents[a.agent], tid = ag.task, t = tid ? w.tasks[tid] : undefined;
      const reply = (ag.draft ?? '').trim();
      const ok = a.stopReason === 'end_turn';
      const tasks = t ? { ...w.tasks, [t.id]: { ...t, last: reply.slice(-400) || t.last, status: ok ? 'done' as const : 'paused' as const, done: ok ? t.total : t.done, hit: t.hit + 1 } } : w.tasks;
      return {
        ...w, tasks,
        agents: patch(w.agents, a.agent, { state: 'idle', draft: '', label: ok ? 'Xong' : `Dừng (${a.stopReason})`, act: ok ? { kind: 'finisher', key: k() } : ag.act }),
        log: reply ? log({ kind: 'say', agent: a.agent, text: reply }) : w.log,
        fx: ok && t ? { kind: 'clear', text: 'TASK CLEAR', sub: `${t.id} · ${t.title}`, key: k() } : w.fx,
      };
    }
    case 'agent.error':
      return { ...w, agents: patch(w.agents, a.agent, { state: 'idle', draft: '', label: 'Lỗi' }), log: log({ kind: 'sfx', agent: a.agent, sfx: '！', text: a.text }) };
    case 'config': return w.agents[a.agent] ? { ...w, agents: patch(w.agents, a.agent, { config: a.options }) } : w;
    case 'quiet': return { ...w, fx: null, flights: [] }; // drop effects that piled up while the session ran in the background
    case 'member.add':
      return { ...w, orch: w.orch || a.member.id, team: [...w.team, a.member], agents: { ...w.agents, [a.member.id]: freshAgent(a.member) }, access: { ...w.access, [a.member.id]: 'ask' } };
    case 'member.remove': {
      if (a.id === w.orch || w.agents[a.id]?.task) return w; // never drop the leader or someone mid-task
      const agents = { ...w.agents };
      delete agents[a.id];
      return { ...w, team: w.team.filter(m => m.id !== a.id), agents };
    }
    case 'start': {
      const fresh = initialWorld(w.team, w.orch);
      return { ...fresh, access: w.access, mission: a.mission, log: [{ key: k(), kind: 'user', to: w.orch, text: a.mission }] };
    }
    case 'land': return { ...w, flights: w.flights.filter(f => f.key !== a.key) };
    case 'narrate': return { ...w, log: log({ kind: 'narrate', text: a.text }) };

    case 'task.new': {
      const part = w.part + 1;
      return {
        ...w, part,
        tasks: { ...w.tasks, [a.id]: { id: a.id, title: a.title, total: a.total, done: 0, owner: a.to, status: 'running', hit: 0, by: a.by, request: a.request, steps: [], files: [] } },
        agents: patch(w.agents, a.to, { state: 'working', task: a.id, label: 'Nhận task', file: '' }),
        fx: { kind: 'title', text: `PART ${part}`, sub: `${a.id} · ${a.title}`, key: k() },
        log: log({ kind: 'sfx', agent: a.to, sfx: 'ゴゴゴ', text: `${a.id} → ${NAME(a.to)}: ${a.title}` }),
      };
    }
    case 'step': {
      const t = w.agents[a.agent].task ? w.tasks[w.agents[a.agent].task!] : undefined;
      const tasks = t ? { ...w.tasks, [t.id]: { ...t, done: Math.min(t.total, t.done + 1), hit: t.hit + 1 } } : w.tasks;
      return {
        ...w, tasks,
        agents: patch(w.agents, a.agent, { state: 'working', label: a.label, file: a.file, tokens: a.tokens, quota: a.quota }),
        log: log({ kind: 'step', agent: a.agent, text: `${t ? `${Math.min(t.total, t.done + 1)}/${t.total} · ` : ''}${a.label}` }),
      };
    }
    case 'say':
      return {
        ...w,
        flights: [...w.flights, { from: a.from, to: a.to, text: a.text, kind: 'say', key: k() }],
        agents: patch(w.agents, a.from, { act: { kind: 'special', key: k() } }),
        log: log({ kind: 'say', agent: a.from, to: a.to, text: a.text }),
      };
    case 'permission':
      if (w.access[a.agent] === 'full') return { ...w, log: log({ kind: 'step', agent: a.agent, text: `Tự duyệt (toàn quyền): ${a.text}` }) };
      return {
        ...w, perm: { agent: a.agent, text: a.text, reqId: a.reqId, options: a.options },
        agents: patch(w.agents, a.agent, { state: 'blocked' }),
        log: log({ kind: 'sfx', agent: a.agent, sfx: 'ゴゴゴゴ', text: `${NAME(a.agent)} xin phép: ${a.text}` }),
      };
    case 'perm.answer': {
      if (!w.perm) return w;
      const id = w.perm.agent;
      return {
        ...w, perm: null,
        agents: patch(w.agents, id, { state: 'working' }),
        log: log({ kind: 'narrate', text: a.ok ? `Bạn cho phép. ${NAME(id)} làm tiếp.` : `Bạn từ chối. ${NAME(id)} bỏ qua bước đó.` }),
      };
    }
    case 'limited': {
      const id = w.agents[a.agent].task;
      return {
        ...w,
        tasks: id ? { ...w.tasks, [id]: { ...w.tasks[id], status: 'paused' } } : w.tasks,
        agents: patch(w.agents, a.agent, { state: 'limited', quota: 0, resetIn: a.resetIn }),
        fx: { kind: 'timestop', text: 'TIME STOP', sub: `${NAME(a.agent)} hết quota · reset sau ${a.resetIn}`, key: k() },
        log: log({ kind: 'sfx', agent: a.agent, sfx: '停止', text: `${NAME(a.agent)} chạm rate limit. Reset sau ${a.resetIn}.` }),
      };
    }
    case 'checkpoint': {
      const id = w.agents[a.agent].task;
      if (!id) return w;
      return {
        ...w,
        tasks: { ...w.tasks, [id]: { ...w.tasks[id], cp: { tokens: a.tokens, replay: a.replay, notes: a.notes } } },
        fx: { kind: 'tbc', text: 'TO BE CONTINUED', sub: `${NAME(a.agent)} ghi checkpoint ${a.tokens} token`, key: k() },
        log: log({ kind: 'sfx', agent: a.agent, sfx: 'カキカキ', text: `Checkpoint ${a.tokens} tok: ${a.notes.join(' · ')}` }),
      };
    }
    case 'handoff': {
      const id = w.agents[a.from].task;
      if (!id) return w;
      const cp = w.tasks[id].cp;
      let agents = patch(w.agents, a.from, { task: undefined, label: undefined, file: undefined });
      agents = patch(agents, a.to, { state: 'working', task: id, label: 'Đọc checkpoint', file: '', act: { kind: 'special', key: k() } });
      return {
        ...w, agents,
        tasks: { ...w.tasks, [id]: { ...w.tasks[id], owner: a.to, status: 'running' } },
        saved: w.saved + (cp ? cp.replay - cp.tokens : 0),
        flights: [...w.flights, { from: a.from, to: a.to, text: `📜 ${cp?.tokens ?? 0} tok`, kind: 'scroll', key: k() }],
        fx: {
          kind: 'handoff', text: 'HANDOFF',
          sub: `${NAME(a.from)} ⟶ ${NAME(a.to)} · đọc ${cp?.tokens ?? 0} tok thay vì ${cp?.replay.toLocaleString() ?? '?'}`, key: k(),
        },
        log: log({ kind: 'sfx', agent: a.to, sfx: '◀◀', text: `${NAME(a.to)} nhận ${id} từ ${NAME(a.from)}, làm tiếp từ bước ${w.tasks[id].done + 1}.` }),
      };
    }
    case 'done': {
      const id = w.agents[a.agent].task;
      if (!id) return w;
      const t = w.tasks[id];
      return {
        ...w,
        tasks: { ...w.tasks, [id]: { ...t, done: t.total, status: 'done', hit: t.hit + 1 } },
        agents: patch(w.agents, a.agent, { state: 'idle', label: 'Xong', file: '', act: { kind: 'finisher', key: k() } }),
        fx: { kind: 'clear', text: 'TASK CLEAR', sub: `${id} · ${t.title}`, key: k() },
        log: log({ kind: 'sfx', agent: a.agent, sfx: 'ドォーン', text: `${NAME(a.agent)} xong ${id}.` }),
      };
    }
  }
}

/**
 * Demo script built from roles, so any member can be the orchestrator (O).
 * W1 runs out of quota mid-task and hands off to O. Extra sub-agents get a review task each.
 * [delay ms before the event, event]. The player pauses on 'permission' until the user answers.
 */
export function demoScript(team: Member[], O: AgentId): [number, Ev][] {
  const name = (id: AgentId) => team.find(m => m.id === id)!.label;
  const [W1, W2, W3, ...extra] = team.map(m => m.id).filter(id => id !== O);
  const reviews: [number, Ev][] = extra.flatMap((id, i): [number, Ev][] => [
    [900, { t: 'say', from: O, to: id, text: `T-${150 + i}: review diff của T-142.` }],
    [600, { t: 'task.new', id: `T-${150 + i}`, title: 'Review diff auth', total: 2, to: id }],
  ]);
  const reviewWork: [number, Ev][] = extra.flatMap((id): [number, Ev][] => [
    [900, { t: 'step', agent: id, label: 'Đọc diff', file: 'src/auth/refresh.ts', tokens: 1100, quota: 70 }],
    [800, { t: 'step', agent: id, label: 'Ghi nhận xét', file: 'review.md', tokens: 1600, quota: 69 }],
    [700, { t: 'done', agent: id }],
  ]);
  return [
    [600, { t: 'narrate', text: `${name(O)} (chỉ huy) đọc lệnh và chia việc cho ${team.length - 1} Stand.` }],
    [1000, { t: 'say', from: O, to: W1, text: 'T-142 cho cậu: sửa auth refresh, 5 bước.' }],
    [700, { t: 'task.new', id: 'T-142', title: 'Sửa auth refresh token', total: 5, to: W1 }],
    [2000, { t: 'say', from: O, to: W2, text: 'T-143: viết test e2e cho login.' }],
    [700, { t: 'task.new', id: 'T-143', title: 'Test e2e login', total: 4, to: W2 }],
    [2000, { t: 'say', from: O, to: W3, text: 'T-144: đổi màu nút Login theo design.' }],
    [700, { t: 'task.new', id: 'T-144', title: 'Đổi màu nút Login', total: 2, to: W3 }],
    ...reviews,
    [2200, { t: 'step', agent: W1, label: 'Đọc luồng refresh', file: 'src/auth/refresh.ts', tokens: 3200, quota: 14 }],
    [1100, { t: 'step', agent: W2, label: 'Dựng fixture user', file: 'tests/e2e/fixtures.ts', tokens: 2100, quota: 72 }],
    [1100, { t: 'step', agent: W3, label: 'Sửa màu nút', file: 'src/ui/LoginButton.tsx', tokens: 900, quota: 56 }],
    [1500, { t: 'step', agent: W1, label: 'Thêm retry khi gặp 401', file: 'src/auth/refresh.ts', tokens: 6100, quota: 8 }],
    [1200, { t: 'step', agent: W3, label: 'Kiểm tra contrast', file: 'src/ui/LoginButton.tsx', tokens: 1400, quota: 55 }],
    [1200, { t: 'done', agent: W3 }],
    ...reviewWork,
    [2200, { t: 'say', from: W2, to: W1, text: 'refresh() trả về gì khi refresh token chết?' }],
    [2200, { t: 'say', from: W1, to: W2, text: 'Ném AuthExpired. Bắt nó rồi redirect /login.' }],
    [2000, { t: 'step', agent: W2, label: 'Viết case token hết hạn', file: 'tests/e2e/login.spec.ts', tokens: 3900, quota: 66 }],
    [1400, { t: 'permission', agent: W2, text: 'chạy `npm run test:e2e`' }],
    [900, { t: 'step', agent: W2, label: 'Chạy test e2e', file: 'tests/e2e/login.spec.ts', tokens: 5200, quota: 61 }],
    [1400, { t: 'step', agent: W1, label: 'Sửa interceptor', file: 'src/api/client.ts', tokens: 9800, quota: 0 }],
    [1000, { t: 'limited', agent: W1, resetIn: '4h12m' }],
    [2600, { t: 'checkpoint', agent: W1, tokens: 287, replay: 41903, notes: ['xong 3/5', 'sửa refresh.ts, client.ts', 'tiếp: test cho retry'] }],
    [2800, { t: 'handoff', from: W1, to: O }],
    [2800, { t: 'step', agent: O, label: 'Viết test cho retry', file: 'src/auth/refresh.test.ts', tokens: 1200, quota: 63 }],
    [1500, { t: 'step', agent: O, label: 'Cập nhật docs auth', file: 'docs/auth.md', tokens: 2000, quota: 62 }],
    [1200, { t: 'done', agent: O }],
    [2200, { t: 'step', agent: W2, label: 'Sửa test flaky', file: 'tests/e2e/login.spec.ts', tokens: 6400, quota: 58 }],
    [1200, { t: 'done', agent: W2 }],
    [2000, { t: 'narrate', text: `Xong hết. Lần bàn giao ${name(W1)} → ${name(O)} tiết kiệm 41,616 token.` }],
  ];
}

/**
 * Handoff note for a task, written by Standlink from the ACP events it recorded:
 * the agent that ran out of quota spends nothing on it, and the next agent reads
 * a few hundred tokens instead of the whole transcript.
 */
export function buildCheckpoint(task: Task, from: string): { text: string; notes: string[]; tokens: number } {
  const steps = (task.steps ?? []).slice(-8);
  const files = task.files ?? [];
  const notes = [
    `xong ${task.done}/${task.total}`,
    files.length ? `file: ${files.slice(0, 6).join(', ')}` : 'chưa đụng file nào',
    steps.length ? `bước cuối: ${steps[steps.length - 1]}` : 'chưa có bước nào',
  ];
  const text = [
    `[Standlink handoff] ${from} hết quota giữa chừng. Bạn làm tiếp task này, đừng làm lại phần đã xong.`,
    `Task ${task.id}: ${task.title}`,
    task.request ? `Yêu cầu gốc: ${task.request}` : '',
    steps.length ? `Đã làm: ${steps.join('; ')}` : '',
    files.length ? `File đã đụng (đọc lại trước khi sửa): ${files.join(', ')}` : '',
    task.last ? `Câu trả lời cuối của ${from}: ${task.last}` : '',
  ].filter(Boolean).join('\n');
  return { text, notes, tokens: Math.ceil(text.length / 4) };
}
