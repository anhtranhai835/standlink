import { useEffect, useReducer, useRef, useState } from 'react';
import { byId, frameUrl, pickFree } from './characters';
import { AddAgent, Flights, NewProject, Overlay, Pane, ProviderList, STATE_LABEL, cssVars, preload } from './components';
import { bridge, updateToEvents, type AcpEventMsg } from './bridge';
import {
  MIN_TEAM, buildCheckpoint, demoScript, initialWorld, newMember, reduce, slug,
  type Action, type AgentId, type Ev, type Member, type Provider, type World,
} from './world';

interface ProjectMeta { id: string; name: string; path: string; cast: Record<AgentId, string> }
interface SavedProject extends ProjectMeta { team: Member[]; orch: AgentId }
interface Run { script: [number, Ev][]; idx: number; playing: boolean; speed: number }

// localStorage is a per-viewer convenience: every read and write may throw (private mode, blocked storage).
const store = {
  get<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted, app still works */ }
  },
};

/** Give every member a character, keeping the ones they already have. */
function castFor(team: Member[], prev: Record<AgentId, string> = {}): Record<AgentId, string> {
  const cast: Record<AgentId, string> = {};
  for (const m of team) cast[m.id] = prev[m.id] ?? pickFree(Object.values(cast));
  return cast;
}

/** A new project starts empty: you pick which providers join it. Nothing is preset. */
function makeProject(name: string, path: string): SavedProject {
  return { id: `p-${Date.now().toString(36)}`, name, path, team: [], orch: '', cast: {} };
}

type Worlds = Record<string, World>;
type Multi = { sid: string; a: Action } | { t: 'add'; sid: string; world: World } | { t: 'remove'; sid: string };
function multi(ws: Worlds, m: Multi): Worlds {
  if ('a' in m) return ws[m.sid] ? { ...ws, [m.sid]: reduce(ws[m.sid], m.a) } : ws;
  if (m.t === 'add') return { ...ws, [m.sid]: m.world };
  const rest = { ...ws };
  delete rest[m.sid];
  return rest;
}

/** Plays one project's demo script in the background, one event per tick, pausing on permission requests. */
function Player({ run, waiting, fire }: { run?: Run; waiting: boolean; fire: (ev: Ev) => void }) {
  const fireRef = useRef(fire);
  fireRef.current = fire;
  useEffect(() => {
    if (!run || !run.playing || waiting || run.idx >= run.script.length) return;
    const [delay, ev] = run.script[run.idx];
    const id = setTimeout(() => fireRef.current(ev), delay / run.speed);
    return () => clearTimeout(id);
  }, [run, waiting]);
  return null;
}

// v2: no preset providers or teams anymore, so earlier saved data is not reused
const PROVIDERS_KEY = 'standlink.providers.v2';
const PROJECTS_KEY = 'standlink.projects.v2';

type Status = 'idle' | 'running' | 'waiting' | 'done';
const STATUS_LABEL: Record<Status, string> = { idle: 'Chờ lệnh', running: 'Đang chạy', waiting: 'Chờ bạn duyệt', done: 'Xong' };
const TASK_LABEL = { running: 'Đang chạy', paused: 'Tạm dừng', done: 'Xong' } as const;

