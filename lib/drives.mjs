// Détection des supports de stockage branchés (cartes mémoire, clés USB, disques) pour l'écran Importation.
// Lecture seule : rien n'est écrit sur les lecteurs. Windows : Win32_LogicalDisk (PowerShell) ; ailleurs :
// points de montage usuels (/Volumes, /media, /run/media, /mnt). Les fonctions de classement sont pures.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

/** Types Win32_LogicalDisk.DriveType. */
export const DRIVE_TYPES = { 0: 'unknown', 1: 'norootdir', 2: 'removable', 3: 'fixed', 4: 'network', 5: 'optical', 6: 'ram' };

export const DRIVE_KIND_LABELS = { sd: 'Carte mémoire', usb: 'Clé USB', disk: 'Disque', nas: 'Réseau', optical: 'Disque optique', other: 'Autre' };

/** Normalise la sortie JSON de Get-CimInstance (un objet seul ou un tableau) : lecteurs prêts uniquement. */
export function parseWindowsDisks(json) {
  let data = json;
  if (typeof json === 'string') { try { data = JSON.parse(json.trim() || '[]'); } catch { return []; } }
  if (!data) return [];
  const list = Array.isArray(data) ? data : [data];
  const out = [];
  for (const d of list) {
    const letter = String(d.DeviceID ?? '').slice(0, 2).toUpperCase();
    if (!/^[A-Z]:$/.test(letter)) continue;
    const total = Number(d.Size) || 0;
    // lecteur de cartes vide ou disque optique sans disque : pas de volume monté
    if (!total || !d.FileSystem) continue;
    out.push({
      root: letter + '\\', letter,
      label: String(d.VolumeName ?? '').trim(),
      filesystem: String(d.FileSystem ?? '').trim(),
      driveType: DRIVE_TYPES[Number(d.DriveType)] ?? 'unknown',
      total, free: Number(d.FreeSpace) || 0,
      serial: d.VolumeSerialNumber ? String(d.VolumeSerialNumber).trim() : null,
    });
  }
  return out;
}

/**
 * Nature probable d'un lecteur. Amovible + dossier DCIM à la racine = carte d'appareil photo ; amovible sans DCIM = clé USB ;
 * fixe = disque (un disque dur externe USB est vu comme fixe par Windows) ; réseau = NAS.
 */
export function classifyDrive(d, { systemDrive = 'C:' } = {}) {
  const system = String(d.letter ?? '').toUpperCase() === String(systemDrive).toUpperCase();
  let kind = 'other';
  if (d.driveType === 'removable') kind = d.dcim ? 'sd' : 'usb';
  else if (d.driveType === 'fixed') kind = d.dcim && !system && d.total <= 1024 ** 4 / 2 ? 'sd' : 'disk';
  else if (d.driveType === 'network') kind = 'nas';
  else if (d.driveType === 'optical') kind = 'optical';
  // à proposer en premier : ce qui se branche et contient des photos d'appareil
  const likelyImport = !system && (d.driveType === 'removable' || !!d.dcim);
  return { ...d, system, kind, kindLabel: DRIVE_KIND_LABELS[kind], likelyImport };
}

const run = (cmd, args, timeout = 8000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(String(stdout)));
});

function hasDir(root, name) {
  try { return fs.statSync(path.join(root, name)).isDirectory(); } catch { return false; }
}

/** Lecteurs Windows : PowerShell, sinon repli sur les lettres existantes (sans libellé ni type). */
async function windowsDrives(exec) {
  try {
    const out = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,FileSystem,Size,FreeSpace,VolumeSerialNumber | ConvertTo-Json -Compress']);
    return parseWindowsDisks(out);
  } catch {
    const out = [];
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const root = letter + ':\\';
      try { if (fs.existsSync(root)) out.push({ root, letter: letter + ':', label: '', filesystem: '', driveType: letter === 'C' ? 'fixed' : 'unknown', total: 0, free: 0, serial: null }); } catch { /* lecteur inaccessible */ }
    }
    return out;
  }
}

/** macOS / Linux : sous-dossiers des points de montage usuels. */
function unixDrives() {
  const roots = [];
  const user = os.userInfo().username;
  for (const base of ['/Volumes', `/media/${user}`, `/run/media/${user}`, '/media', '/mnt']) {
    let entries; try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isDirectory() || e.isSymbolicLink()) roots.push(path.join(base, e.name));
  }
  const out = [];
  for (const root of [...new Set(roots)]) {
    let total = 0, free = 0;
    try { const s = fs.statfsSync(root); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch { continue; }
    if (!total) continue;
    // le disque de démarrage de macOS apparaît aussi dans /Volumes : alias de « / »
    try { if (fs.realpathSync(root) === '/') continue; } catch { /* ignoré */ }
    out.push({ root, letter: '', label: path.basename(root), filesystem: '', driveType: 'removable', total, free, serial: null });
  }
  return out;
}

/**
 * Détecte les lecteurs branchés. `opts` pour les tests : platform, exec (remplace PowerShell), systemDrive.
 * Chaque lecteur : { root, letter, label, filesystem, driveType, kind, kindLabel, total, free, serial, dcim, system, likelyImport }.
 */
export async function detectDrives(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? run;
  const systemDrive = opts.systemDrive ?? (process.env.SystemDrive || 'C:');
  const raw = platform === 'win32' ? await windowsDrives(exec) : unixDrives();
  const list = raw.map(d => {
    // ne pas sonder les lecteurs réseau (peut bloquer longtemps) : DCIM seulement sur les volumes locaux
    const dcim = d.driveType !== 'network' && hasDir(d.root, 'DCIM') ? path.join(d.root, 'DCIM') : null;
    return classifyDrive({ ...d, dcim }, { systemDrive });
  });
  // amovibles et cartes d'abord, puis le reste par lettre
  return list.sort((a, b) => (b.likelyImport - a.likelyImport) || String(a.root).localeCompare(String(b.root)));
}
