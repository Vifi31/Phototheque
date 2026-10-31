// Gestion des supports de stockage (disques, cartes, NAS…).
// Un support est identifié par un empreinte (fingerprint) stable afin de le retrouver même si sa
// lettre/montage change (déconnexion, reconnexion). Le statut distingue « disponible » (présent)
// de « absent » (déconnecté) — un support absent n'est jamais confondu avec des photos supprimées.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logHistory } from './db.mjs';

export const SUPPORT_KINDS = {
  disk: 'Disque dur', sd: 'Carte mémoire', usb: 'Clé USB', nas: 'NAS / réseau',
  camera: 'Appareil photo', smartphone: 'Smartphone', cloud: 'Stockage cloud', other: 'Autre',
};
export const SUPPORT_ROLES = {
  original: 'Originals', backup: 'Sauvegarde', archive: 'Archive', transfer: 'Transfert', unknown: 'Non défini',
};

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const J = v => JSON.stringify(v ?? {});
const P = s => { try { return JSON.parse(s); } catch { return {}; } };

/** Empreinte d'un support : arborescence des premiers entrées de la racine + volume serial.
 *  Permet de reconnaître « le même disque » reconnecté à un autre chemin. */
export function fingerprint(root) {
  try {
    const st = fs.statSync(root);
    if (!st.isDirectory()) return null;
    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.')).slice(0, 64)
      .map(e => `${e.isDirectory() ? 'd' : 'f'}:${e.name}`).sort().join('|');
    return crypto.createHash('sha256').update(String(entries)).digest('hex').slice(0, 32);
  } catch { return null; } // racine inaccessible (support absent)
}

/** Métadonnées de volume Windows (lecteur) : étiquette + numéro de série, via wmic/PowerShell si dispo. */
function volumeInfo(mountPath) {
  const letter = path.resolve(mountPath).slice(0, 2).toUpperCase(); // ex: "E:"
  if (!/^[A-Z]:$/.test(letter)) return {};
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      `powershell -NoProfile -Command "Get-Volume -DriveLetter '${letter[0]}' | Select-Object -Property FileSystemLabel,FileSystem,Size,SizeRemaining | ConvertTo-Json -Compress"`,
      { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    const j = JSON.parse(out);
    return {
      drive_label: j.FileSystemLabel ?? null, filesystem: j.FileSystem ?? null,
      total_bytes: j.Size ?? null, free_bytes: j.SizeRemaining ?? null,
    };
  } catch { return {}; }
}

