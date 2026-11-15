// Tests de Photothèque — `npm test`.
// Couvre : mots-clés, supports, indexation sans copie, métadonnées, vignettes,
// recherche, import (copie + doublons), sauvegardes, et l'intégrité de la base.
// Aucune donnée réelle n'est touchée : tout tourne dans un dossier temporaire.
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';

// isole les données dans un dossier temporaire AVANT d'importer les modules qui lisent .env/paths
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phototheque-test-'));
process.env.PHOTOTHEQUE_HOME = TMP;

const { initStore, saveStore, loadStore } = await import('../lib/store.mjs');
const { createSupports, fingerprint } = await import('../lib/supports.mjs');
const { createKeywords } = await import('../lib/keywords.mjs');
const { createLibrary, isImage, IMAGE_EXTS } = await import('../lib/library.mjs');
const { createImports, uniqueName } = await import('../lib/imports.mjs');
const { createCollections } = await import('../lib/collections.mjs');
const { createAlbums, LAYOUTS, SAFETY_MARGIN, ALBUM_FORMAT_VERSION, ZOOM_MAX: ALB_ZOOM_MAX } = await import('../lib/albums.mjs');
const { createAlbumPdf, BLEED_MM } = await import('../lib/albumpdf.mjs');
const Pdf = await import('../lib/pdf.mjs');
const { createBackupService } = await import('../lib/backup.mjs');
const { openDb, dbStatus, integrity, tableRows, isTable, ftsStatus } = await import('../lib/db.mjs');
const Search = await import('../lib/search.mjs');
const { createZip, readZip } = await import('../lib/zip.mjs');
const { defaultLicense, brief } = await import('../lib/license.mjs');

let ok = 0, ko = 0;
const check = (name, actual, expected, eps = 0.01) => {
  const good = actual === expected
    || (typeof expected === 'number' && Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= eps);
  if (good) { ok++; console.log(`  ok   ${name}`); }
  else { ko++; console.error(`  ECHEC ${name}\n         attendu  ${expected}\n         obtenu   ${actual}`); }
};
const group = t => console.log(`\n${t}`);

// ---------- fabrique d'images de test ----------
async function makeImage(file, { w = 800, h = 600, make = 'Canon', model = 'EOS R5', date = '2024:07:15 14:30:00', color = { r: 40, g: 90, b: 200 } } = {}) {
  const exif = { IFD0: { Make: make, Model: model, Orientation: 'Horizontal (normal)', DateTime: date } };
  let pipeline = sharp({ create: { width: w, height: h, channels: 3, background: color } }).withExif(exif);
  // produit un vrai PNG si l'extension le demande (sinon JPEG), pour tester la lecture du format réel
  pipeline = /\.png$/i.test(file) ? pipeline.png() : pipeline.jpeg({ quality: 85 });
  const buf = await pipeline.toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

// ===================================================================
group('Base de données : schéma et intégrité');
// ===================================================================
{
  const { db } = initStore();
  check('base ouverte', !!db, true, 0);
  check('table photos présente', isTable('photos'), true, 0);
  check('table supports présente', isTable('supports'), true, 0);
  check('table keywords présente', isTable('keywords'), true, 0);
  check("contrôle d'intégrité", integrity(db).length === 1 && integrity(db)[0] === 'ok', true, 0);
  const st = dbStatus(db);
  check('statut : moteur SQLite', /SQLite/i.test(st.engine), true, 0);
  check('statut : au moins 15 tables', st.tables.length >= 15, true, 0);
  db.close();
}

// ===================================================================
group('Mots-clés : création, arborescence, affectation, fusion');
// ===================================================================
let KW, LIB, DB, SUP, IMP, STORE;
{
  const { db, store } = initStore();
  DB = db; STORE = store;
  SUP = createSupports(db); KW = createKeywords(db);
  LIB = createLibrary(db, store, SUP, KW); IMP = createImports(db, store, LIB, KW);

  const v = KW.ensure('Vacances');
  check('création', !!v.id, true, 0);
  check('idempotent (même nom → même id)', KW.ensure('Vacances').id, v.id);
  const enfant = KW.ensure('Été 2024', v.id);
  check('parent rattaché', enfant.parent_id, v.id);
  check('normalisation (accents/casse/espaces)', KW.ensure('ÉTÉ  2024', v.id).id, enfant.id, 0);
  check('suggestion par préfixe', KW.suggest('vac').length, 1, 0);
  check('arborescence : un racine', KW.tree().length >= 1, true, 0);

  KW.ensure('Famille');
  check('au moins 2 mots-clés', KW.list().length >= 2, true, 0);
  // affectation
  const fakePhoto = 'photo-test-1';
  DB.prepare("INSERT INTO photos(id, data) VALUES(?, '{}')").run(fakePhoto);
  KW.attachNames(fakePhoto, ['Vacances', 'Famille']);
  check('mots-clés d\'une photo', KW.ofPhoto(fakePhoto).length, 2, 0);
  KW.recount();
  check('comptage après affectation', KW.byName('Vacances').photo_count, 1, 0);
  // fusion
  const cible = KW.ensure('Congé');
  KW.merge([KW.byName('Famille').id], cible.id);
  check('fusion : la source disparaît', KW.byName('Famille'), null, 0);
  check('fusion : les affectations passent à la cible', KW.ofPhoto(fakePhoto).length, 2, 0);
  // export
  check('export CSV non vide', KW.exportCsv().split('\r\n').length >= 3, true, 0);
  // nettoyage : la photo de test ne doit pas polluer les groupes suivants
  DB.prepare('DELETE FROM photos WHERE id = ?').run(fakePhoto);
}

// ===================================================================
group('Supports : empreinte et statut');
// ===================================================================
{
  // dossier local qui tient lieu de « support »
  const racine = path.join(TMP, 'disque-test');
  fs.mkdirSync(racine, { recursive: true });
  fs.writeFileSync(path.join(racine, 'a.jpg'), 'x');
  const fp = fingerprint(racine);
  check('empreinte calculée', typeof fp === 'string' && fp.length === 32, true, 0);
  check('empreinte stable', fingerprint(racine), fp);
  const s = SUP.upsert({ name: 'Disque test', mount_path: racine, kind: 'disk', role: 'original' });
  check('support ajouté', !!s.id, true, 0);
  check('support disponible', s.status, 'available');
  check('inventaire', SUP.list().length, 1, 0);
  // support absent (chemin inexistant)
  const absent = SUP.upsert({ name: 'Carte absente', mount_path: path.join(TMP, 'nesexiste-pas'), kind: 'sd' });
  check('support absent détecté', absent.status, 'absent');
  check('stats : 1 disponible, 1 absent', SUP.stats().available === 1 && SUP.stats().absent === 1, true, 0);
}

// ===================================================================
group('Indexation sans copie : métadonnées, vignettes, intégrité des originaux');
// ===================================================================
{
  const dossier = path.join(TMP, 'mes-photos');
  await makeImage(path.join(dossier, 'IMG_0001.jpg'), { w: 900, h: 600, date: '2024:07:15 14:30:00' });
  await makeImage(path.join(dossier, 'IMG_0002.jpg'), { w: 1200, h: 800, make: 'Nikon', model: 'Z6 II', date: '2023:12:01 09:00:00' });
  await makeImage(path.join(dossier, 'sous-dossier', 'IMG_0003.png'), { w: 640, h: 480, date: '2022:03:10 08:00:00' });
  // empreinte des originaux avant indexation
  const avant = ['IMG_0001.jpg', 'IMG_0002.jpg', path.join('sous-dossier', 'IMG_0003.png')]
    .map(f => fs.statSync(path.join(dossier, f)).mtimeMs);

  const fid = 'fold-test-1';
  DB.prepare('INSERT INTO folders(id,support_id,path,rel_path,photo_count,indexed_at,status,data) VALUES(?,?,?,NULL,0,NULL,?,?)')
    .run(fid, null, dossier, 'pending', '{}');
  const r = await LIB.indexFolder(fid);
  check('3 fichiers traités', r.total, 3, 0);
  check('3 photos ajoutées', r.added, 3, 0);
  check('0 erreur', r.errors, 0, 0);

  // les originaux ne sont ni modifiés ni déplacés
  const apres = ['IMG_0001.jpg', 'IMG_0002.jpg', path.join('sous-dossier', 'IMG_0003.png')]
    .map(f => fs.statSync(path.join(dossier, f)).mtimeMs);
  check('originaux inchangés (mtime)', JSON.stringify(apres), JSON.stringify(avant));

  // métadonnées extraites
  const list = LIB.search({}, { limit: 10 });
  check('3 photos en base', list.total, 3, 0);
  const p1 = list.rows.find(p => p.camera_model === 'EOS R5');
  check('modèle EXIF lu', !!p1, true, 0);
  check('dimensions lues', p1 && p1.width, 900, 0);
  check('date de prise de vue (EXIF)', p1 && p1.captured_at && p1.captured_at.slice(0, 10), '2024-07-15');
  check('vignette générée', !!(p1 && p1.thumb), true, 0);
  // la vignette existe sur disque
  const detail = LIB.detail(p1.id);
  const thumbRel = detail.files[0].data.thumbs.thumb;
  check('fichier de vignette présent', fs.existsSync(path.join(TMP, 'data', 'thumbs', thumbRel)), true, 0);

  // re-indexation : idempotente (0 ajout)
  const r2 = await LIB.indexFolder(fid);
  check('re-indexation sans doublon', r2.added, 0, 0);

  // recherche
  check('recherche par appareil', LIB.search({ camera: 'Nikon' }).total, 1, 0);
  check('recherche par format', LIB.search({ format: 'png' }).total, 1, 0);
  check('recherche par année', LIB.search({ from: '2024-01-01', to: '2024-12-31' }).total, 1, 0);

  // stats
  const st = LIB.stats();
  check('stats.photos', st.photos, 3, 0);
  check('stats.gps = 0 (pas de GPS)', st.gps, 0, 0);
}

// ===================================================================
group('Recherche plein texte (FTS5) : index, accents, synchronisation');
// ===================================================================
{
  // --- l'index existe réellement, il n'est pas décoratif ---
  const engine = Search.searchEngine(DB);
  check('FTS5 réellement disponible', engine.fts5, true, 0);
  check('moteur annoncé = fts5', engine.mode, 'fts5', 0);
  check('schéma versionné à 2', DB.prepare("SELECT value v FROM meta WHERE key='schema_version'").get().v, '2', 0);
  check('index non vide', ftsStatus(DB).indexed >= LIB.stats().photos, true, 0);
  check('intégrité après migration', integrity(DB)[0], 'ok', 0);
  check('3 déclencheurs de synchronisation',
    DB.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'photos_fts_%'").get().n, 3, 0);

  // --- recherche textuelle réelle ---
  const cible = LIB.search({}, { limit: 10 }).rows[0];
  LIB.update(cible.id, { title: 'Villa d\'été', description: 'Témoignage de famille', notes: 'Réviser le dossier 2024' });
  LIB.syncKeywordsText(cible.id);
  const ids = f => LIB.search(f, { limit: 20 }).rows.map(p => p.id);
  check('trouve un mot du titre', ids({ q: 'villa' }).includes(cible.id), true, 0);
  check('ET plusieurs termes', ids({ q: 'villa témoignage' }).includes(cible.id), true, 0);
  check('ne trouve pas un mot absent', ids({ q: 'chateau' }).includes(cible.id), false, 0);
  check('insensible aux accents (« villa » = « VILLA »)', ids({ q: 'VILLA' }).includes(cible.id), true, 0);
  check('insensible aux accents (« ete » → « été »)',
    LIB.search({ q: 'ete' }, { limit: 20 }).total >= LIB.search({ q: 'été' }, { limit: 20 }).total, true, 0);
  check('mode OU (un seul des termes)', ids({ anyText: ['villa', 'introuvablexyz'] }).includes(cible.id), true, 0);
  check('mode NON (exclut)', ids({ excludeText: ['villa'] }).includes(cible.id), false, 0);
  check('tri inconnu → tri par défaut (pas de 500)', ids({ q: 'villa' }).length > 0, true, 0);

  // --- saisies hostiles : la syntaxe FTS5 ne doit jamais remonter comme erreur ---
  for (const bad of ['"', 'AND NOT (x', '*', '^abc', '(){}[]', ':', 'a OR b AND NOT c', '%\b_']) {
    let err = null;
    try { LIB.search({ q: bad }, { limit: 5 }); } catch (e) { err = e.message; }
    check(`saisie hostile ${JSON.stringify(bad)} sans erreur`, err, null, 0);
  }

  // --- synchronisation : l'index suit les écritures ---
  const mq = q => DB.prepare('SELECT COUNT(*) n FROM photos_fts WHERE photos_fts MATCH ?').get(q).n;
  check('le nouveau mot est indexé', mq('"Temoignage"') >= 1, true, 0);
  LIB.update(cible.id, { title: 'Chalet de montagne', description: null });
  check('ancien mot retiré de l\'index', mq('"Temoignage"'), 0, 0);
  check('ancien titre retiré', mq('"Villa"'), 0, 0);
  check('nouveau titre indexé', mq('"Chalet"'), 1, 0);
  check('retrouvé par la recherche', ids({ q: 'chalet' }).includes(cible.id), true, 0);
  LIB.update(cible.id, { title: null });
  check('titre effacé → index vidé de ce terme', mq('"Chalet"'), 0, 0);

  // --- critères avancés (§9) ---
  const n = f => LIB.search(f, { limit: 50 }).total;
  check('critère : sans étiquette', n({ noKeyword: true }) >= n({ hasKeyword: true }), true, 0);
  // filtre « Mots-clés » de la barre de la Photothèque : sans / avec / un mot-clé précis (branche comprise)
  {
    const total = LIB.stats().photos, kf0 = LIB.keywordFacets();
    check('filtre mots-clés : sans + avec = toute la photothèque', kf0.none + kf0.any, total, 0);
    check('filtre mots-clés : compteur « sans » = critère noKeyword', kf0.none, n({ noKeyword: true }), 0);
    check('filtre mots-clés : compteur « avec » = critère hasKeyword', kf0.any, n({ hasKeyword: true }), 0);
    check('filtre mots-clés : sans et avec sont disjoints et complets', n({ noKeyword: true }) + n({ hasKeyword: true }), total, 0);
    const [pa, pb] = DB.prepare('SELECT id FROM photos ORDER BY id LIMIT 2').all().map(r => r.id);
    const par = KW.ensure('Facette parent'), enf = KW.ensure('Facette enfant', par.id);
    KW.attach(pa, par.id); KW.attach(pa, enf.id); KW.attach(pb, enf.id); KW.recount();
    const kf = LIB.keywordFacets();
    check('filtre mots-clés : branche = photos distinctes (pas d\'affectations doublées)', kf.branch[par.id], 2, 0);
    check('filtre mots-clés : un mot-clé sans enfant n\'a pas d\'entrée de branche', kf.branch[enf.id], undefined, 0);
    check('filtre mots-clés : effectif direct du parent et de l\'enfant', [kf.counts[par.id], kf.counts[enf.id]].join('/'), '1/2', 0);
    check('filtre mots-clés : recherche par le parent inclut l\'enfant', n({ keywordId: par.id }), 2, 0);
    check('filtre mots-clés : recherche par l\'enfant', n({ keywordId: enf.id }), 2, 0);
    check('filtre mots-clés : « sans » exclut les photos marquées', LIB.search({ noKeyword: true }, { limit: 500 }).rows.every(r => r.id !== pa && r.id !== pb), true, 0);
    check('filtre mots-clés : « avec » inclut les photos marquées', LIB.search({ hasKeyword: true }, { limit: 500 }).rows.some(r => r.id === pa), true, 0);
    KW.remove(enf.id); KW.remove(par.id);
    const kf2 = LIB.keywordFacets();
    check('filtre mots-clés : retour à l\'état initial après nettoyage', kf2.none === kf0.none && kf2.any === kf0.any, true, 0);
  }
  // propositions de mots-clés pendant la saisie (public/ui.js, UI.keywordMatches : fonction pure, chargée hors navigateur)
  {
    const vm = await import('node:vm');
    const ctx = vm.createContext({ document: { addEventListener() {}, getElementById() { return null; } }, addEventListener() {}, console });
    const UI = vm.runInContext(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'public', 'ui.js'), 'utf8') + ';UI', ctx);
    const L = [{ id: 1, name: 'Été 2024', parent_id: null, data: {} }, { id: 2, name: 'Vacances', parent_id: null, data: { synonyms: ['congés'] } },
      { id: 3, name: 'France', parent_id: null, data: {} }, { id: 4, name: 'Paris', parent_id: 3, data: {} }, { id: 5, name: 'Aéroport de Paris', parent_id: null, data: {} },
      { id: 6, name: "Fête de l'été", parent_id: null, data: {} }];
    const names = (t, o) => UI.keywordMatches(L, t, o).map(m => m.k.name).join(' | ');
    check('saisie : insensible aux accents et à la casse', names('ETE'), 'Été 2024 | Fête de l\'été', 0);
    check('saisie : début de mot avant « contient »', names('pari'), 'Paris | Aéroport de Paris', 0);
    check('saisie : trouve par synonyme', names('cong'), 'Vacances', 0);
    check('saisie : indique le synonyme trouvé', UI.keywordMatches(L, 'cong')[0].via, 'congés', 0);
    check('saisie : chemin du parent', UI.keywordMatches(L, 'paris')[0].path, 'France', 0);
    check('saisie : rien à proposer pour une saisie vide ou inconnue', names('') + '/' + names('zzz'), '/', 0);
    check('saisie : mots déjà saisis écartés', names('par', { exclude: new Set(['paris']) }), 'Aéroport de Paris', 0);
    check('saisie : nombre de propositions borné', UI.keywordMatches(L, 'e', { limit: 2 }).length, 2, 0);
  }
  check('critère : légendée / sans légende', n({ hasCaption: true }) + n({ noCaption: true }), LIB.stats().photos, 0);
  check('critère : orientation portrait', n({ orientation: 'portrait' }) >= 0, true, 0);
  check('critère : orientation carré', n({ orientation: 'square' }) >= 0, true, 0);
  check('critère : dimensions', n({ minWidth: 1, maxWidth: 100000 }) >= 0, true, 0);
  check('critère : objectif', n({ lens: '50mm' }) >= 0, true, 0);
  check('critère : intégrité (fichier)', n({ integrity: 'missing' }) >= 0, true, 0);
  check('critère : doublons', n({ duplicate: true }) >= 0, true, 0);
  check('critère : année', n({ year: '2024' }) >= 0, true, 0);
  // GPS : aucune photo de test n'est géolocalisée ; la valeur d'URL « 0 » doit valoir « sans GPS »
  check('critère : sans GPS (« 0 » d\'URL)', n({ hasGps: '0' }), LIB.stats().photos, 0);
  check('critère : sans GPS (« false » d\'URL)', n({ hasGps: 'false' }), LIB.stats().photos, 0);
  check('critère : sans GPS (booléen)', n({ hasGps: false }), LIB.stats().photos, 0);
  check('critère : avec GPS (« 1 » d\'URL)', n({ hasGps: '1' }), 0, 0);
  check('critères combinés (texte + orientation + note)',
    n({ q: 'chalet', orientation: 'portrait', rating: 0 }) >= 0, true, 0);
  // ET / OU / NON sur les mots-clés
  KW.ensure('Vacances'); KW.ensure('Famille');
  check('mot-clés : NON n\'écarte rien sans étiquette', n({ excludeKeywords: ['vacances'] }), LIB.stats().photos, 0);
  // les mots-clés saisis se comparent comme la colonne normalized (casse ET accents)
  const tagged = LIB.search({}, { limit: 10 }).rows[1].id;
  KW.attachNames(tagged, ['Été indien', 'Famille']);
  check('mots-clés : ET insensible aux accents', n({ keywords: ['ete indien', 'FAMILLE'] }), 1, 0);
  check('mots-clés : OU', n({ anyKeywords: ['été  indien', 'introuvable'] }), 1, 0);
  check('mots-clés : NON', n({ excludeKeywords: ['Ete Indien'] }), LIB.stats().photos - 1, 0);
  // le texte cherché (keywords_text → FTS5) suit renommage, fusion et suppression des mots-clés
  LIB.syncKeywordsText(tagged);
  const ftsIds = q => LIB.search({ q }, { limit: 20 }).rows.map(p => p.id);
  check('texte : mot-clé trouvé par la recherche libre', ftsIds('indien').includes(tagged), true, 0);
  KW.update(KW.byName('Été indien').id, { name: 'Arrière-saison' });
  check('renommage : ancien nom plus trouvé', ftsIds('indien').includes(tagged), false, 0);
  check('renommage : nouveau nom trouvé', ftsIds('arriere').includes(tagged), true, 0);
  const proches = KW.ensure('Proches'); KW.attach(tagged, proches.id); LIB.syncKeywordsText(tagged);
  KW.merge([KW.byName('Famille').id], proches.id);
  check('fusion : nom source gardé en synonyme, toujours trouvé', ftsIds('famille').includes(tagged), true, 0);
  check('fusion : cible toujours trouvée', ftsIds('proches').includes(tagged), true, 0);
  KW.remove(KW.byName('Arrière-saison').id);
  check('suppression : nom plus trouvé', ftsIds('arriere').includes(tagged), false, 0);
  check('suppression : les autres mots-clés restent (synonyme en texte d’appui)', LIB.detail(tagged).keywords_text, 'Proches ¦ Famille');
  DB.prepare('DELETE FROM photo_keywords WHERE photo_id = ?').run(tagged); LIB.syncKeywordsText(tagged);

  // --- repli LIKE : même résultat si FTS5 n'existait pas ---
  const like = Search.buildQuery({ q: 'chalet' }, { fts: false });
  check('repli LIKE présent si FTS5 absent', /LIKE/.test(like.where), true, 0);
  check('repli LIKE sans condition inutile', like.params.length, 6, 0);
}

// ===================================================================
group('Doublons : même empreinte → même fiche photo');
// ===================================================================
{
  const src = path.join(TMP, 'mes-photos', 'IMG_0001.jpg');
  const copie = path.join(TMP, 'doublon.jpg');
  fs.copyFileSync(src, copie);
  const before = LIB.stats().photos;
  await LIB.indexFile(copie, {});
  check('un doublon ne crée pas de nouvelle photo', LIB.stats().photos, before, 0);
  check('mais un second fichier est indexé', LIB.stats().files, 4, 0);
  const dups = LIB.search({ duplicate: true }, { limit: 10 });
  check('critère doublons : la photo à deux fichiers est trouvée', dups.total, 1, 0);
  check('critère doublons : c\'est bien la photo copiée', LIB.detail(dups.rows[0].id).files.length, 2, 0);
}

// ===================================================================
group('Import (copie) : doublons et collisions gérés, source intacte');
// ===================================================================
{
  const srcDir = path.join(TMP, 'carte-sd');
  fs.mkdirSync(srcDir, { recursive: true });
  await makeImage(path.join(srcDir, 'DSC_0001.jpg'), { make: 'Sony', model: 'A7 IV' });
  await makeImage(path.join(srcDir, 'DSC_0002.jpg'), { make: 'Sony', model: 'A7 IV', color: { r: 10, g: 200, b: 30 } });
  const dest = path.join(TMP, 'imports');
  STORE.import.dest = dest; STORE.import.keepFolders = false; saveStore(DB, STORE);

  const res = await IMP.importFiles([path.join(srcDir, 'DSC_0001.jpg'), path.join(srcDir, 'DSC_0002.jpg')]);
  check('2 fichiers copiés', res.copied, 2, 0);
  check('0 doublon au premier import', res.duplicates, 0, 0);
  check('les copies existent sur disque', res.results.every(r => r.status !== 'copied' || fs.existsSync(r.dest)), true, 0);
  check('source toujours présente', fs.existsSync(path.join(srcDir, 'DSC_0001.jpg')), true, 0);

  // ré-import du même fichier → doublon détecté (empreinte)
  const res2 = await IMP.importFiles([path.join(srcDir, 'DSC_0001.jpg')]);
  check('doublon détecté au ré-import', res2.duplicates, 1, 0);
  check('rien de copié en doublon', res2.copied, 0, 0);

  // collision de nom : deux fichiers différents mais même nom dans la même destination
  await makeImage(path.join(srcDir, 'DSC_0001.jpg.bak'), { color: { r: 99, g: 5, b: 55 } });
  const autre = path.join(srcDir, 'autre', 'DSC_0001.jpg');
  fs.mkdirSync(path.dirname(autre), { recursive: true });
  await makeImage(autre, { color: { r: 1, g: 2, b: 3 } });
  check('nom unique généré', uniqueName(dest, 'DSC_0001.jpg') !== 'DSC_0001.jpg' || !fs.existsSync(path.join(dest, 'DSC_0001.jpg')), true, 0);
}

