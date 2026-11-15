import { useEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { CHARACTERS, SKILLS, frameUrl, framesOf, type Character, type Row } from './characters';
import { MAX_TEAM, type Access, type Agent, type ConfigOption, type AgentId, type Flight, type Fx, type LogItem, type Member, type Provider, type Task } from './world';

const FRAME_MS = 170; // ~6fps: slow enough to read each move
export const cssVars = (v: Record<string, string | number>) => v as CSSProperties;

/**
 * Plays one sprite-sheet row from its first playable frame. Mount it with a key per row,
 * so a new move always starts at frame 1 instead of mid-way through the previous one.
 * once = play to the last frame, hold it for `hold` ms, then call onEnd.
 */
export function Sprite({ char, row, once, frozen, hold = 700, onEnd }: {
  char: Character; row: Row; once?: boolean; frozen?: boolean; hold?: number; onEnd?: () => void;
}) {
  const frames = framesOf(char.id, row);
  const [i, setI] = useState(0);
  const [missing, setMissing] = useState(false);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const last = frames.length - 1;

  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => setI(x => (x >= last ? (once ? x : 0) : x + 1)), FRAME_MS);
    return () => clearInterval(id);
  }, [last, once, frozen]);
  useEffect(() => {
    if (!once || i < last) return;
    const id = setTimeout(() => endRef.current?.(), hold); // hold the finishing pose
    return () => clearTimeout(id);
  }, [once, i, last, hold]);

  if (missing) return <div className="sprite-missing">「{char.stand}」</div>;
  return <img className="sprite" src={frameUrl(char.id, row, frames[Math.min(i, last)])} alt={`${char.user} và ${char.stand}`} draggable={false} onError={() => setMissing(true)} />;
}

/** Warm the browser cache so the first play of a row does not flicker. */
export function preload(char: Character) {
  (['idle', ...SKILLS] as Row[]).forEach(r => {
    for (const f of framesOf(char.id, r)) new Image().src = frameUrl(char.id, r, f);
  });
}

const CRY: Record<Agent['state'], (c: Character) => string> = {
  working: c => c.cry,
  blocked: () => 'ゴゴゴゴ',
  limited: () => '',
  idle: () => '',
};
export const STATE_LABEL: Record<Agent['state'], string> = { idle: 'Chờ lệnh', working: 'Đang làm', blocked: 'Xin phép', limited: 'Hết quota' };

/**
 * One agent pane, laid out like an Orca pane (header, transcript, composer)
 * with a JoJo stage on top where the Stand fights its task.
 */
