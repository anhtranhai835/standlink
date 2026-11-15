import { useEffect, useRef, useState, type CSSProperties, type Ref } from 'react';
import { frameUrl, type Character, type Row } from './characters';
import { MAX_TEAM, type Access, type Agent, type AgentId, type Flight, type Fx, type LogItem, type Member, type Provider, type Task } from './world';

const FRAMES = 8;
const FRAME_MS = 170; // ~6fps: slow enough to read each move
export const cssVars = (v: Record<string, string | number>) => v as CSSProperties;

/** Plays one sprite-sheet row. once = play to the last frame, hold it, then call onEnd. */
export function Sprite({ char, row, once, frozen, onEnd }: {
  char: Character; row: Row; once?: boolean; frozen?: boolean; onEnd?: () => void;
}) {
  const [f, setF] = useState(0);
  const [missing, setMissing] = useState(false);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  useEffect(() => { setF(0); setMissing(false); }, [char.id, row]);
  useEffect(() => {
    if (frozen) return;
    const id = setInterval(() => setF(x => (x >= FRAMES - 1 ? (once ? x : 0) : x + 1)), FRAME_MS);
    return () => clearInterval(id);
  }, [char.id, row, once, frozen]);
  useEffect(() => {
    if (!once || f !== FRAMES - 1) return;
    const id = setTimeout(() => endRef.current?.(), 700); // hold the finishing pose
    return () => clearTimeout(id);
  }, [once, f]);

  if (missing) return <div className="sprite-missing">「{char.stand}」</div>;
  return <img className="sprite" src={frameUrl(char.id, row, f)} alt={`${char.user} và ${char.stand}`} draggable={false} onError={() => setMissing(true)} />;
}

/** Warm the browser cache so the first play of a row does not flicker. */
export function preload(char: Character) {
  (['idle', 'skill1', 'skill2', 'skill3'] as Row[]).forEach(r => {
    for (let i = 0; i < FRAMES; i++) new Image().src = frameUrl(char.id, r, i);
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
  onReroll, onPerm, onAccess, onSend }: {
  member: Member; agent: Agent; task?: Task; char: Character; isOrch: boolean; log: LogItem[];
  nameOf: (id?: AgentId) => string; access: Access; busy: boolean; perm: string | null; stageRef: Ref<HTMLDivElement>;
  onReroll: () => void; onPerm: (ok: boolean) => void; onAccess: (m: Access) => void; onSend: (text: string) => void;
}) {
  const [act, setAct] = useState<'special' | 'finisher' | null>(null);
  useEffect(() => { if (agent.act) setAct(agent.act.kind); }, [agent.act?.key]);
  useEffect(() => setAct(null), [char.id]);
  const row: Row = act ? char[act] : agent.state === 'working' ? char.work : 'idle';
  const cry = CRY[agent.state](char);

  return (
    <section className={`pane s-${agent.state}${isOrch ? ' lead' : ''}`} style={cssVars({ '--c': char.color })} aria-label={member.label}>
      <header className="pane-head">
        <img className="face" src={frameUrl(char.id, 'idle', 0)} alt="" />
        <div className="ph-main">
          <b>{member.label}{isOrch && <span className="badge">👑 CHỈ HUY</span>}</b>
          <span>「{char.stand}」 · {char.user}</span>
        </div>
        <em className={`chip-state st-${agent.state}`}>{STATE_LABEL[agent.state]}</em>
        <button type="button" className="icon" title="Đổi Stand" aria-label="Đổi Stand" onClick={onReroll}>🎲</button>
      </header>

      <div className="stage" ref={stageRef}>
        <div className="burst" aria-hidden="true" />
        <div className="actor"><Sprite char={char} row={row} once={!!act} frozen={agent.state === 'limited'} onEnd={() => setAct(null)} /></div>
        {cry && <span className="cry" aria-hidden="true">{cry}</span>}
        <Target task={task} agent={agent} />
        {agent.state === 'limited' && <div className="stamp">TIME STOP<small>reset sau {agent.resetIn}</small></div>}
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
        onAccess={onAccess} onSend={onSend} />
    </section>
  );
}

/** The task the Stand is attacking: steps are its HP. */
function Target({ task, agent }: { task?: Task; agent: Agent }) {
  if (!task) return <div className="target empty">CHỜ LỆNH</div>;
  return (
    <div className={`target t-${task.status}`}>
      <div className="t-body" key={task.hit}>
        <p className="t-id">{task.id}</p>
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
function PaneComposer({ isOrch, label, access, busy, tokens, quota, usesCtx, onAccess, onSend }: {
  isOrch: boolean; label: string; access: Access; busy: boolean; tokens: number; quota: number; usesCtx: boolean;
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
export function ProviderList({ providers, onAdd, onRemove }: {
  providers: Provider[]; onAdd: (name: string, cmd: string) => void; onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cmd, setCmd] = useState('');
  const submit = () => {
    if (!name.trim() || !cmd.trim()) return;
    onAdd(name.trim(), cmd.trim());
    setName(''); setCmd(''); setOpen(false);
  };
  return (
    <div className="providers">
      <ul>
        {providers.map(p => (
          <li key={p.id}>
            <div><b>{p.name}</b><code>{p.cmd}</code></div>
            <button type="button" className="x" title={`Xoá ${p.name}`} aria-label={`Xoá provider ${p.name}`} onClick={() => onRemove(p.id)}>✕</button>
          </li>
        ))}
        {!providers.length && <li className="tree-note">Chưa có provider. Thêm một cái để lập đội.</li>}
      </ul>
      {open ? (
        <form className="stack-form" onSubmit={e => { e.preventDefault(); submit(); }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên (vd: Kimi, DeepSeek)" aria-label="Tên provider" autoFocus />
          <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="Lệnh ACP (vd: kimi --acp)" aria-label="Lệnh chạy ACP" />
          <div className="row"><button type="submit" disabled={!name.trim() || !cmd.trim()}>Thêm</button><button type="button" onClick={() => setOpen(false)}>Huỷ</button></div>
        </form>
      ) : (
        <button type="button" className="ghost" onClick={() => setOpen(true)}>+ Provider</button>
      )}
    </div>
  );
}

/** New project: a name and the folder the agents will work in. */
export function NewProject({ onCreate, onCancel, onPick }: {
  onCreate: (name: string, path: string) => void; onCancel: () => void; onPick?: () => Promise<string | null>;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  return (
    <form className="stack-form" onSubmit={e => { e.preventDefault(); if (name.trim()) onCreate(name.trim(), path.trim()); }}>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Tên project" aria-label="Tên project" autoFocus />
      <div className="row">
        <input value={path} onChange={e => setPath(e.target.value)} placeholder="Thư mục (vd: D:\code\shop)" aria-label="Thư mục project" />
        {onPick && <button type="button" onClick={async () => { const d = await onPick(); if (d) setPath(d); }}>📁</button>}
      </div>
      <div className="row"><button type="submit" disabled={!name.trim()}>Tạo</button><button type="button" onClick={onCancel}>Huỷ</button></div>
    </form>
  );
}
