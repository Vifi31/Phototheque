// Construction des distributions de Photothèque.
//
//   node scripts/build.mjs [--sortie dossier] [--sans-exe] [--sans-node] [--sans-multiplateforme]
//
// Produit dans dist/ (ou --sortie) :
//   Phototheque-<v>-windows-x64.zip       programme + Node.js livré (node/node.exe) + SHA256SUMS(.sig)
//   Phototheque-<v>-installation.exe      installateur auto-extractible (IExpress, fourni avec Windows)
//   Phototheque-<v>-multiplateforme.zip   programme sans Node.js ni node_modules (macOS / Linux : Node 24 requis)
//   SHA256SUMS (+ SHA256SUMS.sig)         empreintes des fichiers livrés, signées si la clé privée est présente
//
// Signature Ed25519 : clé privée lue dans PHOTOTHEQUE_SIGN_KEY ou %USERPROFILE%\.phototheque\signature\
// (créée par `node scripts/cles.mjs`). Signature Authenticode (en plus) si un certificat de signature de
// code est fourni : PHOTOTHEQUE_CERT_PFX (+ PHOTOTHEQUE_CERT_PASSWORD) ou PHOTOTHEQUE_CERT_THUMBPRINT,
// horodatage PHOTOTHEQUE_TIMESTAMP_URL (par défaut http://timestamp.digicert.com) ; signtool.exe du
// Windows SDK est recherché automatiquement.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { distSources, makeSums, signText, keyId, verifyDist, sha256File, SUMS_FILE, SIG_FILE, PUBLIC_KEY_FILE } from '../lib/dist.mjs';
import { createZip } from '../lib/zip.mjs';
import { buildManifest, MANIFEST_FILE } from '../lib/manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const OUT = path.resolve(opt('--sortie') ?? path.join(ROOT, 'dist'));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const NAME = `Phototheque-${VERSION}`;
const PRIVATE_KEY = process.env.PHOTOTHEQUE_SIGN_KEY || path.join(os.homedir(), '.phototheque', 'signature', 'cle-privee.pem');
const log = (...a) => console.log(...a);
const t0 = Date.now();

