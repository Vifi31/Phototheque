// Distribution : empreintes et signature des versions livrées, vérification d'une installation.
//
// Chaque distribution contient SHA256SUMS (une ligne « empreinte *chemin » par fichier du programme)
// et, si la clé privée de l'éditeur était disponible à la construction, SHA256SUMS.sig : signature
// Ed25519 (node:crypto) de SHA256SUMS. La clé publique est livrée dans distribution/cle-publique.pem ;
// une mise à jour est vérifiée avec la clé de la version DÉJÀ installée (une clé substituée dans le
// nouveau paquet ne suffit donc pas à faire accepter une version modifiée).
// La signature Authenticode des exécutables Windows (signtool) est en plus, et seulement si un
// certificat de signature de code est fourni (scripts/build.mjs).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const SUMS_FILE = 'SHA256SUMS';
export const SIG_FILE = 'SHA256SUMS.sig';
export const PUBLIC_KEY_FILE = 'distribution/cle-publique.pem';
export const INSTALL_INFO_FILE = 'installation.json';

/** Fichiers et dossiers du programme livrés (jamais data/, Sauvegardes/, Versions/, Exports/…). */
export const DIST_FILES = ['server.mjs', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'app.config.json', '.env.example'];
export const DIST_DIRS = ['lib', 'public', 'docs', 'distribution', 'node_modules'];
export const DIST_SCRIPTS = ['scripts/lancer.mjs', 'scripts/verifier.mjs', 'scripts/deverrouiller.mjs'];
/** Fichiers produits par la construction ou l'installation, exclus des empreintes. */
const NOT_SUMMED = new Set([SUMS_FILE, SIG_FILE, INSTALL_INFO_FILE, '.env', 'MANIFEST.json']);

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = f => sha(fs.readFileSync(f));
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(p) : [p];
  });
}
/** Liste des fichiers à livrer depuis l'arborescence de développement. */
export function distSources(root) {
  const out = [];
  for (const f of [...DIST_FILES, ...DIST_SCRIPTS]) { const p = path.join(root, f); if (fs.existsSync(p)) out.push(p); }
  for (const d of DIST_DIRS) out.push(...walk(path.join(root, d)).filter(f => !/(^|[\\/])(\.cache|\.git)([\\/]|$)/.test(f)));
  return out;
}
/** Tous les fichiers d'une distribution (ou d'une installation), sauf ceux produits ensuite. */
export function distFiles(dir) {
  return walk(dir).map(f => rel(dir, f)).filter(r => !NOT_SUMMED.has(r)).sort();
}

/** Texte SHA256SUMS d'un dossier (format de sha256sum : « empreinte *chemin »). */
export function makeSums(dir) {
  return distFiles(dir).map(r => `${sha256File(path.join(dir, r))} *${r}`).join('\n') + '\n';
}
export function parseSums(text) {
  const m = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const x = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim()); if (x) m.set(x[2], x[1]);
  }
  return m;
}

// ------------------------------------------------------------------ clés et signature Ed25519
export function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
export const keyId = publicPem => sha(crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' })).slice(0, 16);
export function signText(text, privatePem) { return crypto.sign(null, Buffer.from(text, 'utf8'), crypto.createPrivateKey(privatePem)).toString('base64'); }
export function checkSignature(text, sigB64, publicPem) {
  try { return crypto.verify(null, Buffer.from(text, 'utf8'), crypto.createPublicKey(publicPem), Buffer.from(String(sigB64).trim(), 'base64')); }
  catch { return false; }
}

/**
 * Vérifie un dossier de distribution ou d'installation : chaque fichier listé dans SHA256SUMS est présent
 * et intact, aucun fichier n'a été ajouté, et la signature (si présente) est valide pour `publicPem`
 * (par défaut la clé livrée dans le dossier). Renvoie un rapport ; `ok` exige la signature si `requireSignature`.
 */
export function verifyDist(dir, { publicPem = null, requireSignature = false } = {}) {
  const sumsPath = path.join(dir, SUMS_FILE);
  if (!fs.existsSync(sumsPath)) return { ok: false, signed: false, error: 'Fichier SHA256SUMS absent : distribution non vérifiable.', modified: [], missing: [], added: [] };
  const text = fs.readFileSync(sumsPath, 'utf8'), sums = parseSums(text);
  const modified = [], missing = [];
  for (const [r, h] of sums) {
    const p = path.join(dir, ...r.split('/'));
    if (!fs.existsSync(p)) missing.push(r); else if (sha256File(p) !== h) modified.push(r);
  }
  const added = distFiles(dir).filter(r => !sums.has(r));
  const pub = publicPem ?? (fs.existsSync(path.join(dir, PUBLIC_KEY_FILE)) ? fs.readFileSync(path.join(dir, PUBLIC_KEY_FILE), 'utf8') : null);
  const sigPath = path.join(dir, SIG_FILE);
  const hasSig = fs.existsSync(sigPath);
  const signed = hasSig && !!pub && checkSignature(text, fs.readFileSync(sigPath, 'utf8'), pub);
  const intact = !modified.length && !missing.length && !added.length;
  let error = null;
  if (!intact) error = `${modified.length} fichier(s) modifié(s), ${missing.length} manquant(s), ${added.length} ajouté(s).`;
  else if (hasSig && !signed) error = pub ? 'Signature invalide pour la clé de l’éditeur.' : 'Clé publique de l’éditeur absente.';
  else if (requireSignature && !hasSig) error = 'Distribution non signée.';
  return { ok: intact && (!hasSig || signed) && (!requireSignature || signed), intact, signed, hasSignature: hasSig, keyId: pub ? keyId(pub) : null, files: sums.size, modified, missing, added, error };
}

/** Informations d'installation écrites par l'installateur (installation.json à la racine du programme). */
export function installInfo(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, INSTALL_INFO_FILE), 'utf8')); } catch { return null; }
}
