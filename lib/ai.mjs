// Intelligence artificielle facultative et locale (cahier des charges §16).
//
// Extension optionnelle : rien dans le cœur de la photothèque n'en dépend. Le module crée ses propres
// tables (ai_features, ai_results, ai_suggestions) et range ses réglages dans la clé `ai.settings` de
// `config`. Retirer ce fichier, public/ia.js et la ligne qui le branche dans server.mjs laisse la
// photothèque intacte.
//
// Deux familles de moteurs :
//   * le moteur intégré « local » (aucun modèle, aucun téléchargement) : descripteurs visuels calculés
//     avec sharp sur la vignette (couleurs, composition, textures), indices de scène simples, et
//     déductions à partir du catalogue (photos semblables, même séance, GPS) ;
//   * des moteurs externes installés séparément par l'utilisateur et déclarés dans data/ia/moteurs/*.json :
//     un programme local (ligne de commande qui répond en JSON) ou un serveur Ollama (modèle de vision).
//     Un moteur doit déclarer sa licence et l'utilisateur doit l'accepter avant de l'activer. Un serveur
//     qui n'est pas sur cet ordinateur est refusé sauf consentement explicite (allowRemote).
//
// Tout résultat est une SUGGESTION (table ai_suggestions, statut pending) : rien n'est attribué sans
// validation, sauf préférence explicite (autoAccept, au-delà d'un seuil). L'acceptation passe par le
// module des métadonnées (lot annulable). Les originaux ne sont jamais lus en écriture.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { logHistory } from './db.mjs';
import { normalizeKeyword } from './keywords.mjs';

export const AI_VERSION = 1; // version des descripteurs : un changement de calcul relance l'analyse
const SETTINGS_KEY = 'ai.settings';

export const FEATURES = {
  keywords: 'Suggestion de mots-clés (d’après les photos semblables déjà décrites)',
  scenes: 'Catégories de scènes et couleurs dominantes',
  similar: 'Recherche d’images visuellement proches',
  describe: 'Recherche par description',
  groups: 'Regroupement d’images similaires',
  classify: 'Suggestions de classement (séances, événements)',
  places: 'Suggestions de lieux',
  faces: 'Détection de visages',
};
/** Fonctions qui demandent un moteur externe déclarant la capacité indiquée. */
export const FEATURE_NEEDS = { faces: 'faces' };

export const AI_DEFAULTS = () => ({
  enabled: false,
  features: { keywords: true, scenes: true, similar: true, describe: true, groups: true, classify: true, places: true, faces: false },
  engines: {},            // id → { enabled, licenseAccepted, acceptedAt }
  pauseMs: 100,           // pause entre deux photos (charge du processeur)
  maxSide: 768,           // côté de l'image transmise à un moteur externe
  lowPriority: true,      // moteurs externes lancés en priorité basse
  gpu: false,             // autoriser la carte graphique (moteurs externes)
  autoAccept: false,      // préférence explicite : accepter sans validation au-delà du seuil
  autoThreshold: 0.9,
  minScore: 0.5,          // en dessous, une suggestion n'est pas proposée
  similarity: 0.82,       // seuil « visuellement proche »
  sessionHours: 3,        // écart qui sépare deux séances de prise de vue
  allowRemote: false, remoteConsentAt: null,
});
const clamp = (v, a, b, d) => (v != null && v !== '' && Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
export function cleanAiSettings(b = {}, cur = AI_DEFAULTS()) {
  const d = AI_DEFAULTS(), o = { ...d, ...cur };
  if (b.enabled !== undefined) o.enabled = !!b.enabled;
  o.features = { ...d.features, ...(cur.features ?? {}) };
  for (const k of Object.keys(FEATURES)) if (b.features?.[k] !== undefined) o.features[k] = !!b.features[k];
  o.pauseMs = clamp(b.pauseMs ?? o.pauseMs, 0, 5000, d.pauseMs);
  o.maxSide = Math.round(clamp(b.maxSide ?? o.maxSide, 256, 2048, d.maxSide));
  for (const k of ['lowPriority', 'gpu', 'autoAccept']) if (b[k] !== undefined) o[k] = !!b[k];
  o.autoThreshold = clamp(b.autoThreshold ?? o.autoThreshold, 0.5, 1, d.autoThreshold);
  o.minScore = clamp(b.minScore ?? o.minScore, 0.1, 0.95, d.minScore);
  o.similarity = clamp(b.similarity ?? o.similarity, 0.5, 0.99, d.similarity);
  o.sessionHours = clamp(b.sessionHours ?? o.sessionHours, 0.25, 48, d.sessionHours);
  if (b.allowRemote !== undefined) {
    o.allowRemote = !!b.allowRemote && b.remoteConsent === true;   // le consentement doit être explicite
    o.remoteConsentAt = o.allowRemote ? new Date().toISOString() : null;
  }
  o.engines = {};
  for (const [id, e] of Object.entries({ ...(cur.engines ?? {}), ...(b.engines ?? {}) })) {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !e || typeof e !== 'object') continue;
    const prev = cur.engines?.[id] ?? {};
    const licenseAccepted = e.licenseAccepted !== undefined ? !!e.licenseAccepted : !!prev.licenseAccepted;
    o.engines[id] = { enabled: !!(e.enabled ?? prev.enabled) && licenseAccepted, licenseAccepted, acceptedAt: licenseAccepted ? (prev.licenseAccepted ? prev.acceptedAt : new Date().toISOString()) : null };
  }
  return o;
}

// ------------------------------------------------------------------ moteurs
export const ENGINE_KINDS = { command: 'Programme local (ligne de commande)', ollama: 'Serveur Ollama (modèle de vision)' };
export const ENGINE_PROVIDES = { labels: 'Mots-clés', description: 'Description', faces: 'Visages' };
export const LOCAL_ENGINE = {
  id: 'local', name: 'Analyse visuelle intégrée', kind: 'builtin', builtin: true, version: String(AI_VERSION),
  license: 'Fait partie de Photothèque — aucun modèle, aucun téléchargement',
  provides: ['features', 'scenes'],
  about: 'Couleurs, composition et textures calculées sur la vignette ; déductions à partir du catalogue (photos semblables, même séance, GPS).',
};
export const isLocalUrl = u => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(u).hostname); } catch { return false; } };
const str = (v, n = 200) => (v == null ? '' : String(v).trim().slice(0, n));

/** Fiche de moteur nettoyée (fichier data/ia/moteurs/<id>.json). */
export function cleanEngine(j = {}) {
  const id = str(j.id, 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id || id === 'local') throw new Error('Identifiant de moteur invalide');
  const kind = ENGINE_KINDS[j.kind] ? j.kind : null;
  if (!kind) throw new Error('Type de moteur inconnu');
  const e = {
    id, kind, name: str(j.name, 80) || id, version: str(j.version, 40), license: str(j.license, 200), licenseUrl: str(j.licenseUrl, 300),
    about: str(j.about, 500), provides: [].concat(j.provides ?? ['labels', 'description']).filter(p => ENGINE_PROVIDES[p]),
    timeoutSec: Math.round(clamp(j.timeoutSec, 5, 900, 120)), lang: str(j.lang, 10) || 'fr',
  };
  if (!e.provides.length) e.provides = ['labels'];
  if (kind === 'command') {
    e.command = str(j.command, 500);
    e.args = (Array.isArray(j.args) ? j.args : ['{image}']).map(a => str(a, 500)).slice(0, 30);
    if (!e.command) throw new Error('Programme du moteur manquant');
  } else {
    e.url = str(j.url, 300) || 'http://127.0.0.1:11434';
    e.model = str(j.model, 120);
    if (!e.model) throw new Error('Modèle Ollama manquant (ex. llava, llama3.2-vision, qwen2.5vl)');
    try { new URL(e.url); } catch { throw new Error('Adresse du serveur invalide'); }
  }
  return e;
}
/** Points qui empêchent d'activer un moteur (licence, programme introuvable, serveur distant non consenti). */
export function engineIssues(e, settings = AI_DEFAULTS()) {
  const out = [];
  if (!e.license) out.push('Licence du modèle non déclarée : le moteur ne peut pas être activé.');
  if (e.kind === 'command' && path.isAbsolute(e.command) && !fs.existsSync(e.command)) out.push('Programme introuvable : ' + e.command);
  if (e.kind === 'ollama' && !isLocalUrl(e.url) && !settings.allowRemote) out.push('Serveur hors de cet ordinateur : envoi refusé sans consentement explicite.');
  return out;
}

