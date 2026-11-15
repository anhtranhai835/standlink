import { useEffect, useReducer, useRef, useState } from 'react';
import { byId, frameUrl, pickFree } from './characters';
import { AddAgent, Flights, MemberEdit, NewProject, Overlay, Pane, ProviderList, STATE_LABEL, SkillList, SpawnDialog, cssVars, preload } from './components';
import { bridge, updateToEvents, type AcpEventMsg, type SkillInfo } from './bridge';
import {
  MAX_TEAM, buildCheckpoint, canRemove, demoScript, initialWorld, newMember, reduce, slug,
  type Action, type AgentId, type Ev, type Member, type Provider, type World,
} from './world';

interface ProjectMeta {
  id: string; name: string; path: string; cast: Record<AgentId, string>;
  prefs?: Record<AgentId, Record<string, string>>; // per member: ACP config option id → chosen value (model, effort…)
}
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
/** Like VS Code: a project is a folder, named after it. */
const folderName = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
const sameDir = (a: string, b: string) => !!a && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const NO_FOLDER = 'Chưa mở thư mục';

/** Agent tabs of one project window: pinned tabs, plus one preview tab (single click) like VS Code. */
interface View { tabs: AgentId[]; preview?: AgentId; focus?: AgentId }
/** A leader's spawn() waiting for the user: the member is already added (so its model / effort list loads). */
interface SpawnReq { sid: string; by: AgentId; id: AgentId }

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
const LAST_KEY = 'standlink.lastProject';
/** Desktop app: each window shows one project (?project=id), like VS Code's one window per folder. */
const winProject = new URLSearchParams(location.search).get('project');
const strip = ({ id, name, path, cast, prefs }: ProjectMeta): ProjectMeta => ({ id, name, path, cast, prefs });

const SB_DEFAULT = 272, SB_MIN = 200, SB_MAX = 520;
const clampSb = (n: number) => Math.round(Math.min(SB_MAX, Math.max(SB_MIN, n)));

type Status = 'idle' | 'running' | 'waiting' | 'done';
const STATUS_LABEL: Record<Status, string> = { idle: 'Chờ lệnh', running: 'Đang chạy', waiting: 'Chờ bạn duyệt', done: 'Xong' };
const TASK_LABEL = { running: 'Đang chạy', paused: 'Tạm dừng', done: 'Xong' } as const;

