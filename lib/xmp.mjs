// Métadonnées documentaires et fichiers XMP annexes (« sidecars »), §8 du cahier des charges.
//
// Politique (docs/ARCHITECTURE.md §20) :
//   1. La base est la référence : ce qui est saisi dans Photothèque n'est jamais écrasé sans aperçu.
//   2. Lecture : XMP annexe, puis métadonnées embarquées (XMP / IPTC / EXIF du fichier) ; à l'indexation
//      d'une nouvelle photo, elles remplissent seulement les champs vides de la fiche.
//   3. Écriture : uniquement dans un XMP annexe (à côté de l'original ou dans le dossier Metadonnees/),
//      jamais dans le fichier original.
//
// Ce module est pur (aucun accès à la base) : construction, lecture, comparaison des champs.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Champs documentaires échangés avec les XMP, dans l'ordre d'affichage. */
export const DOC_FIELDS = {
  title: 'Titre', description: 'Description', author: 'Auteur', copyright: 'Copyright',
  rating: 'Note', color: 'Étiquette de couleur', keywords: 'Mots-clés',
  sublocation: 'Lieu précis', city: 'Ville', state: 'Région', country: 'Pays',
};
/** Champs de lieu : clé interne → clé de photos.data (noms IPTC / XMP lus à l'indexation). */
export const PLACE_KEYS = { sublocation: 'Sublocation', city: 'City', state: 'State', country: 'Country' };
/** Étiquettes de couleur : rang Photothèque (1 à 5) ↔ libellé XMP (convention Lightroom / Bridge). */
export const LABELS = ['', 'Red', 'Yellow', 'Green', 'Blue', 'Purple'];
export const LABELS_FR = ['', 'Rouge', 'Jaune', 'Vert', 'Bleu', 'Violet'];
const LABEL_ALIASES = { red: 1, rouge: 1, yellow: 2, jaune: 2, green: 3, vert: 3, blue: 4, bleu: 4, purple: 5, violet: 5 };
export const labelRank = v => { if (v == null || v === '') return 0; if (Number.isFinite(+v)) return Math.max(0, Math.min(5, Math.round(+v))); return LABEL_ALIASES[String(v).trim().toLowerCase()] ?? 0; };

const xmlEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const xmlUnesc = s => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
  const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return Number.isFinite(n) ? String.fromCodePoint(n) : m;
});

/** Valeur texte propre (chaîne, tableau → premier élément, objet { value } des textes multilingues). */
export function textOf(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return textOf(v.value ?? v['x-default'] ?? Object.values(v)[0]);
  return String(v).replace(/\u0000+$/, '').trim();
}
const listOf = v => (v == null ? [] : Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\s*[;,]\s*/) : [v]).map(textOf).filter(Boolean);

/** Normalise un objet de champs documentaires (valeurs vides → '' ou 0 ; mots-clés : liste de chemins « a|b »). */
export function cleanDoc(d = {}) {
  const out = {};
  for (const k of ['title', 'description', 'author', 'copyright', 'sublocation', 'city', 'state', 'country']) out[k] = textOf(d[k]).slice(0, k === 'description' ? 4000 : 400);
  out.rating = Math.max(0, Math.min(5, Math.round(+d.rating || 0)));
  out.color = labelRank(d.color);
  const seen = new Set();
  out.keywords = listOf(d.keywords).map(k => k.split('|').map(x => x.trim()).filter(Boolean).join('|')).filter(k => k && !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase())).slice(0, 200);
  return out;
}

/**
 * Champs documentaires lus par exifr (sortie fusionnée EXIF / IPTC / XMP, clés traduites).
 * Les noms XMP l'emportent sur IPTC, qui l'emporte sur EXIF (même ordre que les logiciels courants).
 */