export function Pane({ member, agent, task, char, isOrch, log, nameOf, access, busy, perm, stageRef,
  onReroll, onRemove, onPerm, onAccess, onSend, onConfig, providers, onProvider, onLogin }: {
  member: Member; agent: Agent; task?: Task; char: Character; isOrch: boolean; log: LogItem[];
  nameOf: (id?: AgentId) => string; access: Access; busy: boolean; perm: string | null; stageRef: Ref<HTMLDivElement>;
  onReroll: () => void; onPerm: (ok: boolean) => void; onAccess: (m: Access) => void; onSend: (text: string) => void;
  onConfig: (configId: string, value: string) => void; onRemove?: () => void;
  /** Swap this agent to another provider; undefined while it is busy. */
  providers: Provider[]; onProvider?: (providerId: string) => void;
  onLogin: (methodId: string) => void;
}) {
  // `show` = a one-off move playing right now (talking, taking over, finishing, or an idle flourish).
  const [show, setShow] = useState<Row | null>(null);
  const [round, setRound] = useState(0); // which of the 3 skills is up while working
  useEffect(() => { if (agent.act) setShow(char[agent.act.kind]); }, [agent.act?.key]);
  useEffect(() => { setShow(null); setRound(0); }, [char.id]);
  // Idle Stands strike a random pose now and then, so every move of the sheet gets seen.
  useEffect(() => {
    if (agent.state !== 'idle' || show) return;
    const id = setTimeout(() => setShow(SKILLS[Math.floor(Math.random() * SKILLS.length)]), 7000 + Math.random() * 7000);
    return () => clearTimeout(id);
  }, [agent.state, show, char.id]);
  // Working: cycle through all three skills, starting with the character's main attack.
  const workRows = [char.work, ...SKILLS.filter(r => r !== char.work)];
  const working = agent.state === 'working';
  const row: Row = show ?? (working ? workRows[round % workRows.length] : 'idle');
  const cry = CRY[agent.state](char);

  return (
    <section className={`pane s-${agent.state}${isOrch ? ' lead' : ''}`} style={cssVars({ '--c': char.color })} aria-label={member.label}>
      <header className="pane-head">
        <img className="face" src={frameUrl(char.id, 'idle', 0)} alt="" />
        <div className="ph-main">
          <b>
            {member.label}{member.role && <em className="role">{member.role}</em>}
            {isOrch && <span className="badge">👑 CHỈ HUY</span>}
          </b>
          <span>{onProvider ? (
            <select className="prov-pick" value={member.provider} aria-label={`Provider của ${member.label}`}
              title="Đổi provider cho agent này" onChange={e => onProvider(e.target.value)}>
              {!providers.some(p => p.id === member.provider) && <option value={member.provider}>(provider đã xoá)</option>}
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          ) : providers.find(p => p.id === member.provider)?.name} · 「{char.stand}」</span>
        </div>
        <em className={`chip-state st-${agent.state}`}>{STATE_LABEL[agent.state]}</em>
        <button type="button" className="icon" title="Đổi Stand" aria-label="Đổi Stand" onClick={onReroll}>🎲</button>
        <button type="button" className="icon" disabled={!onRemove} onClick={onRemove}
          title={onRemove ? `Xoá ${member.label} khỏi đội` : 'Đang chạy, đợi xong lượt mới xoá được'} aria-label={`Xoá ${member.label}`}>✕</button>
      </header>

      <div className="stage" ref={stageRef}>
        <div className="burst" aria-hidden="true" />
        <div className="actor">
          <Sprite key={`${char.id}-${row}-${show ? 's' : round}`} char={char} row={row}
            once={!!show || working} hold={show ? 700 : 250} frozen={agent.state === 'limited'}
            onEnd={() => (show ? setShow(null) : setRound(r => r + 1))} />
        </div>
        {cry && <span className="cry" aria-hidden="true">{cry}</span>}
        <Target task={task} agent={agent} me={char} />
        {agent.state === 'limited' && <div className="stamp">TIME STOP<small>reset sau {agent.resetIn}</small></div>}
        {agent.auth && !perm && (
          <div className="perm" role="alertdialog" aria-label="Agent cần đăng nhập">
            <p className="ask">🔑 {member.label} cần đăng nhập</p>
            <p className="next">Bấm một cách bên dưới: cửa sổ terminal mở ra để bạn tự đăng nhập. Xong thì gửi lại lệnh.</p>
            <div className="perm-btns">
              {agent.auth.length
                ? agent.auth.map(m => <button key={m.id} type="button" className="yes" title={m.description} onClick={() => onLogin(m.id)}>{m.name}</button>)
                : <span className="next">Agent không gợi ý cách đăng nhập. Mở CLI của nó và đăng nhập thủ công.</span>}
            </div>
          </div>
        )}
        {perm && (
          <div className="perm" role="alertdialog" aria-label="Agent xin phép">
            <p className="next">Câu tiếp theo của bạn sẽ là: “Cho chạy đi!”</p>
            <p className="ask">{member.label} muốn {perm}</p>
            <div className="perm-btns">
              <button type="button" className="yes" onClick={() => onPerm(true)}>CHO PHÉP</button>
              <button type="button" className="no" onClick={() => onPerm(false)}>TỪ CHỐI</button>
            </div>
          </div>
        )}
      </div>

      <Transcript id={member.id} isOrch={isOrch} log={log} nameOf={nameOf} draft={agent.draft} />

      <PaneComposer isOrch={isOrch} label={member.label} access={access} busy={busy} tokens={agent.tokens} quota={agent.ctx ?? agent.quota} usesCtx={agent.ctx !== undefined}
        config={agent.config} onConfig={onConfig}
        onAccess={onAccess} onSend={onSend} />
    </section>
  );
}

