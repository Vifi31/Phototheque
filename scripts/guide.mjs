// Guide utilisateur : captures d'écran et export PDF (public/aide/).
//
//   node scripts/guide.mjs            photothèque d'exemple + captures + PDF
//   node scripts/guide.mjs --pdf      PDF seul (captures existantes)
//   node scripts/guide.mjs --serve    photothèque d'exemple seule, serveur laissé ouvert (port 3298)
//
// Tout se passe dans un dossier temporaire (PHOTOTHEQUE_HOME) avec des images de synthèse : les vraies
// données et les vraies photos ne sont jamais lues. Les captures et le PDF sont produits par Microsoft Edge
// (ou Chrome) sans fenêtre, piloté par le protocole DevTools (WebSocket natif de Node 24).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'aide');
const IMG = path.join(OUT, 'img');
const PORT = 3298, BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.join(os.tmpdir(), 'phototheque-guide');
const PHOTOS = path.join(HOME, 'Photos de famille');
const args = new Set(process.argv.slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BROWSERS = [
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
];

// ------------------------------------------------------------------ images de synthèse
/** Paysage en SVG : ciel en dégradé, soleil, plans successifs. */
function scene({ sky, sun, layers, w = 1800, h = 1200, extra = '' }) {
  const g = sky.map((c, i) => `<stop offset="${(i / (sky.length - 1)) * 100}%" stop-color="${c}"/>`).join('');
  const lay = layers.map(([color, pts]) => `<polygon fill="${color}" points="${pts.map(([x, y]) => `${x * w},${y * h}`).join(' ')} ${w},${h} 0,${h}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="3300" height="2200" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">${g}</linearGradient>
    <radialGradient id="g"><stop offset="0%" stop-color="${sun?.[2] ?? '#fff'}" stop-opacity=".9"/><stop offset="100%" stop-color="${sun?.[2] ?? '#fff'}" stop-opacity="0"/></radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#s)"/>${sun ? `<circle cx="${sun[0] * w}" cy="${sun[1] * h}" r="${h * 0.22}" fill="url(#g)"/><circle cx="${sun[0] * w}" cy="${sun[1] * h}" r="${h * 0.07}" fill="${sun[2]}"/>` : ''}${lay}${extra}</svg>`;
}
const ridge = (base, amp, n, seed) => Array.from({ length: n + 1 }, (_, i) => [i / n, base - amp * Math.abs(Math.sin(i * 1.7 + seed) * Math.cos(i * 0.6 + seed * 2))]);
const city = (w = 1800, h = 1200) => Array.from({ length: 22 }, (_, i) => {
  const bw = 60 + (i * 37) % 70, bh = 260 + (i * 97) % 420, x = i * 84;
  const win = Array.from({ length: Math.floor(bh / 40) }, (_, r) => Array.from({ length: Math.floor(bw / 22) }, (_, c) => ((i + r + c) % 3 ? `<rect x="${x + 6 + c * 22}" y="${h - bh + 12 + r * 40}" width="10" height="16" fill="#fde68a" opacity=".85"/>` : '')).join('')).join('');
  return `<rect x="${x}" y="${h - bh}" width="${bw}" height="${bh}" fill="#1e1b4b"/>${win}`;
}).join('');

const SCENES = [
  { file: 'Montagne_au_matin.jpg', title: 'Lever de soleil sur les Écrins', kw: ['Montagne', 'Été', 'Paysage'], date: '2023-07-14 06:40', cam: ['Canon', 'EOS R6'], rating: 5,
    svg: scene({ sky: ['#fde68a', '#fca5a5', '#93c5fd'], sun: [0.7, 0.42, '#fff7ed'], layers: [['#94a3b8', ridge(0.55, 0.3, 9, 1)], ['#64748b', ridge(0.68, 0.22, 11, 3)], ['#334155', ridge(0.82, 0.12, 13, 5)]] }) },
  { file: 'Glacier.jpg', title: 'Glacier Blanc', kw: ['Montagne', 'Été', 'Randonnée'], date: '2023-07-15 11:20', cam: ['Canon', 'EOS R6'], rating: 4,
    svg: scene({ sky: ['#38bdf8', '#e0f2fe'], layers: [['#f8fafc', ridge(0.5, 0.32, 7, 2)], ['#cbd5e1', ridge(0.7, 0.18, 9, 4)], ['#475569', ridge(0.86, 0.1, 12, 6)]] }) },
  { file: 'Coucher_de_soleil_mer.jpg', title: 'Coucher de soleil à Étretat', kw: ['Mer', 'Été', 'Paysage'], date: '2022-08-03 21:12', cam: ['Fujifilm', 'X-T4'], rating: 5,
    svg: scene({ sky: ['#7c3aed', '#f472b6', '#fb923c', '#fde047'], sun: [0.5, 0.62, '#fef3c7'], layers: [['#1e3a8a', [[0, 0.68], [1, 0.68]]], ['#172554', [[0, 0.85], [1, 0.82]]]] }) },
  { file: 'Plage.jpg', title: 'La plage des Grands Sables', kw: ['Mer', 'Famille', 'Été'], date: '2022-08-05 15:30', cam: ['Fujifilm', 'X-T4'], rating: 3,
    svg: scene({ sky: ['#0ea5e9', '#bae6fd'], sun: [0.2, 0.18, '#fffbeb'], layers: [['#0369a1', [[0, 0.55], [1, 0.52]]], ['#22d3ee', [[0, 0.64], [1, 0.62]]], ['#fde68a', [[0, 0.74], [0.5, 0.71], [1, 0.75]]]] }) },
  { file: 'Foret_automne.jpg', title: 'Forêt de Brocéliande en automne', kw: ['Forêt', 'Automne', 'Randonnée'], date: '2021-10-24 14:05', cam: ['Nikon', 'Z 6II'], rating: 4,
    svg: scene({ sky: ['#fed7aa', '#fdba74'], layers: [['#c2410c', ridge(0.45, 0.25, 30, 1)], ['#9a3412', ridge(0.6, 0.2, 34, 2)], ['#7c2d12', ridge(0.78, 0.15, 40, 3)], ['#451a03', [[0, 0.9], [1, 0.92]]]] }) },
  { file: 'Foret_brume.jpg', title: 'Brume dans les sapins', kw: ['Forêt', 'Hiver'], date: '2021-12-28 09:50', cam: ['Nikon', 'Z 6II'], rating: 3,
    svg: scene({ sky: ['#e2e8f0', '#94a3b8'], layers: [['#64748b', ridge(0.5, 0.3, 40, 7)], ['#334155', ridge(0.66, 0.25, 46, 8)], ['#0f172a', ridge(0.82, 0.2, 52, 9)]] }) },
  { file: 'Ville_de_nuit.jpg', title: 'Lyon, la nuit', kw: ['Ville', 'Nuit'], date: '2024-03-16 22:15', cam: ['Sony', 'ILCE-7M4'], rating: 4,
    svg: scene({ sky: ['#0f172a', '#312e81', '#6d28d9'], extra: city() + '<circle cx="1500" cy="180" r="60" fill="#f8fafc" opacity=".9"/>', layers: [] }) },
  { file: 'Lavande.jpg', title: 'Champs de lavande à Valensole', kw: ['Provence', 'Été', 'Fleurs'], date: '2024-07-02 19:45', cam: ['Sony', 'ILCE-7M4'], rating: 5,
    svg: scene({ sky: ['#c084fc', '#f9a8d4', '#fdba74'], sun: [0.3, 0.42, '#fef3c7'], layers: [['#a78bfa', [[0, 0.58], [1, 0.6]]], ['#8b5cf6', [[0, 0.7], [0.5, 0.68], [1, 0.71]]], ['#6d28d9', [[0, 0.83], [1, 0.84]]], ['#4c1d95', [[0, 0.94], [1, 0.95]]]] }) },
  { file: 'Desert.jpg', title: 'Dunes de Merzouga', kw: ['Voyage', 'Désert'], date: '2019-11-08 17:30', cam: ['Canon', 'EOS 80D'], rating: 4,
    svg: scene({ sky: ['#fb923c', '#fde68a'], sun: [0.75, 0.4, '#fff7ed'], layers: [['#f59e0b', ridge(0.6, 0.12, 4, 1)], ['#d97706', ridge(0.75, 0.1, 5, 2)], ['#b45309', ridge(0.9, 0.06, 6, 3)]] }) },
  { file: 'Lac.jpg', title: 'Lac d\'Annecy', kw: ['Montagne', 'Lac', 'Printemps'], date: '2020-05-21 10:10', cam: ['Canon', 'EOS 80D'], rating: 4,
    svg: scene({ sky: ['#7dd3fc', '#f0f9ff'], layers: [['#4d7c0f', ridge(0.45, 0.2, 8, 3)], ['#365314', ridge(0.55, 0.1, 10, 4)], ['#0e7490', [[0, 0.62], [1, 0.62]]], ['#155e75', [[0, 0.85], [1, 0.86]]]] }) },
  { file: 'Anniversaire.jpg', title: 'Anniversaire de Léa', kw: ['Famille', 'Fête'], date: '2020-02-09 16:00', cam: ['Apple', 'iPhone 11'], rating: 5,
    svg: scene({ sky: ['#fce7f3', '#fbcfe8'], layers: [['#f9a8d4', [[0, 0.8], [1, 0.8]]]], extra: [0.2, 0.4, 0.6, 0.8].map((x, i) => `<circle cx="${x * 1800}" cy="${300 + i * 60}" r="120" fill="${['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6'][i]}"/><line x1="${x * 1800}" y1="${420 + i * 60}" x2="${x * 1800}" y2="960" stroke="#475569" stroke-width="4"/>`).join('') }) },
  { file: 'Neige.jpg', title: 'Première neige au jardin', kw: ['Hiver', 'Famille'], date: '2021-01-17 11:30', cam: ['Apple', 'iPhone 11'], rating: 2,
    svg: scene({ sky: ['#cbd5e1', '#f1f5f9'], layers: [['#f8fafc', [[0, 0.7], [1, 0.66]]]], extra: Array.from({ length: 120 }, (_, i) => `<circle cx="${(i * 151) % 1800}" cy="${(i * 263) % 1100}" r="${4 + (i % 4) * 2}" fill="#fff"/>`).join('') }) },
];
// rafale : deux vues presque identiques (similitude), et une copie exacte (doublon)
SCENES.push({ ...SCENES[2], file: 'Coucher_de_soleil_mer_2.jpg', date: '2022-08-03 21:12:05', rating: 0,
  svg: SCENES[2].svg.replace('stop-color="#fde047"', 'stop-color="#fef08a"') });

async function makeLibrary() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(PHOTOS, { recursive: true });
  const { default: sharp } = await import('sharp');
  for (const s of SCENES) {
    const f = path.join(PHOTOS, s.file), [d, t] = s.date.split(' ');
    await sharp(Buffer.from(s.svg)).jpeg({ quality: 88 })
      .withExif({ IFD0: { Make: s.cam[0], Model: s.cam[1], Artist: 'Famille Martin', Copyright: '© Famille Martin' }, IFD2: { DateTimeOriginal: `${d.replace(/-/g, ':')} ${t.length === 5 ? t + ':00' : t}` } })
      .toFile(f);
    const when = new Date(`${d}T${t.length === 5 ? t + ':00' : t}`); fs.utimesSync(f, when, when);
  }
  fs.mkdirSync(path.join(PHOTOS, 'Sauvegarde téléphone'), { recursive: true });
  fs.copyFileSync(path.join(PHOTOS, 'Anniversaire.jpg'), path.join(PHOTOS, 'Sauvegarde téléphone', 'IMG_2041.jpg'));
}

// ------------------------------------------------------------------ serveur de démonstration
async function startServer() {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PHOTOTHEQUE_HOME: HOME, PHOTOTHEQUE_PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/ping')).ok) return child; } catch { /* pas encore prêt */ } await sleep(250); }
  child.kill(); throw new Error('Le serveur de démonstration ne démarre pas');
}
const api = async (p, method = 'GET', body) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${p} : ${j.error}`); return j;
};
const waitJob = async id => { for (;;) { const { job } = await api('/jobs/' + id); if (job.status !== 'running') return job; await sleep(200); } };

async function fillLibrary() {
  const { support } = await api('/supports', 'POST', { name: 'Disque photos (WD 2 To)', kind: 'disk', role: 'original', mount_path: PHOTOS, brand: 'WD', model: 'Elements 2 To', serial: 'WX41A2B', location: 'Bureau, étagère du haut' });
  const { folder } = await api('/folders', 'POST', { path: PHOTOS, supportId: support.id });
  const idx = await waitJob((await api(`/folders/${folder.id}/index`, 'POST', {})).jobId);
  if (idx.status !== 'done') throw new Error('Indexation : ' + idx.error);
  const rows = (await api('/photos?limit=100&sort=captured_asc')).rows;
  const byName = n => rows.find(r => (r.path ?? '').endsWith(path.sep + n) || r.file_name === n);
  for (const s of SCENES) {
    const r = byName(s.file); if (!r) continue;
    await api('/photos', 'PUT', { id: r.id, title: s.title, rating: s.rating, keywords: s.kw, description: s.file === 'Lavande.jpg' ? 'Fin de journée sur le plateau, juste avant la récolte.' : undefined });
  }
  // collections
  const ete = rows.filter(r => SCENES.find(s => byName(s.file)?.id === r.id)?.kw.includes('Été')).map(r => r.id);
  await api('/collections', 'POST', { name: 'Vacances d’été', kind: 'static', photoIds: ete });
  await api('/collections', 'POST', { name: 'Mes meilleures photos', kind: 'dynamic', query: { rating: 5 } });
  // une version retouchée
  const lav = byName('Lavande.jpg');
  const { version } = await api(`/photos/${lav.id}/edits`, 'POST', { name: 'Chaude et contrastée', params: { contrast: 12, saturation: 22, temperature: 12 } });
  await api(`/edits/${version.id}`, 'PUT', { isDefault: true });
  // album
  const { album } = await api('/albums', 'POST', { name: 'Été 2023 en montagne', format: 'a4-paysage' });
  await api(`/albums/${album.id}/fill`, 'POST', { photoIds: rows.map(r => r.id).slice(0, 8), layout: 'deux-cote' });
  // doublons : empreintes visuelles
  const h = await api('/duplicates/hashes', 'POST', { all: true }); await waitJob(h.jobId);
  // une sauvegarde
  await api('/backups', 'POST', { type: 'data', label: 'Avant rangement' });
  return { rows, album, lav };
}

// ------------------------------------------------------------------ navigateur sans fenêtre (DevTools)
async function startBrowser() {
  const exe = BROWSERS.find(f => fs.existsSync(f)); if (!exe) throw new Error('Microsoft Edge ou Google Chrome introuvable');
  const prof = path.join(HOME, 'navigateur'), port = 9339;
  const child = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  let ver; for (let i = 0; i < 80 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(250); } }
  if (!ver) { child.kill(); throw new Error('Navigateur sans fenêtre injoignable'); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
  let n = 0; const wait = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { const [ok, ko] = wait.get(m.id); wait.delete(m.id); m.error ? ko(new Error(m.error.message)) : ok(m.result); } };
  const send = (method, params = {}, sessionId) => new Promise((ok, ko) => { const id = ++n; wait.set(id, [ok, ko]); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  // fermeture propre (Browser.close), puis arbre de processus au besoin : Edge lance plusieurs sous-processus
  const close = async () => {
    try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch { /* déjà fermé */ }
    try { ws.close(); } catch { /* fermé */ }
    await sleep(500);
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill();
    await sleep(800);
  };
  return { child, s, close };
}

async function capture(b, list) {
  fs.mkdirSync(IMG, { recursive: true });
  const evalJs = async expr => { const r = await b.s('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'erreur JS'); return r.result.value; };
  const settle = () => evalJs(`for (let i = 0; i < 60; i++) { const imgs = [...document.images].filter(im => im.getBoundingClientRect().top < innerHeight); if (imgs.every(im => im.complete)) break; await new Promise(r => setTimeout(r, 100)); } await new Promise(r => setTimeout(r, 400));`);
  for (const shot of list) {
    await b.s('Emulation.setDeviceMetricsOverride', { width: shot.w ?? 1440, height: shot.h ?? 880, deviceScaleFactor: 1, mobile: false });
    await b.s('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await b.s('Page.navigate', { url: BASE + '/' }); await sleep(900);
    await evalJs(`localStorage.clear(); for (let i = 0; i < 50 && !window.App; i++) await new Promise(r => setTimeout(r, 100));`);
    await evalJs(shot.js); await settle();
    const { data } = await b.s('Page.captureScreenshot', { format: 'jpeg', quality: 85, ...(shot.clip ? { clip: { ...shot.clip, scale: 1 } } : {}) });
    fs.writeFileSync(path.join(IMG, shot.name + '.jpg'), Buffer.from(data, 'base64'));
    console.log('  capture', shot.name);
  }
}

async function printPdf(b) {
  await b.s('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.s('Page.navigate', { url: BASE + '/aide/index.html' }); await sleep(1500);
  await b.s('Runtime.evaluate', { expression: 'Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; })))', awaitPromise: true });
  const foot = '<div style="width:100%;font:8px Segoe UI,Arial;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between"><span>Photothèque — Guide de l’utilisateur</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';
  const { data } = await b.s('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: foot, marginTop: 0.5, marginBottom: 0.6, marginLeft: 0, marginRight: 0, generateDocumentOutline: true, generateTaggedPDF: true });
  const f = path.join(OUT, 'Guide-utilisateur-Phototheque.pdf');
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  console.log('  PDF', path.relative(ROOT, f), Math.round(fs.statSync(f).size / 1024), 'Ko');
}

/** Contrôle visuel : la page en mode impression (largeur A4), capturée en entier dans le dossier temporaire. */
async function preview(b) {
  await b.s('Emulation.setDeviceMetricsOverride', { width: 794, height: 1123, deviceScaleFactor: 1, mobile: false });
  await b.s('Emulation.setEmulatedMedia', { media: 'print' });
  await b.s('Page.navigate', { url: BASE + '/aide/index.html' }); await sleep(1500);
  const { data } = await b.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const f = path.join(os.tmpdir(), 'phototheque-guide-apercu.png'); fs.writeFileSync(f, Buffer.from(data, 'base64')); console.log('  aperçu', f);
}

// ------------------------------------------------------------------ déroulé
export const SHOTS = ctx => [
  { name: 'phototheque', h: 1180, js: `await App.go('photos');` },
  { name: 'visionneuse', js: `await App.go('photos'); await new Promise(r => setTimeout(r, 600)); document.querySelectorAll('.photo-cell')[0]?.click();` },
  { name: 'recherche', js: `await App.go('photos'); await new Promise(r => setTimeout(r, 400)); const d = [...document.querySelectorAll('details')].find(x => /Recherche avancée/.test(x.textContent)); if (d) d.open = true; else [...document.querySelectorAll('summary, button')].find(b => /Recherche avancée/.test(b.textContent))?.click(); await new Promise(r => setTimeout(r, 300)); d?.scrollIntoView();` },
  { name: 'planche-dialogue', js: `await App.go('photos'); await new Promise(r => setTimeout(r, 500)); [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Planches, catalogues'))?.click();` },
  { name: 'selection', h: 1180, js: `await App.go('photos'); await new Promise(r => setTimeout(r, 500)); for (const i of [0, 2, 3]) document.querySelectorAll('.photo-cell .ph-sel')[i]?.click();` },
  { name: 'importation', js: `await App.go('import');` },
  { name: 'supports', js: `await App.go('supports');` },
  { name: 'mots-cles', js: `await App.go('keywords');` },
  { name: 'collections', js: `await App.go('collections');` },
  { name: 'albums', js: `await App.go('albums');` },
  { name: 'album-editeur', js: `App.state.albumId = ${JSON.stringify(ctx.album.id)}; await App.go('album');` },
  { name: 'retouche', js: `App.state.editPhotoId = ${JSON.stringify(ctx.lav.id)}; App.state.editBack = 'photos'; await App.go('retouche');` },
  { name: 'doublons', js: `await App.go('duplicates');` },
  { name: 'statistiques', js: `await App.go('stats');` },
  { name: 'rapports', js: `await App.go('reports');` },
  { name: 'administration', js: `await App.go('admin');` },
  { name: 'parametres', js: `await App.go('settings');` },
];

async function main() {
  let server = null, browser = null;
  try {
    if (!args.has('--pdf')) { console.log('Photothèque d’exemple…'); await makeLibrary(); }
    server = await startServer();
    let ctx = null;
    if (!args.has('--pdf')) ctx = await fillLibrary();
    if (args.has('--serve')) { console.log(`Serveur d’exemple : ${BASE} (Ctrl+C pour arrêter)`); await new Promise(() => {}); }
    browser = await startBrowser();
    if (!args.has('--pdf')) { console.log('Captures…'); await capture(browser, SHOTS(ctx)); }
    console.log('PDF…'); await printPdf(browser);
    if (args.has('--apercu')) await preview(browser);
  } finally { await browser?.close(); server?.kill(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
