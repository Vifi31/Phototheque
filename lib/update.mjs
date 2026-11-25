// Mise à jour depuis GitHub : recherche d'une version plus récente et, sur demande, installation.
//
// Rien ne part tout seul : le serveur ne contacte GitHub que lorsque l'utilisateur clique sur « Rechercher une mise
// à jour ». Les requêtes n'emportent aucune donnée personnelle (adresse GitHub publique du projet, nom de client générique).
//
// Trois façons d'être installé, trois façons de mettre à jour :
//   * « git »       : le programme est un dépôt git (poste de développement) → `git merge --ff-only` de la branche
//                     suivie, puis `npm install` si les dépendances ont changé. Refusé s'il y a des modifications
//                     locales ou des commits locaux non publiés (rien n'est jamais écrasé).
//   * « installed » : version installée par l'installateur → téléchargement de l'installateur publié dans la
//                     « release » GitHub, empreinte SHA-256 vérifiée avec SHA256SUMS de la release, enregistré dans
//                     le dossier Téléchargements. L'installateur (qui vérifie la signature avec la clé de la version
//                     installée) reste à lancer par l'utilisateur, Photothèque fermée.
//   * « archive »   : autre cas (copie sans git, sans installateur) → lien vers la page du projet seulement.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

export const DEFAULT_REPO = 'Vifi31/Phototheque';
const HOSTS = ['api.github.com', 'raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const UA = 'Phototheque-update';

/** Compare deux numéros de version « x.y.z » : -1, 0 ou 1 (les parties absentes valent 0 ; un suffixe « -beta » est ignoré). */
export function compareVersions(a, b) {
  const p = v => String(v ?? '').trim().replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
export const isVersion = v => /^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());

/** Sections du CHANGELOG plus récentes que `since` (ou, avec `only`, celle de cette version), du plus récent au plus ancien. */
export function changelogSince(text, since, { only = null, max = 6000 } = {}) {
  const out = [];
  const parts = String(text ?? '').split(/^## \[/m).slice(1);
  for (const part of parts) {
    const m = /^([^\]]+)\]([^\n]*)\n([\s\S]*)$/.exec(part); if (!m) continue;
    const v = m[1].trim();
    if (!isVersion(v)) continue;
    if (only ? compareVersions(v, only) !== 0 : compareVersions(v, since) <= 0) continue;
    out.push({ version: v, title: m[2].replace(/^\s*[—-]\s*/, '').trim(), body: m[3].trim() });
  }
  let total = 0;
  return out.filter(s => (total += s.body.length) <= max || total - s.body.length === 0);
}

const trim = s => String(s ?? '').trim();