export default function App() {
  const [providers, setProviders] = useState<Provider[]>(() => store.get<Provider[]>(PROVIDERS_KEY, []));
  const [boot] = useState<SavedProject[]>(() => {
    const saved = store.get<SavedProject[]>(PROJECTS_KEY, []);
    return saved.length ? saved : [makeProject(NO_FOLDER, '')];
  });
  const [metas, setMetas] = useState<ProjectMeta[]>(() => boot.map(strip));
  const [worlds, dispatchAll] = useReducer(multi, boot, b => Object.fromEntries(b.map(s => [s.id, initialWorld(s.team, s.orch)])));
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [active, setActive] = useState(() => {
    const want = winProject ?? store.get(LAST_KEY, '');
    return boot.find(b => b.id === want)?.id ?? boot[0].id;
  });
  const [view, setView] = useState<Record<string, View>>({});
  const [spawnReq, setSpawnReq] = useState<SpawnReq | null>(null);
  const [panel, setPanel] = useState<'' | 'tasks' | 'providers' | 'skills'>('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentId | null>(null); // sidebar member being renamed
  const [sbWidth, setSbWidth] = useState(() => store.get('standlink.sidebar.width', SB_DEFAULT));
  const [sbOpen, setSbOpen] = useState(() => store.get('standlink.sidebar.open', true));
  useEffect(() => store.set('standlink.sidebar.width', sbWidth), [sbWidth]);
  useEffect(() => store.set('standlink.sidebar.open', sbOpen), [sbOpen]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); setSbOpen(o => !o); }
      if (e.key.toLowerCase() === 'o') { e.preventDefault(); openFolderRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openFolderRef = useRef(() => {});
  const [skills, setSkills] = useState<SkillInfo[] | null>(bridge ? [] : null);
  const [skillsRev, setSkillsRev] = useState(0);
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
  // Merge providers from ~/.standlink/providers.json (desktop app only); ones already in the list are kept as they are.
  useEffect(() => {
    bridge?.configProviders().then(extra => setProviders(ps => [...ps, ...extra.filter(e => !ps.some(p => p.id === e.id))]));
  }, []);
  useEffect(() => {
    const full = (m: ProjectMeta): SavedProject => ({ ...m, team: worlds[m.id]?.team ?? [], orch: worlds[m.id]?.orch ?? '' });
    if (!bridge) { store.set(PROJECTS_KEY, metas.map(full)); return; }
    // Desktop: every window writes only its own project, so windows never overwrite each other's teams.
    const mine = metas.find(m => m.id === active);
    if (!mine) return;
    const saved = store.get<SavedProject[]>(PROJECTS_KEY, []);
    store.set(PROJECTS_KEY, saved.some(x => x.id === mine.id) ? saved.map(x => (x.id === mine.id ? full(mine) : x)) : [...saved, full(mine)]);
  }, [metas, worlds]);
  // Other windows added / removed projects or edited providers: pick that up (the storage event fires only in other windows).
  useEffect(() => {
    if (!bridge) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === PROVIDERS_KEY) setProviders(store.get<Provider[]>(PROVIDERS_KEY, []));
      if (e.key !== PROJECTS_KEY) return;
      const saved = store.get<SavedProject[]>(PROJECTS_KEY, []);
      if (!saved.length) return;
      setMetas(ms => saved.map(x => (x.id === active ? ms.find(m => m.id === active) ?? strip(x) : strip(x))));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [active]);
  useEffect(() => {
    bridge?.claimProject(active);
    store.set(LAST_KEY, active);
  }, [active]);
  useEffect(() => { document.title = meta.path ? `${meta.name} — Standlink` : 'Standlink'; }, [meta.name, meta.path]);
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
    if (bridge) { if (sid !== active) bridge.openProject(sid); return; } // desktop: one window per project
    dispatchAll({ sid, a: { t: 'quiet' } });
    setActive(sid);
  };
  const newProject = (name: string, path: string) => {
    const p = makeProject(name, path);
    setAdding(false);
    if (bridge) {
      store.set(PROJECTS_KEY, [...store.get<SavedProject[]>(PROJECTS_KEY, []), p]); // the new window boots from storage
      setMetas(ms => [...ms, strip(p)]);
      bridge.openProject(p.id);
      return;
    }
    dispatchAll({ t: 'add', sid: p.id, world: initialWorld(p.team, p.orch) });
    setMetas(ms => [...ms, strip(p)]);
    setActive(p.id);
  };
  /** VS Code's Open Folder: a known folder reopens its project; an empty window adopts the folder; otherwise a new window. */
  const openPath = (dir: string) => {
    const known = metas.find(m => sameDir(m.path, dir));
    if (known) { setAdding(false); return switchTo(known.id); }
    if (!meta.path && !w.team.length) {
      setMetas(ms => ms.map(x => (x.id === meta.id ? { ...x, path: dir, name: folderName(dir) } : x)));
      setAdding(false);
      return;
    }
    newProject(folderName(dir), dir);
  };
  const openFolder = async () => {
    if (!bridge) { setAdding(a => !a); return; } // browser demo: type the path instead
    const dir = await bridge.pickFolder();
    if (dir) openPath(dir);
  };
  openFolderRef.current = openFolder;
  const removeProject = (sid: string) => {
    const left = metas.filter(m => m.id !== sid);
    setMetas(left);
    dispatchAll({ t: 'remove', sid });
    if (bridge) {
      store.set(PROJECTS_KEY, store.get<SavedProject[]>(PROJECTS_KEY, []).filter(x => x.id !== sid));
      bridge.closeProject(sid);
      return;
    }
    if (sid === active) switchTo(left[0].id);
  };
  const addProvider = (name: string, cmd: string) => setProviders(ps => {
    let id = slug(name), n = 2;
    while (ps.some(p => p.id === id)) id = `${slug(name)}-${n++}`;
    return [...ps, { id, name, cmd }];
  });

  // ---------- real agents over ACP (Electron). In a browser the demo above is used instead. ----------
  const latest = useRef({ worlds, metas, providers, skills, spawnReq, skillsByProject: {} as Record<string, SkillInfo[]> });
  latest.current = { ...latest.current, worlds, metas, providers, skills, spawnReq };
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
    const sk = latest.current.skills ?? [];
    const skillLine = sk.length ? ` Skill của đội (đọc bằng skill(name) khi cần, đừng đọc hết): ${sk.map(x => `${x.name}${x.description ? ` — ${x.description}` : ''}`).join('; ')}.` : '';
    const roster = ws.team.map(m => `${m.id} = ${m.label}${m.role ? `, ${m.role}` : ''}${m.id === ws.orch ? ' (chỉ huy)' : ''}`).join('; ');
    const me = ws.team.find(m => m.id === id);
    const roleLine = me?.role ? ` Vai trò của bạn: ${me.role}; chỉ làm đúng phần của vai trò đó.` : '';
    const spawnable = latest.current.providers.map(p => p.id).join(', ');
    const lead = ws.team.find(m => m.id === ws.orch)?.label ?? 'chỉ huy';
    return id === ws.orch
      ? `[Standlink] Bạn là CHỈ HUY của một đội agent. Đội: ${roster}. Dùng MCP tool "standlink": board() xem đội và task, assign(member, task, brief) giao việc, ask(member, message) hỏi nhanh. Tiết kiệm token: chia việc nhỏ, brief ngắn, không tự làm phần đã giao. Khi worker xong bạn nhận tin "[Standlink] … xong". assign còn nhận skills[] để đính skill và effort (low cho việc vặt, high cho việc khó). Đội thiếu người cho việc này thì gọi spawn(provider, role, name) (provider: ${spawnable}): user được hỏi và chọn model/effort, bạn nhận tin khi user trả lời. Đừng thêm khi không cần.${roleLine}${skillLine}\n\n`
      : `[Standlink] Bạn là "${ws.team.find(m => m.id === id)?.label}" (id ${id}) trong đội do ${lead} chỉ huy. Đội: ${roster}. Có MCP tool "standlink": board(), ask(member, message). Làm đúng việc được giao, kết thúc bằng 1–3 câu tóm tắt.${roleLine}${skillLine}\n\n`;
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
    bridge.prompt({ projectId: sid, memberId: id, cmd, cwd: pm.path, text: full, prefs: pm.prefs?.[id] });
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
    else if (m.type === 'config') act({ t: 'config', agent: id, options: m.options });
    else if (m.type === 'auth') act({ t: 'auth', agent: id, text: `Cần đăng nhập: ${m.message.slice(0, 160)}`, methods: m.methods });
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
        return `${m.id} | ${m.label}${m.role ? ` | ${m.role}` : ''}${m.id === ws.orch ? ' | chỉ huy' : ''} | ${STATE_LABEL[ag.state]}${t ? ` | ${t.id} ${t.done}/${t.total} ${t.status}: ${t.title}` : ''}`;
      }).join('\n') + (c.memberId === ws.orch ? `\nprovider để spawn: ${latest.current.providers.map(p => p.id).join(', ') || '(chưa có)'}` : ''));
    }
    if (c.tool === 'spawn') {
      if (c.memberId !== ws.orch) return reply('Chỉ chỉ huy được thêm thành viên.', true);
      if (latest.current.spawnReq) return reply('Đang chờ user duyệt yêu cầu thêm người trước đó. Đợi tin rồi hãy gọi lại.', true);
      if (ws.team.length >= MAX_TEAM) return reply(`Đội đã đủ ${MAX_TEAM} người.`, true);
      const ps = latest.current.providers;
      const wantP = String(c.args.provider ?? '').trim().toLowerCase();
      const p = ps.find(x => x.id.toLowerCase() === wantP || x.name.toLowerCase() === wantP);
      if (!p) return reply(`Không có provider "${String(c.args.provider ?? '')}". Có: ${ps.map(x => x.id).join(', ') || 'chưa có'}.`, true);
      const role = String(c.args.role ?? '').trim().slice(0, 40);
      const m = newMember(ws.team, p, role || undefined);
      const name = String(c.args.name ?? '').trim().slice(0, 40);
      if (name) { m.label = name; m.named = true; }
      dispatchAll({ sid, a: { t: 'member.add', member: m } });
      setMetas(ms => ms.map(x => (x.id === sid ? { ...x, cast: { ...x.cast, [m.id]: pickFree(Object.values(x.cast)) } } : x)));
      dispatchAll({ sid, a: { t: 'narrate', text: `${label(c.memberId)} xin thêm ${m.label}${role ? ` (${role})` : ''}. Chờ bạn duyệt.` } });
      // Ask the user (provider, model, effort) instead of adding silently; the answer reaches the leader as a message.
      const req = { sid, by: c.memberId, id: m.id };
      latest.current.spawnReq = req;
      setSpawnReq(req);
      return reply(`Đã hỏi user. Bạn sẽ nhận tin "[Standlink] …" khi user duyệt hoặc từ chối. Đừng assign cho ${m.id} trước đó.`);
    }
    const want = String(c.args.member ?? '').trim().toLowerCase();
    const target = ws.team.find(m => m.id.toLowerCase() === want || m.label.toLowerCase() === want);
    if (!target) return reply(`Không có thành viên "${String(c.args.member ?? '')}". Gọi board() để xem id.`, true);
    if (target.id === c.memberId) return reply('Không giao việc hay hỏi chính mình.', true);
    const st = ws.agents[target.id].state;
    const pend = latest.current.spawnReq;
    if (pend?.sid === sid && pend.id === target.id) return reply(`${target.label} chưa được user duyệt vào đội.`, true);

    if (c.tool === 'assign') {
      const title = String(c.args.task ?? '').trim().slice(0, 120);
      if (!title) return reply('Thiếu task.', true);
      if (st !== 'idle') return reply(`${target.label} đang ${STATE_LABEL[st].toLowerCase()}. Chọn người khác hoặc đợi.`, true);
      const brief = String(c.args.brief ?? '').trim().slice(0, 4000);
      const known = latest.current.skillsByProject[sid] ?? [];
      const want = Array.isArray(c.args.skills) ? c.args.skills.map(String) : [];
      const missing = want.filter(n => !known.some(k => k.name === n));
      if (missing.length) return reply(`Không có skill: ${missing.join(', ')}. Có: ${known.map(k => k.name).join(', ') || 'chưa có skill nào'}.`, true);
      const effort = String(c.args.effort ?? '').trim();
      const effortOpt = ws.agents[target.id].config?.find(o => o.category === 'thought_level');
      if (effort && effortOpt) setMemberConfig(sid, target.id, effortOpt.id, effort);
      const n = Math.max(taskSeq.current, 101 + Object.keys(ws.tasks).length);
      taskSeq.current = n + 1;
      const tid = `T-${n}`;
      dispatchAll({ sid, a: { t: 'say', from: c.memberId, to: target.id, text: `${tid}: ${title}` } });
      dispatchAll({ sid, a: { t: 'task.new', id: tid, title, total: 1, to: target.id, by: c.memberId, request: brief ? `${title}\n${brief}` : title } });
      const skillNote = want.length ? `\nTrước khi làm, gọi skill() để đọc: ${want.join(', ')}.` : '';
      promptAgent(sid, target.id, `[Task ${tid} từ ${label(c.memberId)}] ${title}${brief ? `\n${brief}` : ''}${skillNote}\nXong thì trả lời 1–3 câu tóm tắt.`);
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
  /** Change one ACP config option (model, effort…) and remember it for this member. */
  const setMemberConfig = (sid: string, id: AgentId, configId: string, value: string) => {
    setMetas(ms => ms.map(x => (x.id === sid ? { ...x, prefs: { ...x.prefs, [id]: { ...x.prefs?.[id], [configId]: value } } } : x)));
    bridge?.setConfig(sid, id, configId, value);
  };

  /** The user's answer to the leader's spawn(): keep the member (with the picked name, role, model, effort) or drop it. */
  const answerSpawn = (ok: boolean, label = '', role = '') => {
    const r = spawnReq;
    if (!r) return;
    latest.current.spawnReq = null;
    setSpawnReq(null);
    if (!ok) {
      bridge?.stop(r.sid, r.id);
      dispatch({ t: 'member.remove', id: r.id });
      promptAgent(r.sid, r.by, '[Standlink] User không đồng ý thêm người. Làm tiếp với đội hiện có.', { quiet: true });
      return;
    }
    const name = label.trim() || w.team.find(x => x.id === r.id)?.label || r.id;
    dispatch({ t: 'member.edit', id: r.id, label: name, role: role.trim() });
    const cfg = w.agents[r.id]?.config ?? [];
    const pick = (cat: string) => cfg.find(o => o.category === cat)?.currentValue;
    const extra = [role.trim(), pick('model') && `model ${pick('model')}`, pick('thought_level') && `effort ${pick('thought_level')}`].filter(Boolean).join(', ');
    relay(r.sid, r.id, r.by, `[Standlink] User đã duyệt: ${r.id} (${name}${extra ? `, ${extra}` : ''}) vào đội. Giờ có thể assign cho ${r.id}.`);
  };

  // Start every agent of the open project (no prompt, no tokens) so its model / effort pickers appear.
  useEffect(() => {
    if (!bridge || !meta.path) return;
    for (const m of w.team) {
      const cmd = providers.find(p => p.id === m.provider)?.cmd;
      if (cmd && !w.agents[m.id]?.config) bridge.start({ projectId: meta.id, memberId: m.id, cmd, cwd: meta.path, prefs: meta.prefs?.[m.id] });
    }
  }, [meta.id, meta.path, w.team.map(m => m.provider).join(), providers.length]);

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge.listSkills(meta.path || undefined).then(list => {
      if (!live) return;
      setSkills(list);
      latest.current.skillsByProject[meta.id] = list;
    });
    return () => { live = false; };
  }, [meta.id, meta.path, skillsRev]);

  const saveSkill = async (sk: { name: string; description: string; body: string; project: boolean }) => {
    await bridge!.saveSkill({ name: sk.name, description: sk.description, body: sk.body, cwd: sk.project ? meta.path : undefined });
    setSkillsRev(r => r + 1);
  };
  const deleteSkillFile = async (name: string, project: boolean) => {
    await bridge!.deleteSkill(name, project ? meta.path : undefined);
    setSkillsRev(r => r + 1);
  };

  const pickPath = async () => {
    const dir = await bridge?.pickFolder();
    if (dir) setMetas(ms => ms.map(x => (x.id === meta.id ? { ...x, path: dir, name: folderName(dir) } : x)));
  };
  /** Swap an agent to another provider: stop its process, forget its model / effort picks, keep its Stand. */
  const changeProvider = (id: AgentId, providerId: string) => {
    const p = providers.find(x => x.id === providerId);
    if (!p) return;
    bridge?.stop(meta.id, id);
    primed.current.delete(`${meta.id}/${id}`);
    setMetas(ms => ms.map(x => (x.id === meta.id ? { ...x, prefs: { ...x.prefs, [id]: {} } } : x)));
    dispatch({ t: 'member.provider', id, provider: p });
  };
  const login = (id: AgentId, methodId: string) => {
    const method = w.agents[id]?.auth?.find(m => m.id === methodId);
    const cmd = cmdOf(meta.id, id);
    if (!bridge || !method?.args || !cmd) return;
    primed.current.delete(`${meta.id}/${id}`); // a fresh process after login gets the rules again
    bridge.login({ projectId: meta.id, memberId: id, cmd, cwd: meta.path, args: method.args })
      .then(line => dispatch({ t: 'narrate', text: `Đã mở terminal: ${line}. Đăng nhập xong thì gửi lại lệnh cho ${w.team.find(m => m.id === id)?.label}.` }));
  };
  const removeMember = (id: AgentId) => {
    if (id === w.orch) for (const k of [...primed.current]) if (k.startsWith(`${meta.id}/`)) primed.current.delete(k); // roles change
    bridge?.stop(meta.id, id);
    dispatch({ t: 'member.remove', id });
  };

  /** Where a flying message starts / lands (viewport px): the agent's stage if on screen, else its tab, else its sidebar row. */
  const pos = (id: AgentId) => {
    const q = `[data-agent="${CSS.escape(id)}"]`;
    const el = stageRefs.current[id] ?? document.querySelector(`.tab${q}`) ?? document.querySelector(`.ag${q}`);
    if (!el) return { x: innerWidth / 2, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.3 };
  };

  // ---------- agent tabs (VS Code): click = preview tab, double click = pinned tab ----------
  const vw: View = view[meta.id] ?? store.get<View>(`standlink.tabs.${meta.id}`, { tabs: [] });
  useEffect(() => { if (view[meta.id]) store.set(`standlink.tabs.${meta.id}`, view[meta.id]); }, [view, meta.id]);
  const live = (id?: AgentId): id is AgentId => !!id && !!w.agents[id];
  const pinned = vw.tabs.filter(live);
  let pv = live(vw.preview) && !pinned.includes(vw.preview) ? vw.preview : undefined;
  if (!pv && !pinned.length) pv = live(w.orch) ? w.orch : w.team[0]?.id; // nothing open: show the leader
  const tabIds = pv ? [...pinned, pv] : pinned;
  const shownId = live(vw.focus) && tabIds.includes(vw.focus) ? vw.focus : tabIds[tabIds.length - 1];
  const shownMember = w.team.find(m => m.id === shownId);
  const setVw = (f: (v: View) => View) => setView(all => ({ ...all, [meta.id]: f(all[meta.id] ?? vw) }));
  const previewTab = (id: AgentId) => setVw(v => (v.tabs.includes(id) ? { ...v, focus: id } : { ...v, preview: id, focus: id }));
  const pinTab = (id: AgentId) => setVw(v => ({ tabs: v.tabs.includes(id) ? v.tabs : [...v.tabs, id], preview: v.preview === id ? undefined : v.preview, focus: id }));
  const closeTab = (id: AgentId) => setVw(v => ({ tabs: v.tabs.filter(x => x !== id), preview: v.preview === id ? undefined : v.preview, focus: v.focus === id ? undefined : v.focus }));
  // Ctrl+W closes the shown agent tab, Ctrl+Tab cycles tabs: the editor shortcuts people already know.
  const keys = useRef({ shownId, tabIds, closeTab, previewTab });
  keys.current = { shownId, tabIds, closeTab, previewTab };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (!(e.ctrlKey || e.metaKey) || !k.shownId) return;
      if (e.key.toLowerCase() === 'w') { e.preventDefault(); k.closeTab(k.shownId); }
      if (e.key === 'Tab' && k.tabIds.length > 1) {
        e.preventDefault();
        const i = k.tabIds.indexOf(k.shownId);
        k.previewTab(k.tabIds[(i + (e.shiftKey ? -1 : 1) + k.tabIds.length) % k.tabIds.length]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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

  return (
    <div className={`frame${sbOpen ? '' : ' sb-off'}`} style={cssVars({ '--sb': `${sbWidth}px` })}>
      {/* ---------- sidebar (Orca layout) ---------- */}
      {sbOpen && <aside className="sidebar" aria-label="Project và agent">
        <div className="sb-top"><span className="brand">STANDLINK</span><span className="menace" aria-hidden="true">ゴゴゴ</span></div>
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
          {panel === 'providers' && <ProviderList providers={providers} onAdd={addProvider} onEdit={(id, name, cmd) => setProviders(ps => ps.map(p => (p.id === id ? { ...p, name, cmd } : p)))}
            onRemove={id => setProviders(ps => ps.filter(p => p.id !== id))} />}
          <button type="button" className={panel === 'skills' ? 'on' : ''} aria-expanded={panel === 'skills'} onClick={() => setPanel(p => (p === 'skills' ? '' : 'skills'))}>
            ✦ Skills <small>{skills?.length ?? 0}</small>
          </button>
          {panel === 'skills' && <SkillList skills={skills} canProject={!!meta.path} onSave={saveSkill} onDelete={deleteSkillFile} />}
        </nav>

        <div className="sb-head"><span>PROJECTS</span><button type="button" className="icon" title="Mở thư mục (Ctrl+O)" aria-label="Mở thư mục" onClick={openFolder}>＋</button></div>
        {adding && meta.path && <NewProject onOpen={openPath} onCancel={() => setAdding(false)} />}
        <ul className="tree">
          {metas.map(p => {
            const st = statusOf(p.id), pw = worlds[p.id], open = p.id === meta.id;
            return (
              <li key={p.id} className={open ? 'open' : ''}>
                <div className="proj">
                  <button type="button" className="proj-btn" onClick={() => switchTo(p.id)} aria-current={open}>
                    <span className={`dot2 d-${st}`} aria-hidden="true" />
                    <span className="proj-name">{p.name}</span>
                    {pw?.part ? <span className="tag">PART {pw.part}</span> : null}
                  </button>
                  {metas.length > 1 && !(bridge && open) && st !== 'running' && st !== 'waiting' && (
                    <button type="button" className="x" title="Bỏ khỏi danh sách (không xoá thư mục)" aria-label={`Bỏ project ${p.name} khỏi danh sách`} onClick={() => removeProject(p.id)}>✕</button>
                  )}
                </div>
                <p className="proj-sub">
                  <span title={p.path}>{p.path || 'chưa mở thư mục'}</span> · {STATUS_LABEL[st]}
                  {bridge && open && <button type="button" className="link" onClick={pickPath}>📁 {p.path ? 'Đổi' : 'Chọn'}</button>}
                </p>
                {open && (
                  <ul className="agents">
                    {w.team.map(m => {
                      const ag = w.agents[m.id], lead = w.orch === m.id, ch = castOf(m.id);
                      return (
                        <li key={m.id} data-agent={m.id} className={`ag s-${ag.state}${m.id === shownId ? ' on' : ''}`} style={cssVars({ '--c': ch.color })}>
                          <img className="face sm" src={frameUrl(ch.id, 'idle', 0)} alt="" />
                          <button type="button" className="ag-main" aria-current={m.id === shownId}
                            title="Bấm: xem nhanh · bấm đúp: mở tab" onClick={() => previewTab(m.id)} onDoubleClick={() => pinTab(m.id)}>
                            <b>{m.label}{m.role && <em className="role">{m.role}</em>}</b><span>{ag.task ? `${ag.task} · ${ag.label ?? ''}` : STATE_LABEL[ag.state]}</span>
                          </button>
                          <button type="button" className="x" title={`Đổi tên / vai trò ${m.label}`} aria-label={`Đổi tên ${m.label}`}
                            onClick={() => setEditing(e => (e === m.id ? null : m.id))}>✎</button>
                          <button type="button" className={`crown${lead ? ' on' : ''}`} aria-pressed={lead} disabled={busy}
                            title={lead ? 'Đang là chỉ huy' : 'Chọn làm chỉ huy'} onClick={() => setOrch(m.id)}>👑</button>
                          <button type="button" className="x" disabled={!canRemove(ag)} aria-label={`Xoá ${m.label}`}
                            title={canRemove(ag) ? `Xoá ${m.label}${lead ? ' (người kế tiếp làm chỉ huy)' : ''}` : 'Đang chạy, đợi xong lượt mới xoá được'}
                            onClick={() => removeMember(m.id)}>✕</button>
                          {editing === m.id && (
                            <MemberEdit member={m} onCancel={() => setEditing(null)}
                              onSave={(label, role) => {
                                dispatch({ t: 'member.edit', id: m.id, label, role });
                                primed.current.delete(`${meta.id}/${m.id}`); // new name or role: rules go out again
                                setEditing(null);
                              }} />
                          )}
                        </li>
                      );
                    })}
                    <li>
                      {bridge && !p.path ? <p className="tree-note">Mở thư mục trước, rồi thêm agent.</p> : providers.length
                        ? <AddAgent providers={providers} count={w.team.length} onAdd={addMember} />
                        : <p className="tree-note">Chưa có provider. Mở ⚙ Providers để thêm.</p>}
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </aside>}
      {sbOpen && (
        <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Kéo để đổi độ rộng sidebar"
          aria-valuemin={SB_MIN} aria-valuemax={SB_MAX} aria-valuenow={sbWidth} tabIndex={0}
          title="Kéo để đổi độ rộng · bấm đúp để về mặc định · Ctrl+B ẩn/hiện"
          onDoubleClick={() => setSbWidth(SB_DEFAULT)}
          onKeyDown={e => {
            if (e.key === 'ArrowLeft') setSbWidth(w0 => clampSb(w0 - 16));
            if (e.key === 'ArrowRight') setSbWidth(w0 => clampSb(w0 + 16));
          }}
          onPointerDown={e => {
            const el = e.currentTarget;
            el.setPointerCapture(e.pointerId);
            const move = (ev: PointerEvent) => setSbWidth(clampSb(ev.clientX));
            const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
            el.addEventListener('pointermove', move);
            el.addEventListener('pointerup', up);
          }} />
      )}

      {/* ---------- workspace: tabs, panes, status bar ---------- */}
      <main className="workspace">
        <div className="tabs" role="tablist">
          <button type="button" className="tab sb-toggle" aria-pressed={sbOpen} title={`${sbOpen ? 'Ẩn' : 'Hiện'} sidebar (Ctrl+B)`}
            aria-label={`${sbOpen ? 'Ẩn' : 'Hiện'} sidebar`} onClick={() => setSbOpen(o => !o)}>☰</button>
          {tabIds.map(id => {
            const m = w.team.find(x => x.id === id)!, ag = w.agents[id], on = id === shownId, isPv = id === pv;
            return (
              <div key={id} data-agent={id} className={`tab${on ? ' on' : ''}${isPv ? ' pv' : ''}`} style={cssVars({ '--c': castOf(id).color })}
                onAuxClick={e => { if (e.button === 1) closeTab(id); }}>
                <button type="button" role="tab" aria-selected={on} className="tab-btn"
                  title={isPv ? 'Xem nhanh · bấm đúp để giữ tab' : m.label} onClick={() => previewTab(id)} onDoubleClick={() => pinTab(id)}>
                  <img className="face xs" src={frameUrl(castOf(id).id, 'idle', 0)} alt="" />
                  <span className="tab-name">{m.label}</span>
                  {id === w.orch && <span className="tab-lead" aria-label="chỉ huy">👑</span>}
                  <span className={`dot2 d-${ag.state === 'working' ? 'running' : ag.state === 'blocked' ? 'waiting' : 'idle'}`} aria-hidden="true" />
                </button>
                <button type="button" className="tab-x" title="Đóng tab (Ctrl+W)" aria-label={`Đóng tab ${m.label}`} onClick={() => closeTab(id)}>✕</button>
              </div>
            );
          })}
          <div className="tab-tools">
            <span className="part">{w.part ? `PART ${w.part}` : 'PROLOGUE'}</span>
            <button type="button" disabled={!busy} onClick={() => patchRun({ playing: !run?.playing })}>{run?.playing === false ? '▶ Tiếp' : '⏸ Dừng'}</button>
            <button type="button" disabled={!run} onClick={() => patchRun({ speed: run?.speed === 1 ? 2 : run?.speed === 2 ? 0.5 : 1 })}>{run?.speed ?? 1}x</button>
            <button type="button" onClick={() => setCast(meta.id, () => castFor(w.team))}>🎲 Random</button>
          </div>
        </div>

        <div className="panes" ref={gridRef}>
          {shownMember && [shownMember].map(m => (
            <Pane key={m.id} member={m} agent={w.agents[m.id]} char={castOf(m.id)} isOrch={w.orch === m.id}
              task={w.agents[m.id].task ? w.tasks[w.agents[m.id].task!] : undefined}
              log={w.log} nameOf={nameOf} access={w.access[m.id] ?? 'ask'} busy={!bridge && busy}
              perm={w.perm?.agent === m.id ? w.perm.text : null}
              stageRef={el => { stageRefs.current[m.id] = el; }}
              onReroll={() => setCast(meta.id, c => ({ ...c, [m.id]: pickFree(Object.values(c)) }))}
              onRemove={canRemove(w.agents[m.id]) ? () => removeMember(m.id) : undefined}
              providers={providers}
              onProvider={canRemove(w.agents[m.id]) ? pid => changeProvider(m.id, pid) : undefined}
              onLogin={methodId => login(m.id, methodId)}
              onPerm={answerPerm}
              onAccess={mode => dispatch({ t: 'access', agent: m.id, mode })}
              onSend={text => sendTo(m, text)}
              onConfig={(configId, value) => setMemberConfig(meta.id, m.id, configId, value)} />
          ))}
          {w.team.length === 0 && (
            <div className="empty-state">
              <p className="es-kana" aria-hidden="true">ゴゴゴゴ</p>
              {!meta.path ? (
                <>
                  <h2>Mở một thư mục để bắt đầu</h2>
                  <p className="es-sub">Mỗi thư mục là một project, mở trong cửa sổ riêng, như VS Code.</p>
                  <button type="button" className="cta" onClick={openFolder}>Mở thư mục…</button>
                  {adding && <NewProject onOpen={openPath} onCancel={() => setAdding(false)} />}
                </>
              ) : (
                <>
                  <h2>Đội Stand đang trống</h2>
                  <ol>
                    <li>Mở <b>⚙ Providers</b> ở sidebar, thêm agent CLI có ACP: tên + lệnh chạy.</li>
                    <li>Bấm <b>+ Sub-agent</b> dưới project. Agent đầu tiên làm chỉ huy 👑.</li>
                    <li>Khi cần thêm người, chỉ huy sẽ hỏi bạn qua một cửa sổ để chọn model và effort.</li>
                  </ol>
                </>
              )}
            </div>
          )}
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
      <Flights flights={w.flights} pos={pos} onLand={key => dispatch({ t: 'land', key })} />
      <Overlay fx={w.fx} onDone={() => dispatch({ t: 'fx.done' })} />
      {spawnReq?.sid === meta.id && w.agents[spawnReq.id] && (
        <SpawnDialog key={spawnReq.id} leader={nameOf(spawnReq.by)} member={w.team.find(m => m.id === spawnReq.id)!} agent={w.agents[spawnReq.id]}
          char={castOf(spawnReq.id)} providers={providers} needsFolder={!meta.path}
          onProvider={pid => changeProvider(spawnReq.id, pid)}
          onConfig={(configId, value) => setMemberConfig(meta.id, spawnReq.id, configId, value)}
          onAnswer={answerSpawn} />
      )}
    </div>
  );
}