export function createSupports(db) {
  const map = r => r ? ({ ...r, data: P(r.data) }) : r;

  /** Ajoute ou recrée un support à partir d'un chemin monté (ou d'un support « cloud » sans chemin). */
  function upsert({ id, name, kind = 'disk', role = 'original', mount_path = '', brand = '', model = '', serial = '', location = '', comments = '' }) {
    const existing = id ? db.prepare('SELECT * FROM supports WHERE id = ?').get(id) : null;
    const fp = mount_path ? fingerprint(mount_path) : null;
    const vol = mount_path ? volumeInfo(mount_path) : {};
    const rec = {
      id: existing?.id ?? uid(),
      name: String(name || existing?.name || path.basename(mount_path || 'Support')).slice(0, 120),
      kind, brand, model, serial, location, comments,
      mount_path: mount_path || existing?.mount_path || '',
      drive_label: vol.drive_label ?? existing?.drive_label ?? null,
      filesystem: vol.filesystem ?? existing?.filesystem ?? null,
      total_bytes: vol.total_bytes ?? existing?.total_bytes ?? null,
      free_bytes: vol.free_bytes ?? existing?.free_bytes ?? null,
      role, fp,
      status: mount_path ? (fp ? 'available' : 'absent') : (existing?.status ?? 'unknown'),
    };
    db.prepare(`INSERT INTO supports(id,name,kind,brand,model,serial,filesystem,total_bytes,free_bytes,mount_path,drive_label,volume_serial,role,status,location,comments,added_at,checked_at,fingerprint,data)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,brand=excluded.brand,model=excluded.model,serial=excluded.serial,
        filesystem=excluded.filesystem,total_bytes=excluded.total_bytes,free_bytes=excluded.free_bytes,mount_path=excluded.mount_path,
        drive_label=excluded.drive_label,role=excluded.role,status=excluded.status,location=excluded.location,comments=excluded.comments,
        checked_at=excluded.checked_at,fingerprint=excluded.fingerprint`)
      .run(rec.id, rec.name, rec.kind, rec.brand, rec.model, rec.serial, rec.filesystem, rec.total_bytes, rec.free_bytes,
        rec.mount_path, rec.drive_label, existing?.volume_serial ?? null, rec.role, rec.status, rec.location, rec.comments,
        existing?.added_at ?? now(), now(), rec.fp, existing?.data ? (typeof existing.data === 'string' ? existing.data : J(existing.data)) : '{}');
    logHistory(db, existing ? 'support.update' : 'support.add', `Support « ${rec.name} » ${existing ? 'modifié' : 'ajouté'}`, { id: rec.id, status: rec.status });
    return get(rec.id);
  }

  const get = id => map(db.prepare('SELECT * FROM supports WHERE id = ?').get(id));
  const list = () => db.prepare('SELECT * FROM supports ORDER BY name').all().map(map);
  const remove = id => { const s = get(id); if (!s) throw new Error('Support inconnu'); db.prepare('DELETE FROM supports WHERE id = ?').run(id); logHistory(db, 'support.remove', `Support « ${s.name} » retiré`, { id }); return s; };

  /** Rafraîchit le statut (et le chemin monté) de tous les supports. Reconnecte par empreinte si le chemin a changé. */
  function refresh() {
    const byFp = new Map(list().filter(s => s.fingerprint).map(s => [s.fingerprint, s]));
    const out = [];
    for (const s of list()) {
      if (!s.mount_path) { out.push({ id: s.id, status: s.status }); continue; }
      const fp = fingerprint(s.mount_path);
      if (fp) { // présent au même chemin
        if (fp !== s.fingerprint) db.prepare('UPDATE supports SET fingerprint=?, status=?, checked_at=? WHERE id = ?').run(fp, 'available', now(), s.id);
        else db.prepare('UPDATE supports SET status=?, checked_at=? WHERE id = ?').run('available', now(), s.id);
        out.push({ id: s.id, status: 'available' });
      } else {
        // absent : chercher si une racine candidate correspond à l'empreinte (reconnexion autre chemin)
        const hit = findReconnect(s, byFp);
        if (hit) {
          db.prepare('UPDATE supports SET mount_path=?, status=?, checked_at=? WHERE id = ?').run(hit, 'available', now(), s.id);
          out.push({ id: s.id, status: 'available', remounted: hit });
        } else {
          db.prepare('UPDATE supports SET status=?, checked_at=? WHERE id = ?').run('absent', now(), s.id);
          out.push({ id: s.id, status: 'absent' });
        }
      }
    }
    return out;
  }

  /** Cherche, parmi des racines candidates, un chemin dont l'empreinte correspond au support. */
  function findReconnect(support, byFp) {
    const candidates = candidateRoots(support);
    for (const c of candidates) { if (fingerprint(c) === support.fingerprint) return c; }
    void byFp; return null;
  }
  /** Racines probables : lettres de lecteur amovibles, ou le chemin d'origine. */
  function candidateRoots(support) {
    const out = [];
    if (support.mount_path) out.push(support.mount_path);
    try {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const root = letter + ':\\';
        try { if (fs.existsSync(root)) out.push(root); } catch { /* ignoré */ }
      }
    } catch { /* pas d'énumération possible */ }
    return [...new Set(out)];
  }

  /** Tous les fichiers rattachés à un support, avec statut de disponibilité de leur dossier. */
  function files(supportId) { return db.prepare('SELECT * FROM files WHERE support_id = ? ORDER BY path').all(supportId).map(map); }

  /** Statistiques globales des supports. */
  function stats() {
    const all = list();
    return {
      total: all.length,
      available: all.filter(s => s.status === 'available').length,
      absent: all.filter(s => s.status === 'absent').length,
      byRole: all.reduce((a, s) => ((a[s.role] = (a[s.role] ?? 0) + 1), a), {}),
    };
  }

  return { upsert, get, list, remove, refresh, files, stats, fingerprint, SUPPORT_KINDS, SUPPORT_ROLES };
}