/** Normalise la réponse d'un moteur : { labels: [{ name, score }], description, faces: [{ x, y, w, h, score }] }. */
export function cleanEngineOutput(o = {}) {
  const rawLabels = o.labels ?? o.keywords ?? o.motsCles ?? o.mots_cles ?? o.tags ?? [];
  const labels = [];
  for (const l of [].concat(rawLabels)) {
    const name = str(typeof l === 'string' ? l : l?.name ?? l?.label, 60).replace(/^[#\-•\s]+/, '');
    if (!name || labels.some(x => normalizeKeyword(x.name) === normalizeKeyword(name))) continue;
    labels.push({ name, score: Math.round(clamp(typeof l === 'object' ? l.score ?? l.confidence : null, 0, 1, 0.7) * 100) / 100 });
    if (labels.length >= 20) break;
  }
  const faces = [].concat(o.faces ?? []).filter(f => f && typeof f === 'object').slice(0, 50)
    .map(f => ({ x: clamp(f.x, 0, 1, 0), y: clamp(f.y, 0, 1, 0), w: clamp(f.w, 0, 1, 0), h: clamp(f.h, 0, 1, 0), score: clamp(f.score, 0, 1, 0.8) }));
  return { labels, description: str(o.description ?? o.caption ?? o.legende, 1000), faces };
}
/** Dernier objet JSON d'un texte (un programme peut écrire des lignes de journal avant sa réponse). */
export function lastJson(text) {
  const s = String(text ?? '').trim();
  try { return JSON.parse(s); } catch { /* chercher plus loin */ }
  for (let i = s.lastIndexOf('{'); i >= 0; i = s.lastIndexOf('{', i - 1)) { try { return JSON.parse(s.slice(i)); } catch { /* précédent */ } if (i === 0) break; }
  throw new Error('Réponse du moteur illisible (JSON attendu)');
}

// ------------------------------------------------------------------ descripteurs visuels (moteur intégré)
export const COLOURS = ['rouge', 'orange', 'jaune', 'vert', 'turquoise', 'bleu', 'violet', 'rose', 'brun', 'gris', 'blanc', 'noir'];
function hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, mx ? d / mx : 0, mx];
}
function colourOf(hh, s, v) {
  if (v < 0.18) return 'noir';
  if (s < 0.15) return v > 0.85 ? 'blanc' : 'gris';
  if (hh < 15 || hh >= 345) return v < 0.45 && s < 0.7 ? 'brun' : 'rouge';
  if (hh < 40) return v < 0.6 ? 'brun' : 'orange';
  if (hh < 65) return v < 0.45 ? 'brun' : 'jaune';
  if (hh < 165) return 'vert';
  if (hh < 195) return 'turquoise';
  if (hh < 255) return 'bleu';
  if (hh < 290) return 'violet';
  return 'rose';
}
const N = 64; // côté de l'image analysée
/**
 * Descripteur d'une image : 128 octets (histogramme RGB 4×4×4 en racines, couleurs moyennes d'une grille
 * 4×4, textures d'une grille 4×4), part de chaque couleur nommée, luminosité, saturation, indices de scène.
 */
export async function imageFeatures(src) {
  const { default: sharp } = await import('sharp');
  const { data } = await sharp(src, { failOn: 'none' }).rotate().removeAlpha().toColourspace('srgb').resize(N, N, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const hist = new Float64Array(64), grid = new Float64Array(48), edge = new Float64Array(16), lum = new Float64Array(N * N), greenPx = new Uint8Array(N * N);
  const col = Object.fromEntries(COLOURS.map(c => [c, 0]));
  let satSum = 0, lumSum = 0, lumSq = 0, lowSat = 0, dark = 0, lumTop = 0, lumBottom = 0;
  const top = { blue: 0, bright: 0, warm: 0, n: 0 }, all = { green: 0 };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 3, r = data[i], g = data[i + 1], b = data[i + 2];
    hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++;
    const cell = ((y >> 4) * 4 + (x >> 4)) * 3; grid[cell] += r; grid[cell + 1] += g; grid[cell + 2] += b;
    const [hh, s, v] = hsv(r, g, b);
    col[colourOf(hh, s, v)]++;
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255; lum[y * N + x] = L;
    satSum += s; lumSum += L; lumSq += L * L; if (s < 0.15) lowSat++; if (v < 0.25) dark++;
    if (y < N / 3) lumTop += L; else if (y >= (2 * N) / 3) lumBottom += L;
    if (hh >= 70 && hh < 165 && s > 0.25 && v > 0.2) { all.green++; greenPx[y * N + x] = 1; }
    if (y < N / 3) {
      top.n++;
      if ((hh >= 185 && hh < 250 && s > 0.18 && v > 0.45) || (s < 0.12 && v > 0.78)) top.blue++;
      if ((hh < 50 || hh >= 330) && s > 0.35 && v > 0.35) top.warm++;
    }
  }
  // textures : gradient de luminance moyen par case de la grille 4×4
  let gTop = 0, gGreen = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const gx = lum[y * N + x + 1] - lum[y * N + x - 1], gy = lum[(y + 1) * N + x] - lum[(y - 1) * N + x];
    const m = Math.hypot(gx, gy); edge[(y >> 4) * 4 + (x >> 4)] += m; if (y < N / 3) gTop += m; if (greenPx[y * N + x]) gGreen += m;
  }
  const px = N * N, cellPx = 16 * 16;
  const vec = new Uint8Array(128);
  for (let k = 0; k < 64; k++) vec[k] = Math.round(Math.sqrt(hist[k] / px) * 255);
  for (let k = 0; k < 48; k++) vec[64 + k] = Math.round(grid[k] / cellPx);
  for (let k = 0; k < 16; k++) vec[112 + k] = Math.min(255, Math.round(edge[k] / cellPx * 1200));
  const colours = Object.fromEntries(Object.entries(col).map(([c, n]) => [c, Math.round(n / px * 1000) / 1000]));
  const lumStd = Math.sqrt(Math.max(0, lumSq / px - (lumSum / px) ** 2)), topL = lumTop / (top.n || 1), bottomL = lumBottom / (px - N * Math.ceil((2 * N) / 3));
  const meanSat = satSum / px, meanLum = lumSum / px, texTop = gTop / (top.n || 1);
  // indices de scène : règles simples sur les couleurs et la texture, présentées comme des suggestions
  const scenes = [];
  const sc = (name, score) => { if (score >= 0.3) scenes.push({ name, score: Math.round(Math.min(0.95, score) * 100) / 100 }); };
  if (meanSat < 0.08 && lowSat / px > 0.9 && lumStd > 0.12) sc('Noir et blanc', meanSat < 0.03 ? 0.95 : 0.75);
  if (meanLum < 0.25 && dark / px > 0.45) sc('Nuit', 0.5 + (0.25 - meanLum) * 2);
  const blueTop = top.blue / (top.n || 1), warmTop = top.warm / (top.n || 1), green = all.green / px;
  if (blueTop > 0.5 && texTop < 0.035 && meanSat >= 0.08) sc('Ciel', 0.35 + blueTop * 0.5);
  if (green > 0.35 && gGreen / (all.green || 1) > 0.02) sc('Végétation', 0.3 + green * 0.6);
  if (warmTop > 0.45 && meanLum > 0.15 && meanLum < 0.6 && topL > bottomL + 0.08) sc('Coucher de soleil', 0.3 + warmTop * 0.4);
  return { vec: Buffer.from(vec).toString('base64'), colours, light: Math.round(meanLum * 1000) / 1000, saturation: Math.round(meanSat * 1000) / 1000, scenes };
}
const decode = b64 => new Uint8Array(Buffer.from(b64, 'base64'));
/** Ressemblance de deux descripteurs, de 0 (rien de commun) à 1 (identiques). */
export function similarity(a, b) {
  let bc = 0, dg = 0, de = 0;
  for (let k = 0; k < 64; k++) bc += a[k] * b[k];
  for (let k = 64; k < 112; k++) dg += Math.abs(a[k] - b[k]);
  for (let k = 112; k < 128; k++) de += Math.abs(a[k] - b[k]);
  const hs = Math.min(1, bc / (255 * 255)), gs = Math.max(0, 1 - dg / 48 / 128), es = Math.max(0, 1 - de / 16 / 128);
  return 0.4 * hs + 0.45 * gs + 0.15 * es;
}