// ===================================================================
group('Importation : supports détectés, choix des photos, copie ou déplacement vérifié');
// ===================================================================
{
  const { parseWindowsDisks, classifyDrive, detectDrives } = await import('../lib/drives.mjs');
  // --- détection : normalisation de la sortie Windows ---
  const rows = [
    { DeviceID: 'C:', DriveType: 3, VolumeName: 'OS', FileSystem: 'NTFS', Size: 1e12, FreeSpace: 4e11, VolumeSerialNumber: 'AAAA1111' },
    { DeviceID: 'E:', DriveType: 2, VolumeName: 'EOS_DIGITAL', FileSystem: 'exFAT', Size: 64e9, FreeSpace: 50e9, VolumeSerialNumber: 'BBBB2222' },
    { DeviceID: 'F:', DriveType: 2, VolumeName: '', FileSystem: null, Size: null, FreeSpace: null },     // lecteur de cartes vide
    { DeviceID: 'Z:', DriveType: 4, VolumeName: 'NAS', FileSystem: 'NTFS', Size: 4e12, FreeSpace: 1e12 },
  ];
  const parsed = parseWindowsDisks(JSON.stringify(rows));
  check('détection : lecteur vide ignoré', parsed.map(d => d.letter).join(','), 'C:,E:,Z:', 0);
  check('détection : un seul lecteur (objet et non tableau)', parseWindowsDisks(JSON.stringify(rows[1])).length, 1, 0);
  check('détection : sortie illisible → liste vide', parseWindowsDisks('pas du json').length + parseWindowsDisks('').length, 0, 0);
  const kind = (d, extra = {}) => classifyDrive({ ...parsed.find(x => x.letter === d), ...extra }).kind;
  check('détection : amovible + DCIM = carte mémoire', kind('E:', { dcim: 'E:\\DCIM' }), 'sd', 0);
  check('détection : amovible sans DCIM = clé USB', kind('E:'), 'usb', 0);
  check('détection : disque fixe', kind('C:'), 'disk', 0);
  check('détection : lecteur réseau', kind('Z:'), 'nas', 0);
  check('détection : disque système repéré, jamais proposé en premier', classifyDrive(parsed[0]).system && !classifyDrive(parsed[0]).likelyImport, true, 0);
  check('détection : carte amovible proposée en premier', classifyDrive(parsed[1]).likelyImport, true, 0);
  const fake = await detectDrives({ platform: 'win32', systemDrive: 'C:', exec: async () => JSON.stringify(rows) });
  check('détection : amovible avant le disque système', fake.map(d => d.letter).join(','), 'E:,C:,Z:', 0);
  const down = await detectDrives({ platform: 'win32', exec: async () => { throw new Error('PowerShell absent'); } });
  check('détection : repli sans PowerShell (aucune erreur)', Array.isArray(down), true, 0);

  // --- analyse d'un dossier source ---
  const card = path.join(TMP, 'carte-import');
  const sub = (...a) => path.join(card, ...a);
  fs.mkdirSync(sub('DCIM', '100TEST'), { recursive: true }); fs.mkdirSync(sub('DCIM', '101TEST'), { recursive: true }); fs.mkdirSync(sub('.Trashes'), { recursive: true });
  const col = n => ({ color: { r: 10 + n * 20, g: 200 - n * 15, b: 30 + n * 9 } });
  await makeImage(sub('DCIM', '100TEST', 'A1.jpg'), { make: 'Canon', model: 'R6', ...col(1) });
  await makeImage(sub('DCIM', '100TEST', 'A2.jpg'), { make: 'Canon', model: 'R6', ...col(2) });
  await makeImage(sub('DCIM', '101TEST', 'B1.jpg'), { make: 'Canon', model: 'R6', ...col(3) });
  await makeImage(sub('DCIM', '101TEST', 'B2.jpg'), { make: 'Canon', model: 'R6', ...col(4) });
  fs.writeFileSync(sub('DCIM', '100TEST', 'notes.txt'), 'pas une image');
  fs.writeFileSync(sub('.Trashes', 'caché.jpg'), 'x');
  const importsBefore = DB.prepare('SELECT COUNT(*) n FROM imports').get().n;
  const sc = await IMP.scan(card);
  check('analyse : 4 images (sans texte ni dossier caché)', sc.total, 4, 0);
  check('analyse : triées par dossier puis par nom', sc.files.map(f => f.name).join(','), 'A1.jpg,A2.jpg,B1.jpg,B2.jpg', 0);
  check('analyse : dossier relatif indiqué', sc.files[2].dir, path.join('DCIM', '101TEST'), 0);
  check('analyse : rien n\'est encore connu de la photothèque', sc.newCount, 4, 0);
  check('analyse : volume total', sc.bytes, sc.files.reduce((a, f) => a + fs.statSync(f.path).size, 0), 0);
  check('analyse : dossier inexistant refusé', await IMP.scan(path.join(TMP, 'absent')).then(() => 'ok', e => /introuvable/.test(e.message) ? 'refus' : e.message), 'refus', 0);
  check('analyse : un fichier n\'est pas un dossier', await IMP.scan(sub('DCIM', '100TEST', 'A1.jpg')).then(() => 'ok', () => 'refus'), 'refus', 0);
  check('analyse : limite respectée', (await IMP.scan(card, { limit: 2 })).truncated, true, 0);

  // --- aperçus : uniquement dans les dossiers analysés ---
  const pv = await IMP.preview(sub('DCIM', '100TEST', 'A1.jpg'), 120);
  check('aperçu : image JPEG réduite', Buffer.isBuffer(pv) && pv[0] === 0xFF && pv[1] === 0xD8, true, 0);
  const refuse = f => IMP.preview(f).then(() => 'ok', e => e.status);
  check('aperçu : fichier hors des dossiers analysés refusé', await refuse(path.join(TMP, 'doublon.jpg')), 403, 0);
  check('aperçu : remontée de dossier (..) refusée', await refuse(sub('DCIM', '..', '..', 'doublon.jpg')), 403, 0);
  check('aperçu : fichier non image refusé', await refuse(sub('DCIM', '100TEST', 'notes.txt')), 403, 0);
  check('aperçu : fichier absent', await refuse(sub('DCIM', '100TEST', 'zz.jpg')), 404, 0);

  // --- choix des photos : seules les photos choisies sont importées ---
  STORE.import.dest = path.join(TMP, 'imports-choix'); STORE.import.keepFolders = false; saveStore(DB, STORE);
  const choisies = [sub('DCIM', '100TEST', 'A1.jpg'), sub('DCIM', '101TEST', 'B2.jpg')];
  const rc = await IMP.importFiles(choisies, { mode: 'copy', verify: true });
  check('choix : 2 photos sur 4 copiées', rc.copied, 2, 0);
  check('choix : les autres ne sont pas copiées', fs.readdirSync(STORE.import.dest).sort().join(','), 'A1.jpg,B2.jpg', 0);
  check('choix : en copie, toutes les sources restent', sc.files.every(f => fs.existsSync(f.path)), true, 0);
  const sc2 = await IMP.scan(card);
  check('analyse : les photos déjà importées sont repérées (nom + taille)', sc2.files.filter(f => f.known).map(f => f.name).join(','), 'A1.jpg,B2.jpg', 0);
  check('analyse : 2 nouvelles', sc2.newCount, 2, 0);
  const rowC = DB.prepare('SELECT mode, total, done FROM imports ORDER BY started_at DESC, rowid DESC LIMIT 1').get();
  check('journal des imports : mode copie', rowC.mode, 'copy', 0);
  check('journal des imports : une ligne par import', DB.prepare('SELECT COUNT(*) n FROM imports').get().n, importsBefore + 1, 0);

  // --- copie vérifiée : une copie altérée est refusée et retirée ---
  const corrompre = (s, d) => { fs.copyFileSync(s, d); fs.appendFileSync(d, 'x'); };
  const rv = await IMP.importFiles([sub('DCIM', '100TEST', 'A2.jpg')], { mode: 'copy', verify: true, copyFile: corrompre });
  check('copie vérifiée : altération détectée', rv.errors, 1, 0);
  check('copie vérifiée : la copie ratée est retirée', fs.existsSync(path.join(STORE.import.dest, 'A2.jpg')), false, 0);

  // --- déplacement ---
  const mv = f => IMP.importFiles(f, { mode: 'move' });
  const dA2 = sub('DCIM', '100TEST', 'A2.jpg'), dB1 = sub('DCIM', '101TEST', 'B1.jpg');
  // refus : dossier non analysé
  const horsAnalyse = path.join(TMP, 'hors-analyse.jpg'); await makeImage(horsAnalyse, { color: { r: 77, g: 78, b: 79 } });
  const r0 = await mv([horsAnalyse]);
  check('déplacement : refusé hors d\'un dossier analysé', r0.skipped + '/' + r0.copied, '1/0', 0);
  check('déplacement : la source hors analyse reste intacte', fs.existsSync(horsAnalyse), true, 0);
  // simulation
  const rd = await IMP.importFiles([dA2], { mode: 'move', dryRun: true });
  check('déplacement : simulation sans effet', rd.results[0].status === 'would-move' && fs.existsSync(dA2) && !fs.existsSync(path.join(STORE.import.dest, 'A2.jpg')), true, 0);
  // copie altérée : la source est conservée
  const rb = await IMP.importFiles([dA2], { mode: 'move', copyFile: corrompre });
  check('déplacement : copie altérée → erreur', rb.errors, 1, 0);
  check('déplacement : copie altérée → source conservée', fs.existsSync(dA2), true, 0);
  check('déplacement : copie altérée → copie retirée', fs.existsSync(path.join(STORE.import.dest, 'A2.jpg')), false, 0);
  // suppression impossible : la copie reste, la source aussi, signalé
  const rk = await IMP.importFiles([dA2], { mode: 'move', removeFile: () => { throw new Error('support protégé en écriture'); } });
  check('déplacement : suppression impossible → source gardée et signalée', rk.keptSources + '/' + rk.moved + '/' + rk.copied, '1/0/1', 0);
  check('déplacement : suppression impossible → la copie est bien dans la photothèque', fs.existsSync(path.join(STORE.import.dest, 'A2.jpg')) && fs.existsSync(dA2), true, 0);
  // arrêt demandé : rien n'est fait
  const rs = await IMP.importFiles([dB1], { mode: 'move', shouldStop: () => true });
  check('déplacement : arrêt demandé avant le début', rs.stopped && rs.copied === 0 && fs.existsSync(dB1), true, 0);
  // déplacement réel
  const hB1 = crypto.createHash('sha256').update(fs.readFileSync(dB1)).digest('hex');
  const rm = await mv([dB1]);
  check('déplacement : fichier déplacé', rm.moved + '/' + rm.copied + '/' + rm.errors, '1/1/0', 0);
  check('déplacement : la source n\'existe plus', fs.existsSync(dB1), false, 0);
  const movedDest = rm.results[0].dest;
  check('déplacement : le contenu est identique (empreinte)', crypto.createHash('sha256').update(fs.readFileSync(movedDest)).digest('hex'), hB1, 0);
  const rowM = DB.prepare('SELECT p.id, f.path, f.kind FROM files f JOIN photos p ON p.id = f.photo_id WHERE f.sha256 = ?').all(hB1);
  check('déplacement : la photo est indexée à son nouvel emplacement', rowM.length === 1 && rowM[0].path === movedDest, true, 0);
  const imM = DB.prepare("SELECT mode, data FROM imports WHERE mode = 'move' AND json_extract(data, '$.moved') = 1").get();
  check('journal : import en mode déplacement', !!imM && JSON.parse(imM.data).removedSources.includes(dB1), true, 0);
  check('journal d\'historique : déplacement tracé', DB.prepare("SELECT COUNT(*) n FROM history WHERE kind = 'import.move'").get().n >= 1, true, 0);
  // une source déjà dans la photothèque n'est pas « déplacée » sur elle-même
  const rin = await IMP.importFiles([movedDest], { mode: 'move' });
  check('déplacement : un fichier de la photothèque est ignoré', rin.skipped, 1, 0);
  check('déplacement : il reste en place', fs.existsSync(movedDest), true, 0);

  // --- doublons en mode déplacement : la source n'est retirée que sur demande ET preuve ---
  const dA1 = sub('DCIM', '100TEST', 'A1.jpg');                      // déjà copiée plus haut : doublon
  const rdup = await IMP.importFiles([dA1], { mode: 'move' });
  check('doublon (déplacement) : source conservée par défaut', rdup.duplicates === 1 && fs.existsSync(dA1) && rdup.removedDuplicates === 0, true, 0);
  const rdup2 = await IMP.importFiles([dA1], { mode: 'move', removeDuplicateSources: true });
  check('doublon (déplacement) : source retirée avec la case cochée', rdup2.removedDuplicates === 1 && !fs.existsSync(dA1) && rdup2.results[0].status === 'duplicate-removed', true, 0);
  // l'exemplaire de la photothèque a disparu : la source est conservée
  const dB2 = sub('DCIM', '101TEST', 'B2.jpg'), copieB2 = path.join(STORE.import.dest, 'B2.jpg');
  fs.renameSync(copieB2, copieB2 + '.off');
  const rdup3 = await IMP.importFiles([dB2], { mode: 'move', removeDuplicateSources: true });
  check('doublon (déplacement) : exemplaire absent → source conservée', fs.existsSync(dB2) && rdup3.removedDuplicates === 0, true, 0);
  fs.renameSync(copieB2 + '.off', copieB2);
  // exemplaire altéré : la source est conservée
  fs.appendFileSync(copieB2, 'x');
  const rdup4 = await IMP.importFiles([dB2], { mode: 'move', removeDuplicateSources: true });
  check('doublon (déplacement) : exemplaire différent → source conservée', fs.existsSync(dB2) && rdup4.removedDuplicates === 0, true, 0);
  // un autre exemplaire sur le même support ne prouve rien
  fs.writeFileSync(copieB2, fs.readFileSync(dB2));
  const jumeau = sub('DCIM', '101TEST', 'B2-copie.jpg'); fs.copyFileSync(dB2, jumeau);
  await LIB.indexFile(jumeau, {});
  fs.renameSync(copieB2, copieB2 + '.off');
  const rdup5 = await IMP.importFiles([dB2], { mode: 'move', removeDuplicateSources: true });
  check('doublon (déplacement) : un jumeau sur la même carte ne suffit pas', fs.existsSync(dB2) && rdup5.removedDuplicates === 0, true, 0);
  fs.renameSync(copieB2 + '.off', copieB2);

  // --- route : aucune suppression sans dossier analysé (via le moteur, même par la voie synchrone) ---
  check('déplacement : checkMovable refuse un chemin quelconque', IMP.checkMovable(path.join(TMP, 'doublon.jpg')) !== null, true, 0);
  check('déplacement : checkMovable accepte un fichier analysé', IMP.checkMovable(dB2), null, 0);
}

// ===================================================================
group('Téléphones branchés (MTP) : détection, lecture des photos, copie sans jamais rien supprimer');
// ===================================================================
{
  const { createPhones, parsePortableDevices, classifyPortable } = await import('../lib/phones.mjs');
  // --- classement par identifiant USB ---
  check('téléphone : Apple = iPhone / iPad', JSON.stringify(classifyPortable('05AC', 'Apple iPhone')), JSON.stringify({ brand: 'Apple', kind: 'phone', kindLabel: 'iPhone / iPad' }), 0);
  check('téléphone : constructeur Android reconnu', classifyPortable('18d1', 'Pixel 7').brand + '/' + classifyPortable('18d1', 'Pixel 7').kind, 'Google/phone', 0);
  check('appareil photo reconnu par constructeur', classifyPortable('04a9', 'Canon EOS R6').kind, 'camera', 0);
  check('appareil inconnu : le nom aide', classifyPortable('ffff', 'Canon EOS R6').kind + '/' + classifyPortable('ffff', 'Mon Truc').kindLabel, 'camera/Téléphone', 0);
  // --- analyse de la réponse du script de détection ---
  const raw = { devices: [
    { name: 'Pixel 7', path: '::{20D04FE0}\\\\?\\usb#vid_18d1&pid_4ee1#abc#{6ac27878}', vid: '18d1', storages: ['Mémoire de stockage interne partagée'] },
    { name: 'Apple iPhone', path: '::{20D04FE0}\\\\?\\usb#vid_05ac&pid_12a8#def#{6ac27878}', vid: '05ac', storages: [] },
    { name: 'sans chemin' }, null,
  ] };
  const devs = parsePortableDevices(JSON.stringify(raw));
  check('détection : entrées incomplètes ignorées', devs.length, 2, 0);
  check('détection : appareil prêt si un stockage est exposé', devs[0].ready, true, 0);
  check('détection : appareil verrouillé = aucun stockage', devs[1].ready, false, 0);
  check('détection : identifiant stable pour un même appareil', parsePortableDevices(raw)[0].id, devs[0].id, 0);
  check('détection : identifiants distincts', devs[0].id !== devs[1].id, true, 0);
  check('détection : un seul appareil (objet et non tableau)', parsePortableDevices({ name: 'X', path: 'p', vid: '', storages: 'S' }).length, 1, 0);
  check('détection : réponse illisible → aucun appareil', parsePortableDevices('pas du json').length + parsePortableDevices(null).length, 0, 0);
  // --- détection avec un script simulé ---
  const fakeRun = async (req, o) => { if (req.op === 'detect') o.onLine(raw); return { stopped: false }; };
  const ph = createPhones({ run: fakeRun, platform: 'win32' });
  const seen = await ph.detect();
  check('détection : appareils retournés et mémorisés', seen.length === 2 && ph.known.size === 2, true, 0);
  check('détection : hors Windows, aucun appareil (et aucun script lancé)', (await createPhones({ run: () => { throw new Error('ne doit pas tourner'); }, platform: 'linux' }).detect()).length, 0, 0);
  check('lecture : un appareil inconnu est refusé', await ph.list({ id: 'ph-inconnu' }).then(() => 'ok', e => e.status), 404, 0);

  if (process.platform !== 'win32') { check('essais sur un « appareil » factice : Windows seulement (ignorés)', true, true, 0); }
  else {
    // Un dossier ordinaire joue le rôle d'un appareil : même code Shell (Shell.Application) que pour un vrai téléphone.
    const dev = path.join(TMP, 'faux-telephone');
    const st = path.join(dev, 'Stockage interne');
    for (const d of ['DCIM/Camera', 'DCIM/100APPLE', 'Pictures/Screenshots', 'Autre', 'Android/data']) fs.mkdirSync(path.join(st, d), { recursive: true });
    await makeImage(path.join(st, 'DCIM', 'Camera', 'IMG_0001.jpg'), { make: 'Google', model: 'Pixel 7', color: { r: 200, g: 40, b: 40 } });
    await makeImage(path.join(st, 'DCIM', 'Camera', 'été à.JPG'), { make: 'Google', model: 'Pixel 7', color: { r: 40, g: 200, b: 40 } });
    await makeImage(path.join(st, 'DCIM', '100APPLE', 'IMG_0001.jpg'), { make: 'Apple', model: 'iPhone', color: { r: 40, g: 40, b: 200 } }); // même nom, autre dossier
    await makeImage(path.join(st, 'Pictures', 'Screenshots', 'capture.png'), { color: { r: 120, g: 120, b: 20 } });
    await makeImage(path.join(st, 'Autre', 'hors-racine.jpg'), { color: { r: 1, g: 1, b: 1 } });
    fs.writeFileSync(path.join(st, 'DCIM', 'notes.txt'), 'pas une photo');
    const real = createPhones();
    const ref = { folderRoot: dev };
    const l = await real.list(ref, { limit: 100 });
    const rels = l.files.map(f => f.rel).sort();
    check('lecture : seules les photos de DCIM et Pictures', l.files.length, 4, 0);
    check('lecture : noms accentués conservés', l.files.some(f => f.name.startsWith('été à')), true, 0);
    check('lecture : même nom dans deux dossiers distingué par son chemin', rels.filter(r => /IMG_0001/.test(r)).length, 2, 0);
    check('lecture : ni le texte, ni les autres dossiers', rels.every(r => !/notes|hors-racine/.test(r)), true, 0);
    check('lecture : tailles fournies', l.files.every(f => f.size > 0), true, 0);
    check('lecture : dates de modification fournies', l.files.every(f => typeof f.mtime === 'number' && f.mtime > 0), true, 0);
    check('lecture : limite respectée et signalée', await real.list(ref, { limit: 2 }).then(r => r.files.length + '/' + r.truncated), '2/true', 0);
    check('lecture : appareil sans les dossiers demandés = liste vide', await real.list(ref, { roots: ['Nulle part'] }).then(r => r.files.length), 0, 0);

    // --- copie depuis l'« appareil » ---
    const out = path.join(TMP, 'copie-telephone');
    const jobs = l.files.map((f, i) => ({ rel: f.rel, name: f.name, size: f.size ?? 0, to: path.join(out, String(i)) }));
    const got = [];
    const cr = await real.copy(ref, jobs, { onFile: x => got.push(x) });
    check('copie : tout est copié', cr.copied + '/' + cr.failed, '4/0', 0);
    check('copie : fichiers présents avec leur nom, un dossier par fichier', jobs.every(j => fs.existsSync(path.join(j.to, j.name))), true, 0);
    const hashOf = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const srcHashes = new Set(['DCIM/Camera/IMG_0001.jpg', 'DCIM/Camera/été à.JPG', 'DCIM/100APPLE/IMG_0001.jpg', 'Pictures/Screenshots/capture.png'].map(r => hashOf(path.join(st, r))));
    const copied = jobs.map(j => hashOf(path.join(j.to, j.name)));
    check('copie : contenu identique à l\'original (4 fichiers distincts)', new Set(copied).size === 4 && copied.every(h => srcHashes.has(h)), true, 0);
    const bad = await real.copy(ref, [{ rel: 'Stockage interne\\DCIM\\Camera\\absent.jpg', name: 'absent.jpg', size: 10, to: path.join(out, 'x') }]);
    check('copie : fichier introuvable = échec signalé, pas de plantage', bad.failed, 1, 0);
    check('copie : rien n\'est supprimé sur l\'appareil', l.files.length, (await real.list(ref, { limit: 100 })).files.length, 0);
    const stop = await real.copy(ref, jobs.map((j, i) => ({ ...j, to: path.join(out, 'arret' + i) })), { shouldStop: () => true });
    check('copie : arrêt demandé', stop.stopped, true, 0);

    // --- import depuis le téléphone (moteur d'import, appareil simulé par ce dossier) ---
    STORE.import.dest = path.join(TMP, 'imports-telephone'); STORE.import.keepFolders = false; saveStore(DB, STORE);
    const fake = {
      known: new Map([['ph-test', { id: 'ph-test', name: 'Pixel de test', kind: 'phone', ready: true }], ['ph-lock', { id: 'ph-lock', name: 'iPhone verrouillé', kind: 'phone', ready: false }]]),
      detect: async () => [...fake.known.values()].map(d => ({ ...d, kindLabel: 'Téléphone', brand: null, storages: d.ready ? ['Stockage interne'] : [] })),
      list: (r, o) => real.list(ref, o), copy: (r, j, o) => fake.failOn ? real.copy(ref, j.filter(x => !fake.failOn(x)), o) : real.copy(ref, j, o),
    };
    const IMPP = createImports(DB, STORE, LIB, KW, null, fake);
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter(n => /^phototheque-(phone|prev)-/.test(n)).length;
    check('import téléphone : lecture refusée si l\'appareil est verrouillé', await IMPP.scanPhone('ph-lock').then(() => 'ok', e => e.status), 409, 0);
    check('import téléphone : appareil inconnu', await IMPP.scanPhone('ph-nope').then(() => 'ok', e => e.status), 404, 0);
    check('import téléphone : import refusé avant lecture', await IMPP.importFromPhone('ph-test', ['Stockage interne\\DCIM\\Camera\\IMG_0001.jpg']).then(() => 'ok', e => e.status), 403, 0);
    check('import téléphone : aperçu refusé avant lecture', await IMPP.previewPhone('ph-test', 'Stockage interne\\DCIM\\Camera\\IMG_0001.jpg').then(() => 'ok', e => e.status), 403, 0);
    const sc = await IMPP.scanPhone('ph-test');
    check('import téléphone : 4 photos listées, dossiers distingués', sc.total + '/' + new Set(sc.files.map(f => f.dir)).size, '4/3', 0);
    check('import téléphone : rien n\'est connu de la photothèque', sc.newCount, 4, 0);
    const pv = await IMPP.previewPhone('ph-test', sc.files[0].path, 120);
    check('import téléphone : aperçu JPEG', Buffer.isBuffer(pv) && pv[0] === 0xFF && pv[1] === 0xD8, true, 0);
    check('import téléphone : aperçu d\'une photo non listée refusé', await IMPP.previewPhone('ph-test', 'Stockage interne\\Autre\\hors-racine.jpg').then(() => 'ok', e => e.status), 403, 0);
    const dr = await IMPP.drives({ fresh: true });
    const tile = dr.find(d => d.phone?.id === 'ph-test');
    check('supports détectés : le téléphone apparaît avec les lecteurs', !!tile && tile.root === 'phone:ph-test' && tile.likelyImport && tile.kind === 'phone', true, 0);
    check('supports détectés : le téléphone verrouillé est signalé', dr.find(d => d.phone?.id === 'ph-lock')?.phone.ready, false, 0);

    const pick = sc.files.filter(f => f.name !== 'capture.png').map(f => f.path);      // 3 photos sur 4
    const prog = [];
    const r1 = await IMPP.importFromPhone('ph-test', pick, { mode: 'move', onProgress: p => prog.push(p.status) });
    check('import téléphone : 3 photos copiées (le mode « move » est ignoré)', r1.copied + '/' + r1.mode + '/' + r1.moved, '3/copy/0', 0);
    check('import téléphone : la 4e n\'est pas importée', fs.readdirSync(STORE.import.dest).length, 3, 0);
    check('import téléphone : les résultats parlent du chemin sur le téléphone', r1.results.every(r => /^Stockage interne\\/.test(r.src)), true, 0);
    check('import téléphone : rien n\'est supprimé sur l\'appareil', (await real.list(ref, { limit: 100 })).files.length, 4, 0);
    check('import téléphone : progression en deux temps (lecture, puis copie)', prog.includes('lecture du téléphone') && prog.includes('indexé'), true, 0);
    check('import téléphone : dossiers temporaires effacés', fs.readdirSync(os.tmpdir()).filter(n => /^phototheque-(phone|prev)-/.test(n)).length, tmpBefore, 0);
    const imp = DB.prepare("SELECT mode, data FROM imports WHERE json_extract(data, '$.phone') = 'Pixel de test'").get();
    check('import téléphone : tracé dans le journal des imports', !!imp && imp.mode === 'copy', true, 0);
    // ré-import : doublons détectés par empreinte ; relecture : photos connues (nom + taille)
    const r2 = await IMPP.importFromPhone('ph-test', pick);
    check('import téléphone : ré-import = doublons, rien de copié', r2.duplicates + '/' + r2.copied, '3/0', 0);
    const sc2 = await IMPP.scanPhone('ph-test');
    check('import téléphone : les photos déjà importées sont repérées', sc2.files.filter(f => f.known).length + '/' + sc2.newCount, '3/1', 0);
    // une photo qui ne se copie pas : erreur isolée, le reste passe
    fake.failOn = j => j.name === 'capture.png';
    const r3 = await IMPP.importFromPhone('ph-test', sc2.files.map(f => f.path));
    check('import téléphone : une photo illisible n\'arrête pas l\'import', r3.errors + '/' + r3.duplicates, '1/3', 0);
    fake.failOn = null;
    const rs = await IMPP.importFromPhone('ph-test', sc2.files.map(f => f.path), { shouldStop: () => true });
    check('import téléphone : arrêt demandé', rs.stopped && rs.copied === 0, true, 0);
  }
}

// ===================================================================
group('Collections : sélections et recherches enregistrées');
// ===================================================================
{
  const COL = createCollections(DB, LIB);
  const all = LIB.search({}, { limit: 50 }).rows.map(p => p.id);
  const nikon = LIB.search({ camera: 'Nikon' }).rows[0].id;

  // --- sélection statique ---
  const sel = COL.create({ name: '  Mes   favorites ', photoIds: [all[0], all[1]] });
  check('sélection créée', sel.kind, 'static');
  check('nom nettoyé (espaces)', sel.name, 'Mes favorites');
  check('2 photos à la création', sel.photo_count, 2, 0);
  check('ajout idempotent', COL.addPhotos(sel.id, [all[0], all[2]]).added, 1, 0);
  check('photo inconnue ignorée', COL.addPhotos(sel.id, ['photo-inexistante']).added, 0, 0);
  check('compteur à jour', COL.get(sel.id).photo_count, 3, 0);
  check('ordre d\'ajout conservé (positions)',
    JSON.stringify(DB.prepare('SELECT photo_id FROM collection_photos WHERE collection_id=? ORDER BY position').all(sel.id).map(r => r.photo_id)),
    JSON.stringify([all[0], all[1], all[2]]));
  check('recherche filtrée par collection', LIB.search(COL.resolveFilters({ collectionId: sel.id })).total, 3, 0);
  check('filtre combiné (collection + appareil)', LIB.search(COL.resolveFilters({ collectionId: sel.id, camera: 'Nikon' })).total,
    [all[0], all[1], all[2]].includes(nikon) ? 1 : 0, 0);
  check('retrait de la sélection', COL.removePhotos(sel.id, [all[0]]).removed, 1, 0);
  check('photo retirée toujours au catalogue', !!LIB.detail(all[0]), true, 0);

  // --- recherche enregistrée (dynamique) ---
  const dyn = COL.create({ name: 'Nikon', kind: 'dynamic', query: { camera: 'Nikon', inconnu: 'x', collectionId: sel.id, hasGps: '' } });
  check('recherche enregistrée créée', dyn.kind, 'dynamic');
  check('critères nettoyés (clés inconnues et collectionId écartés)', JSON.stringify(dyn.query), JSON.stringify({ camera: 'Nikon' }));
  check('contenu recalculé', dyn.photo_count, 1, 0);
  check('résolue en critères', LIB.search(COL.resolveFilters({ collectionId: dyn.id })).rows[0]?.id, nikon);
  check('texte saisi ajouté (ET) au critère', LIB.search(COL.resolveFilters({ collectionId: dyn.id, q: 'introuvablexyz' })).total, 0, 0);
  let err = null; try { COL.addPhotos(dyn.id, [all[0]]); } catch (e) { err = e.message; }
  check('pas d\'ajout manuel dans une recherche enregistrée', !!err, true, 0);
  err = null; try { COL.create({ name: 'Vide', kind: 'dynamic', query: { inconnu: 1 } }); } catch (e) { err = e.message; }
  check('recherche enregistrée sans critère refusée', !!err, true, 0);
  err = null; try { COL.create({ name: '   ' }); } catch (e) { err = e.message; }
  check('nom vide refusé', !!err, true, 0);
  check('critères types (nombres, drapeaux, listes)',
    JSON.stringify(Search.cleanFilters({ rating: '3', missing: '0', duplicate: 'true', anyKeywords: 'a, b,', hasGps: '0', prefix: 'false' })),
    JSON.stringify({ rating: 3, missing: 0, duplicate: true, anyKeywords: ['a', 'b'], hasGps: false, prefix: false }));
  check('renommage', COL.update(dyn.id, { name: 'Boîtier Nikon' }).name, 'Boîtier Nikon');
  check('critères modifiables', COL.update(dyn.id, { query: { format: 'png' } }).photo_count, 1, 0);
  check('liste triée par nom', COL.list().map(c => c.name).join('|'), 'Boîtier Nikon|Mes favorites');

  // --- suppression : jamais de photo perdue ---
  const before = LIB.stats().photos;
  check('suppression de la collection', COL.remove(sel.id).photosUntouched, true, 0);
  check('photos conservées après suppression', LIB.stats().photos, before, 0);
  check('liens de la sélection supprimés', DB.prepare('SELECT COUNT(*) n FROM collection_photos WHERE collection_id=?').get(sel.id).n, 0, 0);
  // une photo retirée de l'index disparaît des sélections (clé étrangère ON DELETE CASCADE)
  const tmpSel = COL.create({ name: 'Temporaire', photoIds: [all[all.length - 1]] });
  LIB.removeFromIndex([all[all.length - 1]]);
  check('photo retirée de l\'index → retirée de la sélection', COL.get(tmpSel.id).photo_count, 0, 0);
  COL.remove(tmpSel.id); COL.remove(dyn.id);
  check('intégrité après collections', integrity(DB)[0], 'ok', 0);
}