/** Same task, same opponent: a stable pick from the task id, never the agent's own character. */
function foeFor(taskId: string, me: Character): Character {
  const pool = CHARACTERS.filter(ch => ch.id !== me.id);
  let h = 0;
  for (const ch of taskId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

/**
 * The task as an opponent JoJo facing the agent's Stand, fighting-game style:
 * every finished step lands a hit, the HP bar is the steps left, a done task is a KO.
 */
function Target({ task, agent, me }: { task?: Task; agent: Agent; me: Character }) {
  if (!task) return <div className="target empty">CHỜ LỆNH</div>;
  const foe = foeFor(task.id, me);
  const down = task.status === 'done';
  return (
    <div className={`target fight t-${task.status}`} style={cssVars({ '--foe': foe.color })}>
      <div className="foe" aria-hidden="true">
        <div className="foe-in" key={task.hit}>
          <Sprite key={foe.id} char={foe} row="idle" frozen={down || task.status === 'paused'} />
        </div>
      </div>
      <div className="t-body" key={task.hit}>
        <p className="t-id">{task.id} · VS 「{foe.stand}」</p>
        <p className="t-title">{task.title}</p>
        <div className="hp" aria-label={`Tiến độ ${task.done}/${task.total}`}>
          {Array.from({ length: task.total }, (_, i) => <i key={i} className={i < task.done ? 'gone' : ''} />)}
        </div>
        <p className="t-step">{task.status === 'done' ? `${task.total}/${task.total} xong` : `${task.done}/${task.total} · ${agent.label ?? ''}`}</p>
        {task.status === 'paused' && task.cp && <p className="t-cp">📜 checkpoint {task.cp.tokens} tok</p>}
      </div>
      {task.status === 'done' && <span className="clear">CLEAR!</span>}
    </div>
  );
}

/** Orca-style activity feed for one agent: oldest at top, newest at the bottom, auto-scrolled. */
function Transcript({ id, isOrch, log, nameOf, draft }: { id: AgentId; isOrch: boolean; log: LogItem[]; nameOf: (id?: AgentId) => string; draft?: string }) {
  const items = log.filter(i => i.agent === id || i.to === id || (isOrch && i.kind === 'narrate')).slice(0, 40).reverse();
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [items.length, draft?.length]);

  return (
    <ol className="feed" ref={ref} aria-live="polite">
      {items.length === 0 && <li className="f-note">{isOrch ? 'Ra lệnh ở ô bên dưới để bắt đầu.' : 'Chờ chỉ huy giao việc…'}</li>}
      {items.map(i => {
        if (i.kind === 'user') return <li key={i.key} className="f-user"><span>{i.text}</span></li>;
        if (i.kind === 'narrate') return <li key={i.key} className="f-narr">{i.text}</li>;
        if (i.kind === 'say') {
          const mine = i.agent === id;
          if (!i.to) return <li key={i.key} className="f-text">{i.text}</li>;
          return (
            <li key={i.key} className="f-card">
              <p className="f-card-head">{mine ? `↗ Gửi ${nameOf(i.to)}` : `↙ Tin từ ${nameOf(i.agent)}`}</p>
              <p>{i.text}</p>
            </li>
          );
        }
        if (i.kind === 'sfx') return <li key={i.key} className="f-sfx"><b>{i.sfx}</b> {i.text}</li>;
        return <li key={i.key} className="f-step">✎ {i.text}</li>;
      })}
      {draft && <li className="f-text f-draft">{draft}</li>}
    </ol>
  );
}

/** Per-pane prompt like Orca's: talk to this agent directly; the leader's box gives the whole team an order. */
/** Model and reasoning-effort pickers, built from whatever ACP config options the agent advertises. */
const PICKERS: { category: string; icon: string; label: string }[] = [
  { category: 'model', icon: '🧠', label: 'Model' },
  { category: 'thought_level', icon: '⚡', label: 'Effort' },
];
const flatOptions = (o: ConfigOption) => (o.options ?? []).flatMap(x => ('options' in x ? x.options : [x]));

function PaneComposer({ isOrch, label, access, busy, tokens, quota, usesCtx, config, onAccess, onSend, onConfig }: {
  isOrch: boolean; label: string; access: Access; busy: boolean; tokens: number; quota: number; usesCtx: boolean;
  config?: ConfigOption[]; onConfig: (configId: string, value: string) => void;
  onAccess: (m: Access) => void; onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const locked = isOrch && busy;
  const send = () => {
    const v = text.trim();
    if (!v || locked) return;
    onSend(v);
    setText('');
  };
  return (
    <form className="pc" onSubmit={e => { e.preventDefault(); send(); }}>
      <textarea value={text} rows={1} aria-label={`Nhắn cho ${label}`}
        placeholder={isOrch ? (busy ? 'Đội đang làm. Đợi xong rồi ra lệnh mới…' : 'Ra lệnh cho cả đội… @ file, / lệnh') : `Hỏi ${label}… @ file, / lệnh`}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <div className="pc-bar">
        <select className={`access a-${access}`} value={access} onChange={e => onAccess(e.target.value as Access)} aria-label="Quyền của agent">
          <option value="ask">✋ Hỏi trước</option>
          <option value="full">⚡ Toàn quyền</option>
        </select>
        {PICKERS.map(p => {
          const opt = config?.find(o => o.category === p.category);
          const choices = opt ? flatOptions(opt) : [];
          if (!opt || choices.length < 2) return null; // the agent does not offer this choice
          return (
            <select key={p.category} className="cfg" value={opt.currentValue ?? ''} title={`${p.label}: ${opt.name}`}
              aria-label={`${p.label} của ${label}`} onChange={e => onConfig(opt.id, e.target.value)}>
              {choices.map(c => <option key={c.value} value={c.value}>{p.icon} {c.name}</option>)}
            </select>
          );
        })}
        <span className="pc-meta">{tokens.toLocaleString()} tok · {usesCtx ? `context ${quota}%` : `quota ${quota}%`}</span>
        <button type="submit" className="go" disabled={locked || !text.trim()} aria-label="Gửi">{isOrch ? 'ORA!' : '↑'}</button>
      </div>
    </form>
  );
}

/** Messages and checkpoints flying between panes. pos() = a pane stage's anchor inside the pane grid. */
export function Flights({ flights, pos, onLand }: {
  flights: Flight[]; pos: (id: AgentId) => { x: number; y: number }; onLand: (key: number) => void;
}) {
  return (
    <>
      {flights.map(f => {
        const a = pos(f.from), b = pos(f.to);
        return (
          <div key={f.key} className={`flight f-${f.kind}`} onAnimationEnd={() => onLand(f.key)}
            style={cssVars({ '--x0': `${a.x}px`, '--y0': `${a.y}px`, '--x1': `${b.x}px`, '--y1': `${b.y}px` })}>
            {f.text}
          </div>
        );
      })}
    </>
  );
}

function Clock() {
  return (
    <svg className="clock" viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="44" />
      {Array.from({ length: 12 }, (_, i) => <line key={i} x1="50" y1="10" x2="50" y2="17" transform={`rotate(${i * 30} 50 50)`} />)}
      <line className="hand" x1="50" y1="50" x2="50" y2="18" />
    </svg>
  );
}

/** Full-screen JoJo moments. Each fx mounts fresh (key) and fades itself out with CSS. */
export function Overlay({ fx, onDone }: { fx: Fx | null; onDone: () => void }) {
  if (!fx) return null;
  return (
    <div key={fx.key} className={`fx fx-${fx.kind}`} aria-live="assertive"
      onAnimationEnd={e => { if (e.target === e.currentTarget && e.animationName === 'fade') onDone(); }}>
      {fx.kind === 'timestop' && <Clock />}
      {fx.kind === 'tbc' ? <div className="tbc-arrow">TO BE CONTINUED</div> : <div className="fx-text">{fx.text}</div>}
      {fx.sub && <div className="fx-sub">{fx.sub}</div>}
    </div>
  );
}

/** Add a sub-agent from any registered provider (nested under the active project in the sidebar). */
export function AddAgent({ providers, count, onAdd }: { providers: Provider[]; count: number; onAdd: (p: Provider) => void }) {
  const [pick, setPick] = useState('');
  const chosen = providers.find(p => p.id === pick) ?? providers[0];
  if (count >= MAX_TEAM) return <p className="tree-note">Tối đa {MAX_TEAM} Stand mỗi project.</p>;
  return (
    <div className="add-agent">
      <select value={chosen?.id ?? ''} onChange={e => setPick(e.target.value)} aria-label="Provider cho sub-agent mới" disabled={!providers.length}>
        {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button type="button" disabled={!chosen} onClick={() => chosen && onAdd(chosen)}>+ Sub-agent</button>
    </div>
  );
}

/** User-registered agent CLIs. Nothing is hard-coded: add Kimi, DeepSeek… with the command that speaks ACP. */
export function ProviderList({ providers, onAdd, onEdit, onRemove }: {
  providers: Provider[]; onAdd: (name: string, cmd: string) => void;
  onEdit: (id: string, name: string, cmd: string) => void; onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null); // provider id, 'new', or null
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const openForm = (p?: Provider) => { setEditing(p?.id ?? 'new'); setName(p?.name ?? ''); setCmd(p?.cmd ?? ''); };
  const submit = () => {
    if (!name.trim() || !cmd.trim()) return;
    if (editing === 'new') onAdd(name.trim(), cmd.trim());
    else if (editing) onEdit(editing, name.trim(), cmd.trim());
    setEditing(null);
  };
  const form = (
    <form className="stack-form" onSubmit={e => { e.preventDefault(); submit(); }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên (vd: Kimi, DeepSeek)" aria-label="Tên provider" autoFocus />
      <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="Lệnh ACP (vd: kimi --acp)" aria-label="Lệnh chạy ACP" />
      <div className="row">
        <button type="submit" disabled={!name.trim() || !cmd.trim()}>{editing === 'new' ? 'Thêm' : 'Lưu'}</button>
        <button type="button" onClick={() => setEditing(null)}>Huỷ</button>
      </div>
    </form>
  );
  return (
    <div className="providers">
      <ul>
        {providers.map(p => (editing === p.id ? <li key={p.id} className="editing">{form}</li> : (
          <li key={p.id}>
            <div><b>{p.name}</b><code>{p.cmd}</code></div>
            <span className="row-btns">
              <button type="button" className="x" title={`Sửa ${p.name}`} aria-label={`Sửa provider ${p.name}`} onClick={() => openForm(p)}>✎</button>
              <button type="button" className="x" title={`Xoá ${p.name}`} aria-label={`Xoá provider ${p.name}`} onClick={() => onRemove(p.id)}>✕</button>
            </span>
          </li>
        )))}
        {!providers.length && <li className="tree-note">Chưa có provider. Thêm một cái để lập đội.</li>}
      </ul>
      {editing === 'new' ? form : <button type="button" className="ghost" onClick={() => openForm()}>+ Provider</button>}
    </div>
  );
}

/** Browser demo only (the desktop app uses the system folder picker): type a folder path; the project is named after it. */
export function NewProject({ onOpen, onCancel }: { onOpen: (path: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState('');
  return (
    <form className="stack-form" onSubmit={e => { e.preventDefault(); if (path.trim()) onOpen(path.trim()); }}>
      <label className="field">Thư mục<input value={path} onChange={e => setPath(e.target.value)} placeholder="vd: D:\code\shop" autoFocus /></label>
      <div className="row"><button type="submit" disabled={!path.trim()}>Mở</button><button type="button" onClick={onCancel}>Huỷ</button></div>
    </form>
  );
}

/**
 * The leader asked for one more member (spawn). The member already runs so its real model / effort lists load here;
 * the user picks them, or says no. Native <dialog>: focus stays inside, Esc = decline.
 */
export function SpawnDialog({ leader, member, agent, char, providers, needsFolder, onProvider, onConfig, onAnswer }: {
  leader: string; member: Member; agent: Agent; char: Character; providers: Provider[]; needsFolder: boolean;
  onProvider: (providerId: string) => void; onConfig: (configId: string, value: string) => void;
  onAnswer: (ok: boolean, label?: string, role?: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState(member.label);
  const [role, setRole] = useState(member.role ?? '');
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => setLabel(member.label), [member.provider]); // a new provider renames an unnamed member
  const loading = !agent.config && !needsFolder;
  return (
    <dialog ref={ref} className="spawn" aria-labelledby="spawn-title" style={cssVars({ '--c': char.color })}
      onCancel={e => { e.preventDefault(); onAnswer(false); }}>
      <form method="dialog" onSubmit={e => { e.preventDefault(); onAnswer(true, label, role); }}>
        <header className="spawn-head">
          <img className="face" src={frameUrl(char.id, 'idle', 0)} alt="" />
          <div>
            <p className="spawn-kicker">👑 {leader} cần thêm người</p>
            <h2 id="spawn-title">Thêm 「{char.stand}」 vào đội?</h2>
          </div>
        </header>
        <div className="spawn-grid">
          <label className="field">Tên<input value={label} onChange={e => setLabel(e.target.value.slice(0, 40))} /></label>
          <label className="field">Vai trò<input value={role} onChange={e => setRole(e.target.value.slice(0, 40))} list="role-presets" placeholder="vd: Reviewer" /></label>
          <datalist id="role-presets">{ROLE_PRESETS.map(r => <option key={r} value={r} />)}</datalist>
          <label className="field">Provider
            <select value={member.provider} onChange={e => onProvider(e.target.value)}>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {PICKERS.map(pk => {
            const opt = agent.config?.find(o => o.category === pk.category);
            const choices = opt ? flatOptions(opt) : [];
            return (
              <label key={pk.category} className="field">{pk.label}
                <select value={opt?.currentValue ?? ''} disabled={choices.length < 2} onChange={e => opt && onConfig(opt.id, e.target.value)}>
                  {choices.length ? choices.map(c => <option key={c.value} value={c.value}>{c.name}</option>)
                    : <option value="">{loading ? 'Đang tải…' : 'Mặc định của agent'}</option>}
                </select>
              </label>
            );
          })}
        </div>
        <p className="spawn-note" aria-live="polite">
          {needsFolder ? 'Project chưa có thư mục: agent chỉ chạy được sau khi mở thư mục.'
            : loading ? 'Đang khởi động agent để lấy danh sách model…' : 'Có thể đổi model / effort sau ở ô chat của agent.'}
        </p>
        <div className="spawn-btns">
          <button type="button" className="ghost" onClick={() => onAnswer(false)}>Từ chối</button>
          <button type="submit" className="cta" autoFocus>Thêm vào đội</button>
        </div>
      </form>
    </dialog>
  );
}

/** Team skills: shared playbooks agents load on demand with the `skill` tool. Desktop app only. */
export function SkillList({ skills, canProject, onSave, onDelete }: {
  skills: { name: string; description: string; scope: 'project' | 'app' }[] | null;
  canProject: boolean;
  onSave: (s: { name: string; description: string; body: string; project: boolean }) => Promise<void>;
  onDelete: (name: string, project: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [project, setProject] = useState(false);
  const [error, setError] = useState('');
  if (!skills) return <p className="tree-note">Skill chạy trong bản app desktop.</p>;
  const nameOk = /^[a-z0-9][a-z0-9-]{0,47}$/.test(name);
  const submit = async () => {
    try {
      await onSave({ name, description, body, project });
      setName(''); setDescription(''); setBody(''); setOpen(false); setError('');
    } catch (e) { setError(String((e as Error).message ?? e)); }
  };
  return (
    <div className="providers">
      <ul>
        {skills.map(sk => (
          <li key={`${sk.scope}-${sk.name}`}>
            <div><b>{sk.name} <small className="scope">{sk.scope}</small></b><code>{sk.description || 'chưa có mô tả'}</code></div>
            <button type="button" className="x" title={`Xoá skill ${sk.name}`} aria-label={`Xoá skill ${sk.name}`} onClick={() => onDelete(sk.name, sk.scope === 'project')}>✕</button>
          </li>
        ))}
        {!skills.length && <li className="tree-note">Chưa có skill. Agent chỉ thấy tên + mô tả, đọc nội dung khi cần.</li>}
      </ul>
      {open ? (
        <form className="stack-form" onSubmit={e => { e.preventDefault(); if (nameOk && body.trim()) submit(); }}>
          <input value={name} onChange={e => setName(e.target.value.toLowerCase())} placeholder="tên-skill (vd: review-pr)" aria-label="Tên skill" autoFocus />
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Mô tả 1 dòng: khi nào dùng" aria-label="Mô tả skill" />
          <textarea className="skill-body" value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder="Hướng dẫn chi tiết (markdown)" aria-label="Nội dung skill" />
          {canProject && (
            <label className="check"><input type="checkbox" checked={project} onChange={e => setProject(e.target.checked)} /> Lưu trong project (.standlink/skills)</label>
          )}
          {error && <p className="tree-note err">{error}</p>}
          <div className="row"><button type="submit" disabled={!nameOk || !body.trim()}>Lưu</button><button type="button" onClick={() => setOpen(false)}>Huỷ</button></div>
        </form>
      ) : (
        <button type="button" className="ghost" onClick={() => setOpen(true)}>+ Skill</button>
      )}
    </div>
  );
}

const ROLE_PRESETS = ['Coder', 'Reviewer', 'Tester', 'Planner', 'Researcher', 'Docs', 'Designer', 'DevOps'];

/** Inline rename + role editor for one team member. */
export function MemberEdit({ member, onSave, onCancel }: {
  member: Member; onSave: (label: string, role: string) => void; onCancel: () => void;
}) {
  const [label, setLabel] = useState(member.label);
  const [role, setRole] = useState(member.role ?? '');
  return (
    <form className="stack-form member-edit" onSubmit={e => { e.preventDefault(); onSave(label, role); }}>
      <input value={label} onChange={e => setLabel(e.target.value.slice(0, 40))} placeholder="Tên hiển thị" aria-label="Tên agent" autoFocus />
      <input value={role} onChange={e => setRole(e.target.value.slice(0, 40))} placeholder="Vai trò (vd: Reviewer)" aria-label="Vai trò" list="role-presets" />
      <datalist id="role-presets">{ROLE_PRESETS.map(r => <option key={r} value={r} />)}</datalist>
      <div className="row"><button type="submit">Lưu</button><button type="button" onClick={onCancel}>Huỷ</button></div>
    </form>
  );
}