// ------------------------------------------------------------------ description en mots (recherche locale)
const STOP = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'd', 'l', 'et', 'ou', 'a', 'au', 'aux', 'en', 'avec', 'sur', 'sous', 'dans', 'par', 'pour', 'photo', 'photos', 'image', 'images', 'tres', 'plutot']);
const COLOUR_WORDS = { rouge: 'rouge', rouges: 'rouge', orange: 'orange', oranges: 'orange', jaune: 'jaune', jaunes: 'jaune', vert: 'vert', verte: 'vert', verts: 'vert', vertes: 'vert',
  turquoise: 'turquoise', bleu: 'bleu', bleue: 'bleu', bleus: 'bleu', bleues: 'bleu', violet: 'violet', violette: 'violet', mauve: 'violet', rose: 'rose', roses: 'rose',
  brun: 'brun', marron: 'brun', gris: 'gris', grise: 'gris', blanc: 'blanc', blanche: 'blanc', blancs: 'blanc', noir: 'noir', noire: 'noir', noirs: 'noir' };
const SCENE_WORDS = { ciel: 'Ciel', nuage: 'Ciel', nuages: 'Ciel', vegetation: 'Végétation', nature: 'Végétation', arbre: 'Végétation', arbres: 'Végétation', foret: 'Végétation', jardin: 'Végétation', herbe: 'Végétation',
  nuit: 'Nuit', nocturne: 'Nuit', coucher: 'Coucher de soleil', couchant: 'Coucher de soleil', crepuscule: 'Coucher de soleil', lever: 'Coucher de soleil', soleil: 'Coucher de soleil', monochrome: 'Noir et blanc', nb: 'Noir et blanc' };
const LIGHT_WORDS = { sombre: 'dark', sombres: 'dark', obscur: 'dark', lumineux: 'bright', lumineuse: 'bright', clair: 'bright', claire: 'bright', colore: 'colourful', coloree: 'colourful', colorees: 'colourful', vif: 'colourful', vive: 'colourful', terne: 'dull' };
const words = s => normalizeKeyword(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !STOP.has(w));