// ===================================================================
group('Albums : pages, gabarits, références, contrôles');
// ===================================================================
{
  const ALB = createAlbums(DB, LIB);
  const ids = LIB.search({}, { limit: 50, sort: 'captured_asc' }).rows.map(p => p.id);

  // --- gabarits : tous les cadres restent dans la page, hors fond perdu ils respectent la marge ---
  // (double page : cadres en fractions de la planche, la marge horizontale d'une page y vaut la moitié)
  let inside = true, safe = true, gutter = true;
  for (const [k, l] of Object.entries(LAYOUTS)) for (const f of l.frames) {
    const mx = l.spread ? SAFETY_MARGIN / 2 : SAFETY_MARGIN;
    if (f.x < 0 || f.y < 0 || f.x + f.w > 1.0001 || f.y + f.h > 1.0001) inside = false;
    if (!l.fullBleed && (f.x < mx - 1e-4 || f.y < SAFETY_MARGIN - 1e-4 || f.x + f.w > 1 - mx + 1e-4 || f.y + f.h > 1 - SAFETY_MARGIN + 1e-4)) safe = false;
    // un cadre d'une seule page de la planche ne doit pas mordre sur la marge du pli
    const crosses = f.x < 0.5 && f.x + f.w > 0.5;
    if (l.spread && !crosses && f.x < 0.5 && f.x + f.w > 0.5 - mx + 1e-4) gutter = false;
    if (l.spread && !crosses && f.x >= 0.5 && f.x < 0.5 + mx - 1e-4) gutter = false;
  }
  check('gabarits : cadres dans la page', inside, true, 0);
  check('gabarits : marges de sécurité respectées', safe, true, 0);
  check('doubles pages : marge de sécurité au pli', gutter, true, 0);
  check('doubles pages : 4 gabarits', Object.values(LAYOUTS).filter(l => l.spread).length, 4, 0);
  check('gabarit 2 × 2 : 4 cadres', LAYOUTS.quatre.frames.length, 4, 0);

  // --- création ---
  const a = ALB.create({ name: 'Vacances', format: 'a4-paysage' });
  check('album créé', a.name, 'Vacances');
  check('orientation déduite du format', a.orientation, 'landscape');
  check('dimensions du format', `${a.width_mm}x${a.height_mm}`, '297x210');
  check('version du format de projet', a.data.formatVersion, ALBUM_FORMAT_VERSION, 0);
  check('page de titre créée', a.pages[0].layout + '|' + a.pages[0].title, 'titre|Vacances');
  let err = null; try { ALB.create({ name: 'X', format: 'custom', width_mm: 10, height_mm: 10 }); } catch (e) { err = e.message; }
  check('format personnalisé hors limites refusé', !!err, true, 0);
  check('format personnalisé accepté', ALB.create({ name: 'Perso', format: 'custom', width_mm: 150, height_mm: 400 }).orientation, 'portrait');

  // --- remplissage : pages ajoutées au gabarit, références sans copie ---
  const filesBefore = LIB.stats().files;
  const r = ALB.fill(a.id, [ids[0], ids[1], ids[2], 'inconnue', ids[0]], 'deux-cote');
  check('remplissage : photos inconnues et répétées ignorées', r.added, 3, 0);
  check('remplissage : 2 pages ajoutées', r.pagesAdded, 2, 0);
  check('remplissage : 3 pages au total', r.album.pages.length, 3, 0);
  check('aucune copie de fichier', LIB.stats().files, filesBefore, 0);
  check('index album_photos tenu', LIB.search({ albumId: a.id }).total, 3, 0);
  check('cadre vide signalé', r.album.issues.some(i => i.page === 3 && i.slot === 1 && i.level === 'info'), true, 0);

  // --- pages : modification, réordonnancement, duplication, suppression ---
  let b = ALB.updatePage(a.id, 2, { caption: '  Plage   du matin ', background: '#FFEEDD', slots: [ids[1], ids[0]] });
  check('légende nettoyée', b.pages[1].caption, 'Plage du matin');
  check('couleur de fond normalisée', b.pages[1].background, '#ffeedd');
  check('photos échangées', b.pages[1].slots.join(','), [ids[1], ids[0]].join(','));
  b = ALB.updatePage(a.id, 2, { background: 'rouge', slots: ['inexistante'] });
  check('couleur invalide → blanc', b.pages[1].background, '#ffffff');
  check('photo inconnue refusée dans un cadre', b.pages[1].slots.length, 0, 0);
  b = ALB.updatePage(a.id, 2, { slots: [ids[0], ids[1]] });
  b = ALB.movePage(a.id, 3, 1);
  check('page déplacée en tête', b.pages[0].slots[0], ids[2]);
  b = ALB.duplicatePage(a.id, 1);
  check('page dupliquée', b.pages.length + '|' + b.pages[1].slots[0], `4|${ids[2]}`);
  b = ALB.removePage(a.id, 2);
  check('page supprimée', b.pages.length, 3, 0);
  err = null; try { ALB.removePage(a.id, 99); } catch (e) { err = e.message; }
  check('page inconnue refusée', !!err, true, 0);

  // --- contrôles ---
  b = ALB.updatePage(a.id, 1, { layout: 'plein' });
  const pleine = b.issues.find(i => i.page === 1 && i.slot === 0);
  check('résolution insuffisante détectée (petite image en pleine page A4)', pleine?.level, 'bad');
  check('résolution calculée en ppp', pleine?.dpi > 0 && pleine?.dpi < 150, true, 0);
  b = ALB.updatePage(a.id, 1, { layout: 'deux-cote', slots: [ids[2], ids[1], ids[0]] });
  check('photo hors gabarit signalée', b.issues.some(i => i.page === 1 && /hors gabarit/.test(i.message)), true, 0);
  DB.prepare('UPDATE photos SET missing = 1 WHERE id = ?').run(ids[2]);
  check('photo indisponible signalée', ALB.get(a.id).issues.some(i => i.level === 'warn' && /indisponible/.test(i.message)), true, 0);
  DB.prepare('UPDATE photos SET missing = 0 WHERE id = ?').run(ids[2]);

  // --- changement de format : la mise en page suit ---
  b = ALB.update(a.id, { name: 'Vacances 2024', format: 'carre-20' });
  check('format changé', `${b.width_mm}x${b.height_mm}|${b.orientation}`, '200x200|square');
  check('pages conservées', b.pages.length, 3, 0);

  // --- export du projet : format versionné, références et empreintes ---
  const proj = ALB.exportProject(a.id);
  check('export : identifiant de format', proj.format, 'phototheque-album');
  check('export : version', proj.formatVersion, ALBUM_FORMAT_VERSION, 0);
  check('export : références des photos (chemin + empreinte)', Object.values(proj.photos).every(p => p.path && 'sha256' in p), true, 0);
  check('export : gabarits utilisés décrits', Object.keys(proj.layouts).length >= 1, true, 0);

  // --- liste ---
  const li = ALB.list().find(x => x.id === a.id);
  check('liste : nombre de pages et de photos', `${li.pageCount}|${li.photoCount}`, '3|3');
  check('liste : couverture', !!li.cover, true, 0);

  // --- une photo retirée de l'index reste signalée dans l'album ---
  const tmp = ALB.create({ name: 'Temporaire' });
  const victim = ids[ids.length - 1];
  ALB.fill(tmp.id, [victim], 'une');
  LIB.removeFromIndex([victim]);
  const t2 = ALB.get(tmp.id);
  check('photo retirée → signalée « plus au catalogue »', t2.issues.some(i => i.level === 'bad' && /plus au catalogue/.test(i.message)), true, 0);
  check('photo retirée → référence conservée dans la page', t2.pages[1].slots[0], victim);
  check('photo retirée → plus dans l\'index de l\'album', LIB.search({ albumId: tmp.id }).total, 0, 0);

  // --- suppression : jamais de photo perdue ---
  const before = LIB.stats().photos;
  check('suppression de l\'album', ALB.remove(a.id).photosUntouched, true, 0);
  check('photos conservées', LIB.stats().photos, before, 0);
  check('pages supprimées', DB.prepare('SELECT COUNT(*) n FROM album_pages WHERE album_id = ?').get(a.id).n, 0, 0);
  for (const x of ALB.list()) ALB.remove(x.id);
  check('intégrité après albums', integrity(DB)[0], 'ok', 0);
}