export default function App() {
  const [providers, setProviders] = useState<Provider[]>(() => store.get<Provider[]>(PROVIDERS_KEY, []));
  const [boot] = useState<SavedProject[]>(() => {
    const saved = store.get<SavedProject[]>(PROJECTS_KEY, []);
    return saved.length ? saved : [makeProject('Project đầu tiên', '')];
  });
  const [metas, setMetas] = useState<ProjectMeta[]>(() => boot.map(({ id, name, path, cast }) => ({ id, name, path, cast })));
  const [worlds, dispatchAll] = useReducer(multi, boot, b => Object.fromEntries(b.map(s => [s.id, initialWorld(s.team, s.orch)])));
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [active, setActive] = useState(boot[0].id);
  const [panel, setPanel] = useState<'' | 'tasks' | 'providers'>('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const gridRef = useRef<HTMLDivElement>(null);
  const stageRefs = useRef<Record<AgentId, HTMLDivElement | null>>({});

  const meta = metas.find(m => m.id === active) ?? metas[0];
  const w = worlds[meta.id];
  const run = runs[meta.id];
  const busy = !!run && run.idx < run.script.length;
  const dispatch = (a: Action, sid = meta.id) => dispatchAll({ sid, a });
  const castOf = (id: AgentId) => byId(meta.cast[id] ?? 'jotaro');
  const nameOf = (id?: AgentId) => w.team.find(m => m.id === id)?.label ?? '';
  const setCast = (sid: string, f: (c: Record<AgentId, string>) => Record<AgentId, string>) =>
    setMetas(ms => ms.map(m => (m.id === sid ? { ...m, cast: f(m.cast) } : m)));

  useEffect(() => store.set(PROVIDERS_KEY, providers), [providers]);
  useEffect(() => {
    store.set(PROJECTS_KEY, metas.map(m => ({ ...m, team: worlds[m.id]?.team ?? [], orch: worlds[m.id]?.orch ?? '' })));
  }, [metas, worlds]);
  useEffect(() => { Object.values(meta.cast).forEach(id => preload(byId(id))); }, [meta.cast]);

  const statusOf = (sid: string): Status => {
    const r = runs[sid];
    if (worlds[sid]?.perm) return 'waiting';
    if (r && r.idx < r.script.length) return 'running';
    return r ? 'done' : 'idle';
  };

  const order = (mission: string) => {
    dispatch({ t: 'start', mission });
    setRuns(r => ({ ...r, [meta.id]: { script: demoScript(w.team, w.orch), idx: 0, playing: true, speed: r[meta.id]?.speed ?? 1 } }));
  };
  const patchRun = (p: Partial<Run>) => setRuns(r => (r[meta.id] ? { ...r, [meta.id]: { ...r[meta.id], ...p } } : r));
  const addMember = (p: Provider) => {
    const m = newMember(w.team, p);
    dispatch({ t: 'member.add', member: m });
    setCast(meta.id, c => ({ ...c, [m.id]: pickFree(Object.values(c)) }));
  };
  const switchTo = (sid: string) => {
    dispatchAll({ sid, a: { t: 'quiet' } });
    setActive(sid);
  };
  const newProject = (name: string, path: string) => {
    const p = makeProject(name, path);
    dispatchAll({ t: 'add', sid: p.id, world: initialWorld(p.team, p.orch) });
    setMetas(ms => [...ms, { id: p.id, name, path, cast: p.cast }]);
    setActive(p.id);
    setAdding(false);
  };
  const removeProject = (sid: string) => {
    const left = metas.filter(m => m.id !== sid);
    setMetas(left);
    dispatchAll({ t: 'remove', sid });
    if (sid === active) switchTo(left[0].id);
  };
  const addProvider = (name: string, cmd: string) => setProviders(ps => {
    let id = slug(name), n = 2;
    while (ps.some(p => p.id === id)) id = `${slug(name)}-${n++}`;
    return [...ps, { id, name, cmd }];
  });

  // ---------- real agents over ACP (Electron). In a browser the demo above is used instead. ----------
  const latest = useRef({ worlds, metas, providers });
  latest.current = { worlds, metas, providers };
  const cmdOf = (sid: string, id: AgentId) => {
    const { worlds: ws, providers: ps } = latest.current;
    const m = ws[sid]?.team.find(x => x.id === id);
    return ps.find(p => p.id === m?.provider)?.cmd;
  };

  const primed = useRef(new Set<string>()); // sessions that already got the team rules (sent once, not every turn)
  const replyTo = useRef(new Map<string, AgentId>()); // "project/member" → who asked it something
  const taskSeq = useRef(101);

  /** Team rules, prepended to the first prompt of each agent session only. */
  const preamble = (sid: string, id: AgentId) => {
    const ws = latest.current.worlds[sid];
    const roster = ws.team.map(m => `${m.id} = ${m.label}${m.id === ws.orch ? ' (chỉ huy)' : ''}`).join('; ');
    const lead = ws.team.find(m => m.id === ws.orch)?.label ?? 'chỉ huy';
    return id === ws.orch
      ? `[Standlink] Bạn là CHỈ HUY của một đội agent. Đội: ${roster}. Dùng MCP tool "standlink": board() xem đội và task, assign(member, task, brief) giao việc, ask(member, message) hỏi nhanh. Tiết kiệm token: chia việc nhỏ, brief ngắn, không tự làm phần đã giao. Khi worker xong bạn nhận tin "[Standlink] … xong".\n\n`
      : `[Standlink] Bạn là "${ws.team.find(m => m.id === id)?.label}" (id ${id}) trong đội do ${lead} chỉ huy. Đội: ${roster}. Có MCP tool "standlink": board(), ask(member, message). Làm đúng việc được giao, kết thúc bằng 1–3 câu tóm tắt.\n\n`;
  };

  const promptAgent = (sid: string, id: AgentId, text: string, opts: { quiet?: boolean } = {}) => {
    const pm = latest.current.metas.find(x => x.id === sid);
    const cmd = cmdOf(sid, id);
    if (!bridge) return;
    if (!pm?.path) { dispatchAll({ sid, a: { t: 'agent.error', agent: id, text: 'Chưa chọn thư mục project. Bấm 📁 ở sidebar.' } }); return; }
    if (!cmd) { dispatchAll({ sid, a: { t: 'agent.error', agent: id, text: 'Provider của agent này đã bị xoá.' } }); return; }
    dispatchAll({ sid, a: { t: 'turn.start', agent: id, text, quiet: opts.quiet } });
    const key = `${sid}/${id}`;
    const full = primed.current.has(key) ? text : preamble(sid, id) + text;
    primed.current.add(key);
    bridge.prompt({ projectId: sid, memberId: id, cmd, cwd: pm.path, text: full });
  };

  /** Agent-to-agent message: animate it, then deliver it as the receiver's next (queued) turn. */
  const relay = (sid: string, from: AgentId, to: AgentId, text: string) => {
    if (!latest.current.worlds[sid]?.agents[to]) return;
    dispatchAll({ sid, a: { t: 'say', from, to, text: text.length > 90 ? `${text.slice(0, 87)}…` : text } });
    promptAgent(sid, to, text, { quiet: true });
  };

  /** Rate limit: freeze the agent, write the zero-token checkpoint, pass the task to a free Stand. */
  const handoff = (sid: string, from: AgentId, reason: string) => {
    const ws = latest.current.worlds[sid];
    const tid = ws.agents[from]?.task, t = tid ? ws.tasks[tid] : undefined;
    dispatchAll({ sid, a: { t: 'limited', agent: from, resetIn: '?' } });
    dispatchAll({ sid, a: { t: 'narrate', text: `Lỗi từ agent: ${reason.slice(0, 200)}` } });
    if (!t) return;
    const fromLabel = ws.team.find(m => m.id === from)?.label ?? from;
    const cp = buildCheckpoint(t, fromLabel);
    dispatchAll({ sid, a: { t: 'checkpoint', agent: from, tokens: cp.tokens, replay: Math.max(ws.agents[from].tokens, cp.tokens), notes: cp.notes } });
    const to = [ws.orch, ...ws.team.map(m => m.id)].find(id => id && id !== from && ws.agents[id]?.state === 'idle');
    if (!to) { dispatchAll({ sid, a: { t: 'narrate', text: 'Không còn Stand nào rảnh để nhận việc. Task tạm dừng.' } }); return; }
    setTimeout(() => { // let TIME STOP and TO BE CONTINUED play first
      dispatchAll({ sid, a: { t: 'handoff', from, to } });
      promptAgent(sid, to, cp.text);
    }, 2600);
  };

  useEffect(() => bridge?.onEvent((e: AcpEventMsg) => {
    const sid = e.projectId, id = e.memberId, m = e.msg, ws = latest.current.worlds[sid];
    if (!ws?.agents[id]) return;
    const act = (a: Action) => dispatchAll({ sid, a });
    if (m.type === 'update') updateToEvents(id, m.update).forEach(act);
    else if (m.type === 'permission') {
      if (ws.access[id] === 'full') {
        const allow = m.options.find(o => o.kind.startsWith('allow'));
        bridge!.permission(m.reqId, allow?.optionId ?? null);
        act({ t: 'activity', agent: id, label: `Tự duyệt: ${m.title}` });
      } else act({ t: 'permission', agent: id, text: m.title, reqId: m.reqId, options: m.options });
    } else if (m.type === 'turn-end') {
      const ag = ws.agents[id], reply = (ag.draft ?? '').trim(), t = ag.task ? ws.tasks[ag.task] : undefined;
      const label = (x: AgentId) => ws.team.find(mm => mm.id === x)?.label ?? x;
      act({ t: 'turn.end', agent: id, stopReason: m.stopReason });
      const back = replyTo.current.get(`${sid}/${id}`);
      if (back) {
        replyTo.current.delete(`${sid}/${id}`);
        relay(sid, id, back, `[Trả lời từ ${label(id)}] ${reply || '(không có nội dung)'}`);
      } else if (m.stopReason === 'end_turn' && t?.by && t.by !== id && t.status !== 'done') {
        // one line back to whoever assigned it: the leader never reads the worker's transcript
        relay(sid, id, t.by, `[Standlink] ${t.id} xong bởi ${label(id)}: ${reply.slice(0, 300) || 'không có tóm tắt'}`);
      }
    }
    else if (m.type === 'error') {
      if (m.rateLimit) handoff(sid, id, m.message);
      else act({ t: 'agent.error', agent: id, text: m.message });
    }
    if (m.type === 'exit') primed.current.delete(`${sid}/${id}`); // a new process means a fresh session: rules go again
    if (m.type === 'exit' && ws.agents[id].state !== 'idle') {
      act({ t: 'agent.error', agent: id, text: `Agent đã thoát (${m.code}). ${m.stderr.slice(-300)}` });
    }
  }), []);

  // Team tools called by agents through the MCP bridge (board / assign / ask).
  useEffect(() => bridge?.onMcpCall(c => {
    const sid = c.projectId, ws = latest.current.worlds[sid];
    const reply = (text: string, isError = false) => { bridge!.mcpReply(c.callId, text, isError); };
    if (!ws) return reply('Project không còn tồn tại.', true);
    const label = (x: AgentId) => ws.team.find(m => m.id === x)?.label ?? x;

    if (c.tool === 'board') {
      return reply(ws.team.map(m => {
        const ag = ws.agents[m.id], t = ag.task ? ws.tasks[ag.task] : undefined;
        return `${m.id} | ${m.label}${m.id === ws.orch ? ' | chỉ huy' : ''} | ${STATE_LABEL[ag.state]}${t ? ` | ${t.id} ${t.done}/${t.total} ${t.status}: ${t.title}` : ''}`;
      }).join('\n'));
    }
    const want = String(c.args.member ?? '').trim().toLowerCase();
    const target = ws.team.find(m => m.id.toLowerCase() === want || m.label.toLowerCase() === want);
    if (!target) return reply(`Không có thành viên "${String(c.args.member ?? '')}". Gọi board() để xem id.`, true);
    if (target.id === c.memberId) return reply('Không giao việc hay hỏi chính mình.', true);
    const st = ws.agents[target.id].state;

    if (c.tool === 'assign') {
      const title = String(c.args.task ?? '').trim().slice(0, 120);
      if (!title) return reply('Thiếu task.', true);
      if (st !== 'idle') return reply(`${target.label} đang ${STATE_LABEL[st].toLowerCase()}. Chọn người khác hoặc đợi.`, true);
      const brief = String(c.args.brief ?? '').trim().slice(0, 4000);
      const n = Math.max(taskSeq.current, 101 + Object.keys(ws.tasks).length);
      taskSeq.current = n + 1;
      const tid = `T-${n}`;
      dispatchAll({ sid, a: { t: 'say', from: c.memberId, to: target.id, text: `${tid}: ${title}` } });
      dispatchAll({ sid, a: { t: 'task.new', id: tid, title, total: 1, to: target.id, by: c.memberId, request: brief ? `${title}\n${brief}` : title } });
      promptAgent(sid, target.id, `[Task ${tid} từ ${label(c.memberId)}] ${title}${brief ? `\n${brief}` : ''}\nXong thì trả lời 1–3 câu tóm tắt.`);
      return reply(`Đã giao ${tid} cho ${target.label}. Khi xong bạn sẽ nhận tin.`);
    }
    if (c.tool === 'ask') {
      const msg = String(c.args.message ?? '').trim().slice(0, 2000);
      if (!msg) return reply('Thiếu message.', true);
      if (st === 'limited') return reply(`${target.label} đang hết quota.`, true);
      replyTo.current.set(`${sid}/${target.id}`, c.memberId);
      relay(sid, c.memberId, target.id, `[Tin từ ${label(c.memberId)}] ${msg}\nTrả lời ngắn; câu trả lời được gửi lại cho ${label(c.memberId)}.`);
      return reply(`Đã gửi cho ${target.label}. Câu trả lời sẽ tới sau.`);
    }
    return reply(`Không có tool ${c.tool}.`, true);
  }), []);

  /** Changing the leader changes everyone's role: resend the rules on each agent's next turn. */
  const setOrch = (id: AgentId) => {
    for (const k of [...primed.current]) if (k.startsWith(`${meta.id}/`)) primed.current.delete(k);
    dispatch({ t: 'orch', orch: id });
  };

  const answerPerm = (ok: boolean) => {
    const pr = w.perm;
    if (bridge && pr?.reqId) {
      const opt = pr.options?.find(o => o.kind.startsWith(ok ? 'allow' : 'reject'));
      bridge.permission(pr.reqId, opt?.optionId ?? null);
    }
    dispatch({ t: 'perm.answer', ok });
  };
  const sendTo = (m: Member, text: string) => {
    if (bridge) { dispatch({ t: 'user.msg', to: m.id, text }); promptAgent(meta.id, m.id, text); return; }
    if (w.orch === m.id) order(text);
    else dispatch({ t: 'ask', to: m.id, text });
  };
  const pickPath = async () => {
    const dir = await bridge?.pickFolder();
    if (dir) setMetas(ms => ms.map(x => (x.id === meta.id ? { ...x, path: dir } : x)));
  };
  const removeMember = (id: AgentId) => {
    bridge?.stop(meta.id, id);
    dispatch({ t: 'member.remove', id });
  };

  const pos = (id: AgentId) => {
    const st = stageRefs.current[id], pane = st?.parentElement;
    return st && pane ? { x: pane.offsetLeft + st.offsetWidth * 0.3, y: pane.offsetTop + st.offsetTop + st.offsetHeight * 0.3 } : { x: 0, y: 0 };
  };
  const cols = w.team.length <= 4 ? 2 : w.team.length <= 6 ? 3 : 4;
  const tasks = Object.values(w.tasks);
  const used = w.team.reduce((s, m) => s + (w.agents[m.id]?.tokens ?? 0), 0);
  const byProvider = [...new Set(w.team.map(m => m.provider))].map(pid => {
    const ms = w.team.filter(m => m.provider === pid);
    return {
      pid,
      name: providers.find(p => p.id === pid)?.name ?? ms[0].label,
      quota: Math.min(...ms.map(m => w.agents[m.id].quota)),
      tokens: ms.reduce((s, m) => s + w.agents[m.id].tokens, 0),
    };
  });
  const shown = metas.filter(m => m.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="frame">
      {/* ---------- sidebar (Orca layout) ---------- */}
      <aside className="sidebar" aria-label="Project và agent">
        <div className="sb-top"><span className="brand">STANDLINK</span><span className="menace" aria-hidden="true">ゴゴゴ</span></div>
        <input className="search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="🔍 Tìm project" aria-label="Tìm project" />
        <nav className="sb-nav">
          <button type="button" className={panel === 'tasks' ? 'on' : ''} aria-expanded={panel === 'tasks'} onClick={() => setPanel(p => (p === 'tasks' ? '' : 'tasks'))}>
            ☰ Tasks <small>{tasks.length}</small>
          </button>
          {panel === 'tasks' && (
            <ul className="task-list">
              {!tasks.length && <li className="tree-note">Chưa có task.</li>}
              {tasks.map(t => (
                <li key={t.id} className={`tk tk-${t.status}`} style={cssVars({ '--c': t.owner ? castOf(t.owner).color : '#888' })}>
                  <div className="tk-top"><b>{t.id} · {t.title}</b><span className="chip">{TASK_LABEL[t.status]}</span></div>
                  <div className="mini"><b style={{ width: `${(t.done / t.total) * 100}%` }} /></div>
                  <small>{nameOf(t.owner ?? undefined)} · {t.done}/{t.total}{t.cp ? ` · 📜 ${t.cp.tokens} tok` : ''}</small>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={panel === 'providers' ? 'on' : ''} aria-expanded={panel === 'providers'} onClick={() => setPanel(p => (p === 'providers' ? '' : 'providers'))}>
            ⚙ Providers <small>{providers.length}</small>
          </button>
          {panel === 'providers' && <ProviderList providers={providers} onAdd={addProvider} onRemove={id => setProviders(ps => ps.filter(p => p.id !== id))} />}
        </nav>

        <div className="sb-head"><span>PROJECTS</span><button type="button" className="icon" title="Project mới" aria-label="Project mới" onClick={() => setAdding(a => !a)}>＋</button></div>
        {adding && <NewProject onCreate={newProject} onCancel={() => setAdding(false)} onPick={bridge ? () => bridge!.pickFolder() : undefined} />}
        <ul className="tree">
          {shown.map(p => {
            const st = statusOf(p.id), pw = worlds[p.id], open = p.id === meta.id;
            return (
              <li key={p.id} className={open ? 'open' : ''}>
                <div className="proj">
                  <button type="button" className="proj-btn" onClick={() => switchTo(p.id)} aria-current={open}>
                    <span className={`dot2 d-${st}`} aria-hidden="true" />
                    <span className="proj-name">{p.name}</span>
                    {pw?.part ? <span className="tag">PART {pw.part}</span> : null}
                  </button>
                  {metas.length > 1 && st !== 'running' && st !== 'waiting' && (
                    <button type="button" className="x" title="Xoá project" aria-label={`Xoá project ${p.name}`} onClick={() => removeProject(p.id)}>✕</button>
                  )}
                </div>
                <p className="proj-sub">
                  {p.path || 'chưa chọn thư mục'} · {STATUS_LABEL[st]}
                  {bridge && open && <button type="button" className="link" onClick={pickPath}>📁 {p.path ? 'Đổi' : 'Chọn'}</button>}
                </p>
                {open && (
                  <ul className="agents">
                    {w.team.map(m => {
                      const ag = w.agents[m.id], lead = w.orch === m.id, ch = castOf(m.id);
                      return (
                        <li key={m.id} className={`ag s-${ag.state}`} style={cssVars({ '--c': ch.color })}>
                          <img className="face sm" src={frameUrl(ch.id, 'idle', 0)} alt="" />
                          <div className="ag-main"><b>{m.label}</b><span>{ag.task ? `${ag.task} · ${ag.label ?? ''}` : STATE_LABEL[ag.state]}</span></div>
                          <button type="button" className={`crown${lead ? ' on' : ''}`} aria-pressed={lead} disabled={busy}
                            title={lead ? 'Đang là chỉ huy' : 'Chọn làm chỉ huy'} onClick={() => setOrch(m.id)}>👑</button>
                          {!lead && !ag.task && w.team.length > MIN_TEAM && (
                            <button type="button" className="x" title={`Bỏ ${m.label}`} aria-label={`Bỏ ${m.label}`} onClick={() => removeMember(m.id)}>✕</button>
                          )}
                        </li>
                      );
                    })}
                    <li>
                      {providers.length
                        ? <AddAgent providers={providers} count={w.team.length} onAdd={addMember} />
                        : <p className="tree-note">Chưa có provider. Mở ⚙ Providers để thêm.</p>}
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </aside>

      {/* ---------- workspace: tabs, panes, status bar ---------- */}
      <main className="workspace">
        <div className="tabs" role="tablist">
          {metas.map(p => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === meta.id} className={`tab${p.id === meta.id ? ' on' : ''}`} onClick={() => switchTo(p.id)}>
              <span className={`dot2 d-${statusOf(p.id)}`} aria-hidden="true" />
              {worlds[p.id]?.mission || p.name}
            </button>
          ))}
          <button type="button" className="tab add" title="Project mới" aria-label="Project mới" onClick={() => setAdding(true)}>＋</button>
          <div className="tab-tools">
            <span className="part">{w.part ? `PART ${w.part}` : 'PROLOGUE'}</span>
            <button type="button" disabled={!busy} onClick={() => patchRun({ playing: !run?.playing })}>{run?.playing === false ? '▶ Tiếp' : '⏸ Dừng'}</button>
            <button type="button" disabled={!run} onClick={() => patchRun({ speed: run?.speed === 1 ? 2 : run?.speed === 2 ? 0.5 : 1 })}>{run?.speed ?? 1}x</button>
            <button type="button" onClick={() => setCast(meta.id, () => castFor(w.team))}>🎲 Random</button>
          </div>
        </div>

        <div className="panes" ref={gridRef} style={cssVars({ '--cols': cols })}>
          {[...w.team].sort((a, b) => Number(b.id === w.orch) - Number(a.id === w.orch)).map(m => (
            <Pane key={m.id} member={m} agent={w.agents[m.id]} char={castOf(m.id)} isOrch={w.orch === m.id}
              task={w.agents[m.id].task ? w.tasks[w.agents[m.id].task!] : undefined}
              log={w.log} nameOf={nameOf} access={w.access[m.id] ?? 'ask'} busy={!bridge && busy}
              perm={w.perm?.agent === m.id ? w.perm.text : null}
              stageRef={el => { stageRefs.current[m.id] = el; }}
              onReroll={() => setCast(meta.id, c => ({ ...c, [m.id]: pickFree(Object.values(c)) }))}
              onPerm={answerPerm}
              onAccess={mode => dispatch({ t: 'access', agent: m.id, mode })}
              onSend={text => sendTo(m, text)} />
          ))}
          {w.team.length === 0 && (
            <div className="empty-state">
              <p className="es-kana" aria-hidden="true">ゴゴゴゴ</p>
              <h2>Đội Stand đang trống</h2>
              <ol>
                <li>Mở <b>⚙ Providers</b>, thêm agent CLI bất kỳ có ACP: tên + lệnh chạy.</li>
                <li>{bridge ? <>Bấm <b>📁 Chọn</b> để gắn thư mục cho project.</> : 'Gắn thư mục cho project (bản app desktop).'}</li>
                <li>Bấm <b>+ Sub-agent</b> dưới project. Agent đầu tiên làm chỉ huy 👑.</li>
              </ol>
            </div>
          )}
          <Flights flights={w.flights} pos={pos} onLand={key => dispatch({ t: 'land', key })} />
        </div>

        <footer className="statusbar" aria-label="Quota và token">
          {byProvider.map(p => (
            <span key={p.pid} className={`sb-q${p.quota === 0 ? ' out' : ''}`}>
              <b>{p.name}</b><i><em style={{ width: `${p.quota}%` }} /></i>{p.quota}% · {p.tokens.toLocaleString()} tok
            </span>
          ))}
          <span className="sb-sum">Token đã dùng <b>{used.toLocaleString()}</b></span>
          <span className="sb-sum gold">Tiết kiệm nhờ bàn giao <b>{w.saved.toLocaleString()}</b></span>
          <span className="sb-demo">{bridge ? 'ACP · agent thật' : 'DEMO · dữ liệu giả'}</span>
        </footer>
      </main>

      {metas.map(s => (
        <Player key={s.id} run={runs[s.id]} waiting={!!worlds[s.id]?.perm}
          fire={ev => { dispatch(ev, s.id); setRuns(r => ({ ...r, [s.id]: { ...r[s.id], idx: r[s.id].idx + 1 } })); }} />
      ))}
      <Overlay fx={w.fx} onDone={() => dispatch({ t: 'fx.done' })} />
    </div>
  );
}
