// Ouverture d'une photo dans un logiciel externe (GIMP, Photoshop, Affinity, darktable…), §12.
// L'original n'est jamais confié au logiciel : on lui passe une COPIE rangée dans « Edition externe/ »
// (fichier d'origine copié tel quel, RAW compris, ou version retouchée rendue en TIFF). Les fichiers
// enregistrés là par le logiciel s'ajoutent ensuite à la photothèque en indexant ce dossier.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { logHistory } from './db.mjs';
import { HOME } from './paths.mjs';
import { pipeline } from './edits.mjs';
import { uniqueName } from './imports.mjs';

export const EXTERNAL_DIR = path.join(HOME, 'Edition externe');
export const EXTERNAL_SOURCES = { original: 'Copie du fichier d’origine (RAW compris)', version: 'Version retouchée par défaut, en TIFF' };
export const EXTERNAL_DEFAULTS = () => ({ editor: '' });

/** Réglage nettoyé : chemin d'un programme (.exe, .bat, .cmd ou .app), ou vide = application associée au type de fichier. */
export function cleanExternalSettings(b = {}, cur = EXTERNAL_DEFAULTS()) {
  const o = { ...EXTERNAL_DEFAULTS(), ...cur };
  if (b.editor !== undefined) o.editor = String(b.editor ?? '').trim().replace(/^"(.*)"$/, '$1').slice(0, 400);
  return o;
}
/** Vérifie le programme choisi (existant, exécutable Windows ou application macOS). */
export function checkEditor(editor) {
  if (!editor) return { ok: true, label: 'Application associée au type de fichier' };
  if (!/\.(exe|bat|cmd|app)$/i.test(editor)) return { ok: false, label: 'Le programme doit être un fichier .exe (ou .app sur Mac)' };
  if (!fs.existsSync(editor)) return { ok: false, label: 'Programme introuvable : ' + editor };
  return { ok: true, label: path.basename(editor) };
}

export function createExternal(db, { edits, library, settings = () => EXTERNAL_DEFAULTS(), launcher = null }) {
  const base = n => path.parse(n || 'photo').name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 100) || 'photo';
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');

  /** Prépare la copie à ouvrir ; renvoie son chemin. Jamais l'original lui-même. */
  async function prepare(photoId, { source = 'original' } = {}) {
    const files = db.prepare(`SELECT path, file_name FROM files WHERE photo_id = ? ORDER BY status = 'available' DESC, kind = 'original' DESC`).all(photoId);
    if (!files.length) throw new Error('Photo inconnue');
    fs.mkdirSync(EXTERNAL_DIR, { recursive: true });
    if (source === 'version') {
      const ver = edits.defaultOf(photoId);
      const src = edits.sourceOf(photoId); if (!src) throw new Error('Aucun fichier lisible (support absent ?)');
      const { image } = await pipeline(src.path, ver ? ver.params : {});
      const name = uniqueName(EXTERNAL_DIR, `${base(files[0].file_name)} - ${ver ? ver.name : 'original'} ${stamp()}.tif`);
      const out = path.join(EXTERNAL_DIR, name);
      await image.withIccProfile('srgb').tiff({ compression: 'lzw' }).toFile(out);
      return { file: out, source, fromPreview: src.from === 'apercu' };
    }
    const f = files.find(x => fs.existsSync(x.path));
    if (!f) throw new Error('Fichier d’origine indisponible (support absent ?)');
    const ext = path.extname(f.path);
    const out = path.join(EXTERNAL_DIR, uniqueName(EXTERNAL_DIR, `${base(f.file_name)} - copie ${stamp()}${ext}`));
    fs.copyFileSync(f.path, out, fs.constants.COPYFILE_EXCL);
    return { file: out, source };
  }

  /** Lance le logiciel choisi (ou l'application associée) sur un fichier du dossier « Edition externe ». */
  function launch(file) {
    const rel = path.relative(EXTERNAL_DIR, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Seules les copies du dossier « Edition externe » sont ouvertes');
    const editor = settings()?.editor ?? '';
    const chk = checkEditor(editor); if (!chk.ok) throw new Error(chk.label);
    if (launcher) return launcher(editor, file); // tests : pas de lancement réel
    const [cmd, args] = editor ? [editor, [file]]
      : process.platform === 'win32' ? ['explorer.exe', [file]] : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => { /* signalé par l'absence de fenêtre ; rien à journaliser de plus */ });
    child.unref();
    return { program: chk.label };
  }

  async function open(photoId, opts) {
    const r = await prepare(photoId, opts);
    const l = launch(r.file);
    logHistory(db, 'external.open', `Photo ouverte dans un logiciel externe (copie : ${path.basename(r.file)})`, { photoId, file: r.file, source: r.source });
    return { ...r, ...l, dir: EXTERNAL_DIR };
  }

  /** Indexe le dossier « Edition externe » (création de la fiche du dossier au besoin) : les fichiers modifiés deviennent des photos. */
  async function index() {
    fs.mkdirSync(EXTERNAL_DIR, { recursive: true });
    let folder = db.prepare('SELECT id FROM folders WHERE path = ?').get(EXTERNAL_DIR);
    if (!folder) {
      const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      db.prepare('INSERT INTO folders(id,support_id,path,rel_path,photo_count,indexed_at,status,data) VALUES(?,NULL,?,NULL,0,NULL,?,?)').run(id, EXTERNAL_DIR, 'pending', '{}');
      folder = { id };
    }
    return library.indexFolder(folder.id);
  }

  return { prepare, launch, open, index };
}
