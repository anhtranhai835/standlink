import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built app also loads from file:// inside Electron
// release/ holds the packaged app: watching its locked .exe files crashes the dev server on Windows
export default defineConfig({ base: './', plugins: [react()], server: { port: 5173, watch: { ignored: ['**/release/**', '**/electron-dist/**'] } } });