function run(cmd, args, { cwd, timeout = 120000, shell = false } = {}) {
  return new Promise(resolve => {
    let out = '', err = '';
    let child;
    try { child = spawn(cmd, args, { cwd, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message || e) }); }
    const timer = setTimeout(() => { child.kill(); }, timeout);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: err || String(e.message || e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

/**
 * @param opts.root      dossier du programme
 * @param opts.version   () => version installée
 * @param opts.installed vrai pour une version installée par l'installateur
 * @param opts.repo      « propriétaire/dépôt » GitHub
 * @param opts.fetch     remplaçable (tests)
 * @param opts.exec      remplaçable (tests) : (cmd, args, { cwd, timeout, shell }) → { code, stdout, stderr }
 * @param opts.downloads dossier de téléchargement de l'installateur
 */
export function createUpdater({ root, version, installed = false, repo = DEFAULT_REPO, fetch: fetchImpl = globalThis.fetch, exec = run, downloads = path.join(os.homedir(), 'Downloads') } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Dépôt GitHub invalide');
  let last = null;       // dernier résultat de recherche
  let busy = false;

  async function get(url, { json = true, timeout = 15000, binary = false } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname)) throw new Error('Adresse non autorisée : ' + u.hostname);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/vnd.github+json' : '*/*' }, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) { const e = new Error(`GitHub a répondu ${res.status}`); e.status = res.status; throw e; }
      return binary ? Buffer.from(await res.arrayBuffer()) : json ? await res.json() : await res.text();
    } catch (e) {
      if (e.status) throw e;
      throw Object.assign(new Error(e.name === 'AbortError' ? 'GitHub ne répond pas (délai dépassé)' : 'Connexion à GitHub impossible : ' + (e.cause?.code || e.message || e)), { offline: true });
    } finally { clearTimeout(t); }
  }

  const git = (args, o = {}) => exec('git', args, { cwd: root, ...o });
  async function mode() {
    if (fs.existsSync(path.join(root, '.git'))) { const r = await git(['--version']); if (r.code === 0) return 'git'; }
    return installed ? 'installed' : 'archive';
  }

  /** Recherche une version plus récente. Ne modifie rien. */
  async function check() {
    const current = version();
    const m = await mode();
    const res = { checkedAt: new Date().toISOString(), repo, current, mode: m, url: `https://github.com/${repo}`, latest: null, newer: false, source: null, release: null, notes: [], error: null, offline: false, canApply: false };
    let release = null, main = null, errors = [];
    try { const r = await get(`https://api.github.com/repos/${repo}/releases/latest`); if (r?.tag_name && isVersion(r.tag_name)) release = { version: r.tag_name.replace(/^v/i, ''), url: r.html_url, name: r.name, body: trim(r.body), assets: (r.assets ?? []).map(a => ({ name: a.name, size: a.size, url: a.browser_download_url })) }; }
    catch (e) { if (e.status !== 404) errors.push(e); }
    try { const p = await get(`https://raw.githubusercontent.com/${repo}/main/package.json`, { json: false }); const v = JSON.parse(p).version; if (isVersion(v)) main = { version: v }; }
    catch (e) { errors.push(e); }
    if (!release && !main) {
      const e = errors[0]; res.error = e ? e.message : 'Aucune version trouvée sur GitHub'; res.offline = !!e?.offline; last = res; return res;
    }
    // la version proposée dépend du mode : une copie git suit la branche principale, une installation suit les releases
    const pick = m === 'installed' ? (release ?? null) : (main && release ? (compareVersions(main.version, release.version) >= 0 ? main : release) : (main ?? release));
    res.release = release; res.latest = pick?.version ?? null; res.source = pick && pick === release ? 'release' : 'branche';
    res.newer = !!pick && compareVersions(pick.version, current) > 0;
    if (res.newer) {
      try { const cl = await get(`https://raw.githubusercontent.com/${repo}/main/CHANGELOG.md`, { json: false }); res.notes = changelogSince(cl, current); } catch { /* notes facultatives */ }
      if (!res.notes.length && release?.body) res.notes = [{ version: release.version, title: release.name ?? '', body: release.body.slice(0, 4000) }];
    }
    if (m === 'installed' && !release && main && compareVersions(main.version, current) > 0) { res.newer = false; res.latest = main.version; res.note = 'Une version plus récente existe dans le code source, mais aucun installateur n\'est publié pour elle.'; }
    res.canApply = res.newer && (m === 'git' || (m === 'installed' && !!findAsset(release)));
    last = res; return res;
  }

  const findAsset = rel => rel?.assets?.find(a => /installation\.exe$/i.test(a.name)) ?? rel?.assets?.find(a => /windows-x64\.zip$/i.test(a.name)) ?? null;

  /** Mise à jour d'une copie git : fusion en avance rapide uniquement. */
  async function applyGit(target) {
    const ok = async (args, o) => { const r = await git(args, o); if (r.code !== 0) throw new Error(`git ${args[0]} : ${trim(r.stderr) || trim(r.stdout) || 'échec'}`); return trim(r.stdout); };
    const branch = await ok(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== 'main') throw Object.assign(new Error(`La branche active est « ${branch} » : la mise à jour ne suit que « main ».`), { status: 409 });
    const dirty = await ok(['status', '--porcelain', '--untracked-files=no']);
    if (dirty) throw Object.assign(new Error('Des fichiers du programme ont été modifiés localement : mise à jour refusée pour ne rien écraser.\n' + dirty.split('\n').slice(0, 8).join('\n')), { status: 409 });
    const before = await ok(['rev-parse', 'HEAD']);
    await ok(['fetch', '--quiet', 'origin', 'main'], { timeout: 120000 });
    const ahead = Number(await ok(['rev-list', '--count', 'origin/main..HEAD']));
    if (ahead > 0) throw Object.assign(new Error(`${ahead} commit(s) locaux ne sont pas publiés sur GitHub : mise à jour refusée pour ne rien perdre.`), { status: 409 });
    const behind = Number(await ok(['rev-list', '--count', 'HEAD..origin/main']));
    if (!behind) return { from: before, to: before, updated: false, message: 'Déjà à jour.' };
    await ok(['merge', '--ff-only', '--quiet', 'origin/main']);
    const after = await ok(['rev-parse', 'HEAD']);
    const changed = (await ok(['diff', '--name-only', before, after])).split('\n').filter(Boolean);
    let npm = null;
    if (changed.some(f => f === 'package.json' || f === 'package-lock.json')) {
      const r = await exec('npm install --no-audit --no-fund', [], { cwd: root, timeout: 15 * 60 * 1000, shell: true });
      npm = { ok: r.code === 0, log: trim(r.stderr || r.stdout).slice(-1500) };
    }
    return { from: before, to: after, updated: true, files: changed.length, npm, restartRequired: true, message: `Mise à jour appliquée (${changed.length} fichier(s) modifié(s)).` };
  }

  /** Télécharge l'installateur de la release, vérifie son empreinte SHA-256 (SHA256SUMS de la release), l'enregistre. */
  async function downloadInstaller(rel) {
    const asset = findAsset(rel);
    if (!asset) throw Object.assign(new Error('Aucun installateur Windows n\'est publié pour cette version.'), { status: 404 });
    const sums = rel.assets.find(a => a.name === 'SHA256SUMS');
    if (!sums) throw Object.assign(new Error('La release ne publie pas SHA256SUMS : téléchargement refusé (empreinte non vérifiable).'), { status: 409 });
    const wanted = new Map(); for (const l of (await get(sums.url, { json: false })).split(/\r?\n/)) { const x = /^([0-9a-f]{64}) [ *](.+)$/.exec(l.trim()); if (x) wanted.set(x[2].trim(), x[1]); }
    const buf = await get(asset.url, { binary: true, timeout: 15 * 60 * 1000, json: false });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const expected = wanted.get(asset.name);
    if (!expected) throw Object.assign(new Error('Empreinte de ' + asset.name + ' absente de SHA256SUMS : téléchargement refusé.'), { status: 409 });
    if (expected !== sha) throw Object.assign(new Error('Empreinte SHA-256 différente de celle publiée : fichier rejeté.'), { status: 409 });
    fs.mkdirSync(downloads, { recursive: true });
    const file = path.join(downloads, path.basename(asset.name));
    fs.writeFileSync(file, buf);
    return { file, sha256: sha, size: buf.length, version: rel.version, updated: false, installerReady: true,
      message: `Installateur ${rel.version} téléchargé et vérifié (SHA-256). Fermez Photothèque, puis lancez-le : il vérifie en plus la signature avec la clé de la version installée.` };
  }

  /** Applique la mise à jour proposée par la dernière recherche. */
  async function apply() {
    if (busy) throw Object.assign(new Error('Une mise à jour est déjà en cours'), { status: 409 });
    busy = true;
    try {
      const c = last ?? await check();
      if (!c.newer || !c.canApply) throw Object.assign(new Error(c.newer ? 'Cette installation ne peut pas être mise à jour d\'ici : ' + (c.note ?? 'ouvrez la page du projet.') : 'Aucune mise à jour à appliquer.'), { status: 409 });
      const r = c.mode === 'git' ? await applyGit(c.latest) : await downloadInstaller(c.release);
      last = null;
      return { mode: c.mode, current: c.current, latest: c.latest, ...r };
    } finally { busy = false; }
  }

  return { check, apply, status: () => last, mode, repo };
}