// ------------------------------------------------------------------ icône (générée une fois, versionnée)
async function ensureIcon() {
  const ico = path.join(ROOT, 'distribution', 'phototheque.ico');
  if (fs.existsSync(ico)) return ico;
  const { default: sharp } = await import('sharp');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#0e7490"/></linearGradient></defs>
    <rect x="8" y="8" width="240" height="240" rx="52" fill="url(#g)"/><rect x="40" y="82" width="176" height="122" rx="22" fill="#0f172a"/><rect x="92" y="60" width="72" height="34" rx="10" fill="#0f172a"/>
    <circle cx="128" cy="143" r="44" fill="#e2e8f0"/><circle cx="128" cy="143" r="30" fill="#0e7490"/><circle cx="116" cy="131" r="9" fill="#a5f3fc"/><circle cx="188" cy="104" r="8" fill="#fbbf24"/></svg>`;
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map(s => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()));
  const head = Buffer.alloc(6 + 16 * sizes.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((s, i) => { const e = 6 + 16 * i; head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(pngs[i].length, e + 8); head.writeUInt32LE(off, e + 12); off += pngs[i].length; });
  fs.writeFileSync(ico, Buffer.concat([head, ...pngs]));
  return ico;
}

// ------------------------------------------------------------------ Authenticode (facultatif)
function findSigntool() {
  const base = path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Windows Kits', '10', 'bin');
  try { for (const v of fs.readdirSync(base).filter(d => /^10\./.test(d)).sort().reverse()) { const p = path.join(base, v, 'x64', 'signtool.exe'); if (fs.existsSync(p)) return p; } } catch { /* SDK absent */ }
  return null;
}
const CERT = process.env.PHOTOTHEQUE_CERT_PFX || process.env.PHOTOTHEQUE_CERT_THUMBPRINT ? {
  pfx: process.env.PHOTOTHEQUE_CERT_PFX, password: process.env.PHOTOTHEQUE_CERT_PASSWORD, thumbprint: process.env.PHOTOTHEQUE_CERT_THUMBPRINT,
  timestamp: process.env.PHOTOTHEQUE_TIMESTAMP_URL || 'http://timestamp.digicert.com', signtool: findSigntool() } : null;
function authenticode(files) {
  if (!CERT) return false;
  if (!CERT.signtool) throw new Error('Certificat fourni mais signtool.exe introuvable (Windows SDK).');
  const a = ['sign', '/fd', 'SHA256', '/tr', CERT.timestamp, '/td', 'SHA256', '/d', 'Photothèque'];
  if (CERT.pfx) { a.push('/f', CERT.pfx); if (CERT.password) a.push('/p', CERT.password); } else a.push('/sha1', CERT.thumbprint);
  const r = spawnSync(CERT.signtool, [...a, ...files], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Signature Authenticode refusée par signtool.');
  const v = spawnSync(CERT.signtool, ['verify', '/pa', ...files], { stdio: 'inherit' });
  if (v.status !== 0) throw new Error('Signature Authenticode non vérifiable.');
  return true;
}

// ------------------------------------------------------------------ étapes
function stage(dir, { withNode = true, withModules = true } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const src of distSources(ROOT)) {
    const r = path.relative(ROOT, src);
    if (!withModules && r.split(path.sep)[0] === 'node_modules') continue;
    const dst = path.join(dir, r); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
  }
  if (withNode) {
    fs.mkdirSync(path.join(dir, 'node'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(dir, 'node', 'node.exe'));
    const lic = path.join(path.dirname(process.execPath), 'LICENSE');
    if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(dir, 'node', 'LICENSE'));
  }
}
function seal(dir) {
  const mf = buildManifest({ root: dir, store: null, nodeVersion: process.version, installed: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(mf, null, 2));
  const sums = makeSums(dir);
  fs.writeFileSync(path.join(dir, SUMS_FILE), sums);
  let signed = false;
  if (fs.existsSync(PRIVATE_KEY)) {
    const pub = fs.readFileSync(path.join(ROOT, ...PUBLIC_KEY_FILE.split('/')), 'utf8');
    fs.writeFileSync(path.join(dir, SIG_FILE), signText(sums, fs.readFileSync(PRIVATE_KEY, 'utf8')) + '\n');
    signed = true;
    log(`  signature Ed25519 (clé ${keyId(pub)})`);
  }
  const v = verifyDist(dir);
  if (!v.ok) throw new Error('Distribution non conforme après construction : ' + v.error);
  return { signed, files: v.files };
}
function zipDir(dir, zipFile, prefix = '') {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const entries = walk(dir).map(f => ({ name: prefix + path.relative(dir, f).split(path.sep).join('/'), data: fs.readFileSync(f), mtime: fs.statSync(f).mtime }));
  fs.writeFileSync(zipFile, createZip(entries));
  return entries.length;
}
/** Installateur auto-extractible IExpress : extrait installer.ps1 + le paquet dans un dossier temporaire et lance l'installation. */
function iexpress(zipFile, exeFile) {
  const ie = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'iexpress.exe');
  if (!fs.existsSync(ie)) throw new Error('iexpress.exe introuvable (fourni avec Windows).');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phototheque-iexpress-'));
  try {
    const files = { 'installer.ps1': path.join(ROOT, 'distribution', 'installer.ps1'), [path.basename(zipFile)]: zipFile };
    fs.writeFileSync(path.join(work, 'paquet.sha256'), `${sha256File(zipFile)}  ${path.basename(zipFile)}\r\n`);
    files['paquet.sha256'] = path.join(work, 'paquet.sha256');
    for (const [n, f] of Object.entries(files)) if (path.dirname(f) !== work) fs.copyFileSync(f, path.join(work, n));
    const names = Object.keys(files);
    const sed = [
      '[Version]', 'Class=IEXPRESS', 'SEDVersion=3',
      '[Options]', 'PackagePurpose=InstallApp', 'ShowInstallProgramWindow=0', 'HideExtractAnimation=1', 'UseLongFileName=1', 'InsideCompressed=0',
      'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0', 'RebootMode=N', 'InstallPrompt=%InstallPrompt%', 'DisplayLicense=%DisplayLicense%',
      'FinishMessage=%FinishMessage%', 'TargetName=%TargetName%', 'FriendlyName=%FriendlyName%', 'AppLaunched=%AppLaunched%', 'PostInstallCmd=%PostInstallCmd%',
      'AdminQuietInstCmd=%AdminQuietInstCmd%', 'UserQuietInstCmd=%UserQuietInstCmd%', 'SourceFiles=SourceFiles',
      '[Strings]', 'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=', `TargetName=${exeFile}`, `FriendlyName=Photothèque ${VERSION}`,
      'AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer.ps1', 'PostInstallCmd=<None>',
      'AdminQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer.ps1 -Silencieux',
      'UserQuietInstCmd=powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer.ps1 -Silencieux',
      ...names.map((n, i) => `FILE${i}="${n}"`),
      '[SourceFiles]', `SourceFiles0=${work}\\`, '[SourceFiles0]', ...names.map((n, i) => `%FILE${i}%=`),
    ].join('\r\n') + '\r\n';
    const sedFile = path.join(work, 'phototheque.sed');
    fs.writeFileSync(sedFile, sed, 'latin1');
    fs.rmSync(exeFile, { force: true });
    const r = spawnSync(ie, ['/N', '/Q', sedFile], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0 && !fs.existsSync(exeFile)) throw new Error('IExpress a échoué (code ' + r.status + ').');
    if (!fs.existsSync(exeFile)) throw new Error('IExpress n’a pas produit l’installateur.');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ construction
fs.mkdirSync(OUT, { recursive: true });
log(`Photothèque ${VERSION} → ${OUT}`);
await ensureIcon();
if (!fs.existsSync(path.join(ROOT, ...PUBLIC_KEY_FILE.split('/')))) log('  (aucune clé publique : distributions non signées — `node scripts/cles.mjs` pour en créer une)');
else if (!fs.existsSync(PRIVATE_KEY)) log(`  (clé privée absente : ${PRIVATE_KEY} — distributions non signées)`);

const deliverables = [];
const win = path.join(OUT, NAME);
log('Windows x64…');
stage(win, { withNode: !args.includes('--sans-node') });
if (CERT) authenticode(['distribution/installer.ps1', 'distribution/desinstaller.ps1'].map(f => path.join(win, f)));
const sw = seal(win);
const winZip = path.join(OUT, `${NAME}-windows-x64.zip`);
log(`  ${sw.files} fichiers${sw.signed ? ', signés' : ''} → ${path.basename(winZip)} (${zipDir(win, winZip)} entrées)`);
deliverables.push(winZip);

if (!args.includes('--sans-exe')) {
  const exe = path.join(OUT, `${NAME}-installation.exe`);
  log('Installateur…');
  iexpress(winZip, exe);
  if (CERT) { authenticode([exe]); log('  signature Authenticode'); }
  log(`  ${path.basename(exe)} (${Math.round(fs.statSync(exe).size / 1048576)} Mo)`);
  deliverables.push(exe);
}
if (!args.includes('--sans-multiplateforme')) {
  const multi = path.join(OUT, `${NAME}-multiplateforme`);
  log('Multiplateforme (macOS / Linux, Node.js 24 requis)…');
  stage(multi, { withNode: false, withModules: false });
  const sm = seal(multi);
  const multiZip = path.join(OUT, `${NAME}-multiplateforme.zip`);
  zipDir(multi, multiZip, `${NAME}/`);
  log(`  ${sm.files} fichiers → ${path.basename(multiZip)}`);
  fs.rmSync(multi, { recursive: true, force: true });
  deliverables.push(multiZip);
}
fs.rmSync(win, { recursive: true, force: true });

// empreintes des livrables (à publier avec eux)
const sums = deliverables.map(f => `${sha256File(f)} *${path.basename(f)}`).join('\n') + '\n';
fs.writeFileSync(path.join(OUT, SUMS_FILE), sums);
if (fs.existsSync(PRIVATE_KEY)) fs.writeFileSync(path.join(OUT, SIG_FILE), signText(sums, fs.readFileSync(PRIVATE_KEY, 'utf8')) + '\n');
else fs.rmSync(path.join(OUT, SIG_FILE), { force: true });
log(`Terminé en ${Math.round((Date.now() - t0) / 1000)} s : ${deliverables.map(f => path.basename(f)).join(', ')}, ${SUMS_FILE}${fs.existsSync(path.join(OUT, SIG_FILE)) ? ' + ' + SIG_FILE : ''}.`);
