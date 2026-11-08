// Lanceur de la version installée : démarre le serveur (s'il ne tourne pas déjà) puis ouvre le navigateur.
// Appelé par Phototheque.cmd avec le Node.js livré. Les données sont dans PHOTOTHEQUE_HOME (fichier .env
// écrit par l'installateur), jamais dans le dossier du programme.
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* pas de .env : données à côté du programme */ }
const PORT = Number(process.env.PHOTOTHEQUE_PORT || 3212);
const URL_APP = `http://localhost:${PORT}`;
const open = () => { const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL_APP]] : process.platform === 'darwin' ? ['open', [URL_APP]] : ['xdg-open', [URL_APP]]; try { spawn(c, a, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { /* navigateur à ouvrir à la main */ } };

async function running() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
if (await running()) {
  console.log(`Photothèque est déjà ouverte : ${URL_APP}`);
  if (!process.argv.includes('--sans-navigateur')) open();
  process.exit(0);
}
console.log(`Photothèque démarre sur ${URL_APP} — gardez cette fenêtre ouverte (Ctrl+C ou fermeture pour arrêter).`);
await import(new URL('../server.mjs', import.meta.url).href);
for (let i = 0; i < 40 && !(await running()); i++) await new Promise(r => setTimeout(r, 250));
if (!process.argv.includes('--sans-navigateur')) open();
