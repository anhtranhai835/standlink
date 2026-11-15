// One-command dev run: start Vite if nothing serves :5173 yet, wait for it, then open Electron.
// Closing the app also stops the Vite server this script started.
import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

const URL = 'http://localhost:5173';
const web = path.join(import.meta.dirname, '..');
const up = () => fetch(URL).then(r => r.ok, () => false);

let vite = null;
if (!(await up())) {
  vite = spawn(process.execPath, [path.join(web, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: web, stdio: 'inherit' });
  for (let i = 0; !(await up()); i++) {
    if (i > 120) { console.error('Vite did not start on :5173'); vite.kill(); process.exit(1); }
    await new Promise(r => setTimeout(r, 250));
  }
}

const app = spawn(electronPath, ['.', '--dev'], { cwd: web, stdio: 'inherit' });
app.on('exit', code => { vite?.kill(); process.exit(code ?? 0); });