// ------------------------------------------------------------------ service
export function createAi(db, { keywords, library, metadata, collections, enginesDir, settings: initial } = {}) {
  db.exec(`
CREATE TABLE IF NOT EXISTS ai_features (photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE, version INTEGER NOT NULL, vec TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', computed_at TEXT);
CREATE TABLE IF NOT EXISTS ai_results (photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, engine TEXT NOT NULL, description TEXT, labels TEXT, faces TEXT, error TEXT, ms INTEGER, computed_at TEXT, PRIMARY KEY(photo_id, engine));
CREATE TABLE IF NOT EXISTS ai_suggestions (id INTEGER PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE, kind TEXT NOT NULL, value TEXT NOT NULL, score REAL NOT NULL,
  source TEXT NOT NULL, detail TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, decided_at TEXT, UNIQUE(photo_id, kind, value));
CREATE INDEX IF NOT EXISTS ix_ai_sugg_status ON ai_suggestions(status, kind);`);
  const P = s => { try { return JSON.parse(s); } catch { return null; } };
  const now = () => new Date().toISOString();
  const dir = enginesDir;

  // ---------- réglages ----------
  function settings() {
    const raw = P(db.prepare('SELECT data FROM config WHERE key = ?').get(SETTINGS_KEY)?.data);
    return cleanAiSettings({}, raw ?? initial ?? AI_DEFAULTS());
  }
  function saveSettings(b) {
    const cur = settings();
    if (b.engines) for (const [id, e] of Object.entries(b.engines)) {
      if (!e?.enabled) continue;
      const eng = engine(id); if (!eng) throw new Error('Moteur inconnu : ' + id);
      const accepted = e.licenseAccepted ?? cur.engines[id]?.licenseAccepted;
      if (!accepted) throw new Error(`Acceptez d’abord la licence du moteur « ${eng.name} ».`);
      const issues = engineIssues(eng, { ...cur, ...(b.allowRemote !== undefined ? { allowRemote: !!b.allowRemote && b.remoteConsent === true } : {}) });
      if (issues.length) throw new Error(issues.join(' '));
    }
    const next = cleanAiSettings(b, cur);
    db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(SETTINGS_KEY, JSON.stringify(next));
    if (cur.enabled !== next.enabled || cur.allowRemote !== next.allowRemote) logHistory(db, 'ai.settings', `IA : ${next.enabled ? 'activée' : 'désactivée'}${next.allowRemote ? ', envoi distant autorisé' : ''}`, { enabled: next.enabled, allowRemote: next.allowRemote });
    return next;
  }
  const on = (s, f) => s.enabled && s.features[f];

  // ---------- moteurs externes ----------
  function engineFiles() { try { return fs.readdirSync(dir).filter(f => /\.json$/i.test(f)); } catch { return []; } }
  function engines() {
    const out = [];
    for (const f of engineFiles()) {
      try { out.push({ ...cleanEngine(P(fs.readFileSync(path.join(dir, f), 'utf8')) ?? {}), file: f }); }
      catch (e) { out.push({ id: f.replace(/\.json$/i, ''), name: f, kind: 'invalid', error: e.message, file: f, provides: [] }); }
    }
    return out;
  }
  const engine = id => engines().find(e => e.id === id && e.kind !== 'invalid') ?? null;
  function saveEngine(j) {
    const e = cleanEngine(j);
    fs.mkdirSync(dir, { recursive: true });
    const { file, ...rest } = e;
    fs.writeFileSync(path.join(dir, e.id + '.json'), JSON.stringify(rest, null, 2) + '\n');
    // modifier la fiche d'un moteur (programme, adresse, licence) demande de réaccepter sa licence
    const s = settings();
    if (s.engines[e.id]) saveSettings({ engines: { [e.id]: { enabled: false, licenseAccepted: false } } });
    logHistory(db, 'ai.engine', `Moteur d’IA déclaré : ${e.name}`, { id: e.id, kind: e.kind });
    return e;
  }
  function removeEngine(id) {
    const e = engines().find(x => x.id === id); if (!e) throw new Error('Moteur inconnu');
    fs.rmSync(path.join(dir, e.file), { force: true }); // la fiche de déclaration seulement : le modèle installé n'est pas touché
    const s = settings(); delete s.engines[id];
    db.prepare('INSERT INTO config(key, data) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data').run(SETTINGS_KEY, JSON.stringify(s));
    logHistory(db, 'ai.engine', `Moteur d’IA retiré : ${e.name}`, { id });
    return { removed: id };
  }
  const activeEngines = (s = settings()) => engines().filter(e => e.kind !== 'invalid' && s.engines[e.id]?.enabled && s.engines[e.id]?.licenseAccepted && !engineIssues(e, s).length);

  /** Image transmise à un moteur : aperçu réduit au côté maximal, écrit dans un fichier temporaire. */
  async function engineImage(photoId, maxSide) {
    const src = imageSource(photoId, true); if (!src) throw new Error('image illisible');
    const { default: sharp } = await import('sharp');
    const buf = await sharp(src, { failOn: 'none' }).rotate().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return buf;
  }
  async function runEngine(e, buf, s = settings()) {
    const t0 = Date.now();
    const prompt = 'Décris cette photo en une phrase en français, puis donne de 3 à 10 mots-clés en français (noms communs, sans noms de personnes). '
      + 'Réponds uniquement en JSON : {"description": "...", "motsCles": ["...", "..."]}.';
    let out;
    if (e.kind === 'ollama') {
      if (!isLocalUrl(e.url) && !s.allowRemote) throw new Error('Envoi vers un serveur distant refusé (aucun consentement).');
      const r = await fetch(e.url.replace(/\/+$/, '') + '/api/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(e.timeoutSec * 1000),
        body: JSON.stringify({ model: e.model, prompt, images: [buf.toString('base64')], stream: false, format: 'json', options: s.gpu ? {} : { num_gpu: 0 } }),
      });
      if (r.status === 404) throw new Error(`Modèle « ${e.model} » absent du serveur Ollama : installez-le avec « ollama pull ${e.model} ».`);
      if (!r.ok) throw new Error(`Serveur Ollama : ${r.status} ${(await r.text()).slice(0, 200)}`);
      out = lastJson((await r.json()).response);
    } else {
      const tmp = path.join(os.tmpdir(), `phototheque-ia-${process.pid}-${Date.now().toString(36)}.jpg`);
      fs.writeFileSync(tmp, buf);
      try {
        const args = e.args.map(a => a.replaceAll('{image}', tmp).replaceAll('{lang}', e.lang).replaceAll('{gpu}', s.gpu ? '1' : '0'));
        const stdout = await new Promise((resolve, reject) => {
          const ch = spawn(e.command, args, { windowsHide: true, env: { ...process.env, PHOTOTHEQUE_IA_GPU: s.gpu ? '1' : '0', PHOTOTHEQUE_IA_LANG: e.lang } });
          if (s.lowPriority) try { os.setPriority(ch.pid, os.constants.priority.PRIORITY_LOW); } catch { /* priorité non modifiable */ }
          let o = '', er = '';
          const timer = setTimeout(() => { ch.kill(); reject(new Error(`Délai dépassé (${e.timeoutSec} s)`)); }, e.timeoutSec * 1000);
          ch.stdout.on('data', d => { if (o.length < 1e6) o += d; });
          ch.stderr.on('data', d => { if (er.length < 4000) er += d; });
          ch.on('error', x => { clearTimeout(timer); reject(new Error('Lancement impossible : ' + x.message)); });
          ch.on('close', code => { clearTimeout(timer); code === 0 ? resolve(o) : reject(new Error(`Le programme a échoué (code ${code}) ${er.trim().slice(0, 300)}`)); });
        });
        out = lastJson(stdout);
      } finally { fs.rmSync(tmp, { force: true }); }
    }
    const res = cleanEngineOutput(out);
    if (!e.provides.includes('faces')) res.faces = [];
    if (!e.provides.includes('description')) res.description = '';
    return { ...res, ms: Date.now() - t0 };
  }
  /** Modèles d'un serveur Ollama (ceux qui lisent les images d'abord). */
  async function ollamaModels(url = 'http://127.0.0.1:11434') {
    const s = settings();
    if (!isLocalUrl(url) && !s.allowRemote) throw new Error('Serveur hors de cet ordinateur : consentement à l’envoi distant nécessaire.');
    let r;
    try { r = await fetch(String(url).replace(/\/+$/, '') + '/api/tags', { signal: AbortSignal.timeout(4000) }); }
    catch { throw new Error('Serveur Ollama injoignable à ' + url + ' (installé et lancé ?)'); }
    if (!r.ok) throw new Error('Serveur Ollama : ' + r.status);
    const models = ((await r.json()).models ?? []).map(m => ({ name: m.name, size: m.size, vision: (m.capabilities ?? []).includes('vision') || /llava|vision|[0-9.]vl|bakllava|moondream|minicpm-v|gemma3/i.test(m.name) }));
    return models.sort((a, b) => (b.vision - a.vision) || a.name.localeCompare(b.name));
  }
  /** Essai d'un moteur sur une photo (ou la première photo lisible). Rien n'est enregistré. */
  async function testEngine(id, photoId) {
    const e = engine(id); if (!e) throw new Error('Moteur inconnu');
    const s = settings(), issues = engineIssues(e, s); if (issues.length) throw new Error(issues.join(' '));
    if (e.kind === 'ollama') {
      const m = (await ollamaModels(e.url)).find(x => x.name === e.model || x.name === e.model + ':latest');
      if (!m) throw new Error(`Modèle « ${e.model} » absent du serveur Ollama : installez-le avec « ollama pull ${e.model} ».`);
      if (!m.vision) throw new Error(`Le modèle « ${e.model} » ne lit pas les images : choisissez un modèle de vision (llava, llama3.2-vision, qwen2.5vl…).`);
    }
    const pid = photoId || db.prepare('SELECT id FROM photos ORDER BY captured_at DESC LIMIT 1').get()?.id;
    if (!pid) throw new Error('Aucune photo à analyser');
    return { photoId: pid, ...(await runEngine(e, await engineImage(pid, s.maxSide), s)) };
  }

  // ---------- images ----------
  function imageSource(photoId, large = false) {
    const files = db.prepare("SELECT path, data, status FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END").all(photoId);
    for (const f of files) {
      const t = P(f.data)?.thumbs ?? {};
      for (const rel of large ? [t.preview, t.thumb] : [t.thumb, t.preview]) if (rel) { const abs = library.thumbAbs(rel); if (fs.existsSync(abs)) return abs; }
    }
    for (const f of files) if (f.path && f.status === 'available' && fs.existsSync(f.path)) return f.path; // lecture seule
    return null;
  }

  // ---------- analyse (travail en arrière-plan) ----------
  let job = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function jobState() { return job ? { id: job.id, status: job.status, done: job.done, total: job.total, failed: job.failed, current: job.current, startedAt: job.startedAt, endedAt: job.endedAt, result: job.result, error: job.error, errors: job.errors.slice(-10) } : null; }
  /**
   * Analyse les photos : descripteurs du moteur intégré (manquants ou d'une ancienne version, ou tous) puis
   * moteurs externes actifs (photos pas encore vues par ce moteur), puis recalcul des suggestions.
   */
  function startAnalysis({ all = false, ids = null } = {}) {
    const s = settings();
    if (!s.enabled) throw new Error('L’IA est désactivée (Paramètres de l’IA).');
    if (job?.status === 'running' || job?.status === 'paused') throw new Error('Une analyse est déjà en cours.');
    const list = ids?.length ? ids : db.prepare('SELECT id FROM photos ORDER BY captured_at DESC').all().map(r => r.id);
    const featOf = db.prepare('SELECT version FROM ai_features WHERE photo_id = ?');
    const resOf = db.prepare('SELECT 1 FROM ai_results WHERE photo_id = ? AND engine = ? AND error IS NULL');
    const ext = activeEngines(s);
    const work = list.map(id => ({ id, local: all || featOf.get(id)?.version !== AI_VERSION, engines: ext.filter(e => all || !resOf.get(id, e.id)) }))
      .filter(w => w.local || w.engines.length);
    job = { id: 'ia' + Date.now().toString(36), status: 'running', done: 0, total: work.length, failed: 0, current: null, startedAt: now(), endedAt: null, result: null, error: null, errors: [], stop: false, pause: false };
    const me = job;
    (async () => {
      const upF = db.prepare(`INSERT INTO ai_features(photo_id, version, vec, data, computed_at) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(photo_id) DO UPDATE SET version = excluded.version, vec = excluded.vec, data = excluded.data, computed_at = excluded.computed_at`);
      const upR = db.prepare(`INSERT INTO ai_results(photo_id, engine, description, labels, faces, error, ms, computed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(photo_id, engine) DO UPDATE SET description = excluded.description, labels = excluded.labels, faces = excluded.faces, error = excluded.error, ms = excluded.ms, computed_at = excluded.computed_at`);
      for (const w of work) {
        while (me.pause && !me.stop) await sleep(200);
        if (me.stop) break;
        me.current = w.id;
        try {
          if (w.local) {
            const src = imageSource(w.id); if (!src) throw new Error('image illisible (support absent ?)');
            const f = await imageFeatures(src);
            upF.run(w.id, AI_VERSION, f.vec, JSON.stringify({ colours: f.colours, light: f.light, saturation: f.saturation, scenes: f.scenes }), now());
          }
          if (w.engines.length) {
            const buf = await engineImage(w.id, s.maxSide);
            for (const e of w.engines) {
              try { const r = await runEngine(e, buf, s); upR.run(w.id, e.id, r.description || null, JSON.stringify(r.labels), JSON.stringify(r.faces), null, r.ms, now()); }
              catch (x) { upR.run(w.id, e.id, null, null, null, String(x.message || x).slice(0, 500), null, now()); me.errors.push({ id: w.id, engine: e.id, error: String(x.message || x) }); }
            }
          }
        } catch (x) { me.failed++; me.errors.push({ id: w.id, error: String(x.message || x) }); }
        me.done++;
        if (s.pauseMs) await sleep(s.pauseMs);
      }
      me.current = null;
      me.result = { analysed: me.done - me.failed, failed: me.failed, stopped: me.stop, suggestions: me.stop ? null : refreshSuggestions() };
      me.status = me.stop ? 'stopped' : 'done'; me.endedAt = now();
      logHistory(db, 'ai.analyse', `Analyse IA : ${me.done - me.failed} photo(s)${me.failed ? `, ${me.failed} échec(s)` : ''}${me.stop ? ' (arrêtée)' : ''}`, { done: me.done, failed: me.failed });
    })().catch(x => { me.status = 'error'; me.error = String(x.message || x); me.endedAt = now(); });
    return jobState();
  }
  function control(action) {
    if (!job || !['running', 'paused'].includes(job.status)) throw new Error('Aucune analyse en cours');
    if (action === 'pause') { job.pause = true; job.status = 'paused'; }
    else if (action === 'resume') { job.pause = false; job.status = 'running'; }
    else if (action === 'stop') { job.stop = true; job.pause = false; }
    else throw new Error('Action inconnue');
    return jobState();
  }
  const waitJob = async () => { while (job && ['running', 'paused'].includes(job.status)) await sleep(20); return jobState(); };

  // ---------- données en mémoire pour les calculs ----------
  function vectors() {
    return db.prepare('SELECT f.photo_id id, f.vec, f.data, p.captured_at FROM ai_features f JOIN photos p ON p.id = f.photo_id WHERE f.version = ?').all(AI_VERSION)
      .map(r => ({ id: r.id, v: decode(r.vec), d: P(r.data) ?? {}, at: r.captured_at }));
  }
  /** Mots déjà portés par une photo (noms, parents et synonymes), normalisés. */
  function existingNames() {
    const m = new Map();
    for (const r of db.prepare('SELECT id, keywords_text FROM photos').all()) m.set(r.id, new Set(String(r.keywords_text ?? '').split(/\s*[|¦]\s*/).filter(Boolean).map(normalizeKeyword)));
    return m;
  }
  function photoKeywords() {
    const m = new Map();
    for (const r of db.prepare('SELECT pk.photo_id id, k.name FROM photo_keywords pk JOIN keywords k ON k.id = pk.keyword_id').all()) { if (!m.has(r.id)) m.set(r.id, []); m.get(r.id).push(r.name); }
    return m;
  }
  /** Séances : photos datées triées, coupées dès que l'écart dépasse `hours`. */
  function sessions(hours) {
    const rows = db.prepare('SELECT id, captured_at at, gps_lat lat, gps_lon lon FROM photos WHERE captured_at IS NOT NULL ORDER BY captured_at').all();
    const out = []; let cur = null, last = null;
    for (const r of rows) {
      const t = Date.parse(r.at); if (!Number.isFinite(t)) continue;
      if (!cur || t - last > hours * 3600e3) { cur = []; out.push(cur); }
      cur.push(r); last = t;
    }
    return out;
  }
  const placeOfDoc = d => (d ? { sublocation: d.sublocation || '', city: d.city || '', state: d.state || '', country: d.country || '' } : null);
  const placeKey = pl => [pl.sublocation, pl.city, pl.state, pl.country].join('|');
  const placeLabel = v => v.split('|').filter(Boolean).join(', ');
  const hasPlace = pl => !!(pl && (pl.sublocation || pl.city || pl.state || pl.country));
  const km = (a, b) => { const R = 6371, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon); const q = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(q)); };

  // ---------- suggestions ----------
  /**
   * Recalcule toutes les suggestions en attente. Les suggestions acceptées ou refusées sont gardées :
   * une suggestion refusée n'est jamais reproposée. Renvoie le nombre de suggestions par source.
   */
  function refreshSuggestions() {
    const s = settings();
    const out = []; // [photoId, kind, value, score, source, detail]
    const has = existingNames();
    const push = (id, kind, value, score, source, detail = null) => {
      if (score < s.minScore) return;
      if (kind === 'keyword' && has.get(id)?.has(normalizeKeyword(value))) return;
      out.push([id, kind, value, Math.round(Math.min(1, score) * 100) / 100, source, detail ? JSON.stringify(detail) : null]);
    };
    const V = s.enabled ? vectors() : [];
    // scènes (moteur intégré)
    if (on(s, 'scenes')) for (const p of V) for (const sc of p.d.scenes ?? []) push(p.id, 'keyword', sc.name, sc.score, 'scene', { indice: 'couleurs et textures' });
    // moteurs externes : mots-clés et visages
    if (s.enabled) for (const r of db.prepare('SELECT photo_id id, engine, labels, faces FROM ai_results WHERE error IS NULL').all()) {
      const eng = engine(r.engine); if (!eng) continue;
      if (on(s, 'keywords')) for (const l of P(r.labels) ?? []) push(r.id, 'keyword', l.name, l.score, 'engine:' + r.engine, { moteur: eng.name });
      const faces = P(r.faces) ?? [];
      if (on(s, 'faces') && faces.length) push(r.id, 'keyword', faces.length >= 3 ? 'Groupe' : faces.length === 2 ? 'Personnes' : 'Portrait', Math.max(...faces.map(f => f.score)), 'faces', { moteur: eng.name, visages: faces.length });
    }
    const kwOf = photoKeywords();
    // photos semblables déjà décrites : vote pondéré des 8 plus proches voisins
    if (on(s, 'keywords') && V.length > 1) {
      const tagged = V.filter(p => kwOf.has(p.id));
      for (const p of V) {
        const near = [];
        for (const q of tagged) { if (q.id === p.id) continue; const sim = similarity(p.v, q.v); if (sim >= s.similarity) near.push([q, sim]); }
        if (!near.length) continue;
        near.sort((a, b) => b[1] - a[1]); near.length = Math.min(near.length, 8);
        const tot = near.reduce((t, [, sim]) => t + sim, 0), votes = new Map();
        for (const [q, sim] of near) for (const k of kwOf.get(q.id)) { const v = votes.get(k) ?? { w: 0, n: 0, ids: [] }; v.w += sim; v.n++; v.ids.push(q.id); votes.set(k, v); }
        for (const [k, v] of votes) if (v.n >= 2 || (near[0][1] >= 0.93 && v.ids[0] === near[0][0].id)) push(p.id, 'keyword', k, (v.w / tot) * (v.n >= 2 ? 1 : 0.85), 'similar', { semblables: v.ids.slice(0, 5) });
      }
    }
    // même séance : mot-clé porté par au moins la moitié des photos de la séance
    const S = (on(s, 'classify') || on(s, 'places')) ? sessions(s.sessionHours) : [];
    if (on(s, 'classify')) for (const ses of S) {
      if (ses.length < 3) continue;
      const count = new Map();
      for (const r of ses) for (const k of kwOf.get(r.id) ?? []) count.set(k, (count.get(k) ?? 0) + 1);
      for (const [k, n] of count) {
        const share = n / ses.length; if (share < 0.5) continue;
        for (const r of ses) if (!(kwOf.get(r.id) ?? []).includes(k)) push(r.id, 'keyword', k, Math.min(0.9, share), 'session', { seance: [ses[0].at, ses.at(-1).at], photos: ses.length, portent: n });
      }
    }
    // lieux : photo située la plus proche (2 km) ou même séance
    if (on(s, 'places') && metadata) {
      const docs = new Map(db.prepare('SELECT id FROM photos').all().map(r => [r.id, placeOfDoc(metadata.docOf(r.id))]));
      const known = db.prepare('SELECT id, gps_lat lat, gps_lon lon FROM photos WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL').all().filter(r => hasPlace(docs.get(r.id)));
      for (const r of db.prepare('SELECT id, gps_lat lat, gps_lon lon FROM photos WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL').all()) {
        if (hasPlace(docs.get(r.id))) continue;
        let best = null; for (const k of known) { const d = km(r, k); if (d <= 2 && (!best || d < best.d)) best = { d, k }; }
        if (best) push(r.id, 'place', placeKey(docs.get(best.k.id)), 0.95 - best.d * 0.15, 'gps', { distanceKm: Math.round(best.d * 100) / 100, depuis: best.k.id });
      }
      for (const ses of S) {
        const placed = ses.map(r => docs.get(r.id)).filter(hasPlace).map(placeKey);
        if (!placed.length) continue;
        const freq = new Map(); for (const k of placed) freq.set(k, (freq.get(k) ?? 0) + 1);
        const [key, n] = [...freq].sort((a, b) => b[1] - a[1])[0];
        for (const r of ses) if (!hasPlace(docs.get(r.id)) && r.lat == null) push(r.id, 'place', key, 0.5 + 0.3 * n / placed.length, 'session', { seance: [ses[0].at, ses.at(-1).at], photos: ses.length });
      }
    }
    // on garde la meilleure proposition d'une même valeur pour une même photo
    const best = new Map();
    for (const row of out) { const k = row[0] + '\u0000' + row[1] + '\u0000' + normalizeKeyword(row[2]); if (!best.has(k) || best.get(k)[3] < row[3]) best.set(k, row); }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec("DELETE FROM ai_suggestions WHERE status = 'pending'");
      const ins = db.prepare('INSERT OR IGNORE INTO ai_suggestions(photo_id, kind, value, score, source, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)');
      const t = now(); for (const r of best.values()) ins.run(...r, t);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* déjà annulée */ } throw e; }
    const bySource = {}; for (const r of db.prepare("SELECT source, COUNT(*) n FROM ai_suggestions WHERE status = 'pending' GROUP BY source").all()) bySource[r.source] = r.n;
    let auto = null;
    if (s.autoAccept) {
      const ids = db.prepare("SELECT id FROM ai_suggestions WHERE status = 'pending' AND score >= ?").all(s.autoThreshold).map(r => r.id);
      if (ids.length) auto = accept(ids, { auto: true });
    }
    return { pending: Object.values(bySource).reduce((a, b) => a + b, 0), bySource, auto };
  }

  const SOURCES = { scene: 'Indice visuel (couleurs et textures)', similar: 'Photos semblables déjà décrites', session: 'Même séance de prise de vue', gps: 'Photo voisine (GPS)', faces: 'Visages détectés' };
  const sourceLabel = src => SOURCES[src] ?? (src.startsWith('engine:') ? 'Moteur : ' + (engine(src.slice(7))?.name ?? src.slice(7)) : src);
  function suggestions({ status = 'pending', kind = '', source = '', photoId = '', value = '', limit = 200, offset = 0 } = {}) {
    const w = ['s.status = ?'], a = [status];
    if (kind) { w.push('s.kind = ?'); a.push(kind); }
    if (source) { w.push(source === 'engine' ? "s.source LIKE 'engine:%'" : 's.source = ?'); if (source !== 'engine') a.push(source); }
    if (photoId) { w.push('s.photo_id = ?'); a.push(photoId); }
    if (value) { w.push('s.value = ?'); a.push(value); }
    const where = w.join(' AND ');
    const rows = db.prepare(`SELECT s.*, p.title FROM ai_suggestions s JOIN photos p ON p.id = s.photo_id WHERE ${where} ORDER BY s.score DESC, s.id LIMIT ? OFFSET ?`).all(...a, Math.min(1000, limit), offset)
      .map(r => ({ id: r.id, photoId: r.photo_id, title: r.title, kind: r.kind, value: r.value, label: r.kind === 'place' ? placeLabel(r.value) : r.value, score: r.score, source: r.source, sourceLabel: sourceLabel(r.source), detail: P(r.detail), status: r.status, decidedAt: r.decided_at }));
    const total = db.prepare(`SELECT COUNT(*) n FROM ai_suggestions s WHERE ${where}`).get(...a).n;
    const byValue = db.prepare(`SELECT s.kind, s.value, COUNT(*) n, ROUND(AVG(s.score), 2) score FROM ai_suggestions s WHERE ${where} GROUP BY s.kind, s.value ORDER BY n DESC, score DESC LIMIT 60`).all(...a)
      .map(r => ({ ...r, label: r.kind === 'place' ? placeLabel(r.value) : r.value }));
    return { rows, total, byValue, sources: Object.fromEntries(db.prepare("SELECT source FROM ai_suggestions WHERE status = 'pending' GROUP BY source").all().map(r => [r.source, sourceLabel(r.source)])) };
  }
  /** Accepte des suggestions : mots-clés ajoutés et lieux remplis (champs vides seulement) par lots annulables. */
  function accept(ids, { auto = false } = {}) {
    const list = [].concat(ids ?? []).map(Number).filter(Number.isFinite);
    const rows = list.length ? db.prepare(`SELECT * FROM ai_suggestions WHERE status = 'pending' AND id IN (${list.map(() => '?').join(',')})`).all(...list) : [];
    if (!rows.length) return { accepted: 0, batches: [] };
    if (!metadata) throw new Error('Module des métadonnées indisponible');
    const groups = new Map();
    for (const r of rows) { const k = r.kind + '\u0000' + r.value; if (!groups.has(k)) groups.set(k, { kind: r.kind, value: r.value, photos: [] }); groups.get(k).photos.push(r.photo_id); }
    const batches = [];
    for (const g of groups.values()) {
      let res;
      if (g.kind === 'keyword') res = metadata.applyEdit(g.photos, { keywordsAdd: [g.value] });
      else if (g.kind === 'place') {
        const [sublocation, city, state, country] = g.value.split('|');
        const ch = {}; for (const [k, v] of Object.entries({ sublocation, city, state, country })) if (v) ch[k] = { mode: 'fill', value: v };
        res = metadata.applyEdit(g.photos, ch);
      } else continue;
      batches.push({ kind: g.kind, value: g.value, photos: g.photos.length, batchId: res.batchId });
    }
    const t = now(), st = db.prepare("UPDATE ai_suggestions SET status = 'accepted', decided_at = ? WHERE id = ?");
    for (const r of rows) st.run(t, r.id);
    logHistory(db, 'ai.accept', `${rows.length} suggestion(s) IA acceptée(s)${auto ? ' automatiquement (préférence)' : ''}`, { batches, auto });
    return { accepted: rows.length, batches, ids: rows.map(r => r.id) };
  }
  /** Annule une acceptation : lots de métadonnées annulés, suggestions remises en attente. */
  function undoAccept(ids, batchIds) {
    let restored = 0, kept = 0;
    for (const b of [].concat(batchIds ?? []).filter(Boolean)) { const u = metadata.undo(b); restored += u.restored ?? 0; kept += u.kept ?? 0; }
    const list = [].concat(ids ?? []).map(Number).filter(Number.isFinite);
    if (list.length) db.prepare(`UPDATE ai_suggestions SET status = 'pending', decided_at = NULL WHERE status = 'accepted' AND id IN (${list.map(() => '?').join(',')})`).run(...list);
    return { restored, kept, pending: list.length };
  }
  function reject(ids) {
    const list = [].concat(ids ?? []).map(Number).filter(Number.isFinite); if (!list.length) return { rejected: 0 };
    const r = db.prepare(`UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE status = 'pending' AND id IN (${list.map(() => '?').join(',')})`).run(now(), ...list);
    return { rejected: Number(r.changes) };
  }
  /** Oublie les refus : les suggestions refusées pourront être reproposées au prochain calcul. */
  function forgetRejected() { const r = db.prepare("DELETE FROM ai_suggestions WHERE status = 'rejected'").run(); return { forgotten: Number(r.changes) }; }

  // ---------- recherche visuelle ----------
  function similar(photoId, { limit = 30, min = null } = {}) {
    const s = settings(); if (!on(s, 'similar')) throw new Error('Recherche d’images proches désactivée');
    const V = vectors(), me = V.find(p => p.id === photoId);
    if (!me) return { photoId, analysed: false, rows: [] };
    const th = min ?? Math.max(0.5, s.similarity - 0.1);
    const rows = V.filter(p => p.id !== photoId).map(p => ({ id: p.id, score: Math.round(similarity(me.v, p.v) * 1000) / 1000 })).filter(r => r.score >= th).sort((a, b) => b.score - a.score).slice(0, Math.min(200, limit));
    return { photoId, analysed: true, threshold: th, rows };
  }
  /** Regroupe les images semblables : chaque photo rejoint le groupe dont la première photo lui ressemble le plus. */
  function groups({ min = null, minSize = 2 } = {}) {
    const s = settings(); if (!on(s, 'groups')) throw new Error('Regroupement désactivé');
    const th = min ?? s.similarity, out = [];
    for (const p of vectors().sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))) {
      let best = null, bs = 0;
      for (const g of out) { const sim = similarity(g.lead.v, p.v); if (sim >= th && sim > bs) { best = g; bs = sim; } }
      if (best) { best.ids.push(p.id); best.sum += bs; } else out.push({ lead: p, ids: [p.id], sum: 0 });
    }
    return { threshold: th, groups: out.filter(g => g.ids.length >= minSize).sort((a, b) => b.ids.length - a.ids.length).slice(0, 200)
      .map(g => ({ ids: g.ids, count: g.ids.length, cohesion: Math.round(g.sum / (g.ids.length - 1) * 100) / 100, cover: g.lead.id, colours: Object.entries(g.lead.d.colours ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c) })) };
  }
  /** Événements : séances de prise de vue, avec lieu et mots-clés les plus fréquents (suggestion de collection). */
  function events({ minSize = 3 } = {}) {
    const s = settings(); if (!on(s, 'classify')) throw new Error('Suggestions de classement désactivées');
    const kwOf = photoKeywords(), out = [];
    for (const ses of sessions(s.sessionHours)) {
      if (ses.length < minSize) continue;
      const kw = new Map(); for (const r of ses) for (const k of kwOf.get(r.id) ?? []) kw.set(k, (kw.get(k) ?? 0) + 1);
      const places = new Map(); if (metadata) for (const r of ses) { const pl = placeOfDoc(metadata.docOf(r.id)); if (hasPlace(pl)) { const k = placeLabel(placeKey(pl)); places.set(k, (places.get(k) ?? 0) + 1); } }
      const top = [...kw].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k), place = [...places].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const d0 = ses[0].at.slice(0, 10), d1 = ses.at(-1).at.slice(0, 10);
      const fr = d => d.split('-').reverse().join('/');
      out.push({ from: ses[0].at, to: ses.at(-1).at, count: ses.length, ids: ses.map(r => r.id), cover: ses[Math.floor(ses.length / 2)].id, keywords: top, place,
        name: [d0 === d1 ? fr(d0) : `${fr(d0)} – ${fr(d1)}`, place ?? top[0] ?? null].filter(Boolean).join(' · ') });
    }
    return { hours: s.sessionHours, events: out.reverse().slice(0, 300) };
  }
  function makeCollection(name, ids) {
    if (!collections) throw new Error('Collections indisponibles');
    return collections.create({ name: str(name, 120) || 'Suggestion IA', kind: 'static', photoIds: [].concat(ids ?? []).slice(0, 5000) });
  }

  // ---------- recherche par description ----------
  /**
   * Interprète une description en mots : couleurs, scènes, luminosité (moteur intégré) et texte libre
   * (descriptions et mots-clés des moteurs externes, titre, légende et mots-clés de la fiche).
   * Une photo doit répondre à chaque mot compris ; le score est la moyenne des correspondances.
   */
  function describe(q, { limit = 60 } = {}) {
    const s = settings(); if (!on(s, 'describe')) throw new Error('Recherche par description désactivée');
    const ws = words(q); if (!ws.length) return { q, terms: [], rows: [] };
    const terms = [];
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i], two = ws[i + 1] ? w + ' ' + ws[i + 1] : '';
      if (two === 'noir blanc' || two === 'coucher soleil' || two === 'lever soleil') { const sun = two.includes('soleil'); terms.push({ word: sun ? two.replace(' ', ' de ') : 'noir et blanc', type: 'scene', value: sun ? 'Coucher de soleil' : 'Noir et blanc' }); i++; continue; }
      if (SCENE_WORDS[w]) terms.push({ word: w, type: 'scene', value: SCENE_WORDS[w] });
      else if (COLOUR_WORDS[w]) terms.push({ word: w, type: 'colour', value: COLOUR_WORDS[w] });
      else if (LIGHT_WORDS[w]) terms.push({ word: w, type: 'light', value: LIGHT_WORDS[w] });
      else terms.push({ word: w, type: 'text', value: w });
    }
    const feats = new Map(vectors().map(p => [p.id, p.d]));
    const ext = new Map(); for (const r of db.prepare('SELECT photo_id id, description, labels FROM ai_results WHERE error IS NULL').all()) ext.set(r.id, (ext.get(r.id) ?? '') + ' ' + (r.description ?? '') + ' ' + (P(r.labels) ?? []).map(l => l.name).join(' '));
    const rows = [];
    for (const p of db.prepare('SELECT id, title, description, keywords_text FROM photos').all()) {
      const d = feats.get(p.id), text = ' ' + words([p.title, p.description, p.keywords_text, ext.get(p.id)].filter(Boolean).join(' ')).join(' ') + ' ';
      let sum = 0, okAll = true; const why = [];
      for (const t of terms) {
        let m = 0;
        if (t.type === 'colour') m = d ? Math.min(1, (d.colours?.[t.value] ?? 0) / 0.3) : 0;
        else if (t.type === 'scene') { m = d ? (d.scenes ?? []).find(x => x.name === t.value)?.score ?? 0 : 0; if (text.includes(' ' + words(t.value)[0])) m = Math.max(m, 1); }
        else if (t.type === 'light') m = !d ? 0 : t.value === 'dark' ? Math.max(0, (0.45 - d.light) / 0.3) : t.value === 'bright' ? Math.max(0, (d.light - 0.5) / 0.3) : t.value === 'colourful' ? Math.max(0, (d.saturation - 0.25) / 0.3) : Math.max(0, (0.25 - d.saturation) / 0.2);
        if (t.type === 'text' || m < 0.15) { const stem = t.word.length > 4 ? t.word.replace(/(s|x)$/, '') : t.word; if (text.includes(' ' + stem)) m = Math.max(m, 1); }
        m = Math.min(1, m);
        if (m < 0.15) { okAll = false; break; }
        sum += m; why.push(`${t.word} ${Math.round(m * 100)} %`);
      }
      if (okAll) rows.push({ id: p.id, score: Math.round(sum / terms.length * 100) / 100, why });
    }
    rows.sort((a, b) => b.score - a.score);
    return { q, terms, total: rows.length, rows: rows.slice(0, Math.min(500, limit)), engines: activeEngines(s).filter(e => e.provides.includes('description')).length };
  }

  // ---------- fiche d'une photo ----------
  function photo(photoId) {
    const f = db.prepare('SELECT version, data, computed_at FROM ai_features WHERE photo_id = ?').get(photoId);
    const d = P(f?.data) ?? null;
    return {
      photoId, analysed: !!f && f.version === AI_VERSION, computedAt: f?.computed_at ?? null,
      colours: d ? Object.entries(d.colours ?? {}).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ colour: c, share: v })) : [],
      light: d?.light ?? null, saturation: d?.saturation ?? null, scenes: d?.scenes ?? [],
      results: db.prepare('SELECT engine, description, labels, faces, error, ms, computed_at FROM ai_results WHERE photo_id = ?').all(photoId)
        .map(r => ({ engine: r.engine, name: engine(r.engine)?.name ?? r.engine, description: r.description, labels: P(r.labels) ?? [], faces: P(r.faces) ?? [], error: r.error, ms: r.ms, computedAt: r.computed_at })),
      suggestions: suggestions({ photoId, limit: 100 }).rows,
    };
  }

  // ---------- état ----------
  function status() {
    const s = settings(), ext = engines();
    const total = db.prepare('SELECT COUNT(*) n FROM photos').get().n;
    const analysed = db.prepare('SELECT COUNT(*) n FROM ai_features f JOIN photos p ON p.id = f.photo_id WHERE f.version = ?').get(AI_VERSION).n;
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM ai_suggestions GROUP BY status').all().map(r => [r.status, r.n]));
    const active = activeEngines(s);
    return {
      settings: s, features: FEATURES, featureNeeds: FEATURE_NEEDS,
      available: Object.fromEntries(Object.keys(FEATURES).map(k => [k, !FEATURE_NEEDS[k] || active.some(e => e.provides.includes(FEATURE_NEEDS[k]))])),
      engines: [{ ...LOCAL_ENGINE, active: s.enabled }, ...ext.map(e => ({ ...e, ...(s.engines[e.id] ?? { enabled: false, licenseAccepted: false }), local: e.kind === 'command' || isLocalUrl(e.url), issues: e.kind === 'invalid' ? [e.error] : engineIssues(e, s), active: s.enabled && active.some(a => a.id === e.id), analysed: db.prepare('SELECT COUNT(*) n FROM ai_results WHERE engine = ? AND error IS NULL').get(e.id).n, errors: db.prepare('SELECT COUNT(*) n FROM ai_results WHERE engine = ? AND error IS NOT NULL').get(e.id).n }))],
      engineKinds: ENGINE_KINDS, engineProvides: ENGINE_PROVIDES, enginesDir: dir,
      photos: total, analysed, suggestions: { pending: counts.pending ?? 0, accepted: counts.accepted ?? 0, rejected: counts.rejected ?? 0 },
      job: jobState(), cpus: os.cpus().length,
    };
  }
  /** Efface les résultats de l'IA (descripteurs, réponses des moteurs, suggestions en attente). Rien d'autre n'est touché. */
  function clearResults() {
    const a = db.prepare('DELETE FROM ai_features').run().changes, b = db.prepare('DELETE FROM ai_results').run().changes, c = db.prepare("DELETE FROM ai_suggestions WHERE status = 'pending'").run().changes;
    logHistory(db, 'ai.clear', 'Résultats de l’IA effacés', { features: Number(a), results: Number(b), suggestions: Number(c) });
    return { features: Number(a), results: Number(b), suggestions: Number(c) };
  }

  return { ollamaModels, undoAccept, settings, saveSettings, engines, engine, saveEngine, removeEngine, testEngine, startAnalysis, control, waitJob, jobState, refreshSuggestions, suggestions, accept, reject, forgetRejected, similar, groups, events, makeCollection, describe, photo, status, clearResults, imageSource };
}