export function docFromExifr(t = {}) {
  // exifr rend le texte XMP sans décoder les entités (&amp;, &lt;…)
  const first = (...keys) => { for (const k of keys) { const v = xmlUnesc(textOf(t[k])); if (v) return v; } return ''; };
  const hier = listOf(t.hierarchicalSubject ?? t.HierarchicalSubject).map(xmlUnesc);
  const flat = [...new Set([...listOf(t.subject), ...listOf(t.Keywords)].map(xmlUnesc))];
  return cleanDoc({
    title: first('title', 'ObjectName', 'Headline', 'XPTitle'),
    description: first('description', 'Caption', 'ImageDescription', 'XPComment'),
    author: first('creator', 'Byline', 'Artist', 'XPAuthor'),
    copyright: first('rights', 'CopyrightNotice', 'Copyright'),
    rating: t.Rating ?? t.rating ?? 0,
    color: t.Label ?? t.label ?? '',
    keywords: mergeKeywordPaths(hier, flat),
    sublocation: first('Location', 'Sublocation', 'SubLocation'),
    city: first('City'), state: first('State', 'ProvinceState'), country: first('Country', 'CountryName'),
  });
}
/** Chemins hiérarchiques + mots-clés plats non couverts par la feuille d'un chemin. */
function mergeKeywordPaths(hier, flat) {
  const leaves = new Set(hier.map(p => p.split('|').pop().trim().toLowerCase()));
  return [...hier, ...flat.filter(k => !leaves.has(k.toLowerCase()))];
}

