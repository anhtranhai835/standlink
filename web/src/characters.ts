// JoJo cast. Sprites live in public/sprites/<id>/<row>-NN.webp (local only, gitignored; made by scripts/slice_sprites.py).
// Each sheet row: idle, then three abilities. work = row played while doing a task,
// special = row played when talking or taking over a task, finisher = row played on task done.
export type Row = 'idle' | 'skill1' | 'skill2' | 'skill3';

export interface Character {
  id: string;
  user: string;
  stand: string;
  color: string;
  work: Row;
  special: Row;
  finisher: Row;
  cry: string;
}

const c = (id: string, user: string, stand: string, color: string, work: Row, special: Row, finisher: Row, cry = 'ドドドド'): Character =>
  ({ id, user, stand, color, work, special, finisher, cry });

export const CHARACTERS: Character[] = [
  c('jotaro', 'Jotaro Kujo', 'STAR PLATINUM', '#9a7bff', 'skill1', 'skill2', 'skill3', 'オラオラ'),
  c('dio', 'DIO', 'THE WORLD', '#f2c230', 'skill2', 'skill1', 'skill3', '無駄無駄'),
  c('joseph', 'Joseph Joestar', 'HERMIT PURPLE', '#b07de0', 'skill2', 'skill1', 'skill3', 'ゴゴゴ'),
  c('kakyoin', 'Noriaki Kakyoin', 'HIEROPHANT GREEN', '#3fd17a', 'skill1', 'skill2', 'skill3', 'レロレロ'),
  c('polnareff', 'J. P. Polnareff', 'SILVER CHARIOT', '#c9d6e2', 'skill1', 'skill2', 'skill3', 'ホラホラ'),
  c('avdol', 'Muhammad Avdol', "MAGICIAN'S RED", '#ff6a2b', 'skill1', 'skill3', 'skill2', 'ボォォ'),
  c('kira', 'Yoshikage Kira', 'KILLER QUEEN', '#f29ac8', 'skill1', 'skill3', 'skill2', 'カチッ'),
  c('okuyasu', 'Okuyasu Nijimura', 'THE HAND', '#4a86ff', 'skill1', 'skill2', 'skill3', 'ガオン'),
  c('giorno', 'Giorno Giovanna', 'GOLD EXPERIENCE', '#ffd24a', 'skill3', 'skill1', 'skill2', '無駄無駄'),
  c('bucciarati', 'Bruno Bucciarati', 'STICKY FINGERS', '#74b0ff', 'skill3', 'skill1', 'skill2', 'アリアリ'),
  // skill2 (time erase) is almost all painted background, so it never ends a task
  c('diavolo', 'Diavolo', 'KING CRIMSON', '#e23a4a', 'skill3', 'skill1', 'skill3', 'ドドドド'),
  c('jolyne', 'Jolyne Cujoh', 'STONE FREE', '#4fc3ff', 'skill3', 'skill1', 'skill2', 'オラオラ'),
  c('pucci', 'Enrico Pucci', 'WHITESNAKE', '#e6e6ee', 'skill1', 'skill2', 'skill3', 'ゴゴゴ'),
  c('rohan', 'Rohan Kishibe', "HEAVEN'S DOOR", '#d9c27a', 'skill1', 'skill2', 'skill3', 'ドォーン'),
  c('josuke', 'Josuke Higashikata', 'CRAZY DIAMOND', '#ff8ad0', 'skill1', 'skill2', 'skill3', 'ドラララ'),
];

export const byId = (id: string) => CHARACTERS.find(ch => ch.id === id) ?? CHARACTERS[0];

export const frameUrl = (id: string, row: Row, i: number) => `sprites/${id}/${row}-${String(i + 1).padStart(2, '0')}.webp`;

export const SKILLS: Row[] = ['skill1', 'skill2', 'skill3'];
const ALL_FRAMES = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Playable frames per row, written by scripts/slice_sprites.py. Frames that are a painted
 * background (a whole time-stop scene) are left out so a pane never shows a dark box.
 */
let manifest: Record<string, Partial<Record<Row, number[]>>> = {};
fetch('sprites/manifest.json').then(r => (r.ok ? r.json() : {})).then(m => { manifest = m; }).catch(() => { /* no sprites yet */ });
export const framesOf = (id: string, row: Row): number[] => manifest[id]?.[row] ?? ALL_FRAMES;

/** n distinct random characters. */
export function randomCast(n: number): string[] {
  const ids = CHARACTERS.map(ch => ch.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, n);
}

/** A random character not in `used` (falls back to anyone once all 15 are taken). */
export function pickFree(used: string[]): string {
  const pool = CHARACTERS.filter(ch => !used.includes(ch.id));
  const from = pool.length ? pool : CHARACTERS;
  return from[Math.floor(Math.random() * from.length)].id;
}