// ------------------------------------------------------------------ routes /api/ai/*
/**
 * Routes HTTP de l'extension (branchées par une seule ligne dans server.mjs). Renvoie true si la requête
 * a été traitée. `cards(ids)` fournit les vignettes des photos (dans l'ordre demandé).
 */
export function aiRoutes(ai, { json, readBody, cards }) {
  const withCards = (rows, key = 'id') => { const m = new Map(cards(rows.map(r => r[key])).map(c => [c.id, c])); return rows.map(r => ({ ...r, card: m.get(r[key]) ?? null })); };
  return async function handle(req, res, p, m, url) {
    if (!p.startsWith('/api/ai')) return false;
    const sp = url.searchParams, body = () => readBody(req);
    try {
      if (p === '/api/ai' && m === 'GET') return json(res, 200, ai.status()), true;
      if (p === '/api/ai/settings' && m === 'PUT') { ai.saveSettings(await body()); return json(res, 200, ai.status()), true; }
      if (p === '/api/ai/engines' && m === 'POST') { const e = ai.saveEngine(await body()); return json(res, 200, { engine: e, status: ai.status() }), true; }
      if (p.startsWith('/api/ai/engines/') && m === 'DELETE') { ai.removeEngine(decodeURIComponent(p.split('/')[4])); return json(res, 200, ai.status()), true; }
      if (p.startsWith('/api/ai/engines/') && p.endsWith('/test') && m === 'POST') { const b = await body(); const r = await ai.testEngine(decodeURIComponent(p.split('/')[4]), b.photoId); return json(res, 200, { result: r, card: cards([r.photoId])[0] ?? null }), true; }
      if (p === '/api/ai/ollama/models' && m === 'GET') return json(res, 200, { models: await ai.ollamaModels(sp.get('url') || undefined) }), true;
      if (p === '/api/ai/analyse' && m === 'POST') { const b = await body(); return json(res, 200, { job: ai.startAnalysis({ all: !!b.all, ids: Array.isArray(b.ids) ? b.ids.slice(0, 5000) : null }) }), true; }
      if (p === '/api/ai/analyse' && m === 'GET') return json(res, 200, { job: ai.jobState() }), true;
      if (p === '/api/ai/analyse/control' && m === 'POST') { const b = await body(); return json(res, 200, { job: ai.control(b.action) }), true; }
      if (p === '/api/ai/suggestions/refresh' && m === 'POST') return json(res, 200, ai.refreshSuggestions()), true;
      if (p === '/api/ai/suggestions' && m === 'GET') {
        const r = ai.suggestions({ status: sp.get('status') || 'pending', kind: sp.get('kind') || '', source: sp.get('source') || '', value: sp.get('value') || '', photoId: sp.get('photoId') || '', limit: +sp.get('limit') || 200, offset: +sp.get('offset') || 0 });
        return json(res, 200, { ...r, rows: withCards(r.rows, 'photoId') }), true;
      }
      if (p === '/api/ai/suggestions/accept' && m === 'POST') { const b = await body(); return json(res, 200, ai.accept(b.ids)), true; }
      if (p === '/api/ai/suggestions/undo' && m === 'POST') { const b = await body(); return json(res, 200, ai.undoAccept(b.ids, b.batches)), true; }
      if (p === '/api/ai/suggestions/reject' && m === 'POST') { const b = await body(); return json(res, 200, ai.reject(b.ids)), true; }
      if (p === '/api/ai/suggestions/forget' && m === 'POST') return json(res, 200, ai.forgetRejected()), true;
      if (p === '/api/ai/similar' && m === 'GET') { const r = ai.similar(sp.get('photoId') || '', { limit: +sp.get('limit') || 60, min: sp.get('min') ? +sp.get('min') : null }); return json(res, 200, { ...r, me: cards([r.photoId])[0] ?? null, rows: withCards(r.rows) }), true; }
      if (p === '/api/ai/groups' && m === 'GET') { const r = ai.groups({ min: sp.get('min') ? +sp.get('min') : null }); return json(res, 200, { ...r, groups: r.groups.map(g => ({ ...g, cards: cards(g.ids.slice(0, 8)) })) }), true; }
      if (p === '/api/ai/events' && m === 'GET') { const r = ai.events(); return json(res, 200, { ...r, events: r.events.map(g => ({ ...g, cards: cards([g.cover, ...g.ids.filter(i => i !== g.cover)].slice(0, 6)) })) }), true; }
      if (p === '/api/ai/collection' && m === 'POST') { const b = await body(); return json(res, 200, { collection: ai.makeCollection(b.name, b.ids) }), true; }
      if (p === '/api/ai/describe' && m === 'GET') { const r = ai.describe(sp.get('q') || '', { limit: +sp.get('limit') || 60 }); return json(res, 200, { ...r, rows: withCards(r.rows) }), true; }
      if (p === '/api/ai/photo' && m === 'GET') { const id = sp.get('id') || ''; return json(res, 200, { ...ai.photo(id), card: cards([id])[0] ?? null }), true; }
      if (p === '/api/ai/clear' && m === 'POST') return json(res, 200, ai.clearResults()), true;
      return json(res, 404, { error: 'Route IA inconnue' }), true;
    } catch (e) { return json(res, 400, { error: String(e.message || e) }), true; }
  };
}