/** Construit le paquet XMP d'une fiche (`doc` : sortie de cleanDoc ; `extra.captured_at`, `extra.tool`). */
export function buildXmp(doc, { captured_at = null, tool = 'Photothèque' } = {}) {
  const d = cleanDoc(doc);
  const attrs = [`xmp:CreatorTool="${xmlEsc(tool)}"`];
  if (d.rating) attrs.push(`xmp:Rating="${d.rating}"`);
  if (d.color) attrs.push(`xmp:Label="${LABELS[d.color]}"`);
  if (captured_at) attrs.push(`photoshop:DateCreated="${xmlEsc(String(captured_at).replace(/\.\d+Z?$/, '').replace(/Z$/, ''))}"`);
  for (const [k, prop] of [['city', 'photoshop:City'], ['state', 'photoshop:State'], ['country', 'photoshop:Country'], ['sublocation', 'Iptc4xmpCore:Location']]) if (d[k]) attrs.push(`${prop}="${xmlEsc(d[k])}"`);
  const alt = (name, v) => v ? `   <${name}><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(v)}</rdf:li></rdf:Alt></${name}>\n` : '';
  const bag = (name, list, kind = 'Bag') => list.length ? `   <${name}><rdf:${kind}>${list.map(v => `<rdf:li>${xmlEsc(v)}</rdf:li>`).join('')}</rdf:${kind}></${name}>\n` : '';
  const leaves = [...new Set(d.keywords.map(k => k.split('|').pop()))];
  const hier = d.keywords.filter(k => k.includes('|'));
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${xmlEsc(tool)}">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"
    ${attrs.join('\n    ')}>
${alt('dc:title', d.title)}${alt('dc:description', d.description)}${bag('dc:creator', d.author ? [d.author] : [], 'Seq')}${alt('dc:rights', d.copyright)}${bag('dc:subject', leaves)}${bag('lr:hierarchicalSubject', hier)}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/** Lit une propriété XMP (forme attribut ou élément ; rdf:Alt / Seq / Bag → liste). */
function prop(xml, qname) {
  const q = qname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`[\\s"']${q}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xml);
  if (a) return [xmlUnesc(a[1] ?? a[2])];
  const e = new RegExp(`<${q}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${q}>)`).exec(xml);
  if (!e) return null;
  const inner = e[1] ?? '';
  const lis = [...inner.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)];
  if (lis.length) {
    // texte multilingue : x-default d'abord
    const def = lis.find(m => /xml:lang\s*=\s*["']x-default["']/.test(m[0]));
    return (def ? [def, ...lis.filter(m => m !== def)] : lis).map(m => xmlUnesc(m[1].trim()));
  }
  return [xmlUnesc(inner.replace(/<[^>]+>/g, '').trim())];
}

/** Champs documentaires d'un XMP (annexe ou paquet), et l'outil qui l'a écrit. */
export function parseXmp(xml) {
  xml = String(xml ?? '');
  const one = q => (prop(xml, q) ?? [])[0] ?? '';
  const many = q => prop(xml, q) ?? [];
  const doc = cleanDoc({
    title: one('dc:title'), description: one('dc:description'), author: one('dc:creator'), copyright: one('dc:rights'),
    rating: one('xmp:Rating'), color: one('xmp:Label'),
    keywords: mergeKeywordPaths(many('lr:hierarchicalSubject'), many('dc:subject')),
    sublocation: one('Iptc4xmpCore:Location'), city: one('photoshop:City'), state: one('photoshop:State'), country: one('photoshop:Country'),
  });
  return { doc, tool: one('xmp:CreatorTool') || (/x:xmptk="([^"]*)"/.exec(xml)?.[1] ?? '') };
}

export const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/** Valeur d'affichage d'un champ (comparaisons et aperçus). */
export function showValue(field, v) {
  if (field === 'keywords') return (v ?? []).join(', ');
  if (field === 'rating') return v ? `${v} / 5` : '';
  if (field === 'color') return LABELS_FR[v] ?? '';
  return v ?? '';
}
/** Égalité de deux valeurs d'un champ (mots-clés : mêmes chemins, sans tenir compte de l'ordre ni de la casse). */
export function sameValue(field, a, b) {
  if (field === 'keywords') {
    const n = l => [...new Set((l ?? []).map(x => String(x).toLowerCase()))].sort().join('\n');
    return n(a) === n(b);
  }
  if (field === 'rating' || field === 'color') return (+a || 0) === (+b || 0);
  return String(a ?? '').trim() === String(b ?? '').trim();
}
export const isEmpty = (field, v) => field === 'keywords' ? !(v ?? []).length : field === 'rating' || field === 'color' ? !(+v) : !String(v ?? '').trim();

/**
 * Emplacements possibles du XMP annexe d'un fichier.
 * `beside` : à côté de l'original, « IMG_0001.xmp » (convention Adobe) ou « IMG_0001.jpg.xmp » (darktable…) ;
 * `folder` : sous `dir` (Metadonnees/), en reprenant le chemin complet (lecteur compris) pour éviter les collisions.
 */
export function sidecarPath(file, { destination = 'folder', naming = 'adobe', dir }) {
  const name = naming === 'full' ? path.basename(file) + '.xmp' : path.basename(file, path.extname(file)) + '.xmp';
  if (destination === 'beside') return path.join(path.dirname(file), name);
  const parts = path.resolve(path.dirname(file)).split(/[\\/]+/).filter(Boolean).map(p => p.replace(/[:*?"<>|]/g, '').trim() || '_');
  return path.join(dir, ...parts, name);
}
/** Annexes existantes d'un fichier, par ordre de priorité (à côté : les deux nommages ; puis dossier dédié). */
export function findSidecars(file, dir) {
  const c = [sidecarPath(file, { destination: 'beside', naming: 'adobe' }), sidecarPath(file, { destination: 'beside', naming: 'full' }),
    sidecarPath(file, { destination: 'folder', naming: 'adobe', dir }), sidecarPath(file, { destination: 'folder', naming: 'full', dir })];
  return [...new Set(c)].filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

/** Description d'un profil ICC (étiquette « desc », types desc v2 et mluc v4). */
export function iccDescription(buf) {
  try {
    if (!buf || buf.length < 132) return '';
    const n = buf.readUInt32BE(128);
    for (let i = 0; i < Math.min(n, 100); i++) {
      const o = 132 + i * 12; if (o + 12 > buf.length) break;
      if (buf.toString('latin1', o, o + 4) !== 'desc') continue;
      const off = buf.readUInt32BE(o + 4), size = buf.readUInt32BE(o + 8);
      const type = buf.toString('latin1', off, off + 4);
      if (type === 'desc') { const len = buf.readUInt32BE(off + 8); return buf.toString('latin1', off + 12, off + 12 + Math.max(0, len - 1)).trim(); }
      if (type === 'mluc') {
        const recs = buf.readUInt32BE(off + 8); if (!recs) return '';
        const len = buf.readUInt32BE(off + 20), so = buf.readUInt32BE(off + 24);
        const s = buf.subarray(off + so, Math.min(off + so + len, off + size));
        let out = ''; for (let j = 0; j + 1 < s.length; j += 2) out += String.fromCharCode(s.readUInt16BE(j));
        return out.replace(/\u0000+$/, '').trim();
      }
    }
  } catch { /* profil illisible */ }
  return '';
}