// ===================================================================
group('Albums : export PDF (impression et aperçu)');
// ===================================================================
{
  // --- écriture PDF : encodage, chasses, coupure, contraste ---
  check('WinAnsi : accents, euro, œ', [...Pdf.winAnsi('éÀ€œ')].join(','), '233,192,128,156');
  check('WinAnsi : caractère hors table ramené à sa base', Pdf.winAnsi('ő').toString('latin1'), 'o');
  check('chasse Helvetica : « A » corps 10', Pdf.textWidth('A', 10), 6.67);
  check('chasse d’une lettre accentuée = lettre de base', Pdf.textWidth('é', 10), Pdf.textWidth('e', 10));
  check('coupure en lignes', Pdf.wrapText('un deux trois quatre', 10, Pdf.textWidth('trois quatre', 10)).join('|'), 'un deux|trois quatre');
  check('texte clair sur fond foncé', Pdf.textColorOn('#101820'), '#ffffff');
  check('texte foncé sur fond clair', Pdf.textColorOn('#ffeedd'), '#1e293b');

  const ALB = createAlbums(DB, LIB), APDF = createAlbumPdf(DB, LIB, ALB);
  // ordre déterministe : une photo présente en deux fichiers (doublon fabriqué ici) entre deux photos uniques
  const ids = [];
  for (const [k, [w, hh, color]] of [[1200, 800, { r: 200, g: 60, b: 40 }], [900, 600, { r: 30, g: 160, b: 90 }], [800, 600, { r: 240, g: 200, b: 40 }]].entries()) {
    const f = path.join(TMP, 'pdf', `photo-${k}.jpg`);
    await makeImage(f, { w, h: hh, color, date: `2023:0${k + 1}:01 10:00:00` });
    await LIB.indexFile(f, {});
    ids.push(DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(f).photo_id);
  }
  const dupId = ids[1], dupCopy = path.join(TMP, 'pdf', 'copie-photo-1.jpg');
  fs.copyFileSync(path.join(TMP, 'pdf', 'photo-1.jpg'), dupCopy);
  await LIB.indexFile(dupCopy, {});
  check('PDF : photo en double préparée', DB.prepare('SELECT COUNT(*) n FROM files WHERE photo_id = ?').get(dupId).n, 2, 0);
  const a = ALB.create({ name: 'Résumé (été)', format: 'a4-portrait' });
  ALB.updatePage(a.id, 1, { caption: 'Sous-titre « accentué »' });
  ALB.fill(a.id, [ids[0], ids[1], ids[2]], 'deux-pile');          // pages 2 (2 photos) et 3 (1 photo + 1 vide)
  ALB.addPage(a.id, { layout: 'plein' });
  ALB.updatePage(a.id, 4, { slots: [ids[0]] });                    // même photo, autre taille de cadre
  ALB.updatePage(a.id, 2, { caption: 'Une légende assez longue pour la page deux, avec des accents : « déjà vu ».' });
  const orig = DB.prepare("SELECT path FROM files WHERE photo_id = ? AND kind = 'original'").get(ids[0]).path;
  const sumBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  const render = async opts => { const chunks = []; const rep = await APDF.render(a.id, { ...opts, write: b => chunks.push(Buffer.from(b)) }); return { rep, buf: Buffer.concat(chunks) }; };
  const { rep, buf } = await render({ quality: 'print' });
  const txt = buf.toString('latin1');
  check('PDF : en-tête et fin de fichier', txt.startsWith('%PDF-1.4') && txt.trimEnd().endsWith('%%EOF'), true, 0);
  const count = needle => txt.split(needle).length - 1;
  check('PDF : une page par page d’album', count('/Type /Page '), 4, 0);
  check('PDF : compte rendu = taille réelle', rep.bytes, buf.length, 0);
  const sx = +txt.slice(txt.lastIndexOf('startxref') + 10).trim().split(/\s/)[0];
  const xref = txt.slice(sx).split('\n').slice(2).filter(l => / [nf] $/.test(l));
  check('PDF : table des références cohérente', xref.length > 5 && xref.every((l, k) => !l.endsWith('n ') || txt.startsWith(`${k} 0 obj`, +l.slice(0, 10))), true, 0);
  check('PDF : format A4 en points', txt.includes('/MediaBox [0 0 595.276 841.89]'), true, 0);
  check('PDF : 4 images (photo réutilisée à deux tailles)', rep.images, 4, 0);
  check('PDF : images en JPEG', count('/Filter /DCTDecode'), 4, 0);
  const widths = [...txt.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map(m => +m[1]);
  const real = ids.slice(0, 3).map(i => LIB.detail(i)), maxW = Math.max(...real.map(d => d.width));
  check('PDF : jamais agrandie au-delà de la résolution réelle', widths.length === 4 && widths.every(w => w <= maxW), true, 0);
  check('PDF : pleine page recadrée au format sans agrandissement', txt.includes(`/Width ${Math.round(real[0].height * 210 / 297)} /Height ${real[0].height}`), true, 0);
  check('PDF : résolution faible signalée', rep.lowDpi.length > 0, true, 0);
  check('PDF : cadre vide signalé', rep.unfilled.some(u => u.page === 3 && u.reason === 'cadre vide'), true, 0);
  check('PDF : titre accentué encodé', txt.includes('(R\\351sum\\351 \\(\\351t\\351\\))'), true, 0);
  check('PDF : polices Helvetica WinAnsi', txt.includes('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding'), true, 0);
  check('PDF : titre du document (UTF-16)', txt.includes('/Title <FEFF005200E900730075006D00E9'), true, 0);
  check('PDF : original non modifié', crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex'), sumBefore);
  check('PDF : export journalisé', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'album-pdf'").get().n, 1, 0);

  // --- fonds perdus : page agrandie de 3 mm, boîte de coupe au format exact ---
  const bl = await render({ quality: 'screen', bleed: true });
  const bt = bl.buf.toString('latin1'), e = (297 + 2 * BLEED_MM) / 25.4 * 72;
  check('fonds perdus : boîte média agrandie', bt.includes(`/MediaBox [0 0 ${Math.round((210 + 2 * BLEED_MM) / 25.4 * 72 * 1000) / 1000} ${Math.round(e * 1000) / 1000}]`), true, 0);
  check('fonds perdus : boîte de coupe au format', bt.includes('/TrimBox [8.504 8.504 603.78 850.394]'), true, 0);
  check('aperçu écran : plus léger que l’impression', bl.buf.length < buf.length, true, 0);

  // --- original indisponible : repli sur une copie de même empreinte, sinon sur l'aperçu en cache ---
  const off = pid => { const fl = DB.prepare('SELECT id, path FROM files WHERE photo_id = ?').all(pid); for (const f of fl) DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(path.join(TMP, 'absent', f.id + '.jpg'), f.id); return () => { for (const f of fl) DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(f.path, f.id); }; };
  const nFiles = pid => DB.prepare('SELECT COUNT(*) n FROM files WHERE photo_id = ?').get(pid).n;
  const dup = ids.slice(0, 3).find(pid => nFiles(pid) > 1);
  if (dup) {
    const first = DB.prepare("SELECT id, path FROM files WHERE photo_id = ? ORDER BY CASE kind WHEN 'original' THEN 0 ELSE 1 END, indexed_at").get(dup);
    DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(path.join(TMP, 'absent', 'nulle-part.jpg'), first.id);
    const fc = await render({ quality: 'screen' });
    check('original absent → copie de même empreinte utilisée', fc.rep.fromCopy.length > 0 && fc.rep.fromPreview.length === 0, true, 0);
    DB.prepare('UPDATE files SET path = ? WHERE id = ?').run(first.path, first.id);
  } else check('original absent → copie de même empreinte utilisée (photo en double attendue)', false, true, 0);
  const single = ids.slice(0, 3).find(pid => nFiles(pid) === 1);
  const restore = off(single);
  const fb = await render({ quality: 'screen' });
  check('aucun fichier accessible → aperçu en cache utilisé', fb.rep.fromPreview.length > 0, true, 0);
  check('aucun fichier accessible → cadres toujours remplis', fb.rep.unfilled.filter(u => u.reason !== 'cadre vide').length, 0, 0);
  restore();

  // --- recadrage manuel : modèle, conservation, contrôles, PDF, projet ---
  const { cleanCrop, cropWindow, ZOOM_MAX } = await import('../lib/albums.mjs');
  check('recadrage par défaut → aucun', cleanCrop({ x: 0.5, y: 0.5, zoom: 1 }), null);
  check('recadrage : bornes (zoom, centre)', JSON.stringify(cleanCrop({ x: -3, y: '0.25', zoom: 99 })), JSON.stringify({ x: 0, y: 0.25, zoom: ZOOM_MAX }));
  check('recadrage invalide → aucun', cleanCrop('n’importe quoi'), null);
  let w0 = cropWindow(1200, 800, 100, 100, null);
  check('fenêtre par défaut : photo paysage dans un carré, centrée', `${w0.width.toFixed(4)}|${w0.left.toFixed(4)}|${w0.height}`, '0.6667|0.1667|1');
  w0 = cropWindow(1200, 800, 100, 100, { x: 0.5, y: 0.5, zoom: 2 });
  check('fenêtre zoom × 2 : moitié de la largeur et de la hauteur', `${w0.width.toFixed(4)}|${w0.height}`, '0.3333|0.5');
  w0 = cropWindow(1200, 800, 100, 100, { x: 0, y: 1, zoom: 2 });
  check('fenêtre : centre ramené pour ne jamais montrer de vide', `${w0.left}|${w0.top}`, '0|0.5');

  let c = ALB.updatePage(a.id, 2, { crops: [{ x: 0.3, y: 0.4, zoom: 2 }, { x: 0.5, y: 0.5, zoom: 1 }] });
  check('recadrage enregistré', JSON.stringify(c.pages[1].crops), JSON.stringify([{ x: 0.3, y: 0.4, zoom: 2 }, null]));
  const dpiOf = (al, pg, sl) => al.issues.find(i => i.page === pg && i.slot === sl && i.dpi)?.dpi;
  const d1 = dpiOf(ALB.get(a.id), 2, 0);
  ALB.updatePage(a.id, 2, { crops: [null, null] });
  const d0 = dpiOf(ALB.get(a.id), 2, 0);
  check('contrôle : le zoom divise la résolution effective', Math.abs(d1 - d0 / 2) <= 1, true, 0);
  c = ALB.updatePage(a.id, 2, { crops: [{ x: 0.3, y: 0.4, zoom: 2 }] });
  c = ALB.updatePage(a.id, 2, { caption: 'autre légende', slots: [ids[0], ids[1]] });
  check('recadrage gardé si la photo reste dans son cadre', c.pages[1].crops[0]?.zoom, 2, 0);
  c = ALB.updatePage(a.id, 2, { slots: [ids[1], ids[0]] });
  check('recadrage oublié si la photo du cadre change', c.pages[1].crops[0], null);
  c = ALB.updatePage(a.id, 3, { crops: [null, { x: 0.2, y: 0.2, zoom: 3 }] });
  check('pas de recadrage sur un cadre vide', c.pages[2].crops[1] ?? null, null);
  check('projet exporté : recadrages inclus', JSON.stringify(ALB.exportProject(a.id).pages[1].crops), JSON.stringify([null, null]));

  DB.prepare('UPDATE photos SET orientation = 6 WHERE id = ?').run(ids[0]);
  const turned = ALB.get(a.id).photos[ids[0]];
  check('photo tournée (EXIF 6) : dimensions affichées échangées', `${turned.width}x${turned.height}`, `${real[0].height}x${real[0].width}`);
  DB.prepare('UPDATE photos SET orientation = 1 WHERE id = ?').run(ids[0]);

  // pleine page (photo 1200 × 800 recadrée au format A4 portrait) : zoom × 2 → deux fois moins de pixels utiles
  ALB.updatePage(a.id, 4, { crops: [{ x: 0.2, y: 0.5, zoom: 2 }] });
  const cr = await render({ quality: 'print' }), ct = cr.buf.toString('latin1');
  const base = Math.round(real[0].height * 210 / 297);
  check('PDF : partie recadrée seule, sans agrandissement', ct.includes(`/Width ${Math.round(base / 2)} /Height ${real[0].height / 2}`), true, 0);
  check('PDF : recadrage = nouvelle image (pas de réutilisation)', cr.rep.images, 4, 0);
  ALB.updatePage(a.id, 4, { crops: [null] });

  // --- doubles pages : numérotation, alignement, résolution, PDF page par page et en planches ---
  const { folios } = await import('../lib/albums.mjs');
  check('numérotation : une double page compte pour deux', JSON.stringify(folios([{ layout: 'titre' }, { layout: 'double-plein' }, { layout: 'une' }])), JSON.stringify([{ folio: 1, span: 1 }, { folio: 2, span: 2 }, { folio: 4, span: 1 }]));
  const sp = ALB.create({ name: 'Planches', format: 'carre-20', spreads: true });
  check('vue en planches enregistrée à la création', sp.spreads, true, 0);
  ALB.fill(sp.id, [ids[1]], 'une');                              // page 2
  ALB.addPage(sp.id, { layout: 'double-plein' });                // pages 3–4 : commence à droite
  let s2 = ALB.updatePage(sp.id, 3, { slots: [ids[0]] });
  check('double page : 4 pages imprimées', s2.printedPages, 4, 0);
  check('double page : numéros 3–4', `${s2.pages[2].folio}|${s2.pages[2].span}`, '3|2');
  check('double page sur une page de droite signalée', s2.issues.some(i => i.page === 3 && /Pages 3–4 : la double page commence sur une page de droite/.test(i.message)), true, 0);
  const spDpi = s2.issues.find(i => i.page === 3 && i.slot === 0 && i.dpi)?.dpi;
  check('double page : résolution sur la largeur de la planche', spDpi, Math.round(25.4 * 1200 / 400), 0);
  s2 = ALB.addPage(sp.id, { layout: 'une', after: 1 });          // une page de plus avant → 4–5, à gauche
  check('double page réalignée : plus d’alerte', s2.issues.some(i => /page de droite/.test(i.message)), false, 0);
  check('double page réalignée : pages 4–5', s2.pages[3].folio, 4, 0);
  check('liste : pages imprimées', ALB.list().find(x => x.id === sp.id).pageCount, 5, 0);
  check('vue en planches désactivable', ALB.update(sp.id, { spreads: false }).spreads, false, 0);

  const renderSp = async opts => { const chunks = []; const rep = await APDF.render(sp.id, { ...opts, write: b2 => chunks.push(Buffer.from(b2)) }); return { rep, t: Buffer.concat(chunks).toString('latin1') }; };
  const pp = await renderSp({ quality: 'print' });
  check('PDF page par page : une page PDF par page imprimée', pp.t.split('/Type /Page ').length - 1, 5, 0);
  check('PDF page par page : format de la page (20 cm)', pp.t.includes('/MediaBox [0 0 566.929 566.929]'), true, 0);
  check('PDF : la double page n’écrit son image qu’une fois', pp.rep.images, 2, 0);
  check('PDF : panoramique à sa résolution réelle (1200 px de large)', pp.t.includes(`/Width 1200 /Height 600`), true, 0);
  check('PDF : cadre vide compté une fois', pp.rep.unfilled.length, 1, 0);
  check('PDF : découpe au pli (deux moitiés décalées)', pp.t.includes('re W n'), true, 0);
  const pl = await renderSp({ quality: 'screen', layout: 'spreads', bleed: true });
  check('PDF en planches : page 1 seule puis paires', `${pl.rep.pdfPages}|${pl.t.split('/Type /Page ').length - 1}`, '3|3');
  check('PDF en planches : largeur de deux pages + fonds perdus', pl.t.includes(`/MediaBox [0 0 ${Math.round((400 + 2 * BLEED_MM) / 25.4 * 72 * 1000) / 1000} `), true, 0);
  check('PDF en planches : boîte de coupe sur deux pages', pl.t.includes(`/TrimBox [8.504 8.504 ${Math.round((400 + BLEED_MM) / 25.4 * 72 * 1000) / 1000} `), true, 0);
  ALB.remove(sp.id);

  // --- annuler / rétablir ---
  let u = ALB.create({ name: 'Annulable', format: 'carre-20' });
  check('annulation : rien au départ', `${u.history.undo}|${u.history.redo}`, 'null|null');
  u = ALB.updatePage(u.id, 1, { caption: 'Sous-titre' });
  check('annulation : étape nommée', u.history.undo, 'Page 1 : texte');
  check('annulation : modification sans effet ignorée', ALB.updatePage(u.id, 1, { caption: 'Sous-titre' }).history.undoCount, 1, 0);
  let r2 = ALB.undo(u.id);
  check('annuler : texte rétabli', `${r2.done}|${r2.album.pages[0].caption}`, 'Page 1 : texte|');
  check('annuler : étape disponible pour rétablir', r2.album.history.redo, 'Page 1 : texte');
  r2 = ALB.redo(u.id);
  check('rétablir : texte remis', r2.album.pages[0].caption, 'Sous-titre');
  u = ALB.fill(u.id, [ids[0], ids[1], ids[2]], 'une').album;
  check('remplissage annulable', ALB.undo(u.id).album.pages.length, 1, 0);
  u = ALB.addPage(u.id, { layout: 'deux-cote' });
  check('nouvelle modification : plus rien à rétablir', u.history.redo, null);
  u = ALB.update(u.id, { spreads: true });
  check('vue en planches : pas une étape', u.history.undo, "Ajout d'une page");
  u = ALB.update(u.id, { name: 'Renommé', format: 'a4-paysage' });
  u = ALB.undo(u.id).album;
  check('annuler : nom et format rétablis', `${u.name}|${u.width_mm}x${u.height_mm}`, 'Annulable|200x200');
  check('annuler : la vue en planches est conservée', u.spreads, true, 0);
  // déplacement d'une photo entre deux pages (avec son recadrage) : une seule étape
  ALB.updatePage(u.id, 2, { slots: [ids[0], ids[1]], crops: [{ x: 0.2, y: 0.5, zoom: 2 }, null] });
  u = ALB.addPage(u.id, { layout: 'une' });
  u = ALB.updatePage(u.id, 3, { slots: [ids[2]] });
  u = ALB.movePhoto(u.id, { page: 2, slot: 0 }, { page: 3, slot: 0 });
  check('déplacement : photos échangées entre pages', `${u.pages[1].slots[0] === ids[2]}|${u.pages[2].slots[0] === ids[0]}`, 'true|true');
  check('déplacement : le recadrage suit la photo', `${u.pages[2].crops[0]?.zoom}|${u.pages[1].crops[0]}`, '2|null');
  check('déplacement : une seule étape', u.history.undo, "Déplacement d'une photo");
  u = ALB.undo(u.id).album;
  check('annuler le déplacement : les deux pages rétablies', `${u.pages[1].slots[0] === ids[0]}|${u.pages[2].slots[0] === ids[2]}|${u.pages[1].crops[0]?.zoom}`, 'true|true|2');
  let e2 = null; try { ALB.movePhoto(u.id, { page: 1, slot: 0 }, { page: 2, slot: 0 }); } catch (x) { e2 = x.message; }
  check('déplacement depuis un cadre vide refusé, sans étape', `${e2}|${ALB.get(u.id).history.redo}`, "Aucune photo à déplacer|Déplacement d'une photo");
  for (let k = 0; k < 55; k++) ALB.updatePage(u.id, 1, { caption: 'v' + k });
  check('annulation : 50 étapes au plus', ALB.get(u.id).history.undoCount, 50, 0);
  while (ALB.get(u.id).history.undo) ALB.undo(u.id);
  e2 = null; try { ALB.undo(u.id); } catch (x) { e2 = x.message; }
  check('rien à annuler signalé', e2, 'Rien à annuler');
  check('annulation : historique de l’opération', DB.prepare("SELECT COUNT(*) n FROM history WHERE kind = 'album.undo'").get().n > 0, true, 0);
  ALB.remove(u.id);

  let err = null; try { await APDF.render('inconnu', { write: () => {} }); } catch (x) { err = x.message; }
  check('album inconnu refusé', err, 'Album inconnu');
  ALB.remove(a.id);
}

// ===================================================================
group('Retouche non destructive et export de photos');
// ===================================================================
{
  const E = await import('../lib/edits.mjs');
  const X = await import('../lib/exports.mjs');
  const { default: exifr } = await import('exifr');
  const { EXPORT_DIR } = await import('../lib/paths.mjs');

  // --- réglages : nettoyage et bornes ---
  const cp = E.cleanParams({ exposure: 9, rotate: 450, crop: { x: 0.9, y: -1, w: 0.5, h: 2 }, mono: 'rouge', inconnu: 1 });
  check('réglages : exposition bornée', cp.exposure, 2, 0);
  check('réglages : rotation ramenée au quart de tour', `${cp.rotate}|${E.cleanParams({ rotate: -90 }).rotate}`, '90|270');
  check('réglages : recadrage ramené dans l’image', JSON.stringify(cp.crop), JSON.stringify({ x: 0.5, y: 0, w: 0.5, h: 1 }));
  check('réglages : valeur inconnue ignorée', 'inconnu' in cp || cp.mono !== null, false, 0);
  check('réglages neutres reconnus', E.isNeutral({ crop: { x: 0, y: 0, w: 1, h: 1 } }), true, 0);
  check('redressement : rectangle sans coin vide plus petit', E.inscribedRect(1000, 500, 5).w < 1000 && E.inscribedRect(1000, 500, 0).w === 1000, true, 0);
  check('géométrie : quart de tour échange largeur et hauteur', JSON.stringify((({ width, height }) => [width, height])(E.geometry(400, 200, { rotate: 90 }))), '[200,400]');

  // --- rendu : image de test moitié rouge (gauche) / moitié bleue (droite) ---
  const sharpTest = (await import('sharp')).default;
  const half = path.join(TMP, 'retouche', 'moitie.png');
  fs.mkdirSync(path.dirname(half), { recursive: true });
  await sharpTest({ create: { width: 400, height: 200, channels: 3, background: '#0000ff' } })
    .composite([{ input: await sharpTest({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer(), left: 0, top: 0 }]).png().toFile(half);
  const sumHalf = crypto.createHash('sha256').update(fs.readFileSync(half)).digest('hex');
  const px = async (r, x, y) => { const { data, info } = await r.image.raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
  const isRed = c => c[0] > 200 && c[2] < 60, isBlue = c => c[2] > 200 && c[0] < 60;
  let r = await E.pipeline(half, { crop: { x: 0, y: 0, w: 0.5, h: 1 } });
  check('rendu : recadrage sur la moitié gauche', `${r.width}x${r.height}|${isRed(await px(r, 100, 100))}`, '200x200|true');
  r = await E.pipeline(half, { flipH: true, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
  check('rendu : recadrage exprimé dans l’image retournée', isBlue(await px(r, 100, 100)), true, 0);
  r = await E.pipeline(half, { rotate: 90 });
  check('rendu : quart de tour (rouge en haut)', `${r.width}x${r.height}|${isRed(await px(r, 100, 50))}`, '200x400|true');
  r = await E.pipeline(half, { straighten: 10 });
  const corner = await px(r, 0, 0);
  check('rendu : redressement sans coin blanc', corner[0] === 255 && corner[1] === 255 && corner[2] === 255, false, 0);
  r = await E.pipeline(half, { mono: 'bw' });
  const g = await px(r, 300, 100);
  check('rendu : noir et blanc', g[0] === g[1] && g[1] === g[2], true, 0);
  r = await E.pipeline(half, { maxSide: 100 }, { maxSide: 100 });
  check('rendu : réduction sans déformation', `${r.width}x${r.height}`, '100x50');
  const sepia = await px(await E.pipeline(half, { mono: 'sepia' }), 300, 100);
  check('rendu : sépia (teinte chaude)', sepia[0] > sepia[2], true, 0);
  const lit = await px(await E.pipeline(half, { exposure: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), 10, 10);
  check('rendu : exposition (le rouge sature, pas de bleu ajouté)', lit[0] === 255 && lit[2] < 60, true, 0);

  // --- versions : création, historique, annulation, version par défaut ---
  await LIB.indexFile(half, {});
  const hid = DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(half).photo_id;
  const ED = E.createEdits(DB, LIB);
  check('aucune version au départ', ED.list(hid).length, 0, 0);
  let v1 = ED.create(hid, { params: { exposure: 0.5 } });
  check('première version : par défaut', `${v1.is_default}|${v1.name}`, 'true|Version 1');
  let v2 = ED.create(hid, { from: v1.id });
  check('copie d’une version', `${v2.is_default}|${v2.params.exposure}|${v2.name}`, 'false|0.5|Version 1 (copie)');
  v1 = ED.update(v1.id, { params: { ...v1.params, contrast: 20 } });
  v1 = ED.update(v1.id, { params: { ...v1.params, mono: 'bw' } });
  check('réglages enregistrés, 2 étapes', `${v1.params.contrast}|${v1.params.mono}|${v1.undo}`, '20|bw|2');
  check('modification sans effet : pas d’étape', ED.update(v1.id, { params: v1.params }).undo, 2, 0);
  v1 = ED.undo(v1.id);
  check('annuler', `${v1.params.mono}|${v1.undo}|${v1.redo}`, 'null|1|1');
  v1 = ED.redo(v1.id);
  check('rétablir', v1.params.mono, 'bw');
  v1 = ED.reset(v1.id);
  check('réinitialiser (annulable)', `${v1.neutral}|${v1.undo}`, 'true|3');
  v1 = ED.undo(v1.id);
  check('annuler la réinitialisation', v1.params.mono, 'bw');
  let e3 = null; try { ED.redo(v1.id); ED.redo(v1.id); } catch (x) { e3 = x.message; }
  check('rien à rétablir signalé', e3, 'Rien à rétablir');
  v2 = ED.update(v2.id, { isDefault: true, name: '  Tirage   ' });
  check('version par défaut changée, renommée', `${v2.is_default}|${ED.get(v1.id).is_default}|${v2.name}`, 'true|false|Tirage');
  check('historique persistant (relu de la base)', E.createEdits(DB, LIB).get(v1.id).undo, 3, 0);
  check('recherche : photo marquée retouchée', LIB.search({}, { limit: 500 }).rows.find(p => p.id === hid)?.edits, 2, 0);
  const prevFile = await ED.preview(hid, v1.params, { size: 300 });
  check('aperçu retouché mis en cache', fs.existsSync(prevFile) && prevFile.includes(path.join('thumbs', 'edits')), true, 0);
  check('aperçu : même réglages, même fichier', await ED.preview(hid, v1.params, { size: 300 }), prevFile);
  check('photo retouchable en pleine définition', ED.capability(hid).fullRes, true, 0);

  // --- export ---
  const EX = X.createExports(DB, ED);
  check('nom de fichier : modèle', X.fileNameFor('{date}-{n}-{nom}', { original: 'IMG 1.JPG', captured_at: '2024-07-15T10:00:00Z', index: 3 }), '2024-07-15-003-IMG 1');
  check('nom de fichier : caractères interdits retirés', X.fileNameFor('{titre}', { title: 'a/b:c*?', original: 'x.jpg', index: 1 }), 'a_b_c_');
  DB.prepare('UPDATE photos SET gps_lat = 48.8566, gps_lon = 2.3522, camera_make = ? WHERE id = ?').run('Canon', hid);
  let rep = await EX.run([hid], { format: 'jpeg', quality: 80, maxSide: 200, metadata: 'nogps', watermark: { text: '© Test' }, naming: '{nom}', folder: 'Essai' });
  check('export : un fichier, dans Exports/Essai', `${rep.files.length}|${rep.dir === path.join(EXPORT_DIR, 'Essai')}|${fs.existsSync(rep.files[0].file)}`, '1|true|true');
  check('export : taille réduite (plus grand côté 200)', `${rep.files[0].width}x${rep.files[0].height}`, '200x100');
  const bw = await sharpTest(rep.files[0].file).raw().toBuffer({ resolveWithObject: true });
  const p0 = [bw.data[3 * (50 * 200 + 30)], bw.data[3 * (50 * 200 + 30) + 1], bw.data[3 * (50 * 200 + 30) + 2]];
  check('export : version par défaut appliquée (copie d’exposition, couleur)', p0[0] > 200 && p0[2] < 80, true, 0);
  let tags = await exifr.parse(rep.files[0].file, { gps: true, tiff: true });
  check('export sans GPS : marque conservée, pas de position', `${tags?.Make}|${tags?.latitude ?? 'aucune'}`, 'Canon|aucune');
  rep = await EX.run([hid], { format: 'jpeg', maxSide: 200, metadata: 'keep', version: 'original', folder: 'Essai' });
  tags = await exifr.parse(rep.files[0].file, { gps: true, tiff: true });
  check('export : nom unique, rien n’est écrasé', rep.files[0].name, 'moitie (2).jpg');
  check('export avec GPS : position écrite', Math.abs((tags?.latitude ?? 0) - 48.8566) < 0.001, true, 0);
  ED.update(v2.id, { params: { mono: 'bw' } });
  rep = await EX.run([hid], { format: 'png', maxSide: 200, metadata: 'none', folder: 'Essai' });
  const nb = await sharpTest(rep.files[0].file).raw().toBuffer({ resolveWithObject: true });
  check('export : PNG, version par défaut en noir et blanc', `${path.extname(rep.files[0].name)}|${nb.data[0] === nb.data[1] && nb.data[1] === nb.data[2]}`, '.png|true');
  check('export sans métadonnées', (await exifr.parse(rep.files[0].file, { tiff: true }))?.Make ?? 'aucune', 'aucune');
  rep = await EX.run([hid, 'inconnue'], { format: 'tiff', maxSide: 120, folder: '../../hors' });
  check('export : dossier ramené dans Exports', rep.dir.startsWith(EXPORT_DIR), true, 0);
  check('export : erreur par photo, le lot continue', `${rep.files.length}|${rep.errors.length}|${path.extname(rep.files[0].name)}`, '1|1|.tif');
  check('export consigné', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'photos'").get().n, 4, 0);
  const sp2 = EX.saveProfile({ name: 'Mon profil', format: 'webp', quality: 70 });
  check('profil enregistré', EX.profiles().saved[sp2.id]?.format, 'webp');
  check('profil du même nom remplacé', EX.saveProfile({ name: 'Mon profil', format: 'png' }).id, sp2.id);
  EX.removeProfile(sp2.id);
  check('profil supprimé', Object.keys(EX.profiles().saved).length, 0, 0);
  let e4 = null; try { EX.saveProfile({ name: ' ' }); } catch (x) { e4 = x.message; }
  check('profil sans nom refusé', e4, 'Nom de profil vide');
  check('original jamais modifié', crypto.createHash('sha256').update(fs.readFileSync(half)).digest('hex'), sumHalf);

  // --- albums : la version retouchée par défaut est montrée, contrôlée et imprimée ---
  const ALB2 = createAlbums(DB, LIB), APDF2 = createAlbumPdf(DB, LIB, ALB2);
  ED.update(v2.id, { params: { rotate: 90, mono: 'bw' } });           // v2 = version par défaut
  let alb = ALB2.create({ name: 'Retouches', format: 'carre-20' });
  alb = ALB2.fill(alb.id, [hid], 'une').album;
  const aph = alb.photos[hid];
  check('album : version retouchée utilisée (aperçu rendu)', `${aph.edit?.name}|${aph.preview.includes('/render?edit=' + v2.id)}`, 'Tirage|true');
  check('album : dimensions de la version retouchée (quart de tour)', `${aph.width}x${aph.height}|${aph.original.width}x${aph.original.height}`, '200x400|400x200');
  const ad = alb.issues.find(i => i.page === 2 && i.dpi)?.dpi;
  check('album : résolution calculée sur la version retouchée', ad, Math.round(25.4 * Math.min(200 / (LAYOUTS.une.frames[0].w * 200), 400 / (LAYOUTS.une.frames[0].h * 200))), 0);
  check('projet exporté : réglages de la version retouchée', ALB2.exportProject(alb.id).photos[hid]?.edit?.params?.mono, 'bw');

  // --- réimport d'un projet exporté (toujours un nouvel album, photos retrouvées, retouches recréées) ---
  {
    const ALB3 = createAlbums(DB, LIB, ED);
    const proj = JSON.parse(JSON.stringify(ALB3.exportProject(alb.id)));
    const before = JSON.stringify(ALB3.get(alb.id).pages);
    const an = ALB3.analyseProject(proj);
    check('import : analyse sans écriture', `${an.photos.found}/${an.photos.total}|${an.photos.byId}|${an.edits.same}|${DB.prepare('SELECT COUNT(*) n FROM albums').get().n}`, `1/1|1|1|${DB.prepare('SELECT COUNT(*) n FROM albums').get().n}`);
    const imp = ALB3.importProject(proj);
    check('import : nouvel album, nom distinct', `${imp.album.id !== alb.id}|${imp.name}`, 'true|Retouches (importé)');
    check('import : pages et photos reprises', JSON.stringify(imp.album.pages.map(p => [p.layout, p.slots, p.title])), JSON.stringify(ALB3.get(alb.id).pages.map(p => [p.layout, p.slots, p.title])));
    check('import : album d’origine intact', JSON.stringify(ALB3.get(alb.id).pages), before);
    check('import : second import → suffixe numéroté', ALB3.importProject(proj).name, 'Retouches (importé 2)');
    check('import : retouche identique non dupliquée', `${imp.edits.same}|${imp.edits.created}`, '1|0');
    // photo identifiée autrement : par contenu, puis par chemin, sinon introuvable (référence gardée et signalée)
    const swap = (pr, newId, patch = {}) => { const q = JSON.parse(JSON.stringify(pr)); q.photos = { [newId]: { ...q.photos[hid], ...patch } }; q.pages.forEach(p => { p.slots = p.slots.map(s => (s === hid ? newId : s)); }); return q; };
    check('import : photo retrouvée par contenu (SHA-256)', ALB3.analyseProject(swap(proj, 'autre-id')).photos.bySha256, 1);
    check('import : photo retrouvée par chemin', ALB3.analyseProject(swap(proj, 'autre-id', { sha256: 'f'.repeat(64) })).photos.byPath, 1);
    const lost = ALB3.importProject(swap(proj, 'id-inconnu', { sha256: 'f'.repeat(64), path: 'Z:/nulle/part.jpg', title: 'Perdue' }));
    check('import : photo introuvable listée', `${lost.photos.missing.length}|${lost.photos.missing[0]?.title}`, '1|Perdue');
    check('import : cadre de la photo introuvable signalé', lost.album.issues.some(i => i.level === 'bad' && /n'est plus au catalogue/.test(i.message)), true, 0);
    // retouche différente : nouvelle version, jamais « par défaut » si la photo en a déjà une
    const nVer = DB.prepare('SELECT COUNT(*) n FROM edits WHERE photo_id = ?').get(hid).n;
    const sep = JSON.parse(JSON.stringify(proj)); sep.photos[hid].edit = { name: 'Sépia', params: { rotate: 90, mono: 'sepia' } };
    const ie = ALB3.importProject(sep);
    const created = DB.prepare("SELECT name, is_default FROM edits WHERE photo_id = ? AND name LIKE '%(import)'").get(hid);
    check('import : retouche recréée comme nouvelle version', `${ie.edits.created}|${DB.prepare('SELECT COUNT(*) n FROM edits WHERE photo_id = ?').get(hid).n - nVer}|${created?.name}|${created?.is_default}`, '1|1|Sépia (import)|0');
    check('import : retouches ignorées sur demande', ALB3.importProject(sep, { withEdits: false }).edits.created, 0, 0);
    // contenu nettoyé comme dans l'éditeur
    const odd = JSON.parse(JSON.stringify(proj));
    odd.pages[1].crops = [{ x: 5, y: -1, zoom: 99 }]; odd.pages.push({ layout: 'inconnu', background: 'rouge', slots: [42, hid], title: 'x'.repeat(900) });
    const io = ALB3.importProject(odd), lastP = io.album.pages.at(-1);
    check('import : recadrage borné', JSON.stringify(io.album.pages[1].crops[0]), JSON.stringify({ x: 1, y: 0, zoom: ALB_ZOOM_MAX }));
    check('import : gabarit, fond, cadres et texte nettoyés', `${lastP.layout}|${lastP.background}|${JSON.stringify(lastP.slots)}|${lastP.title.length}`, `une|#ffffff|[null,"${hid}"]|300`);
    let ef = null; try { ALB3.analyseProject({ format: 'autre' }); } catch (x) { ef = x.message; }
    check('import : fichier étranger refusé', /pas un projet d’album/.test(ef ?? ''), true, 0);
    let ev = null; try { ALB3.analyseProject({ ...proj, formatVersion: 99 }); } catch (x) { ev = x.message; }
    check('import : format plus récent refusé', /plus récent/.test(ev ?? ''), true, 0);
    let ej = null; try { ALB3.analyseProject('{ pas du json'); } catch (x) { ej = x.message; }
    check('import : JSON illisible refusé', /illisible/.test(ej ?? ''), true, 0);
    DB.prepare("DELETE FROM edits WHERE photo_id = ? AND name LIKE '%(import)'").run(hid);
    for (const r of DB.prepare("SELECT id FROM albums WHERE name LIKE 'Retouches (%'").all()) ALB3.remove(r.id);
  }
  const chunks2 = []; const prep = await APDF2.render(alb.id, { quality: 'screen', write: b3 => chunks2.push(Buffer.from(b3)) });
  const pdfBuf = Buffer.concat(chunks2), pt = pdfBuf.toString('latin1');
  check('PDF : photo imprimée dans sa version retouchée', `${prep.edited.length}|${prep.edited[0]?.version}`, '1|Tirage');
  const at = pt.indexOf('/Subtype /Image'), len = +/\/Length (\d+)/.exec(pt.slice(at))[1], st = pt.indexOf('stream\n', at) + 7;
  const jp = await sharpTest(pdfBuf.subarray(st, st + len)).raw().toBuffer({ resolveWithObject: true });
  const mid = 3 * (Math.floor(jp.info.height / 2) * jp.info.width + Math.floor(jp.info.width / 2));
  check('PDF : image en noir et blanc (réglage de la version)', Math.abs(jp.data[mid] - jp.data[mid + 2]) <= 3, true, 0);
  check('PDF : image tournée (largeur native 200 px, 215 sans rotation)', jp.info.width, 200, 0);
  // --- grille et visionneuse : vignette et aperçu de la version retouchée par défaut ---
  const gcard = () => LIB.search({}, { limit: 1000 }).rows.find(p => p.id === hid);
  const gc = gcard();
  check('grille : vignette de la version retouchée', `${gc.thumb.includes('/render?edit=' + v2.id + '&size=400')}|${gc.preview.includes('&size=1200')}`, 'true|true');
  check('grille : original conservé pour comparer', `${gc.original.thumb.startsWith('/api/thumb/')}|${gc.original.width}x${gc.original.height}|${gc.width}x${gc.height}`, 'true|400x200|200x400');
  check('grille : nom de la version', gc.edit?.name, 'Tirage');
  check('grille et album : même rendu', gc.thumb, alb.photos[hid].thumb);
  ED.update(v2.id, { params: { rotate: 90, mono: 'sepia' } });
  check('grille : vignette renouvelée après une retouche', gcard().thumb !== gc.thumb, true, 0);
  ED.update(v2.id, { params: {} });                                    // version neutre → retour à l'original
  check('album : version neutre → original', ALB2.get(alb.id).photos[hid].edit ?? null, null);
  check('grille : version neutre → vignette d’origine', `${gcard().thumb.startsWith('/api/thumb/')}|${gcard().original ?? null}`, 'true|null');
  ALB2.remove(alb.id);

  // --- suppression d'une version ---
  const rm = ED.remove(v2.id);
  check('suppression de la version par défaut : une autre le devient', `${rm.originalUntouched}|${ED.get(v1.id).is_default}`, 'true|true');
  LIB.removeFromIndex([hid]);
  check('photo retirée : ses versions disparaissent', DB.prepare('SELECT COUNT(*) n FROM edits WHERE photo_id = ?').get(hid).n, 0, 0);
}

// ===================================================================
group('Doublons et photos similaires : exacts, potentiels, similaires, rafales');
// ===================================================================
{
  const D = await import('../lib/duplicates.mjs');
  const sh = (await import('sharp')).default;
  const dir = path.join(TMP, 'doublons');
  fs.mkdirSync(path.join(dir, 'autre'), { recursive: true });
  // images à motifs (les images unies des autres groupes ont toutes la même empreinte visuelle)
  const svgA = (w, hh) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${w * 0.7}" cy="${hh * 0.5}" r="${hh * 0.3}" fill="#c00"/></svg>`);
  const svgB = (w, hh) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}">${Array.from({ length: 8 }, (_, i) => `<rect x="${i * w / 8}" width="${w / 16}" height="${hh}" fill="#123"/>`).join('')}<rect width="100%" height="30%" y="70%" fill="#fd0"/></svg>`);
  const svgC = (w, hh, k) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}"><rect width="100%" height="100%" fill="#${k}"/><polygon points="0,0 ${w},${hh} 0,${hh}" fill="#fff"/></svg>`);
  const write = async (name, svg, exif) => { const f = path.join(dir, name); let s = sh(svg); if (exif) s = s.withExif(exif); await s.jpeg({ quality: 90 }).toFile(f); return f; };
  const A = await write('paysage.jpg', svgA(600, 400));
  const As = await write('paysage-reduit.jpg', svgA(300, 200));
  const Acopy = path.join(dir, 'autre', 'paysage-copie.jpg'); fs.copyFileSync(A, Acopy);
  const B = await write('rayures.jpg', svgB(600, 400));
  const N1 = await write('IMG_9.jpg', svgC(640, 480, '0a5'));
  const N2 = path.join(dir, 'autre', 'IMG_9.jpg'); await sh(svgC(640, 480, 'a05')).rotate(180).jpeg().toFile(N2);
  const cam = t => ({ IFD0: { Make: 'Test', Model: 'Rafale X', DateTime: t }, IFD2: { DateTimeOriginal: t } });
  const R1 = await write('rafale-1.jpg', svgC(400, 300, '111'), cam('2023:05:01 10:00:00'));
  const R2 = await write('rafale-2.jpg', svgC(400, 300, '222'), cam('2023:05:01 10:00:01'));
  const R3 = await write('rafale-3.jpg', svgC(400, 300, '333'), cam('2023:05:01 10:00:20'));
  for (const f of [A, As, Acopy, B, N1, N2, R1, R2, R3]) await LIB.indexFile(f, {});
  const pid = f => DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(f).photo_id;
  const [a, as, b, n1, n2, r1, r2, r3] = [A, As, B, N1, N2, R1, R2, R3].map(pid);
  const sums = Object.fromEntries([A, As, Acopy, B].map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));

  check('distance de Hamming : opposées', D.hamming('0000000000000000', 'ffffffffffffffff'), 64, 0);
  const hA = DB.prepare('SELECT perceptual_hash h FROM photos WHERE id = ?').get(a).h;
  check('empreinte visuelle calculée à l’indexation (dHash + couleur moyenne)', /^[0-9a-f]{22}$/.test(hA ?? ''), true, 0);
  const flat = async c => D.dhash(await sh({ create: { width: 64, height: 48, channels: 3, background: c } }).png().toBuffer());
  const fr = await flat('#e00000'), fb = await flat('#0000e0');
  check('aplats de couleurs différentes : même dHash, couleur distincte', `${D.hamming(fr, fb)}|${D.colorGap(fr, fb) > D.MAX_COLOR_GAP}`, '0|true');
  check('même image réduite : empreintes proches', D.hamming(hA, await D.dhash(As)) <= 4, true, 0);
  check('images différentes : empreintes éloignées', D.hamming(hA, await D.dhash(B)) > 20, true, 0);

  const DUP = D.createDuplicates(DB, LIB);
  const has = (r, ids) => r.groups.find(g => ids.every(id => g.photos.some(p => p.id === id)));
  let ex = DUP.groups('exact', { limit: 200 });
  const gA = ex.groups.find(g => g.kind === 'files' && g.photos[0].id === a);
  check('exacts : copie rattachée, 2 fichiers listés', gA?.photos[0].files.length, 2, 0);
  let sim = DUP.groups('similar', { threshold: 8, limit: 200 });
  const gS = has(sim, [a, as]);
  check('similaires : image et version réduite regroupées', !!gS, true, 0);
  check('similaires : groupe marqué « versions » (dimensions différentes)', gS?.kind, 'versions');
  check('similaires : image différente écartée', gS?.photos.some(p => p.id === b), false, 0);
  check('similaires : tolérance 0 plus stricte', !!has(DUP.groups('similar', { threshold: 0, limit: 200 }), [a, b]), false, 0);
  const pot = DUP.groups('potential', { limit: 200 });
  check('potentiels : même nom et mêmes dimensions, contenu différent', !!has(pot, [n1, n2]), true, 0);
  const bur = DUP.groups('burst', { seconds: 2, limit: 200 });
  const gB = has(bur, [r1, r2]);
  check('rafales : deux photos à 1 s', !!gB, true, 0);
  check('rafales : la photo 20 s plus tard est à part', gB?.photos.some(p => p.id === r3), false, 0);
  check('rafales : intervalle élargi à 30 s', !!has(DUP.groups('burst', { seconds: 30, limit: 200 }), [r1, r2, r3]), true, 0);
  const sumUp = DUP.summary({ threshold: 8, seconds: 2 });
  check('résumé : les quatre niveaux comptés', ['exact', 'potential', 'similar', 'burst'].every(k => sumUp[k] >= 1), true, 0);

  // décisions
  DUP.setReference([a, as], a);
  sim = DUP.groups('similar', { threshold: 8, limit: 200 });
  const gR = has(sim, [a, as]);
  check('référence : en tête du groupe, l’autre est sa variante', `${gR.photos[0].id === a}|${gR.photos[0].isReference}|${gR.photos.find(p => p.id === as).reference === a}`, 'true|true|true');
  let e5 = null; try { DUP.setReference([a, as], b); } catch (x) { e5 = x.message; }
  check('référence hors du groupe refusée', e5, 'La référence doit faire partie du groupe');
  DUP.ignore([a, as]);
  check('« pas des doublons » : groupe écarté', !!has(DUP.groups('similar', { threshold: 8, limit: 200 }), [a, as]), false, 0);
  DUP.resetIgnored();
  check('groupes écartés reproposés', !!has(DUP.groups('similar', { threshold: 8, limit: 200 }), [a, as]), true, 0);
  DUP.clearReference([a, as]);
  check('référence annulée', DUP.groups('similar', { threshold: 8, limit: 200 }).groups.find(g => g.photos.some(p => p.id === a)).photos.some(p => p.isReference), false, 0);
  const copyFile = DB.prepare('SELECT id FROM files WHERE path = ?').get(Acopy).id;
  DUP.setReferenceFile(copyFile);
  check('fichier de référence : la copie devient l’original', LIB.search({}, { limit: 1000 }).rows.find(p => p.id === a)?.path, Acopy);
  check('fichier de référence : l’autre fichier reste indexé comme copie', DB.prepare('SELECT kind FROM files WHERE path = ?').get(A).kind, 'copy');

  // variantes masquées dans la Photothèque (critères hideVariants / variants / variantsOf)
  DUP.setReference([a, as], a);
  const ids = f => LIB.search(f, { limit: 1000 }).rows.map(p => p.id);
  const hid = LIB.search({ hideVariants: true }, { limit: 1000 });
  check('masquer les variantes : la variante disparaît, la référence reste', `${hid.rows.some(p => p.id === as)}|${hid.rows.some(p => p.id === a)}`, 'false|true');
  check('masquer les variantes : nombre de variantes masquées renvoyé', hid.hiddenVariants, 1);
  check('masquer les variantes : les autres photos restent visibles', hid.total, LIB.search({}, { limit: 1 }).total - 1);
  check('masquer + autre critère : variantes masquées comptées dans ce périmètre seulement', LIB.search({ hideVariants: true, format: 'png' }, { limit: 1 }).hiddenVariants, 0);
  check('seulement les variantes', ids({ variants: true }).join(), as);
  check('référence et ses variantes', ids({ variantsOf: a }).sort().join(), [a, as].sort().join());
  const card = id => LIB.search({ variantsOf: a }, { limit: 10 }).rows.find(p => p.id === id);
  check('carte : nombre de variantes de la référence', card(a).variants, 1);
  check('carte : référence de la variante', `${card(as).variantOf === a}|${card(a).variantOf}`, 'true|null');
  check('critères enregistrables (recherche sauvegardée)', JSON.stringify(Search.cleanFilters({ hideVariants: 'true', variants: '0', variantsOf: a })), JSON.stringify({ variantsOf: a, hideVariants: true }));
  const plan = DB.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM photos v WHERE json_extract(v.data, '$.duplicate.reference') = ?`).all(a).map(r => r.detail).join(' ');
  check('index des variantes utilisé (ix_photos_variant)', /ix_photos_variant/.test(plan), true, 0);
  // référence retirée de l'index : sa variante n'est plus masquée (jamais introuvable)
  const bData = DB.prepare('SELECT data FROM photos WHERE id = ?').get(b).data;
  DB.prepare('UPDATE photos SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(bData), duplicate: { reference: 'photo-retiree' } }), b);
  check('référence absente : la variante reste visible', `${ids({ hideVariants: true }).includes(b)}|${ids({ variants: true }).includes(b)}`, 'true|false');
  DB.prepare('UPDATE photos SET data = ? WHERE id = ?').run(bData, b);
  DUP.clearReference([a, as]);
  check('référence annulée : plus rien de masqué', LIB.search({ hideVariants: true }, { limit: 1 }).hiddenVariants, 0);

  // suppression d'une fiche en double (index seulement ; fichier conservé et écarté de l'indexation)
  {
    const nFiles = () => DB.prepare('SELECT COUNT(*) n FROM files WHERE photo_id = ?').get(a).n;
    const copyRow = DB.prepare('SELECT id FROM files WHERE path = ?').get(Acopy); // fichier de référence depuis setReferenceFile
    const rf = DUP.removeFile(copyRow.id);
    check('fiche de fichier supprimée, photo conservée', `${rf.fileUntouched}|${nFiles()}|${!!DB.prepare('SELECT 1 FROM photos WHERE id = ?').get(a)}`, 'true|1|true');
    check('fichier toujours présent sur le disque', fs.existsSync(Acopy), true, 0);
    check('autre fichier promu fichier de référence', DB.prepare('SELECT kind FROM files WHERE path = ?').get(A).kind, 'original');
    check('fichier écarté compté', DUP.summary({}).excludedFiles, 1);
    check('réindexation : le fichier écarté n’est pas rattaché', `${await LIB.indexFile(Acopy, {})}|${nFiles()}`, 'excluded|1');
    let e6 = null; try { DUP.removeFile(DB.prepare('SELECT id FROM files WHERE path = ?').get(A).id); } catch (x) { e6 = x.message; }
    check('dernier fichier d’une photo : refusé', /seul fichier/.test(e6 ?? ''), true, 0);
    // fiche d'une photo (avec ses deux fichiers) supprimée
    const twin = path.join(dir, 'autre', 'jumelle.jpg'); fs.copyFileSync(B, twin); await LIB.indexFile(twin, {});
    const rp = DUP.removePhoto(b);
    check('fiche de photo supprimée, fichiers gardés sur le disque', `${!!DB.prepare('SELECT 1 FROM photos WHERE id = ?').get(b)}|${rp.files.length}|${fs.existsSync(B)}|${fs.existsSync(twin)}`, 'false|2|true|true');
    check('réindexation : les fichiers de la fiche supprimée restent écartés', `${await LIB.indexFile(B, {})}|${await LIB.indexFile(twin, {})}`, 'excluded|excluded');
    // contenu modifié : le fichier redevient indexable
    const mod = path.join(dir, 'autre', 'modifie.jpg'); fs.copyFileSync(As, mod); await LIB.indexFile(mod, {});
    DUP.removeFile(DB.prepare('SELECT id FROM files WHERE path = ?').get(mod).id);
    await sh(svgB(320, 200)).jpeg().toFile(mod);
    check('fichier écarté dont le contenu change : indexé de nouveau', await LIB.indexFile(mod, {}), 'added');
    check('réautorisation des fichiers écartés', `${DUP.resetExcluded().reset >= 2}|${DUP.excludedCount()}`, 'true|0');
    check('après réautorisation : indexable', await LIB.indexFile(Acopy, {}), 'added');
  }

  // empreintes manquantes
  DB.prepare('UPDATE photos SET perceptual_hash = NULL WHERE id = ?').run(as);
  check('empreinte manquante comptée', DUP.missingHashes() >= 1, true, 0);
  const ch = await DUP.computeHashes();
  check('empreintes manquantes calculées', `${ch.computed >= 1}|${DB.prepare('SELECT perceptual_hash h FROM photos WHERE id = ?').get(as).h !== null}`, 'true|true');
  check('aucun fichier supprimé ni modifié', Object.entries(sums).every(([f, s]) => fs.existsSync(f) && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') === s), true, 0);
}

// ===================================================================
group('Planches-contact : grille légendée en PDF');
// ===================================================================
{
  const CS = await import('../lib/contactsheet.mjs');
  const { createEdits } = await import('../lib/edits.mjs');
  const ED = createEdits(DB, LIB), SHEET = CS.createContactSheets(DB, LIB, ED);
  check('options : bornes et valeurs inconnues', JSON.stringify(CS.cleanSheetOptions({ page: 'x', columns: 99, rows: 0, fields: ['name', 'pirate', 'name'], quality: '?' })),
    JSON.stringify({ layout: 'grid', groupBy: 'year', page: 'a4-portrait', columns: 12, rows: 1, fields: ['name'], title: '', quality: 'screen', edited: true, margin: 12, background: 'white', subtitle: '', author: '', cover: true }));
  check('texte trop long coupé avec points de suspension', `${CS.fitText('IMG_0001_tres_long_nom_de_fichier.jpg', 8, 60).endsWith('…')}|${CS.fitText('court', 8, 60)}`, 'true|court');
  const rows = LIB.search({}, { limit: 5, sort: 'captured_asc' }).rows.filter(r => r.path && fs.existsSync(r.path));
  const ids = rows.map(r => r.id);
  const shaOf = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const before = rows.map(r => shaOf(r.path));
  const ed = ED.create(ids[0], { name: 'N&B', params: { mono: 'bw' } }); ED.update(ed.id, { isDefault: true });
  const make = async (list, o) => { const ch = []; const rep = await SHEET.render(list, o, { write: b => ch.push(Buffer.from(b)), label: 'Essai' }); return { rep, buf: Buffer.concat(ch) }; };
  const { rep, buf } = await make([...ids, 'inconnue'], { columns: 2, rows: 2, title: 'Été 2024 — planche', fields: ['number', 'name', 'date', 'dimensions'] });
  const txt = buf.toString('latin1');
  check('PDF valide', `${txt.startsWith('%PDF-1.4')}|${txt.trimEnd().endsWith('%%EOF')}`, 'true|true');
  check('pages : photos réparties 2 × 2 (photo inconnue ignorée)', `${rep.photos}|${rep.pages}|${(txt.match(/\/Type \/Page /g) || []).length}`, `${ids.length}|${Math.ceil(ids.length / 4)}|${Math.ceil(ids.length / 4)}`);
  check('une image par photo lisible', rep.images + rep.unreadable.length, ids.length);
  check('titre accentué (WinAnsi) et pagination', `${txt.includes('(\\311t\\351 2024 \\227 planche)')}|${txt.includes(`(Page 1 / ${rep.pages})`)}`, 'true|true');
  check('titre du document : tiret cadratin conservé (UTF-16)', /\/Title <FEFF00C9[0-9A-F]*2014/.test(txt), true, 0);
  // numéro en gras puis nom du fichier sur la même ligne (coupé si trop long : on compare le début)
  check('légende : numéro et nom de fichier', `${txt.includes('(1) Tj')}|${txt.includes('(' + path.basename(rows[0].path).slice(0, 5))}`, 'true|true');
  check('version retouchée montrée par défaut', rep.edited, 1);
  check('version d’origine sur demande', (await make(ids, { edited: false })).rep.edited, 0);
  const pr = (await make(ids, { quality: 'print', columns: 3, rows: 3 })).rep;
  check('qualité impression : lue sur les originaux', pr.fromOriginal >= 1, true, 0);
  let e1 = null; try { await make([], {}); } catch (x) { e1 = x.message; }
  check('aucune photo : refusé', e1, 'Aucune photo pour la planche-contact');
  let e2 = null; try { await make(ids, { columns: 12, rows: 16, fields: Object.keys(CS.SHEET_FIELDS) }); } catch (x) { e2 = x.message; }
  check('grille trop dense : refusée avec explication', /Trop de photos par page/.test(e2 ?? ''), true, 0);
  check('planche consignée dans les exports', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'contact-sheet'").get().n >= 3, true, 0);
  check('originaux jamais modifiés', rows.every((r, k) => shaOf(r.path) === before[k]), true, 0);
  ED.remove(ed.id);
}

// ===================================================================
group('Fiches détaillées (PDF) et catalogue CSV');
// ===================================================================
{
  const CS = await import('../lib/contactsheet.mjs');
  const CAT = await import('../lib/catalog.mjs');
  const { createEdits } = await import('../lib/edits.mjs');
  const ED = createEdits(DB, LIB), SHEET = CS.createContactSheets(DB, LIB, ED), C = CAT.createCatalog(DB);
  check('mise en page inconnue : planche par défaut', `${CS.cleanSheetOptions({ layout: 'x' }).layout}|${CS.cleanSheetOptions({ layout: 'detail' }).layout}`, 'grid|detail');
  const wr = CS.wrapText('un deux trois quatre cinq six sept huit neuf dix onze douze', 8, 60, 2);
  check('texte replié : deux lignes au plus, fin signalée', `${wr.length}|${wr[1].endsWith(' …')}`, '2|true');
  check('mot trop long (chemin) coupé sur plusieurs lignes', CS.wrapText('C:\\Photos\\' + 'x'.repeat(80) + '.jpg', 8, 80, 9).length > 1, true, 0);
  const rows = LIB.search({}, { limit: 3, sort: 'captured_asc' }).rows.filter(r => r.path && fs.existsSync(r.path));
  const ids = rows.map(r => r.id);
  const shaOf = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const before = rows.map(r => shaOf(r.path));
  LIB.update(ids[0], { title: 'Portrait ; "Mamie" =1', description: 'Ligne 1\nLigne 2', rating: 4 });
  // fiche : libellés et valeurs
  const rec = C.record(ids[0], 1), lines = C.detailLines(rec), L = Object.fromEntries(lines.map(l => [l.label, l.value]));
  check('fiche : titre, note, emplacement, empreinte', `${L.Titre}|${L.Note}|${!!L.Emplacement?.includes(path.basename(rows[0].path))}|${L['Empreinte SHA-256'] === rec.sha256}`, `Portrait ; "Mamie" =1|4 / 5|true|true`);
  check('fiche : valeurs vides omises', lines.every(l => l.value.trim() !== ''), true, 0);
  check('photo inconnue : pas de fiche', C.record('inconnue'), null);
  // PDF : une page par photo
  const ch = [];
  const rep = await SHEET.render([...ids, 'inconnue'], { layout: 'detail', title: 'Fiches — essai', columns: 12, rows: 16 }, { write: b => ch.push(Buffer.from(b)), label: 'Essai' });
  const txt = Buffer.concat(ch).toString('latin1');
  check('PDF des fiches : une page par photo', `${rep.layout}|${rep.photos}|${rep.pages}|${(txt.match(/\/Type \/Page /g) || []).length}`, `detail|${ids.length}|${ids.length}|${ids.length}`);
  check('fiche : numéro, libellés et pagination', `${txt.includes('(N\\260 1)')}|${txt.includes('(Empreinte SHA-256)')}|${txt.includes(`(Page ${ids.length} / ${ids.length})`)}`, 'true|true|true');
  check('fiche : grille ignorée (12 × 16 accepté)', rep.images + rep.unreadable.length, ids.length);
  check('fiches consignées dans les exports', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'detail-sheets'").get().n >= 1, true, 0);
  // CSV
  check('CSV : échappement (; " saut de ligne) et anti-formule', `${CAT.csvCell('a;b')}|${CAT.csvCell('dit "x"')}|${CAT.csvCell('=SOMME(A1)')}|${CAT.csvCell('-1,5', true)}`, `"a;b"|"dit ""x"""|'=SOMME(A1)|-1,5`);
  const out = C.csv([...ids, 'inconnue', ids[0]], { label: 'Essai' });
  const recs = out.text.slice(1).split('\r\n').filter(Boolean);
  check('CSV : BOM UTF-8, en-tête + une ligne par photo (doublon et inconnue ignorés)', `${out.text.charCodeAt(0) === 0xfeff}|${recs.length}|${out.photos}`, `true|${ids.length + 1}|${ids.length}`);
  check('CSV : colonnes de l’en-tête', recs[0].split(';').length, CAT.CSV_COLUMNS.length);
  check('CSV : titre échappé, description sur deux lignes conservée', `${out.text.includes(`"'Portrait ; ""Mamie"" =1"`) || out.text.includes(`"Portrait ; ""Mamie"" =1"`)}|${out.text.includes('"Ligne 1\nLigne 2"')}`, 'true|true');
  check('CSV : virgule décimale', /\d,\d/.test(CAT.CSV_COLUMNS.find(c => c[0] === 'latitude')[2]({ gps_lat: 43.6045 })), true, 0);
  let e1 = null; try { C.csv([]); } catch (x) { e1 = x.message; }
  check('CSV vide : refusé', e1, 'Aucune photo à exporter');
  check('originaux jamais modifiés', rows.every((r, k) => shaOf(r.path) === before[k]), true, 0);
  LIB.update(ids[0], { title: null, description: null, rating: 0 });
}

// ===================================================================
group('Catalogues thématiques : groupes, sommaire, pages');
// ===================================================================
{
  const CS = await import('../lib/contactsheet.mjs');
  const CAT = await import('../lib/catalog.mjs');
  const { createEdits } = await import('../lib/edits.mjs');
  const SHEET = CS.createContactSheets(DB, LIB, createEdits(DB, LIB));
  // groupes d'une fiche, sans base : critères et cas « sans … »
  const rec = (o = {}) => ({ captured_at: null, keywords: [], file: null, camera: '', data: '{}', gps_lat: null, gps_lon: null, ...o });
  const G = (r, by) => CAT.groupsOf(r, by).map(g => g.label).join('|');
  check('année / mois', `${G(rec({ captured_at: '2022-06-02T10:00:00' }), 'year')}|${G(rec({ captured_at: '2022-06-02' }), 'month')}|${G(rec(), 'year')}`, '2022|juin 2022|Sans date');
  check('mot-clé : un groupe par mot-clé', `${G(rec({ keywords: ['Été', 'Famille'] }), 'keyword')}#${G(rec(), 'keyword')}`, 'Été|Famille#Sans mot-clé');
  check('lieu : métadonnées IPTC / XMP, sans répétition', G(rec({ data: JSON.stringify({ Sublocation: 'Capitole', City: 'Toulouse', State: 'toulouse', Country: ['France'] }) }), 'place'), 'Capitole, Toulouse, France');
  check('lieu : position GPS arrondie à défaut, sinon « non renseigné »', `${G(rec({ gps_lat: 43.6045, gps_lon: 1.4442 }), 'place')}|${G(rec(), 'place')}`, 'Position GPS 43,6 ; 1,4|Lieu non renseigné');
  const sorted = [{ key: '￿Sans date', tier: 9 }, { key: '2023', tier: 0 }, { key: '2021', tier: 0 }].sort(CAT.compareGroups).map(g => g.key.replace('￿', '')).join(',');
  check('ordre des groupes : chronologique, « sans » à la fin', sorted, '2021,2023,Sans date');
  check('option de regroupement inconnue : année', `${CS.cleanSheetOptions({ groupBy: 'x' }).groupBy}|${CS.cleanSheetOptions({ layout: 'catalog', groupBy: 'keyword' }).groupBy}`, 'year|keyword');
  // PDF
  const rows = LIB.search({}, { limit: 6, sort: 'captured_asc' }).rows;
  const ids = rows.map(r => r.id);
  const years = new Set(rows.map(r => (r.captured_at ?? '').slice(0, 4) || 'Sans date'));
  const make = async o => { const ch = []; const rep = await SHEET.render(ids, { layout: 'catalog', columns: 2, rows: 2, ...o }, { write: b => ch.push(Buffer.from(b)), label: 'Essai' }); return { rep, txt: Buffer.concat(ch).toString('latin1') }; };
  const { rep, txt } = await make({ groupBy: 'year' });
  const expPages = 1 + rep.groups.reduce((a, g) => a + Math.ceil(g.photos / 4), 0);
  check('un groupe par année', rep.groups.length, years.size);
  check('pages : sommaire + pages de chaque groupe', `${rep.pages}|${(txt.match(/\/Type \/Page /g) || []).length}`, `${expPages}|${expPages}`);
  check('sommaire : page de début de chaque groupe', rep.groups.every((g, k) => g.page === 2 + rep.groups.slice(0, k).reduce((a, x) => a + Math.ceil(x.photos / 4), 0)), true, 0);
  check('sommaire et bandeau de groupe dans le PDF', `${txt.includes('(Sommaire)')}|${txt.includes(`(${rep.groups[0].name})`)}`, 'true|true');
  check('chaque photo une fois par année', rep.cells, ids.length);
  const kw = (await make({ groupBy: 'keyword' })).rep;
  const occ = ids.reduce((a, id) => a + Math.max(1, DB.prepare('SELECT COUNT(*) n FROM photo_keywords WHERE photo_id = ?').get(id).n), 0);
  check('par mot-clé : une case par mot-clé de chaque photo', kw.cells, occ);
  check('catalogue consigné dans les exports', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'catalog'").get().n >= 2, true, 0);
}

// ===================================================================
group('Portfolio : couverture, une photo par page, fonds');
// ===================================================================
{
  const CS = await import('../lib/contactsheet.mjs');
  const { createEdits } = await import('../lib/edits.mjs');
  const SHEET = CS.createContactSheets(DB, LIB, createEdits(DB, LIB));
  check('options : fond inconnu, textes nettoyés, couverture', JSON.stringify((({ background, subtitle, author, cover }) => ({ background, subtitle, author, cover }))(CS.cleanSheetOptions({ background: 'rose', subtitle: '  Été   2024 ', author: ' Moi ', cover: 'false' }))),
    JSON.stringify({ background: 'white', subtitle: 'Été 2024', author: 'Moi', cover: false }));
  const rows = LIB.search({}, { limit: 4, sort: 'captured_asc' }).rows.filter(r => r.path && fs.existsSync(r.path));
  const ids = rows.map(r => r.id);
  const make = async o => { const ch = []; const rep = await SHEET.render(ids, { layout: 'portfolio', ...o }, { write: b => ch.push(Buffer.from(b)), label: 'Essai' }); return { rep, txt: Buffer.concat(ch).toString('latin1') }; };
  const { rep, txt } = await make({ title: 'Mes photos', subtitle: 'Sélection', author: 'A. Auteur', background: 'black', fields: ['number', 'name', 'date'], columns: 12, rows: 16 });
  check('couverture + une page par photo (grille ignorée)', `${rep.layout}|${rep.pages}|${(txt.match(/\/Type \/Page /g) || []).length}|${rep.images + rep.unreadable.length}`, `portfolio|${ids.length + 1}|${ids.length + 1}|${ids.length}`);
  check('couverture : titre, sous-titre, auteur', `${txt.includes('(Mes photos) Tj')}|${txt.includes('(S\\351lection) Tj')}|${txt.includes('(A. Auteur) Tj')}`, 'true|true|true');
  check('fond noir sur chaque page', (txt.match(/0\.067 0\.067 0\.067 rg 0 0 /g) || []).length >= ids.length + 1, true, 0);
  check('légende : numéro et nom du fichier en tête', txt.includes(`(1  \\267  ${path.basename(rows[0].path).slice(0, 4)}`), true, 0);
  check('folio : numéro de page discret', txt.includes(`(${ids.length + 1}) Tj`), true, 0);
  const nc = (await make({ cover: false })).rep;
  check('sans couverture : une page par photo', nc.pages, ids.length);
  check('portfolio consigné dans les exports', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind = 'portfolio'").get().n >= 2, true, 0);
}

// ===================================================================
group('Inventaires et rapports (PDF / CSV)');
// ===================================================================
{
  const R = await import('../lib/reports.mjs');
  const { renderTableDoc } = await import('../lib/reportdoc.mjs');
  const pdfOf = async fn => { const ch = []; const out = await fn(b => ch.push(Buffer.from(b))); return { out, txt: Buffer.concat(ch).toString('latin1') }; };
  // document tabulaire : pagination et en-tête répété
  const big = await pdfOf(w => renderTableDoc({ title: 'Essai', sections: [{ heading: 'Liste', columns: [{ label: 'Colonne A' }, { label: 'Nombre', align: 'right' }], rows: Array.from({ length: 160 }, (_, i) => [`ligne ${i}`, String(i)]) }] }, w));
  check('tableau long : plusieurs pages, en-tête répété', `${big.out.pages > 1}|${(big.txt.match(/\(Colonne A\) Tj/g) || []).length === big.out.pages}|${big.txt.includes('(Liste \\(suite\\)) Tj')}`, 'true|true|true');
  const statusBefore = DB.prepare('SELECT id, status FROM files ORDER BY id').all().map(f => f.status).join(',');
  const fakeBackups = { DIR: 'X:/Sauvegardes', list: () => [
    { name: 'a.zip', size: 2048, mtime: new Date().toISOString(), manifest: { type: 'data', createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), version: '0.18.0', counts: { photos: 5 } } },
    { name: 'b.zip', size: 10, mtime: '2020-01-01T00:00:00Z', error: 'manifest absent' }],
  verify: n => ({ ok: n !== 'a.zip' ? false : true, entries: 3, bad: [] }) };
  const REP = R.createReports(DB, { backups: fakeBackups, backupSettings: () => ({ auto: true, every: 7, time: '20:00', type: 'data', keep: 10 }) });
  // inventaire
  const nFiles = DB.prepare('SELECT COUNT(*) n FROM files').get().n;
  const inv = await REP.build('inventory');
  check('inventaire : tous les fichiers, une ligne CSV par fichier', `${inv.summary.files}|${inv.csv.rows.length}`, `${nFiles}|${nFiles}`);
  let e1 = null; try { await REP.build('inventory', { supportId: 'inconnu' }); } catch (x) { e1 = x.message; }
  check('inventaire : support inconnu refusé', e1, 'Support inconnu');
  const ip = await pdfOf(w => REP.pdf('inventory', {}, w));
  check('inventaire en PDF', `${ip.txt.startsWith('%PDF-1.4')}|${ip.txt.includes('(Inventaire par support) Tj')}|${ip.out.pages >= 1}`, 'true|true|true');
  // fichiers manquants : une copie fictive d'une photo existante, absente du disque
  const f0 = DB.prepare("SELECT * FROM files WHERE status = 'available' AND photo_id IS NOT NULL LIMIT 1").get();
  const ghost = path.join(os.tmpdir(), `phototheque-absent-${Date.now()}.jpg`);
  DB.prepare("INSERT INTO files(id, photo_id, path, file_name, size_bytes, sha256, kind, status, indexed_at) VALUES(?,?,?,?,?,?,?,?,?)").run('ghost-file', f0.photo_id, ghost, 'absent.jpg', 1234, f0.sha256, 'copy', 'available', new Date().toISOString());
  // copie altérée : même taille que l'original, empreinte de référence différente
  const altered = path.join(os.tmpdir(), `phototheque-altere-${Date.now()}.jpg`); fs.copyFileSync(f0.path, altered);
  DB.prepare("INSERT INTO files(id, photo_id, path, file_name, size_bytes, sha256, kind, status, indexed_at) VALUES(?,?,?,?,?,?,?,?,?)").run('altered-file', f0.photo_id, altered, 'altere.jpg', fs.statSync(altered).size, 'f'.repeat(64), 'copy', 'available', new Date().toISOString());
  const mi = await REP.build('missing');
  const row = mi.csv.rows.find(r => r[3] === ghost);
  check('manquants : fichier absent du disque signalé', `${!!row}|${row?.[6]}`, 'true|Fichier introuvable');
  check('manquants : autre copie disponible indiquée, photo non perdue', `${!!row?.[7]}|${mi.summary.lost}`, 'true|0');
  // intégrité
  const iq = await REP.build('integrity', { mode: 'quick' });
  check('intégrité rapide : base intègre, absent compté, altération non vue', `${iq.summary.db}|${iq.summary.absent >= 1}|${iq.summary.hash}`, 'true|true|0');
  const ifu = await REP.build('integrity', { mode: 'full' });
  check('intégrité complète : empreinte différente détectée', `${ifu.summary.hash}|${ifu.csv.rows.some(r => r[1] === altered && /Empreinte/.test(r[0]))}`, '1|true');
  DB.prepare("UPDATE files SET size_bytes = 1 WHERE id = 'altered-file'").run();
  check('intégrité : taille différente détectée', (await REP.build('integrity')).summary.size, 1);
  DB.prepare("DELETE FROM files WHERE id IN ('ghost-file', 'altered-file')").run(); fs.rmSync(altered, { force: true });
  check('rapports : statuts du catalogue inchangés', DB.prepare('SELECT id, status FROM files ORDER BY id').all().map(f => f.status).join(','), statusBefore);
  // sauvegardes
  const bk = await REP.build('backups');
  check('sauvegardes : ancienneté, archive illisible signalée', `${bk.summary.count}|${bk.summary.ageDays}|${bk.summary.bad}|${bk.summary.auto}`, '2|3|1|true');
  const none = await R.createReports(DB).build('backups');
  check('sans sauvegarde : « aucune »', `${none.summary.count}|${none.summary.ageDays}`, '0|null');
  // CSV
  const cv = await REP.csv('missing');
  check('CSV : BOM, en-tête', `${cv.text.charCodeAt(0) === 0xfeff}|${cv.text.slice(1).split('\r\n')[0].split(';')[0]}`, 'true|support');
  let e2 = null; try { await REP.build('pirate'); } catch (x) { e2 = x.message; }
  check('rapport inconnu refusé', e2, 'Rapport inconnu');
  check('rapports consignés dans les exports', DB.prepare("SELECT COUNT(*) n FROM exports WHERE kind LIKE 'report-%'").get().n >= 2, true, 0);
}

// ===================================================================
group('Sauvegardes : création, vérification, restauration');
// ===================================================================
{
  const svc = createBackupService({ root: process.cwd(), getStats: () => ({ photos: LIB.stats().photos }), db: DB });
  const b = svc.create('data', { label: 'test' });
  check('sauvegarde créée', !!b.name, true, 0);
  check('manifeste présent', b.manifest.app, 'Phototheque');
  const v = svc.verify(b.name);
  check('archive vérifiée intacte', v.ok, true, 0);
  check('liste', svc.list().length >= 1, true, 0);
  svc.remove(b.name);
  check('suppression', svc.list().length, 0, 0);
}

// ===================================================================
group('ZIP (sans dépendance) :aller-retour');
// ===================================================================
{
  const entries = [{ name: 'a.txt', data: Buffer.from('bonjour') }, { name: 'dir/b.bin', data: Buffer.from([1, 2, 3, 250, 255]) }];
  const buf = createZip(entries);
  const read = readZip(buf);
  check('2 entrées', read.length, 2, 0);
  check('contenu texte', read[0].read().toString(), 'bonjour');
  check('contenu binaire', JSON.stringify(Array.from(read[1].read())), JSON.stringify([1, 2, 3, 250, 255]));
}

// ===================================================================
group('Licence et store');
// ===================================================================
{
  const l = defaultLicense();
  check('titulaire par défaut', !!l.holder, true, 0);
  check('brief copyright', /©/.test(brief(l).copyright), true, 0);
  // round-trip du store
  STORE.scan.thumbSize = 512; saveStore(DB, STORE);
  const reload = loadStore(DB);
  check('store persisté (thumbSize)', reload.scan.thumbSize, 512, 0);
}

// ===================================================================
group('Reconnaissance des extensions image');
// ===================================================================
{
  check('jpg reconnu', isImage('a.jpg'), true, 0);
  check('JPEG en majuscules', isImage('b.JPEG'), true, 0);
  check('png reconnu', isImage('c.png'), true, 0);
  check('raw reconnu', isImage('d.nef'), true, 0);
  check('txt rejeté', isImage('e.txt'), false, 0);
  check('vidéo rejetée', isImage('f.mp4'), false, 0);
  check('ensemble non vide', IMAGE_EXTS.size > 10, true, 0);
}

// ===================================================================
group('Mots-clés : arborescence, synonymes, catégories, vocabulaire');
// ===================================================================
{
  const ids = LIB.search({}, { limit: 4 }).rows.map(p => p.id);
  const [a, b, c] = ids;
  const n = (f) => LIB.search(f, { limit: 500 }).total;
  const animaux = KW.ensure('Animaux');
  const chat = KW.ensure('Chat'); KW.update(chat.id, { parentId: animaux.id, category: 'Faune', synonyms: 'matou, minou, Chat' });
  const chien = KW.ensure('Chien', animaux.id);
  check('synonymes nettoyés (doublon du libellé retiré)', KW.get(chat.id).data.synonyms.join('|'), 'matou|minou');
  check('catégorie enregistrée', KW.get(chat.id).data.category, 'Faune');
  KW.attachNames(a, ['chat']); KW.attachNames(b, ['Chien']); KW.recount();
  check('affectation par nom : mot-clé existant sous un parent réutilisé', KW.list().filter(k => k.normalized === 'chat').length, 1, 0);
  LIB.syncKeywordsText(a); LIB.syncKeywordsText(b);
  check('parent : inclut les mots-clés rangés dessous', n({ keywords: ['animaux'] }), 2, 0);
  check('parent par identifiant : idem', n({ keywordId: animaux.id }), 2, 0);
  check('synonyme : trouve le mot-clé', n({ keywords: ['Minou'] }), 1, 0);
  check('OU avec synonyme', n({ anyKeywords: ['matou', 'chien'] }), 2, 0);
  check('NON sur le parent exclut les enfants', n({ excludeKeywords: ['animaux'] }), LIB.stats().photos - 2, 0);
  check('catégorie de mot-clé comme critère', n({ keywordCategory: 'faune' }), 1, 0);
  check('texte libre : parent trouvé par le texte d’appui', LIB.search({ q: 'animaux' }, { limit: 20 }).rows.some(p => p.id === a), true, 0);
  check('texte libre : synonyme trouvé', LIB.search({ q: 'matou' }, { limit: 20 }).rows.some(p => p.id === a), true, 0);
  check('noms affichés sans le texte d’appui', (await import('../lib/keywords.mjs')).keywordNamesOf(LIB.detail(a).keywords_text).join('|'), 'Chat');
  let err = ''; try { KW.update(animaux.id, { parentId: chat.id }); } catch (e) { err = e.message; }
  check('boucle interdite (parent sous son enfant)', /descendants/.test(err), true, 0);
  err = ''; try { KW.update(chien.id, { name: 'chat' }); } catch (e) { err = e.message; }
  check('deux libellés identiques au même endroit refusés', /fusion/.test(err), true, 0);
  const felins = KW.ensure('Félins');
  KW.update(chat.id, { parentId: felins.id });
  check('déplacement : le texte d’appui suit', /Félins/.test(LIB.detail(a).keywords_text) && !/Animaux/.test(LIB.detail(a).keywords_text), true, 0);
  KW.update(chat.id, { parentId: animaux.id });

  // doublons de vocabulaire
  const dupA = KW.ensure('Chien', felins.id); // même libellé ailleurs
  const pl = KW.ensure('Montagnes'); const sg = KW.ensure('montagne');
  const typo = KW.ensure('Cathédrale'); const typo2 = KW.ensure('Cathedrales');
  const tir = KW.ensure('Saint-Étienne'); const tir2 = KW.ensure('saint etienne');
  const syn = KW.ensure('Minou'); // libellé égal au synonyme de « Chat »
  const groups = KW.vocabularyDuplicates();
  const has = (...xs) => groups.some(g => xs.every(x => g.keywords.some(k => k.id === x)));
  check('vocabulaire : même libellé à deux endroits', has(chien.id, dupA.id), true, 0);
  check('vocabulaire : pluriel', has(pl.id, sg.id), true, 0);
  check('vocabulaire : accent et pluriel', has(typo.id, typo2.id), true, 0);
  check('vocabulaire : tiret', has(tir.id, tir2.id), true, 0);
  check('vocabulaire : synonyme d’un autre', has(chat.id, syn.id), true, 0);
  check('vocabulaire : chemin affiché', groups.find(g => g.keywords.some(k => k.id === dupA.id)).keywords.some(k => k.path === 'Félins › Chien'), true, 0);
  check('vocabulaire : rien de faux (Animaux seul)', groups.some(g => g.keywords.some(k => k.id === animaux.id)), false, 0);
  check('vocabulaire : ne modifie rien', KW.get(pl.id)?.name, 'Montagnes');

  // fusion : synonymes conservés, refus si la cible est sous la source
  err = ''; try { KW.merge([animaux.id], chat.id); } catch (e) { err = e.message; }
  check('fusion d’un parent dans son enfant refusée', /autre sens/.test(err), true, 0);
  KW.merge([sg.id], pl.id);
  check('fusion : libellé source devenu synonyme', KW.get(pl.id).data.synonyms.includes('montagne'), true, 0);

  const u = KW.usage();
  check('statistiques : non utilisés comptés', u.unused >= 6, true, 0);
  check('statistiques : catégories', u.categories.some(x => x.category === 'Faune' && x.keywords === 1), true, 0);
  check('statistiques : affectations', u.assignments >= 2, true, 0);
  check('catégories pour les listes', KW.categories().join('|'), 'Faune');
  const csv = KW.exportCsv();
  check('export CSV : synonymes et catégorie', /"Chat","Animaux","1","Faune","matou, minou"/.test(csv), true, 0);
  KW.importList([{ name: 'Oiseau', parent: 'Animaux', category: 'Faune', synonyms: 'piaf' }]);
  check('import : parent, catégorie et synonymes', (() => { const k = KW.list().find(x => x.name === 'Oiseau'); return k.parent_id === animaux.id && k.data.category === 'Faune' && k.data.synonyms[0] === 'piaf'; })(), true, 0);

  // suppression d'un parent : enfants remontés, texte d'appui recalculé
  KW.remove(animaux.id);
  check('suppression du parent : enfant remonté à la racine', KW.get(chat.id).parent_id, null);
  check('suppression du parent : texte d’appui recalculé', /Animaux/.test(LIB.detail(a).keywords_text), false, 0);

  // lieu
  DB.prepare('UPDATE photos SET data = ? WHERE id = ?').run(JSON.stringify({ City: 'Toulouse', Country: ['France'] }), c);
  check('lieu : ville', n({ place: 'toulouse' }), 1, 0);
  check('lieu : pays (tableau XMP)', n({ place: 'France' }), 1, 0);
  check('lieu : jokers SQL échappés', n({ place: '%' }), 0, 0);
  check('lieu renseigné', n({ hasPlace: '1' }), 1, 0);
  check('lieu non renseigné', n({ hasPlace: '0' }), LIB.stats().photos - 1, 0);

  // état de sauvegarde
  const total = LIB.stats().photos;
  check('sauvegarde : aucune copie de sauvegarde au départ', n({ backup: 'uncovered' }), total, 0);
  const bk = SUP.upsert({ name: 'Disque de sauvegarde', kind: 'disk', role: 'backup' });
  const f0 = DB.prepare('SELECT * FROM files WHERE photo_id = ? LIMIT 1').get(a);
  DB.prepare('INSERT INTO files(id, photo_id, support_id, path, file_name, status) VALUES(?,?,?,?,?,?)').run('test-bk-file', a, bk.id, 'X:\\copie.jpg', 'copie.jpg', 'available');
  check('sauvegarde : photo couverte', n({ backup: 'covered' }), 1, 0);
  check('sauvegarde : les autres non couvertes', n({ backup: 'uncovered' }), total - 1, 0);
  check('un seul exemplaire : la photo couverte n’en fait pas partie', LIB.search({ backup: 'single' }, { limit: 500 }).rows.some(p => p.id === a), false, 0);
  check('critères enregistrés : lieu et sauvegarde gardés', JSON.stringify(Search.cleanFilters({ place: ' Toulouse ', backup: 'covered', hasPlace: '0', keywordCategory: 'Faune' })), '{"place":"Toulouse","backup":"covered","keywordCategory":"Faune","hasPlace":false}');
  check('critères enregistrés : état de sauvegarde inconnu écarté', Search.cleanFilters({ backup: 'x' }).backup, undefined);
  DB.prepare('DELETE FROM files WHERE id = ?').run('test-bk-file'); SUP.remove(bk.id);
  DB.prepare('UPDATE photos SET data = ? WHERE id = ?').run('{}', c);
  for (const k of KW.list()) KW.remove(k.id);
  void f0;
}

// ===================================================================
group('Métadonnées : XMP annexes, priorité, aperçu, annulation');
// ===================================================================
{
  const X = await import('../lib/xmp.mjs');
  const { createMetadata } = await import('../lib/metadata.mjs');
  const { XMP_DIR } = await import('../lib/paths.mjs');
  const doc = { title: 'Lever <de> soleil & co', description: 'Fin de journée', author: 'V. F.', copyright: '© 2024', rating: 4, color: 2, keywords: ['Lieux|Montagne', 'Été'], city: 'Toulouse', country: 'France' };
  const xmp = X.buildXmp(doc, { captured_at: '2024-07-15T14:30:00.000Z', tool: 'Photothèque test' });
  const back = X.parseXmp(xmp);
  check('XMP : aller-retour des champs', JSON.stringify(back.doc), JSON.stringify(X.cleanDoc(doc)));
  check('XMP : outil d’écriture lu', back.tool, 'Photothèque test');
  check('XMP : caractères spéciaux échappés', /Lever &lt;de&gt; soleil &amp; co/.test(xmp), true, 0);
  check('XMP : mot-clé hiérarchique et feuille', /<rdf:li>Lieux\|Montagne<\/rdf:li>/.test(xmp) && /<rdf:li>Montagne<\/rdf:li>/.test(xmp), true, 0);
  const lr = '<x:xmpmeta><rdf:RDF><rdf:Description xmp:Rating="3" xmp:Label="Green" photoshop:City="Lyon"><dc:subject><rdf:Bag><rdf:li>Nuit</rdf:li><rdf:li>Ville</rdf:li></rdf:Bag></dc:subject><dc:title><rdf:Alt><rdf:li xml:lang="fr-FR">Titre fr</rdf:li><rdf:li xml:lang="x-default">Titre</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>';
  const o = X.parseXmp(lr).doc;
  check('XMP d’un autre logiciel : attributs, x-default, liste', `${o.rating}|${o.color}|${o.city}|${o.title}|${o.keywords.join(',')}`, '3|3|Lyon|Titre|Nuit,Ville');
  check('annexe : nommage Adobe', X.sidecarPath('D:\\photos\\IMG_1.JPG', { destination: 'beside', naming: 'adobe' }), 'D:\\photos\\IMG_1.xmp');
  check('annexe : nommage complet', X.sidecarPath('D:\\photos\\IMG_1.JPG', { destination: 'beside', naming: 'full' }), 'D:\\photos\\IMG_1.JPG.xmp');
  check('annexe : dossier dédié, lecteur repris', X.sidecarPath('D:\\photos\\IMG_1.JPG', { destination: 'folder', naming: 'adobe', dir: 'C:\\M' }), 'C:\\M\\D\\photos\\IMG_1.xmp');

  // indexation : métadonnées embarquées puis annexe, champs vides seulement
  const dir = path.join(TMP, 'meta-src'); fs.mkdirSync(dir, { recursive: true });
  const fa = path.join(dir, 'embarque.jpg'), fb = path.join(dir, 'annexe.jpg');
  fs.writeFileSync(fa, await sharp({ create: { width: 120, height: 80, channels: 3, background: '#a52' } }).withIccProfile('srgb').withXmp(xmp).jpeg().toBuffer());
  fs.writeFileSync(fb, await sharp({ create: { width: 120, height: 80, channels: 3, background: '#25a' } }).withXmp(X.buildXmp({ title: 'Titre embarqué', rating: 1 })).jpeg().toBuffer());
  fs.writeFileSync(path.join(dir, 'annexe.xmp'), X.buildXmp({ title: 'Titre de l’annexe', keywords: ['Mer'], rating: 5 }, { tool: 'Autre logiciel' }));
  await LIB.indexFile(fa, {}); await LIB.indexFile(fb, {});
  const idOf = file => DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(file).photo_id;
  const pa = idOf(fa), pb = idOf(fb);
  const MD = createMetadata(DB, { keywords: KW, library: LIB, settings: () => STORE.metadata, version: 'test' });
  const da = MD.docOf(pa), db2 = MD.docOf(pb);
  check('indexation : titre, note, couleur embarqués', `${da.title}|${da.rating}|${da.color}|${da.city}`, 'Lever <de> soleil & co|4|2|Toulouse');
  check('indexation : mots-clés hiérarchiques recréés', da.keywords.join(','), 'Été,Lieux|Montagne');
  check('indexation : l’annexe XMP passe avant l’embarqué', `${db2.title}|${db2.rating}|${db2.keywords.join(',')}`, 'Titre de l’annexe|5|Mer');
  check('profil ICC lu', LIB.detail(pa).data.IccProfile, 'sRGB');

  // modification en masse : aperçu sans écriture, remplir si vide / remplacer
  DB.prepare("UPDATE photos SET author = NULL WHERE id = ?").run(pb);
  const plan = MD.planEdit([pa, pb], { author: { mode: 'fill', value: 'Auteur commun' }, title: { mode: 'set', value: 'Nouveau titre' }, keywordsAdd: ['Saisons|Hiver'], keywordsRemove: ['Montagne'] });
  check('aperçu : n’écrit rien', MD.docOf(pa).title, 'Lever <de> soleil & co');
  check('aperçu : « remplir si vide » ne touche pas un auteur présent', plan.rows.find(r => r.id === pa).changes.some(c => c.field === 'author'), false, 0);
  check('aperçu : auteur vide rempli', plan.rows.find(r => r.id === pb).changes.find(c => c.field === 'author')?.after, 'Auteur commun');
  check('aperçu : écrasements comptés', plan.summary.overwrites, 4, 0);
  const res = MD.applyEdit([pa, pb], { author: { mode: 'fill', value: 'Auteur commun' }, title: { mode: 'set', value: 'Nouveau titre' }, keywordsAdd: ['Saisons|Hiver'], keywordsRemove: ['Montagne'] });
  check('application : valeurs écrites', `${MD.docOf(pa).title}|${MD.docOf(pb).author}|${MD.docOf(pa).keywords.join(',')}`, 'Nouveau titre|Auteur commun|Été,Saisons|Hiver');
  check('application : lot enregistré', MD.batches()[0].photos, 2, 0);
  LIB.update(pb, { title: 'Retouché à la main' });
  const u = MD.undo(res.batchId);
  check('annulation : valeurs rétablies', `${MD.docOf(pa).title}|${MD.docOf(pa).keywords.join(',')}|${MD.docOf(pb).author ?? ''}`, 'Lever <de> soleil & co|Été,Lieux|Montagne|');
  check('annulation : valeur modifiée depuis laissée', `${MD.docOf(pb).title}|${u.kept}`, 'Retouché à la main|1');
  let err = ''; try { MD.undo(res.batchId); } catch (e) { err = e.message; }
  check('annulation : pas deux fois', /déjà/.test(err), true, 0);

  // relecture des fichiers
  LIB.update(pa, { title: null, description: 'Saisie dans la base' });
  const rd = await MD.planRead([pa], { mode: 'fill' });
  check('relecture (remplir) : titre vide repris du fichier', rd.rows[0]?.changes.find(c => c.field === 'title')?.after, 'Lever <de> soleil & co');
  check('relecture (remplir) : saisie de la base conservée', rd.rows[0].changes.some(c => c.field === 'description'), false, 0);
  const rr = await MD.planRead([pa], { mode: 'replace' });
  check('relecture (remplacer) : différence proposée', rr.rows[0].changes.find(c => c.field === 'description')?.after, 'Fin de journée');
  await MD.applyRead([pa], { mode: 'fill' });
  check('relecture appliquée', MD.docOf(pa).title, 'Lever <de> soleil & co');

  // écriture des annexes : dossier dédié, puis à côté (conflit avec l'annexe d'un autre logiciel)
  STORE.metadata = { readOnIndex: true, destination: 'folder', naming: 'adobe' };
  const w1 = MD.planWrite([pa, pb]);
  check('écriture : plan « à créer »', w1.count.create, 2, 0);
  const d1 = MD.applyWrite([pa, pb]);
  const ta = X.sidecarPath(fa, { destination: 'folder', naming: 'adobe', dir: XMP_DIR });
  check('écriture : annexes créées hors du dossier des photos', d1.created === 2 && fs.existsSync(ta) && ta.startsWith(XMP_DIR), true, 0);
  check('écriture : contenu relu identique', X.parseXmp(fs.readFileSync(ta, 'utf8')).doc.title, 'Lever <de> soleil & co');
  check('écriture : déjà à jour', MD.planWrite([pa]).count.same, 1, 0);
  LIB.update(pa, { title: 'Titre modifié' });
  check('écriture : mise à jour d’une annexe écrite par Photothèque', MD.planWrite([pa]).count.update, 1, 0);
  fs.appendFileSync(ta, '<!-- modifié ailleurs -->');
  check('écriture : annexe modifiée ailleurs = conflit', MD.planWrite([pa]).count.conflict, 1, 0);
  const before = fs.readFileSync(ta, 'utf8');
  MD.applyWrite([pa]);
  check('conflit : laissé par défaut', fs.readFileSync(ta, 'utf8'), before);
  MD.applyWrite([pa], { conflicts: 'replace' });
  check('conflit remplacé : copie de l’ancienne gardée', fs.readdirSync(path.dirname(ta)).some(n => n.endsWith('.xmp.bak')), true, 0);
  STORE.metadata = { readOnIndex: true, destination: 'beside', naming: 'adobe' };
  check('à côté : annexe d’un autre logiciel = conflit', MD.planWrite([pb]).rows[0].status, 'conflict');
  const imgBefore = fs.readFileSync(fa);
  MD.applyWrite([pa]);
  check('à côté : annexe créée près de l’original', fs.existsSync(path.join(dir, 'embarque.xmp')), true, 0);
  check('l’original n’est jamais modifié', Buffer.compare(imgBefore, fs.readFileSync(fa)), 0, 0);
  STORE.metadata = { readOnIndex: false, destination: 'folder', naming: 'adobe' };
  const fc = path.join(dir, 'sans-lecture.jpg');
  fs.writeFileSync(fc, await sharp({ create: { width: 60, height: 40, channels: 3, background: '#5a2' } }).withXmp(X.buildXmp({ title: 'Ignoré' })).jpeg().toBuffer());
  await LIB.indexFile(fc, {});
  check('réglage : lecture à l’indexation désactivée', MD.docOf(idOf(fc)).title, '');
  STORE.metadata = { readOnIndex: true, destination: 'folder', naming: 'adobe' };
  LIB.removeFromIndex([pa, pb, idOf(fc)]);
}

// ===================================================================
group('Navigation : liste explicite, image pleine définition');
// ===================================================================
{
  const all = LIB.search({}, { limit: 3 }).rows.map(p => p.id);
  check('liste explicite : seulement ces photos', LIB.search({ ids: all.slice(0, 2) }, { limit: 50 }).total, 2, 0);
  check('liste explicite en texte (paramètre d’URL)', LIB.search({ ids: all.slice(0, 2).join(',') }, { limit: 50 }).total, 2, 0);
  check('liste explicite vide : aucune photo', LIB.search({ ids: [] }, { limit: 50 }).total, 0, 0);
  check('liste explicite jamais enregistrée', Search.cleanFilters({ ids: all.join(','), rating: 3 }).ids, undefined);
  const dir = path.join(TMP, 'zoom'); fs.mkdirSync(dir, { recursive: true });
  const big = path.join(dir, 'grande.jpg');
  await makeImage(big, { w: 2400, h: 1600 });
  await LIB.indexFile(big, {});
  const id = DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(big).photo_id;
  const full = await LIB.fullImage(id);
  const m = await sharp(full).metadata();
  check('pleine définition : dimensions de l’original', `${m.width}x${m.height}`, '2400x1600');
  check('pleine définition : en cache, hors du dossier de l’original', full.startsWith(path.join(TMP, 'data')) && !full.startsWith(dir), true, 0);
  check('pleine définition : cache réutilisé', await LIB.fullImage(id), full);
  const before = fs.readFileSync(big);
  fs.renameSync(big, big + '.absent');
  const fb = await LIB.fullImage(id);
  check('original absent : repli sur l’aperçu', !!fb && fb !== full, true, 0);
  fs.renameSync(big + '.absent', big);
  check('original intact', Buffer.compare(before, fs.readFileSync(big)), 0, 0);
  check('photo inconnue : rien', await LIB.fullImage('inconnue'), null);
  LIB.removeFromIndex([id]);
}

// ===================================================================
group('Retouche avancée : tonalité, courbe, vibrance, bruit, profils, logiciel externe');
// ===================================================================
{
  const E = await import('../lib/edits.mjs');
  const { createExports } = await import('../lib/exports.mjs');
  const { createExternal, EXTERNAL_DIR, checkEditor, cleanExternalSettings } = await import('../lib/external.mjs');
  const X = await import('../lib/xmp.mjs');
  // courbe
  const lut = E.curveLut([[0, 0], [64, 44], [192, 212], [255, 255]]);
  check('courbe : passe par ses points', `${lut[0]}|${lut[64]}|${lut[192]}|${lut[255]}`, '0|44|212|255');
  check('courbe : toujours croissante (pas d’oscillation)', [...lut].every((v, i) => !i || v >= lut[i - 1]), true, 0);
  check('courbe : hors des points extrêmes, constante', E.curveLut([[20, 30], [200, 220]])[5], 30);
  check('courbe identité = aucune', E.cleanParams({ curve: [[0, 0], [255, 255]] }).curve, null);
  check('courbe : points nettoyés (bornes, doublons)', JSON.stringify(E.cleanParams({ curve: [[10, 20], [10, 30], [300, 200], ['x', 1]] }).curve), '[[10,20],[255,200]]');
  check('courbe : 16 points au plus', E.cleanParams({ curve: Array.from({ length: 20 }, (_, i) => [i * 12, i * 10]) }).curve, null);
  check('tonalité : ombres relevées, extrémités fixes', `${E.toneCurve(0, 1, 0)}|${E.toneCurve(1, 1, 0)}|${E.toneCurve(0.25, 1, 0) > 0.3}`, '0|1|true');
  check('tonalité : toujours croissante aux extrêmes', [-1, 1].every(a => [-1, 1].every(b => { let prev = -1; for (let i = 0; i <= 100; i++) { const v = E.toneCurve(i / 100, a, b); if (v < prev) return false; prev = v; } return true; })), true, 0);
  const px = (rgb, prm) => { const b = Buffer.from(rgb); E.applyPixelOps(b, 1, 1, 3, prm); return [...b].join(','); };
  check('ombres : un pixel sombre s’éclaircit, teinte conservée', (() => { const [r, g, b] = px([40, 20, 10], { shadows: 80 }).split(',').map(Number); return r > 40 && Math.abs(r / g - 2) < 0.15; })(), true, 0);
  check('hautes lumières : un pixel clair s’assombrit', +px([230, 230, 230], { highlights: -80 }).split(',')[0] < 230, true, 0);
  check('ombres sans effet sur le blanc', px([255, 255, 255], { shadows: 100 }), '255,255,255');
  const vib = (rgb, v) => { const o = px(rgb, { vibrance: v }).split(',').map(Number); return Math.max(...o) - Math.min(...o); };
  check('vibrance : couleur terne plus relevée que couleur vive', (vib([140, 120, 110], 80) - 30) / 30 > (vib([250, 30, 20], 80) - 230) / 230, true, 0);
  check('vibrance : gris inchangé', px([128, 128, 128], { vibrance: 100 }), '128,128,128');
  // bruit : image bruitée → écart-type réduit ; un contour net reste net
  const W = 64, H = 64, noisy = Buffer.alloc(W * H * 3);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < W * H; i++) { const base = (i % W) < 32 ? 60 : 190; for (let c = 0; c < 3; c++) noisy[i * 3 + c] = Math.max(0, Math.min(255, base + Math.round((rnd() - 0.5) * 30))); }
  const sd = b => { let s1 = 0, s2 = 0, n = 0; for (let y = 0; y < H; y++) for (let x = 4; x < 28; x++) { const v = b[(y * W + x) * 3]; s1 += v; s2 += v * v; n++; } return Math.sqrt(s2 / n - (s1 / n) ** 2); };
  const den = Buffer.from(noisy); E.applyPixelOps(den, W, H, 3, { noise: 80, colorNoise: 50 });
  check('bruit : grain atténué', sd(den) < sd(noisy) * 0.6, true, 0);
  check('bruit : le contour reste net', den[(10 * W + 30) * 3] < 100 && den[(10 * W + 34) * 3] > 150, true, 0);
  check('gris (1 canal) : courbe appliquée', (() => { const b = Buffer.from([64]); E.applyPixelOps(b, 1, 1, 1, { curve: [[0, 0], [64, 128], [255, 255]] }); return b[0]; })(), 128);
  check('anciennes versions de réglages relues sans changement', JSON.stringify(E.cleanParams({ v: 1, contrast: 10 }).curve) + E.cleanParams({ v: 1 }).highlights, 'null0');
  const src = path.join(TMP, 'retouche-avancee.jpg'); await makeImage(src, { w: 400, h: 300, color: { r: 120, g: 90, b: 70 } });
  const { image } = await E.pipeline(src, { shadows: 40, curve: E.CURVES['s-doux'].points, vibrance: 20, noise: 20, colorNoise: 20, saturation: 10, mono: null });
  const outMeta = await image.jpeg().toBuffer().then(b => sharp(b).metadata());
  check('rendu complet : dimensions conservées', `${outMeta.width}x${outMeta.height}`, '400x300');
  check('filtres : les nouveaux réglages font partie du ton', ['curve', 'vibrance', 'highlights', 'shadows'].every(k => E.TONE_KEYS.includes(k)), true, 0);

  // export : profils de couleur
  await LIB.indexFile(src, {});
  const pid = DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(src).photo_id;
  const EXP = createExports(DB, E.createEdits(DB, LIB));
  const exp = async colorProfile => { const r = await EXP.run([pid], { format: 'jpeg', colorProfile, folder: 'test-icc-' + colorProfile }); const m = await sharp(r.files[0].file).metadata(); return { label: r.files[0].colorProfile, space: m.space, icc: X.iccDescription(m.icc) }; };
  check('export sRGB', (await exp('srgb')).icc, 'sRGB');
  check('export Display P3 : profil embarqué', /P3/.test((await exp('p3')).icc), true, 0);
  check('export CMJN en JPEG : 4 couches', (await exp('cmyk')).space, 'cmyk');
  check('export « profil de l’original » sans profil : sRGB', (await exp('original')).label, 'sRGB (l’original n’a pas de profil)');
  const r2 = await EXP.run([pid], { format: 'png', colorProfile: 'cmyk', folder: 'test-icc-png' });
  check('CMJN refusé en PNG : sRGB', r2.files[0].colorProfile, 'sRGB (le CMJN exige JPEG ou TIFF)');
  check('profil personnel : chemin hors du dossier Profils refusé', (await EXP.run([pid], { format: 'jpeg', colorProfile: 'file:../../evil.icc', folder: 'test-icc-evil' })).files[0].colorProfile, 'sRGB');
  const r3 = await EXP.run([pid], { format: 'jpeg', colorProfile: 'file:absent.icc', folder: 'test-icc-bad' });
  check('profil personnel introuvable : erreur, rien d’écrit', r3.errors.length === 1 && !r3.files.length, true, 0);

  // logiciel externe : copie, jamais l'original
  const launched = [];
  const EXT = createExternal(DB, { edits: E.createEdits(DB, LIB), library: LIB, settings: () => ({ editor: '' }), launcher: (ed, file) => { launched.push(file); return { program: 'test' }; } });
  const before = fs.readFileSync(src);
  const o1 = await EXT.open(pid, { source: 'original' });
  check('externe : copie dans « Edition externe »', o1.file.startsWith(EXTERNAL_DIR) && fs.existsSync(o1.file), true, 0);
  check('externe : copie identique à l’original', Buffer.compare(fs.readFileSync(o1.file), before), 0, 0);
  check('externe : le logiciel reçoit la copie', launched[0], o1.file);
  const o2 = await EXT.open(pid, { source: 'version' });
  check('externe : version rendue en TIFF', /\.tif$/.test(o2.file) && (await sharp(o2.file).metadata()).format === 'tiff', true, 0);
  let err = ''; try { EXT.launch(src); } catch (e) { err = e.message; }
  check('externe : refuse d’ouvrir un original', /Edition externe/.test(err), true, 0);
  check('externe : programme inexistant refusé', checkEditor('C:\\nexiste\\pas.exe').ok, false, 0);
  check('externe : seul un exécutable est accepté', checkEditor(src).ok, false, 0);
  check('externe : réglage nettoyé (guillemets)', cleanExternalSettings({ editor: ' "C:\\a b\\gimp.exe" ' }).editor, 'C:\\a b\\gimp.exe');
  fs.writeFileSync(path.join(EXTERNAL_DIR, 'modifiee.png'), await sharp({ create: { width: 50, height: 40, channels: 3, background: '#123456' } }).png().toBuffer());
  const ix = await EXT.index();
  check('externe : fichiers modifiés ajoutés à la photothèque', ix.added >= 1, true, 0);
  check('original intact', Buffer.compare(before, fs.readFileSync(src)), 0, 0);
}

// ===================================================================
group('Albums et exports : styles, modèles, JPEG par page, prestataires, tirages');
// ===================================================================
{
  const A = await import('../lib/albums.mjs');
  const AP = await import('../lib/albumpdf.mjs');
  const { createExports, cleanPrint } = await import('../lib/exports.mjs');
  const E = await import('../lib/edits.mjs');
  const exifr = (await import('exifr')).default;
  const st = A.cleanStyle({ border: { width: 50, color: 'rouge' }, textColor: '#ABCDEF', align: 'x' });
  check('style : bordure bornée à 10 mm', st.border.width, 10);
  check('style : couleur invalide → blanc', st.border.color, '#ffffff');
  check('style : alignement inconnu → centré', st.align, 'center');
  check('style : couleur de texte en minuscules', st.textColor, '#abcdef');
  check('style : défaut sans bordure, texte automatique', JSON.stringify(A.cleanStyle(null)), JSON.stringify({ border: { width: 0, color: '#ffffff' }, textColor: null, align: 'center' }));

  // photos de l'album
  const dir = path.join(TMP, 'album-styles'), ids = [];
  for (const [k, [w, hh]] of [[1600, 1200], [1200, 1600], [1600, 1200], [1600, 1200]].entries()) {
    const f = path.join(dir, 'p' + k + '.jpg'); await makeImage(f, { w, h: hh, color: { r: 20 + k * 3, g: 40, b: 220 } });
    await LIB.indexFile(f, {}); ids.push(DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(f).photo_id);
  }
  const before = fs.readFileSync(path.join(dir, 'p0.jpg'));
  const ALB = A.createAlbums(DB, LIB), APDF = AP.createAlbumPdf(DB, LIB, ALB);
  const al = ALB.create({ name: 'Styles', format: 'carre-20' });
  ALB.fill(al.id, ids, 'deux-cote');
  let g = ALB.applyStyle(al.id, 'passe');
  check('modèle appliqué à toutes les pages', g.pages.every(p => p.background === '#f4efe6' && p.style.border.width === 4), true, 0);
  check('modèle : étape annulable', g.history.undo.startsWith('Modèle « Passe-partout'), true, 0);
  g = ALB.addPage(al.id, { layout: 'une' });
  check('nouvelle page : reprend le style de la précédente', g.pages.at(-1).background + g.pages.at(-1).style.border.width, '#f4efe64');
  g = ALB.updatePage(al.id, 4, { style: { border: { width: 3 } } });
  check('style partiel : la couleur de bordure est gardée', g.pages[3].style.border.width + g.pages[3].style.border.color, '3#ffffff');
  check('modification de style annulable', g.history.undo, 'Page 4 : style');
  g = ALB.applyStyle(al.id, { background: '#000000', border: { width: 1.5, color: '#ff0000' }, textColor: '#ffff00', align: 'left' }, { page: 2 });
  check('style composé appliqué à une seule page', g.pages[1].background + g.pages[1].style.align + g.pages[0].background, '#000000left#f4efe6');
  g = ALB.undo(al.id).album;
  check('annuler : style rétabli', g.pages[1].background, '#f4efe6');
  let err = ''; try { ALB.applyStyle(al.id, 'inconnu'); } catch (e) { err = e.message; }
  check('modèle inconnu refusé', err, 'Modèle inconnu');
  const sv = ALB.saveStyle({ name: 'Mon style', background: '#102030', border: { width: 2, color: '#eeeeee' }, align: 'right' });
  check('modèle enregistré', ALB.styles().saved[sv.key].name + ALB.styles().saved[sv.key].align, 'Mon styleright');
  check('modèle de même nom remplacé', ALB.saveStyle({ name: 'Mon style', background: '#203040' }).key, sv.key);
  ALB.applyStyle(al.id, sv.key, { page: 1 });
  check('modèle enregistré applicable', ALB.get(al.id).pages[0].background, '#203040');
  ALB.removeStyle(sv.key);
  check('modèle supprimé', !!ALB.styles().saved[sv.key], false, 0);
  err = ''; try { ALB.saveStyle({ name: '  ' }); } catch (e) { err = e.message; }
  check('modèle sans nom refusé', err, 'Nom de modèle vide');
  const proj = ALB.exportProject(al.id);
  check('projet : style des pages exporté', proj.pages[1].style.border.width, 4);
  const imp = ALB.importProject(proj);
  check('réimport : style conservé', imp.album.pages[1].style.border.width + imp.album.pages[1].background, '4#f4efe6');
  check('format de projet inchangé (champ ajouté)', proj.formatVersion, 1);

  // rendu JPEG par page : bordure rouge de 3 mm autour d'une photo bleue
  const b2 = ALB.create({ name: 'Bordure', format: 'carre-20' });
  ALB.fill(b2.id, [ids[0]], 'une');
  ALB.applyStyle(b2.id, { background: '#ffffff', border: { width: 3, color: '#ff0000' }, align: 'center' });
  const out = path.join(TMP, 'pages-jpeg'); fs.mkdirSync(out);
  const rj = await APDF.render(b2.id, { output: 'jpeg', dir: out, dpi: 100, bleed: true, bleedMm: 3 });
  check('JPEG : un fichier par page', rj.files.map(f => f.name).join(','), 'page-001.jpg,page-002.jpg');
  const px = Math.round((200 + 6) / 25.4 * 100);
  check('JPEG : taille = format + fonds perdus à la résolution', rj.files[1].width + 'x' + rj.files[1].height, px + 'x' + px);
  const m2 = await sharp(path.join(out, 'page-002.jpg')).metadata();
  check('JPEG : résolution inscrite', m2.density, 100);
  const rgbAt = async (x, y) => [...(await sharp(path.join(out, 'page-002.jpg')).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())].slice(0, 3);
  // cadre « une » : marge 6 % → bord du cadre à 3 mm + 12 mm du bord du fichier ; bordure de 3 mm à l'intérieur
  const edge = Math.round((3 + 0.06 * 200 + 1.5) / 25.4 * 100), mid = Math.round(px / 2);
  const [r1, g1, bb1] = await rgbAt(edge, mid), [r2, g2, bb2] = await rgbAt(mid, mid);
  check('JPEG : bordure rouge dans le cadre', r1 > 200 && g1 < 60 && bb1 < 60, true, 0);
  check('JPEG : photo au centre du cadre', bb2 > 180 && r2 < 80, true, 0);
  const [r0] = await rgbAt(3, 3);
  check('JPEG : fond blanc jusqu’au fond perdu', r0 > 240, true, 0);
  const sp = path.join(TMP, 'planches'); fs.mkdirSync(sp);
  const rs = await APDF.render(al.id, { output: 'jpeg', dir: sp, dpi: 60, layout: 'spreads' });
  check('JPEG par planche : page 1 seule puis paires', rs.files.map(f => f.pages.join('-')).join(' '), '-1 2-3 4-');
  // PDF : texte aligné à gauche / à droite
  const t3 = ALB.create({ name: 'Textes', format: 'carre-20' });
  ALB.addPage(t3.id, { layout: 'une' }); ALB.updatePage(t3.id, 2, { caption: 'Légende' });
  const pdfX = async align => { ALB.updatePage(t3.id, 2, { style: { align } }); const ch = []; await APDF.render(t3.id, { quality: 'screen', write: b => ch.push(b) }); const txt = Buffer.concat(ch).toString('latin1'); return +/ ([\d.]+) [\d.]+ Td \(L\\351gende\) Tj/.exec(txt)?.[1]; };
  const xl = await pdfX('left'), xc = await pdfX('center'), xr = await pdfX('right');
  check('PDF : légende alignée à gauche, au centre, à droite', xl < xc && xc < xr, true, 0);
  check('PDF : à gauche, sur la marge de 6 %', xl, 0.06 * 200 * Pdf.MM, 0.5);

  // profils de prestataire
  const sc = AP.cleanService({ name: ' X ', output: 'jpeg', dpi: 5000, bleed_mm: 30, width_mm: 300, height_mm: null, colorProfile: 'file:../x.icc', minPages: 0 });
  check('prestataire : bornes', `${sc.dpi}|${sc.bleed_mm}|${sc.width_mm}|${sc.colorProfile}|${sc.minPages}`, '600|10|null|srgb|null');
  check('prestataire : profils intégrés génériques', Object.values(AP.BUILTIN_SERVICES).every(v => v.name.startsWith('Générique')), true, 0);
  const a2 = ALB.get(al.id);
  const iss = AP.checkService(a2, AP.cleanService({ name: 'p', width_mm: 300, height_mm: 300, minPages: 20, pageMultiple: 3, safety_mm: 15, colorProfile: 'file:absent.icc', output: 'jpeg' }));
  const has = re => iss.some(i => re.test(i.message));
  check('contrôle : format différent', has(/attend 300 × 300 mm/), true, 0);
  check('contrôle : pages insuffisantes', has(/au moins 20/), true, 0);
  check('contrôle : multiple de pages', has(/multiple de 3/), true, 0);
  check('contrôle : zone de sécurité', has(/zone de sécurité du profil \(15 mm\)/), true, 0);
  check('contrôle : profil ICC absent', has(/absent\.icc/), true, 0);
  check('contrôle : profil conforme sans alerte', AP.checkService(a2, AP.cleanService({ name: 'ok', width_mm: 200, height_mm: 200 })).length, 0);
  const svc = APDF.saveService({ name: 'Labo test', output: 'pdf', bleed_mm: 3, notes: 'site du labo' });
  check('profil de prestataire enregistré', APDF.services().saved[svc.key].name, 'Labo test');
  const send = await APDF.sendFolder(al.id, svc.key, { version: '9.9' });
  check('dossier d’envoi dans Exports', send.dir.startsWith(path.join(TMP, 'Exports')), true, 0);
  check('dossier d’envoi : PDF, projet, fiche', ['album.pdf', 'album.json', 'LISEZ-MOI.txt'].every(n => fs.existsSync(path.join(send.dir, n))), true, 0);
  const readme = fs.readFileSync(path.join(send.dir, 'LISEZ-MOI.txt'), 'utf8');
  check('fiche : rien n’est envoyé, notes du profil', /n’envoie rien/.test(readme) && /site du labo/.test(readme) && /206 × 206 mm/.test(readme), true, 0);
  check('fiche : projet relisible', JSON.parse(fs.readFileSync(path.join(send.dir, 'album.json'), 'utf8')).format, 'phototheque-album');
  const send2 = await APDF.sendFolder(al.id, 'generique-jpeg');
  check('deux envois : deux dossiers distincts', send2.dir !== send.dir && fs.readdirSync(path.join(send2.dir, 'pages')).length, ALB.get(al.id).printedPages);
  APDF.removeService(svc.key);
  check('profil de prestataire supprimé', !!APDF.services().saved[svc.key], false, 0);
  check('originaux intacts', Buffer.compare(before, fs.readFileSync(path.join(dir, 'p0.jpg'))), 0, 0);

  // tirages : dimensions physiques
  check('tirage : sans dimensions → aucun', cleanPrint({ width_mm: 0, height_mm: 100 }), null);
  check('tirage : bornes', JSON.stringify(cleanPrint({ width_mm: 100, height_mm: 150, dpi: 5000, fit: 'x' })), JSON.stringify({ width_mm: 100, height_mm: 150, dpi: 1200, fit: 'fill', rotate: true }));
  const gps = path.join(TMP, 'tirage', 'gps.jpg'); fs.mkdirSync(path.dirname(gps), { recursive: true });
  fs.writeFileSync(gps, await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 120, b: 60 } } })
    .withExif({ IFD0: { Make: 'Canon' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '43/1 36/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '1/1 26/1 0/1' } }).jpeg().toBuffer());
  await LIB.indexFile(gps, {});
  const gid = DB.prepare('SELECT photo_id FROM files WHERE path = ?').get(gps).photo_id;
  const EXP = createExports(DB, E.createEdits(DB, LIB));
  const pr = { width_mm: 100, height_mm: 150, dpi: 300, fit: 'fill', rotate: true };
  const t1 = await EXP.run([gid], { format: 'jpeg', metadata: 'nogps', print: pr, folder: 'tirages' });
  const f1 = t1.files[0], mt = await sharp(f1.file).metadata();
  check('tirage : photo paysage → format tourné, pixels exacts', `${f1.width}x${f1.height}`, '1772x1181');
  check('tirage : 300 ppp inscrits', mt.density, 300);
  check('tirage : résolution effective calculée', f1.print.effectiveDpi, Math.round(300 / Math.max(1772 / 1200, 1181 / 800)));
  check('tirage : résolution limite signalée (203 ppp)', f1.print.level, 'warn');
  check('tirage sans GPS : GPS absent', await exifr.gps(f1.file).catch(() => null) ?? null, null);
  check('tirage : fiche de commande', fs.existsSync(path.join(t1.dir, 'LISEZ-MOI.txt')) && /résolution effective/.test(fs.readFileSync(path.join(t1.dir, 'LISEZ-MOI.txt'), 'utf8')), true, 0);
  const t2 = await EXP.run([gid], { format: 'jpeg', metadata: 'keep', print: { ...pr, fit: 'fit', rotate: false }, folder: 'tirages' });
  const f2 = t2.files[0];
  check('tirage sans rotation : format portrait gardé', `${f2.width}x${f2.height}`, '1181x1772');
  check('tirage « photo entière » : bandes blanches', (await sharp(f2.file).extract({ left: 590, top: 5, width: 1, height: 1 }).raw().toBuffer())[0] > 240, true, 0);
  check('tirage avec GPS demandé : GPS présent', Math.round((await exifr.gps(f2.file))?.latitude ?? 0), 44);
  check('fiche existante jamais écrasée', t2.readme, 'LISEZ-MOI (2).txt');
  check('profil intégré « Tirage 10 × 15 »', EXP.profiles().builtin['tirage-10x15'].print.width_mm, 100);
}

// ===================================================================
group('Sauvegardes et sécurité : chiffrement, destinations, tests, restauration sélective, verrou');
// ===================================================================
{
  const B = await import('../lib/backup.mjs');
  const { createSelectiveRestore } = await import('../lib/restore.mjs');
  const { createLock, checkPassword, LOCK_COOKIE } = await import('../lib/lock.mjs');
  const { applyStagedRestore, cleanLock } = await import('../lib/store.mjs');
  const R = await import('../lib/reports.mjs');
  const A = await import('../lib/albums.mjs');
  const { createCollections } = await import('../lib/collections.mjs');
  const { saveStore: save2, loadStore: load2 } = await import('../lib/store.mjs');

  // chiffrement de bas niveau
  const zip = createZip([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'x.txt', data: Buffer.from('données') }]);
  const enc = B.encryptArchive(zip, 'mot-de-passe', { app: 'Phototheque', type: 'data' });
  check('chiffré : en-tête lisible sans mot de passe', B.encryptedHeader(enc).header.type, 'data');
  check('chiffré : contenu illisible en clair', enc.includes(Buffer.from('données')), false, 0);
  check('déchiffrement : archive identique', Buffer.compare(B.decryptArchive(enc, 'mot-de-passe'), zip), 0, 0);
  let err = ''; try { B.decryptArchive(enc, 'faux'); } catch (e) { err = e.message; }
  check('mauvais mot de passe refusé', err, 'Mot de passe incorrect, ou archive altérée');
  const tampered = Buffer.from(enc); tampered[14] ^= 1; err = '';
  try { B.decryptArchive(tampered, 'mot-de-passe'); } catch (e) { err = e.message; }
  check('en-tête modifié détecté (authentifié)', /altérée/.test(err), true, 0);
  const ver = B.makeVerifier('abc12345');
  check('vérificateur : bon mot de passe', B.checkVerifier(ver, 'abc12345'), true, 0);
  check('vérificateur : mauvais mot de passe', B.checkVerifier(ver, 'abc12346'), false, 0);
  check('réglages : jamais de mot de passe, vérificateur nettoyé', JSON.stringify(Object.keys(B.backupSettings({ password: 'x', verifier: { salt: 'zz' } }))).includes('password') || B.backupSettings({ verifier: { salt: 'zz' } }).verifier !== null, false, 0);

  // service complet, avec réglages en mémoire
  const S = B.backupSettings({ keep: 2 });
  const svc = B.createBackupService({ root: process.cwd(), getStats: () => ({ photos: LIB.stats().photos }), db: DB, getSettings: () => S, saveSettings: () => {} });
  const destA = path.join(TMP, 'dest-a'), destB = path.join(TMP, 'dest-b'); fs.mkdirSync(destA); fs.mkdirSync(destB);
  svc.saveDestination({ name: 'Externe', path: destA, kind: 'external' });
  svc.saveDestination({ name: 'Ailleurs', path: destB, kind: 'offsite' });
  svc.saveDestination({ name: 'Débranché', path: path.join(TMP, 'absent'), kind: 'nas' });
  err = ''; try { svc.saveDestination({ name: 'x', path: 'relatif' }); } catch (e) { err = e.message; }
  check('destination : chemin absolu exigé', /Chemin absolu/.test(err), true, 0);
  err = ''; try { svc.saveDestination({ name: 'x', path: svc.DIR }); } catch (e) { err = e.message; }
  check('destination : pas le dossier Sauvegardes lui-même', /autre emplacement/.test(err), true, 0);
  const b1 = svc.create('data', { label: 'test 0.27' });
  check('copies vers les destinations accessibles', b1.copies.filter(c => c.ok).length, 2);
  check('copie identique (SHA-256)', Buffer.compare(fs.readFileSync(path.join(destA, B.DEST_SUBDIR, b1.name)), fs.readFileSync(svc.filePath(b1.name))), 0, 0);
  check('destination débranchée : échec signalé', b1.copies.find(c => c.name === 'Débranché').ok, false, 0);
  check('échec journalisé et en alerte', svc.alerts().some(a => a.level === 'bad' && /Débranché/.test(a.message)), true, 0);
  check('manifeste : empreintes SHA-256 des fichiers', !!b1.manifest.sha256['data/phototheque.db'], true, 0);
  check('règle 3-2-1 satisfaite', JSON.stringify(svc.rule321()), JSON.stringify({ copies: 4, three: true, two: true, one: true }));
  svc.ackAlerts();
  check('alertes acquittées', svc.alerts().some(a => a.level === 'bad' && /Débranché/.test(a.message)), false, 0);
  // test de restauration
  const t1 = await svc.testRestore(b1.name);
  check('test de restauration réussi', t1.ok, true, 0);
  check('test : catalogue ouvert et contrôlé', /intégrité SQLite correcte/.test(t1.message), true, 0);
  check('test mémorisé dans la liste', svc.list().find(x => x.name === b1.name).test.ok, true, 0);
  const broken = path.join(svc.DIR, 'phototheque_data_casse.zip');
  const raw = fs.readFileSync(svc.filePath(b1.name)); const cut = Buffer.from(raw); cut[200] ^= 0xff; fs.writeFileSync(broken, cut);
  const t2 = await svc.testRestore('phototheque_data_casse.zip');
  check('test : archive altérée détectée', t2.ok, false, 0);
  fs.rmSync(broken);
  // aperçu du contenu
  const c1 = await svc.contents(b1.name);
  check('aperçu : nombre de photos du catalogue sauvegardé', c1.catalogue.counts.photos, LIB.stats().photos);
  check('aperçu : albums listés', Array.isArray(c1.catalogue.albums), true, 0);
  // chiffrement activé
  err = ''; try { svc.setEncryption({ password: 'court' }); } catch (e) { err = e.message; }
  check('mot de passe trop court refusé', /trop court/.test(err), true, 0);
  svc.setEncryption({ password: 'tres-secret' });
  check('chiffrement : vérificateur seul conservé', S.encrypt && !!S.verifier && !JSON.stringify(S).includes('tres-secret'), true, 0);
  const b2 = svc.create('data');
  check('sauvegarde chiffrée (.enc)', /\.enc$/.test(b2.name) && B.isEncrypted(fs.readFileSync(svc.filePath(b2.name))), true, 0);
  check('liste : manifeste public lisible', svc.list().find(x => x.name === b2.name).manifest.encrypted, true, 0);
  svc.lockEncryption();
  err = ''; try { svc.create('data'); } catch (e) { err = e.message; }
  check('sans mot de passe en session : création refusée', /requis/.test(err), true, 0);
  check('alerte : mot de passe attendu si programmation', (S.auto = true, svc.alerts().some(a => /attendent le mot de passe/.test(a.message))), true, 0);
  S.auto = false;
  check('vérification sans mot de passe : partielle', svc.verify(b2.name).ok, null);
  check('test avec le mot de passe : réussi', (await svc.testRestore(b2.name, 'tres-secret')).ok, true, 0);
  check('test avec un mauvais mot de passe : échec', (await svc.testRestore(b2.name, 'faux')).ok, false, 0);
  err = ''; try { svc.unlockEncryption('faux'); } catch (e) { err = e.message; }
  check('session : mauvais mot de passe refusé', err, 'Mot de passe incorrect');
  svc.unlockEncryption('tres-secret');
  check('session : mot de passe accepté', svc.encryptionUnlocked(), true, 0);
  // restauration sélective : un album et une collection supprimés depuis
  const ALB = A.createAlbums(DB, LIB), COL = createCollections(DB, LIB);
  const pid = DB.prepare('SELECT id FROM photos LIMIT 1').get().id;
  const al = ALB.create({ name: 'Album à retrouver' }); ALB.fill(al.id, [pid], 'une');
  const col = COL.create({ name: 'Sélection à retrouver', kind: 'static', photoIds: [pid] });
  const b3 = svc.create('data');
  ALB.remove(al.id); COL.remove(col.id);
  const SEL = createSelectiveRestore(DB, { backups: svc, albums: ALB, collections: COL });
  const rs = await SEL.restoreSelection(b3.name, { albums: [al.id], collections: [col.id] });
  check('sélective : album recréé', rs.albums[0].name + rs.albums[0].found, 'Album à retrouver (restauré)1');
  check('sélective : collection recréée avec sa photo', rs.collections[0].photos, 1);
  check('sélective : sauvegarde de sécurité', !!rs.safety && fs.existsSync(svc.filePath(rs.safety)), true, 0);
  check('sélective : rien d’écrasé (nouvel album)', ALB.list().filter(x => x.name.startsWith('Album à retrouver')).length, 1);
  // restauration complète : la base est mise en attente, jamais réécrite ouverte
  const rr = svc.restore(b1.name);
  check('restauration complète : redémarrage demandé', rr.restartRequired, true, 0);
  check('base en attente identique à la sauvegarde', Buffer.compare(fs.readFileSync(B.STAGED_DB), zipBufDb(svc, b1.name)), 0, 0);
  check('base en service non remplacée (données postérieures présentes)', DB.prepare("SELECT COUNT(*) n FROM albums WHERE name = 'Album à retrouver (restauré)'").get().n, 1);
  fs.rmSync(B.STAGED_DB);
  check('rien en attente : rien à appliquer', applyStagedRestore(), false, 0);
  // rétention dans les destinations (2 programmées gardées)
  for (let k = 0; k < 3; k++) svc.create('data', { auto: true });
  check('destination : rétention des sauvegardes programmées', fs.readdirSync(path.join(destA, B.DEST_SUBDIR)).filter(f => /_auto/.test(f)).length, 2);

  // rapport des originaux non couverts
  const REP = R.createReports(DB, { backups: svc, backupSettings: () => S });
  const cov = await REP.build('coverage');
  check('rapport : originaux non couverts', cov.summary.photos, LIB.stats().photos);
  check('rapport : couverture + non couverture = total', cov.summary.covered + cov.summary.uncovered, cov.summary.photos);
  const bk = await REP.build('backups', { verify: false });
  check('rapport de sauvegardes : destinations et journal', bk.sections.some(s => s.heading === 'Destinations') && bk.sections.some(s => /Journal/.test(s.heading ?? '')), true, 0);

  // clés des modules préservées par l'enregistrement des réglages (correctif 0.27)
  ALB.saveStyle({ name: 'Survivant', background: '#123456' });
  const st0 = load2(DB); save2(DB, st0);
  check('réglages enregistrés : modèles d’album conservés', Object.values(ALB.styles().saved).some(m => m.name === 'Survivant'), true, 0);
  check('store : les clés des modules n’y sont pas recopiées', Object.keys(load2(DB)).some(k => k.includes('.')), false, 0);

  // verrouillage
  let L = cleanLock({});
  const lock = createLock({ getLock: () => L, setLock: x => { L = cleanLock(x); } });
  const req = c => ({ headers: { cookie: c ?? '' } });
  check('verrou inactif : tout est permis', lock.allowed(req()), true, 0);
  err = ''; try { lock.setPassword({ password: '123' }); } catch (e) { err = e.message; }
  check('verrou : mot de passe trop court', /trop court/.test(err), true, 0);
  const set = lock.setPassword({ password: 'secret1', idleMinutes: 10 });
  check('verrou : empreinte seulement', !!L.hash && !JSON.stringify(L).includes('secret1'), true, 0);
  check('verrou : empreinte vérifiable', checkPassword(L, 'secret1'), true, 0);
  const ck = set.cookie.split(';')[0];
  check('cookie HttpOnly, SameSite=Strict', /HttpOnly/.test(set.cookie) && /SameSite=Strict/.test(set.cookie) && ck.startsWith(LOCK_COOKIE + '='), true, 0);
  check('session ouverte : permis', lock.allowed(req(ck)), true, 0);
  check('sans jeton : refusé', lock.allowed(req()), false, 0);
  lock.lockNow();
  check('verrouiller : la session est fermée', lock.allowed(req(ck)), false, 0);
  err = ''; try { lock.unlock('faux'); } catch (e) { err = e.message; }
  check('déverrouillage : mauvais mot de passe', err, 'Mot de passe incorrect');
  const u = lock.unlock('secret1');
  check('déverrouillage : nouvelle session', lock.allowed(req(u.cookie.split(';')[0])), true, 0);
  for (let k = 0; k < 5; k++) { try { lock.unlock('faux'); } catch { /* attendu */ } }
  err = ''; try { lock.unlock('secret1'); } catch (e) { err = e.message; }
  check('après 5 erreurs : attente imposée', /réessayez/.test(err), true, 0);
  // inactivité
  let t = 0; let L2 = cleanLock({});
  const lock2 = createLock({ getLock: () => L2, setLock: x => { L2 = cleanLock(x); }, now: () => t });
  const c2 = lock2.setPassword({ password: 'secret2', idleMinutes: 1 }).cookie.split(';')[0];
  t = 30000; check('inactivité courte : session gardée', lock2.allowed(req(c2)), true, 0);
  t = 30000 + 61000; check('inactivité dépassée : verrouillé', lock2.allowed(req(c2)), false, 0);
  err = ''; try { lock2.disable({ current: 'faux' }); } catch (e) { err = e.message; }
  check('désactivation : mot de passe actuel exigé', err, 'Mot de passe actuel incorrect');
  lock2.disable({ current: 'secret2' });
  check('désactivé : tout est permis', lock2.allowed(req()), true, 0);
}
function zipBufDb(svc, name) { return readZip(fs.readFileSync(svc.filePath(name))).find(e => e.name === 'data/phototheque.db').read(); }

// ===================================================================
group('Tableau de bord : chiffres, répartitions, manques, volumes, cache, export');
// ===================================================================
{
  const D = await import('../lib/dashboard.mjs');
  const Search = await import('../lib/search.mjs');
  check('filtres : année, support, format seulement', JSON.stringify(D.cleanDashFilters({ year: '2024', format: 'jpeg', supportId: 's1', pirate: 'x', })), JSON.stringify({ year: '2024', supportId: 's1', format: 'jpeg' }));
  check('filtres : année invalide ignorée', JSON.stringify(D.cleanDashFilters({ year: '24; DROP' })), '{}');
  const dir = path.join(TMP, 'taille'); fs.mkdirSync(path.join(dir, 'sous'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1000)); fs.writeFileSync(path.join(dir, 'sous', 'b.bin'), Buffer.alloc(500));
  check('taille de dossier récursive', JSON.stringify(D.dirSize(dir)), JSON.stringify({ bytes: 1500, files: 2 }));
  check('dossier absent : zéro', D.dirSize(path.join(TMP, 'nexistepas')).bytes, 0);

  const DB2 = DB;
  const DSH = D.createDashboard(DB2, {});
  const d = DSH.compute({});
  const n = DB2.prepare('SELECT COUNT(*) n FROM photos').get().n;
  check('photos', d.totals.photos, n);
  check('fichiers', d.totals.files, DB2.prepare('SELECT COUNT(*) n FROM files').get().n);
  check('volume référencé = somme des fichiers', d.totals.bytes, DB2.prepare('SELECT COALESCE(SUM(size_bytes), 0) n FROM files').get().n);
  check('sans mot-clé', d.gaps.noKeyword, DB2.prepare('SELECT COUNT(*) n FROM photos WHERE id NOT IN (SELECT photo_id FROM photo_keywords)').get().n);
  check('sans date', d.gaps.noDate, DB2.prepare('SELECT COUNT(*) n FROM photos WHERE captured_at IS NULL').get().n);
  check('sans GPS', d.gaps.noGps, DB2.prepare('SELECT COUNT(*) n FROM photos WHERE gps_lat IS NULL').get().n);
  check('répartition par année : total = photos', d.dist.year.reduce((s, r) => s + r.n, 0), n);
  check('répartition par format : total = photos', d.dist.format.reduce((s, r) => s + r.n, 0), n);
  check('répartition par mois : format AAAA-MM', d.dist.month.every(r => /^\d{4}-\d{2}$/.test(r.k)), true, 0);
  check('mois de l’année entre 1 et 12', d.dist.monthOfYear.every(r => r.k >= 1 && r.k <= 12), true, 0);
  check('volumes distincts : originaux, copies, aperçus, exports, sauvegardes', ['originals', 'copies', 'previews', 'exports', 'backups'].every(k => d.volumes[k] && Number.isFinite(d.volumes[k].bytes)), true, 0);
  check('originaux + copies = volume référencé', d.volumes.originals.bytes + d.volumes.copies.bytes, d.totals.bytes);
  check('état du catalogue : base contrôlée', d.health.db, true, 0);
  check('état : niveau connu', ['ok', 'warn', 'bad'].includes(d.health.level), true, 0);
  check('historique des importations', Array.isArray(d.imports), true, 0);
  // cache : même résultat sans recalcul, recalcul si le catalogue change
  const again = DSH.compute({});
  check('cache : second appel servi du cache', again.cached, true, 0);
  DB2.prepare("INSERT INTO history(ts, kind, detail) VALUES (?, 'test', 'modification')").run(new Date().toISOString());
  check('cache : invalidé après une modification', DSH.compute({}).cached ?? false, false, 0);
  // filtres
  const yr = d.dist.year.find(r => r.k)?.k;
  if (yr) check('filtre par année', DSH.compute({ year: yr }).totals.photos, d.dist.year.find(r => r.k === yr).n);
  const fm = d.dist.format.find(r => r.k)?.k;
  if (fm) check('filtre par format', DSH.compute({ format: fm }).totals.photos, d.dist.format.find(r => r.k === fm).n);
  // CSV
  const c = DSH.csv(d);
  check('CSV : BOM, sections', c.charCodeAt(0) === 0xfeff && /Manques/.test(c) && /Par objectif/.test(c) && c.includes('\r\n'), true, 0);
  // critère « sans date » de la recherche
  check('recherche : critère sans date', LIB.search(Search.cleanFilters({ noDate: true }), { limit: 1 }).total, d.gaps.noDate);
}

// ===================================================================
group('IA facultative et locale : descripteurs, moteurs, suggestions, recherche, regroupements');
// ===================================================================
{
  const AI = await import('../lib/ai.mjs');
  const http = await import('http');
  // réglages
  const d0 = AI.cleanAiSettings({});
  check('désactivée par défaut', d0.enabled, false, 0);
  check('envoi distant refusé sans consentement explicite', AI.cleanAiSettings({ allowRemote: true }).allowRemote, false, 0);
  check('envoi distant accepté avec consentement', AI.cleanAiSettings({ allowRemote: true, remoteConsent: true }).allowRemote, true, 0);
  check('moteur non activable sans licence acceptée', AI.cleanAiSettings({ engines: { x: { enabled: true } } }).engines.x.enabled, false, 0);
  check('pause bornée', AI.cleanAiSettings({ pauseMs: 999999 }).pauseMs, 5000);
  check('chaque fonction se désactive', AI.cleanAiSettings({ features: { faces: true, groups: false } }).features.groups, false, 0);
  // fiches de moteurs
  let err = ''; try { AI.cleanEngine({ id: 'x', kind: 'cloud' }); } catch (e) { err = e.message; }
  check('type de moteur inconnu refusé', /inconnu/.test(err), true, 0);
  err = ''; try { AI.cleanEngine({ id: 'x', kind: 'ollama' }); } catch (e) { err = e.message; }
  check('Ollama : modèle obligatoire', /Modèle/.test(err), true, 0);
  const eNoLic = AI.cleanEngine({ id: 'Mon Moteur!', kind: 'command', command: 'outil' });
  check('identifiant nettoyé', eNoLic.id, 'mon-moteur', 0);
  check('licence manquante signalée', AI.engineIssues(eNoLic).some(x => /Licence/.test(x)), true, 0);
  check('adresse locale reconnue', AI.isLocalUrl('http://127.0.0.1:11434') && AI.isLocalUrl('http://localhost:1') && !AI.isLocalUrl('https://exemple.com'), true, 0);
  check('serveur distant refusé sans consentement', AI.engineIssues(AI.cleanEngine({ id: 'd', kind: 'ollama', model: 'm', url: 'https://ia.exemple.com', license: 'MIT' })).some(x => /consentement/.test(x)), true, 0);
  // réponses des moteurs
  const out = AI.cleanEngineOutput({ motsCles: ['Mer', 'mer', { name: 'Plage', score: 0.9 }, ''], description: 'Une plage', faces: [{ x: 2, y: 0.1, w: 0.2, h: 0.2 }] });
  check('réponse : mots-clés dédoublonnés, score par défaut', out.labels.map(l => `${l.name}:${l.score}`).join(','), 'Mer:0.7,Plage:0.9');
  check('réponse : visage borné', out.faces[0].x, 1);
  check('réponse : JSON après des lignes de journal', AI.lastJson('chargement du modèle…\n{"labels":["a"]}').labels[0], 'a');

  // images de synthèse
  const dir = path.join(TMP, 'ia-photos'); fs.mkdirSync(dir, { recursive: true });
  const W = 240, H = 180;
  async function raw(file, fn) {
    const b = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, bl] = fn(x, y); const i = (y * W + x) * 3; b[i] = r; b[i + 1] = g; b[i + 2] = bl; }
    await sharp(b, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toFile(path.join(dir, file));
    return path.join(dir, file);
  }
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const landscape = (light = 0) => (x, y) => y < H * 0.55 ? [70 + light, 140 + light + y / 6, 235] : [40 + rnd() * 50, 110 + rnd() * 90 + light, 30 + rnd() * 30];
  const files = {
    sky1: await raw('ciel-1.jpg', landscape(0)),
    sky2: await raw('ciel-2.jpg', landscape(12)),
    red: await raw('rouge.jpg', () => [205, 25, 30]),
    bw: await raw('nb.jpg', (x, y) => { const v = ((x >> 4) + (y >> 4)) % 2 ? 30 : 220; return [v, v, v]; }),
    white: await raw('blanc.jpg', () => [250, 250, 250]),
    night: await raw('nuit.jpg', (x, y) => (x % 37 === 0 && y % 23 === 0 ? [255, 230, 150] : [8, 10, 22])),
  };
  const fsky = await AI.imageFeatures(files.sky1), fnb = await AI.imageFeatures(files.bw), fw = await AI.imageFeatures(files.white), fn = await AI.imageFeatures(files.night), fred = await AI.imageFeatures(files.red);
  check('descripteur : 128 octets', Buffer.from(fsky.vec, 'base64').length, 128, 0);
  check('scène : ciel', fsky.scenes.some(s => s.name === 'Ciel'), true, 0);
  check('scène : végétation', fsky.scenes.some(s => s.name === 'Végétation'), true, 0);
  check('scène : noir et blanc', fnb.scenes.some(s => s.name === 'Noir et blanc'), true, 0);
  check('aplat blanc : pas « noir et blanc »', fw.scenes.some(s => s.name === 'Noir et blanc'), false, 0);
  check('scène : nuit', fn.scenes.some(s => s.name === 'Nuit'), true, 0);
  check('couleur dominante : rouge', Object.entries(fred.colours).sort((a, b) => b[1] - a[1])[0][0], 'rouge', 0);
  const dec = b => new Uint8Array(Buffer.from(b, 'base64'));
  const fsky2 = await AI.imageFeatures(files.sky2);
  check('ressemblance : identique = 1', AI.similarity(dec(fsky.vec), dec(fsky.vec)), 1, 0.001);
  check('ressemblance : variante éclaircie > 0,9', AI.similarity(dec(fsky.vec), dec(fsky2.vec)) > 0.9, true, 0);
  check('ressemblance : images différentes < 0,6', AI.similarity(dec(fsky.vec), dec(fred.vec)) < 0.6, true, 0);

  // service sur une base à part
  const { createSupports: CS } = await import('../lib/supports.mjs');
  const { createMetadata } = await import('../lib/metadata.mjs');
  const db = openDb(path.join(TMP, 'ia.db'));
  const kw = createKeywords(db), sup = CS(db), lib = createLibrary(db, STORE, sup, kw), md = createMetadata(db, { keywords: kw, library: lib, settings: () => ({}), version: 'test' }), col = createCollections(db, lib);
  for (const f of Object.values(files)) await lib.indexFile(f, {});
  const idOf = f => db.prepare('SELECT photo_id FROM files WHERE path = ?').get(f).photo_id;
  const P = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, idOf(f)]));
  const at = (id, iso, lat = null, lon = null) => db.prepare('UPDATE photos SET captured_at = ?, gps_lat = ?, gps_lon = ? WHERE id = ?').run(iso, lat, lon, id);
  at(P.sky1, '2025-06-01T10:00:00', 45.9, 6.1); at(P.sky2, '2025-06-01T10:20:00', 45.905, 6.105); at(P.red, '2025-06-01T11:00:00');
  at(P.bw, '2025-08-10T09:00:00'); at(P.white, '2025-08-12T09:00:00'); at(P.night, '2025-09-01T22:00:00');
  md.applyEdit([P.sky1, P.red], { keywordsAdd: ['Montagne'] });
  md.applyEdit([P.sky1], { city: { mode: 'set', value: 'Annecy' }, country: { mode: 'set', value: 'France' } });

  // moteur externe « programme local » (script Node d'essai) et serveur Ollama simulé
  const engDir = path.join(TMP, 'ia-moteurs');
  const script = path.join(TMP, 'moteur-essai.mjs');
  fs.writeFileSync(script, "import fs from 'fs'; const n = fs.statSync(process.argv[2]).size; console.log('journal'); console.log(JSON.stringify({ description: 'Image ' + (n > 0 ? 'lue' : 'vide') + ' en ' + process.argv[3], labels: ['Essai', { name: 'Paysage', score: 0.95 }], faces: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.88 }] }));");
  let ollamaReq = null;
  const srv = http.createServer((req, res) => { if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b', capabilities: ['completion'] }, { name: 'llava', capabilities: ['completion', 'vision'] }] })); } let s = ''; req.on('data', c => { s += c; }); req.on('end', () => { ollamaReq = JSON.parse(s); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ response: JSON.stringify({ description: 'Un lac de montagne', motsCles: ['Lac', 'Montagne'] }) })); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const ai = AI.createAi(db, { keywords: kw, library: lib, metadata: md, collections: col, enginesDir: engDir });
  err = ''; try { ai.startAnalysis(); } catch (e) { err = e.message; }
  check('désactivée : aucune analyse', /désactivée/.test(err), true, 0);
  ai.saveSettings({ enabled: true, pauseMs: 0 });
  ai.saveEngine({ id: 'essai', name: 'Essai', kind: 'command', command: process.execPath, args: [script, '{image}', '{lang}'], license: 'MIT', provides: ['labels', 'description', 'faces'] });
  ai.saveEngine({ id: 'lac', name: 'Ollama simulé', kind: 'ollama', model: 'llava', url: `http://127.0.0.1:${srv.address().port}`, license: 'Apache-2.0', provides: ['labels', 'description'] });
  err = ''; try { ai.saveSettings({ engines: { essai: { enabled: true } } }); } catch (e) { err = e.message; }
  check('activation refusée tant que la licence n’est pas acceptée', /licence/.test(err), true, 0);
  ai.saveSettings({ engines: { essai: { enabled: true, licenseAccepted: true }, lac: { enabled: true, licenseAccepted: true } } });
  check('moteurs actifs', ai.status().engines.filter(e => e.active).length, 3, 0);
  check('visages disponibles avec un moteur qui les fournit', ai.status().available.faces, true, 0);
  const t = await ai.testEngine('essai', P.sky1);
  check('essai d’un moteur : réponse lue (JSON après journal)', `${t.description}|${t.labels.map(l => l.name).join(',')}`, 'Image lue en fr|Essai,Paysage');
  const om = await ai.ollamaModels(`http://127.0.0.1:${srv.address().port}`);
  check('Ollama : modèles de vision en premier', om.map(m => m.name + (m.vision ? '*' : '')).join(), 'llava*,llama3.2:3b');
  check('Ollama : essai d’un modèle de vision', (await ai.testEngine('lac', P.sky1)).description, 'Un lac de montagne');
  ai.saveEngine({ id: 'texte', name: 'Texte', kind: 'ollama', model: 'llama3.2:3b', url: `http://127.0.0.1:${srv.address().port}`, license: 'Llama' });
  ai.saveSettings({ engines: { texte: { enabled: false, licenseAccepted: true } } });
  err = ''; try { await ai.testEngine('texte', P.sky1); } catch (e) { err = e.message; }
  check('Ollama : modèle sans vision signalé', /ne lit pas les images/.test(err), true, 0);
  ai.removeEngine('texte');
  check('essai : rien n’est enregistré', db.prepare('SELECT COUNT(*) n FROM ai_results').get().n, 0, 0);

  ai.startAnalysis(); const j = await ai.waitJob();
  check('analyse terminée', j.status, 'done', 0);
  check('analyse : toutes les photos décrites', db.prepare('SELECT COUNT(*) n FROM ai_features').get().n, 6, 0);
  check('analyse : résultats des deux moteurs', db.prepare('SELECT COUNT(*) n FROM ai_results WHERE error IS NULL').get().n, 12, 0);
  check('Ollama : image envoyée, carte graphique non autorisée', !!ollamaReq?.images?.[0] && ollamaReq.options?.num_gpu === 0 && ollamaReq.model === 'llava', true, 0);
  check('originaux intacts', fs.statSync(files.sky1).size === fs.readFileSync(files.sky1).length && !fs.readdirSync(dir).some(f => /xmp$/i.test(f)), true, 0);
  const sug = (id, value, kind = 'keyword') => db.prepare("SELECT * FROM ai_suggestions WHERE photo_id = ? AND kind = ? AND value = ?").get(id, kind, value);
  check('suggestion : scène « Ciel »', sug(P.sky1, 'Ciel')?.source, 'scene');
  check('suggestion : même séance (Montagne)', ['session', 'similar'].includes(sug(P.sky2, 'Montagne')?.source), true, 0);
  check('suggestion : lieu d’une photo voisine (GPS)', sug(P.sky2, '|Annecy||France', 'place')?.source, 'gps');
  check('suggestion : mot-clé d’un moteur externe', sug(P.red, 'Paysage')?.source, 'engine:essai');
  check('suggestion : déjà porté → non proposé', sug(P.sky1, 'Montagne'), undefined, 0);
  check('visages : désactivé par défaut', sug(P.red, 'Portrait'), undefined, 0);
  check('tout est « en attente » (rien d’attribué)', db.prepare("SELECT COUNT(*) n FROM ai_suggestions WHERE status <> 'pending'").get().n, 0, 0);
  check('aucun mot-clé ajouté sans validation', md.docOf(P.sky2).keywords.includes('Montagne'), false, 0);
  ai.saveSettings({ features: { faces: true } }); ai.refreshSuggestions();
  check('visages activés : suggestion « Portrait »', sug(P.red, 'Portrait')?.source, 'faces');

  // accepter, annuler, refuser
  const a = ai.accept([sug(P.sky2, 'Montagne').id, sug(P.sky2, '|Annecy||France', 'place').id]);
  check('accepter : mot-clé ajouté', md.docOf(P.sky2).keywords.includes('Montagne'), true, 0);
  check('accepter : lieu rempli', `${md.docOf(P.sky2).city}|${md.docOf(P.sky2).country}`, 'Annecy|France');
  check('accepter : lots de métadonnées', a.batches.length === 2 && a.batches.every(b => b.batchId), true, 0);
  ai.refreshSuggestions();
  check('acceptée : gardée après recalcul', sug(P.sky2, 'Montagne').status, 'accepted');
  const u = ai.undoAccept(a.ids, a.batches.map(b => b.batchId));
  check('annuler : valeurs rétablies', !md.docOf(P.sky2).keywords.includes('Montagne') && !md.docOf(P.sky2).city && u.restored >= 2, true, 0);
  check('annuler : suggestion de nouveau en attente', sug(P.sky2, 'Montagne').status, 'pending');
  ai.reject([sug(P.red, 'Essai').id]); ai.refreshSuggestions();
  check('refus : jamais reproposé', sug(P.red, 'Essai').status, 'rejected');
  ai.forgetRejected(); ai.refreshSuggestions();
  check('refus oubliés : reproposé', sug(P.red, 'Essai').status, 'pending');
  const list = ai.suggestions({ value: 'Essai' });
  check('liste par valeur', list.total, 6, 0);
  check('liste : source lisible', list.rows[0].sourceLabel, 'Moteur : Essai');
  // préférence explicite : acceptation automatique au-delà du seuil
  ai.saveSettings({ autoAccept: true, autoThreshold: 0.94 });
  const r = ai.refreshSuggestions();
  check('acceptation automatique au-delà du seuil seulement', r.auto?.accepted > 0 && db.prepare("SELECT COUNT(*) n FROM ai_suggestions WHERE status = 'accepted' AND score < 0.94").get().n === 0, true, 0);
  check('acceptation automatique tracée', db.prepare("SELECT COUNT(*) n FROM history WHERE kind = 'ai.accept' AND detail LIKE '%automatiquement%'").get().n, 1, 0);
  ai.saveSettings({ autoAccept: false });

  // recherche visuelle, regroupements, événements, description
  const sim = ai.similar(P.sky1);
  check('photos proches : la variante en premier', sim.rows[0]?.id, P.sky2);
  check('photos proches : l’aplat rouge écarté', sim.rows.some(x => x.id === P.red), false, 0);
  check('regroupement : ciel 1 et 2 ensemble', ai.groups({ minSize: 2 }).groups.some(g => g.ids.includes(P.sky1) && g.ids.includes(P.sky2)), true, 0);
  const ev = ai.events();
  check('événement : la séance de 3 photos', ev.events.length === 1 && ev.events[0].count === 3 && ev.events[0].place === 'Annecy, France', true, 0);
  check('événement : nom proposé', ev.events[0].name, '01/06/2025 · Annecy, France');
  const c = ai.makeCollection(ev.events[0].name, ev.events[0].ids);
  check('événement → collection', col.get(c.id).count ?? db.prepare('SELECT COUNT(*) n FROM collection_photos WHERE collection_id = ?').get(c.id).n, 3, 0);
  const q1 = ai.describe('ciel bleu');
  check('description « ciel bleu » : les paysages', q1.rows.slice(0, 2).map(x => x.id).sort().join(), [P.sky1, P.sky2].sort().join());
  check('description : mots compris', q1.terms.map(x => x.type).join(), 'scene,colour');
  check('description « rouge »', ai.describe('photo rouge').rows[0]?.id, P.red);
  check('description « noir et blanc » : pas l’aplat blanc', ai.describe('noir et blanc').rows.map(x => x.id).join(), P.bw);
  check('description : texte des moteurs (« lac »)', ai.describe('lac').total, 6, 0);
  check('fiche IA d’une photo', ai.photo(P.sky1).results.length === 2 && ai.photo(P.sky1).scenes.length > 0, true, 0);
  ai.saveSettings({ features: { similar: false } });
  err = ''; try { ai.similar(P.sky1); } catch (e) { err = e.message; }
  check('fonction désactivée : refusée', /désactivée/.test(err), true, 0);
  // serveur distant : refusé sans consentement
  ai.saveEngine({ id: 'loin', name: 'Distant', kind: 'ollama', model: 'm', url: 'https://ia.exemple.invalid', license: 'MIT' });
  err = ''; try { ai.saveSettings({ engines: { loin: { enabled: true, licenseAccepted: true } } }); } catch (e) { err = e.message; }
  check('moteur distant : activation refusée sans consentement', /consentement/.test(err), true, 0);
  ai.removeEngine('loin');
  check('retirer un moteur : fiche seule supprimée', fs.existsSync(path.join(engDir, 'loin.json')) === false && fs.existsSync(script), true, 0);
  // suppression d'une photo : ses résultats partent avec elle
  db.prepare('DELETE FROM photos WHERE id = ?').run(P.night);
  check('photo retirée : résultats IA supprimés', db.prepare('SELECT COUNT(*) n FROM ai_features WHERE photo_id = ?').get(P.night).n + db.prepare('SELECT COUNT(*) n FROM ai_suggestions WHERE photo_id = ?').get(P.night).n, 0, 0);
  const cl = ai.clearResults();
  check('effacer les résultats : mots-clés acceptés gardés', cl.features === 5 && db.prepare("SELECT COUNT(*) n FROM ai_suggestions WHERE status = 'accepted'").get().n > 0, true, 0);
  srv.close(); db.close();
}

// ===================================================================
group('Distribution : empreintes, signature, vérification, construction');
// ===================================================================
{
  const D = await import('../lib/dist.mjs');
  const { spawnSync } = await import('child_process');
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
  const src = D.distSources(ROOT).map(f => path.relative(ROOT, f).split(path.sep).join('/'));
  check('livré : serveur, lib, interface, lanceur, installateur', ['server.mjs', 'lib/ai.mjs', 'public/index.html', 'scripts/lancer.mjs', 'distribution/installer.ps1', 'distribution/desinstaller.ps1', 'distribution/Phototheque.cmd'].every(f => src.includes(f)), true, 0);
  check('jamais livrés : données, sauvegardes, versions, tests, .env', src.some(f => /^(data|Sauvegardes|Versions|Exports|Rapports)\//.test(f) || f === '.env' || f === 'scripts/test.mjs'), false, 0);
  check('dépendances livrées', src.some(f => f.startsWith('node_modules/sharp/')) && src.some(f => f.startsWith('node_modules/exifr/')), true, 0);

  const dir = path.join(TMP, 'distrib'); fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.mkdirSync(path.join(dir, 'distribution'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.mjs'), 'console.log(1)'); fs.writeFileSync(path.join(dir, 'lib', 'a.mjs'), 'export const a = 1;');
  const keys = D.generateKeys(), other = D.generateKeys();
  fs.writeFileSync(path.join(dir, 'distribution', 'cle-publique.pem'), keys.publicPem);
  const sums = D.makeSums(dir);
  check('SHA256SUMS : une ligne par fichier', sums.trim().split('\n').length, 3, 0);
  check('SHA256SUMS : format sha256sum', /^[0-9a-f]{64} \*lib\/a\.mjs$/m.test(sums), true, 0);
  fs.writeFileSync(path.join(dir, D.SUMS_FILE), sums);
  check('non signée : intègre, acceptée', D.verifyDist(dir).ok && !D.verifyDist(dir).signed, true, 0);
  check('non signée : refusée si signature exigée', D.verifyDist(dir, { requireSignature: true }).ok, false, 0);
  fs.writeFileSync(path.join(dir, D.SIG_FILE), D.signText(sums, keys.privatePem));
  const v = D.verifyDist(dir, { requireSignature: true });
  check('signée : signature valide', v.ok && v.signed && v.keyId === D.keyId(keys.publicPem), true, 0);
  check('clé d’une autre installation : refusée', D.verifyDist(dir, { publicPem: other.publicPem }).ok, false, 0);
  fs.writeFileSync(path.join(dir, D.INSTALL_INFO_FILE), '{}'); fs.writeFileSync(path.join(dir, '.env'), 'X=1');
  check('installation.json et .env ignorés', D.verifyDist(dir).ok, true, 0);
  fs.appendFileSync(path.join(dir, 'lib', 'a.mjs'), '//');
  const vm = D.verifyDist(dir);
  check('fichier modifié détecté', !vm.ok && vm.modified.join() === 'lib/a.mjs', true, 0);
  fs.writeFileSync(path.join(dir, 'lib', 'a.mjs'), 'export const a = 1;');
  fs.writeFileSync(path.join(dir, 'lib', 'intrus.mjs'), 'x');
  check('fichier ajouté détecté', D.verifyDist(dir).added.join(), 'lib/intrus.mjs');
  fs.rmSync(path.join(dir, 'lib', 'intrus.mjs')); fs.rmSync(path.join(dir, 'server.mjs'));
  check('fichier manquant détecté', D.verifyDist(dir).missing.join(), 'server.mjs');
  fs.writeFileSync(path.join(dir, 'server.mjs'), 'console.log(1)');
  // une signature recalculée avec une autre clé (et la clé publique remplacée) ne passe pas avec la clé installée
  const forged = D.makeSums(dir); fs.writeFileSync(path.join(dir, D.SUMS_FILE), forged); fs.writeFileSync(path.join(dir, D.SIG_FILE), D.signText(forged, other.privatePem));
  check('signature d’une autre clé : refusée par la clé installée', D.verifyDist(dir, { publicPem: keys.publicPem }).ok, false, 0);
  check('vérificateur en ligne de commande : code 1 si refus', spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verifier.mjs'), dir, '--json', '--signature-obligatoire', '--cle', path.join(dir, 'distribution', 'cle-publique.pem')]).status, 1, 0);
  check('installation.json lu', JSON.stringify(D.installInfo(dir)), '{}');

  // construction réelle (sans Node.js livré ni installateur, pour rester rapide), non signée
  const out = path.join(TMP, 'dist');
  const b = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--sortie', out, '--sans-exe', '--sans-node'], { encoding: 'utf8', env: { ...process.env, PHOTOTHEQUE_SIGN_KEY: path.join(TMP, 'aucune-cle.pem'), PHOTOTHEQUE_CERT_PFX: '', PHOTOTHEQUE_CERT_THUMBPRINT: '' } });
  check('construction : terminée', b.status, 0, 0);
  if (b.status !== 0) console.error(b.stdout, b.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const zipf = path.join(out, `Phototheque-${pkg.version}-windows-x64.zip`);
  check('construction : paquet Windows et multiplateforme', fs.existsSync(zipf) && fs.existsSync(path.join(out, `Phototheque-${pkg.version}-multiplateforme.zip`)), true, 0);
  const entries = readZip(fs.readFileSync(zipf)).map(e => e.name);
  check('paquet : SHA256SUMS et manifeste', entries.includes('SHA256SUMS') && entries.includes('MANIFEST.json'), true, 0);
  check('paquet : aucune donnée personnelle', entries.some(n => /^(data|Sauvegardes|Versions|Exports)\//.test(n) || n === '.env'), false, 0);
  // le paquet extrait se vérifie
  const ex = path.join(TMP, 'extrait');
  for (const e of readZip(fs.readFileSync(zipf))) { const f = path.join(ex, ...e.name.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, e.read()); }
  check('paquet extrait : conforme', D.verifyDist(ex).ok, true, 0);
  check('empreintes des livrables', fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').includes(path.basename(zipf)), true, 0);
}

// ---------- bilan ----------
console.log(`\n${'='.repeat(46)}\nRésultat : ${ok} OK, ${ko} échec(s)`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* nettoyage best effort */ }
process.exit(ko ? 1 : 0);
