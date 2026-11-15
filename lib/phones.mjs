// Téléphones et appareils photo branchés en mode transfert de fichiers (MTP / PTP), sous Windows.
//
// Ces appareils n'ont pas de lettre de lecteur : Windows les montre dans « Ce PC » comme des « appareils portables »
// et ne les expose qu'à l'interface Shell (Shell.Application), pas au système de fichiers que lit Node. On passe donc
// par un script PowerShell (COM) pour : détecter les appareils, lister leurs photos (DCIM, Pictures) et en copier.
//
// Lecture seule : rien n'est écrit, renommé ni supprimé sur l'appareil. Les photos sont copiées vers un dossier
// temporaire, puis importées par lib/imports.mjs (copie uniquement : pas de déplacement depuis un téléphone).
//
// Sécurité : le script est constant (-EncodedCommand) ; les données (appareil, fichiers, dossier de destination) passent
// par un fichier JSON temporaire, jamais dans le texte du script. Les chemins demandés doivent provenir d'une liste
// établie par ce module (contrôlé dans imports.mjs).
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

/** Constructeurs reconnus par leur identifiant USB (vid). */
const VENDORS = {
  '05ac': { brand: 'Apple', kind: 'phone', label: 'iPhone / iPad' },
  '04e8': { brand: 'Samsung', kind: 'phone' }, '18d1': { brand: 'Google', kind: 'phone' }, '2717': { brand: 'Xiaomi', kind: 'phone' },
  '22b8': { brand: 'Motorola', kind: 'phone' }, '12d1': { brand: 'Huawei', kind: 'phone' }, '2a70': { brand: 'OnePlus', kind: 'phone' },
  '0fce': { brand: 'Sony', kind: 'phone' }, '1004': { brand: 'LG', kind: 'phone' }, '0bb4': { brand: 'HTC', kind: 'phone' },
  '22d9': { brand: 'OPPO', kind: 'phone' }, '2d95': { brand: 'vivo', kind: 'phone' }, '19d2': { brand: 'ZTE', kind: 'phone' },
  '04a9': { brand: 'Canon', kind: 'camera' }, '04b0': { brand: 'Nikon', kind: 'camera' }, '054c': { brand: 'Sony', kind: 'camera' },
  '04cb': { brand: 'Fujifilm', kind: 'camera' }, '04da': { brand: 'Panasonic', kind: 'camera' }, '07b4': { brand: 'Olympus', kind: 'camera' },
};

/** Nature d'un appareil portable d'après son identifiant USB : { brand, kind: 'phone' | 'camera', kindLabel }. */
export function classifyPortable(vid, name = '') {
  const v = VENDORS[String(vid ?? '').toLowerCase()];
  const looksCamera = /canon|nikon|eos|fuji|lumix|olympus|camera|appareil photo/i.test(name);
  const kind = v?.kind ?? (looksCamera ? 'camera' : 'phone');
  const kindLabel = v?.label ?? (kind === 'camera' ? 'Appareil photo' : (/iphone|ipad/i.test(name) ? 'iPhone / iPad' : 'Téléphone'));
  return { brand: v?.brand ?? null, kind, kindLabel };
}

/** Normalise la réponse du script de détection (un objet ou un tableau d'appareils). Pure et testée. */
export function parsePortableDevices(payload) {
  let data = payload;
  if (typeof payload === 'string') { try { data = JSON.parse(payload); } catch { return []; } }
  const raw = data?.devices ?? data ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const d of list) {
    if (!d || !d.path || !d.name) continue;
    const storages = [].concat(d.storages ?? []).map(String).filter(Boolean);
    const c = classifyPortable(d.vid, String(d.name));
    out.push({
      id: 'ph-' + crypto.createHash('sha1').update(String(d.path)).digest('hex').slice(0, 12),
      name: String(d.name), path: String(d.path), vid: d.vid ? String(d.vid) : null,
      ...c, storages,
      // un appareil verrouillé, ou pas en « transfert de fichiers », n'expose aucun stockage
      ready: storages.length > 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Script PowerShell (Windows PowerShell 5.1). Une seule opération par exécution : detect | list | copy.
// Entrée : fichier JSON désigné par $env:PT_REQ. Sortie : une ligne JSON par résultat (UTF-8).
// ---------------------------------------------------------------------------------------------------------------------
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$req = Get-Content -LiteralPath $env:PT_REQ -Raw -Encoding UTF8 | ConvertFrom-Json
$sh = New-Object -ComObject Shell.Application
function Emit($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 8)) }
# toute erreur non prévue : une ligne {fatal} lisible par Node (et non le bruit CLIXML de PowerShell)
trap { Emit @{ fatal = $_.Exception.Message }; exit 1 }

# Appareils portables de « Ce PC » : pas de lettre de lecteur, chemin Shell contenant l'identifiant USB / WPD
function Get-Devices {
  foreach ($it in $sh.NameSpace(17).Items()) {
    $p = [string]$it.Path
    if ($p -match '^[A-Za-z]:\\') { continue }
    if ($p -match '(?i)usb#vid_|wpdbusenum|\{6ac27878-a6fa-4155-ba85-f98f491d4f33\}') { $it }
  }
}
# Dossier racine de l'opération : l'appareil désigné, ou (tests) un dossier ordinaire joué comme un appareil
function Get-RootFolder {
  if ($req.folderRoot) { $f = $sh.NameSpace([string]$req.folderRoot); if (-not $f) { throw 'Dossier introuvable' }; return $f }
  foreach ($d in Get-Devices) { if ([string]$d.Path -eq [string]$req.devicePath) { return $d.GetFolder } }
  throw 'Appareil introuvable (débranché ?)'
}
function Find-Child($folder, $name) {
  foreach ($c in $folder.Items()) { if ([string]$c.Name -eq $name) { return $c } }
  return $null
}

if ($req.op -eq 'detect') {
  $res = @()
  foreach ($d in Get-Devices) {
    $storages = @()
    try { $f = $d.GetFolder; if ($f) { foreach ($s in $f.Items()) { $storages += [string]$s.Name } } } catch { }
    $vid = ''
    if ([string]$d.Path -match '(?i)vid_([0-9a-f]{4})') { $vid = $Matches[1].ToLower() }
    $res += [pscustomobject]@{ name = [string]$d.Name; path = [string]$d.Path; vid = $vid; storages = @($storages) }
  }
  Emit @{ devices = @($res) }
  exit 0
}

if ($req.op -eq 'list') {
  $imgExt = @('jpg','jpeg','jpe','jfif','png','gif','tif','tiff','webp','bmp','heic','heif','avif','cr2','cr3','nef','arw','orf','rw2','dng','raf','pef','srw','raw')
  $roots = @($req.roots | ForEach-Object { ([string]$_).ToLower() })
  $limit = [int]$req.limit
  $script:count = 0; $script:truncated = $false
  function Walk($folder, $rel, $depth) {
    if ($depth -gt 10 -or $script:truncated) { return }
    foreach ($it in $folder.Items()) {
      if ($script:truncated) { return }
      $name = [string]$it.Name
      $relp = if ($rel) { $rel + '\' + $name } else { $name }
      $isDir = $false
      try { $isDir = [bool]$it.IsFolder } catch { }
      if ($isDir -and $name -notmatch '(?i)\.(zip|cab)$') {
        $sub = $null; try { $sub = $it.GetFolder } catch { }
        if ($sub) { Walk $sub $relp ($depth + 1) }
        continue
      }
      $ext = ''
      if ($name -match '\.([A-Za-z0-9]{2,5})$') { $ext = $Matches[1].ToLower() }
      elseif ([string]$it.Type -match '(?i)jpe?g') { $ext = 'jpg'; $name += '.jpg' }
      elseif ([string]$it.Type -match '(?i)png') { $ext = 'png'; $name += '.png' }
      elseif ([string]$it.Type -match '(?i)hei[cf]') { $ext = 'heic'; $name += '.heic' }
      if ($imgExt -notcontains $ext) { continue }
      if ($script:count -ge $limit) { $script:truncated = $true; return }
      $size = $null; try { $size = [int64]$it.Size } catch { }
      $mt = $null; try { $mt = ([DateTimeOffset]$it.ModifyDate).ToUnixTimeMilliseconds() } catch { }
      # le nom d'origine (pour retrouver l'élément) peut différer du nom affiché si l'extension était masquée
      Emit @{ f = @{ rel = $relp; name = $name; shown = [string]$it.Name; size = $size; mtime = $mt } }
      $script:count++
    }
  }
  $root = Get-RootFolder
  foreach ($storage in $root.Items()) {
    $sf = $null; try { $sf = $storage.GetFolder } catch { }
    if (-not $sf) { continue }
    foreach ($top in $sf.Items()) {
      if ($roots -contains ([string]$top.Name).ToLower()) {
        $tf = $null; try { $tf = $top.GetFolder } catch { }
        if ($tf) { Walk $tf ([string]$storage.Name + '\' + [string]$top.Name) 1 }
      }
    }
  }
  Emit @{ done = $true; truncated = $script:truncated; count = $script:count }
  exit 0
}

if ($req.op -eq 'copy') {
  $root = Get-RootFolder
  foreach ($job in $req.files) {
    try {
      # retrouve l'élément en descendant le chemin affiché (Stockage\DCIM\Camera\IMG_0001.jpg)
      $parts = ([string]$job.rel) -split '\\'
      $f = $root; $item = $null
      for ($i = 0; $i -lt $parts.Count; $i++) {
        $item = Find-Child $f $parts[$i]
        if (-not $item) { throw ('introuvable : ' + $job.rel) }
        if ($i -lt $parts.Count - 1) { $f = $item.GetFolder }
      }
      $dir = [string]$job.to
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $dir = (Resolve-Path -LiteralPath $dir).ProviderPath   # Shell.NameSpace exige des antislashs
      $ns = $sh.NameSpace($dir)
      # 4 : sans boîte de progression ; 16 : « oui à tout » ; 0x400 : sans boîte d'erreur
      $ns.CopyHere($item, 0x414)
      $size = [int64]$job.size
      $deadline = (Get-Date).AddSeconds([Math]::Max(60, [int]($size / 1MB * 4) + 30))
      $ok = $false
      while ((Get-Date) -lt $deadline) {
        $fi = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($fi -and $fi.Length -gt 0) {
          $l1 = $fi.Length; Start-Sleep -Milliseconds 400; $fi.Refresh()
          if ($fi.Length -eq $l1 -and ($size -le 0 -or $fi.Length -ge $size)) {
            # fichier libéré par l'Explorateur : la copie est terminée
            try { $h = [IO.File]::Open($fi.FullName, 'Open', 'Read', 'None'); $h.Close(); $ok = $true; break } catch { }
          }
        }
        Start-Sleep -Milliseconds 200
      }
      if (-not $ok) { throw 'copie incomplète ou trop lente' }
      $fi = Get-ChildItem -LiteralPath $dir -File | Select-Object -First 1
      if ($fi.Name -ne [string]$job.name) { Rename-Item -LiteralPath $fi.FullName -NewName ([string]$job.name) }
      Emit @{ ok = $true; rel = [string]$job.rel }
    } catch {
      Emit @{ ok = $false; rel = [string]$job.rel; error = $_.Exception.Message }
    }
  }
  Emit @{ done = $true }
  exit 0
}
throw 'Opération inconnue'
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

/**
 * Exécute le script PowerShell pour une opération. `onLine(obj)` reçoit chaque ligne JSON de sortie.
 * `shouldStop()` est consulté à chaque ligne : s'il renvoie vrai, le processus est arrêté.
 * Remplaçable dans les tests (option `run` de createPhones).
 */
export function runPowerShell(req, { onLine, shouldStop, timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const reqFile = path.join(os.tmpdir(), `phototheque-phone-${crypto.randomUUID()}.json`);
    fs.writeFileSync(reqFile, JSON.stringify(req), 'utf8');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ENCODED],
      { env: { ...process.env, PT_REQ: reqFile }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', fatal = '', stopped = false, finished = false;
    const done = (fn, v) => { if (finished) return; finished = true; clearTimeout(timer); try { fs.unlinkSync(reqFile); } catch { /* ignoré */ } fn(v); };
    const timer = setTimeout(() => { child.kill(); done(reject, new Error('Délai dépassé en lisant l\'appareil')); }, timeout);
    const handle = line => {
      line = line.trim(); if (!line) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.fatal) fatal = String(o.fatal);
      onLine?.(o);
      if (!stopped && shouldStop?.()) { stopped = true; child.kill(); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.resume(); // le bruit de PowerShell (CLIXML) n'est pas exploité : les erreurs passent par {fatal}
    child.on('error', e => done(reject, e));
    child.on('close', code => {
      handle(buf);
      if (stopped) return done(resolve, { stopped: true });
      if (code !== 0) return done(reject, new Error(fatal || 'PowerShell a échoué (code ' + code + ')'));
      done(resolve, { stopped: false });
    });
  });
}

/** Racines explorées sur un appareil : photos d'appareil (DCIM) et dossier Images d'Android. */
export const PHONE_ROOTS = ['DCIM', 'Pictures'];

export function createPhones({ run = runPowerShell, platform = process.platform } = {}) {
  // un seul accès à la fois : un appareil MTP ne gère pas bien les sessions simultanées
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const known = new Map(); // id → appareil de la dernière détection

  /** Appareils portables branchés (liste vide hors Windows). */
  async function detect() {
    if (platform !== 'win32') return [];
    let payload = null;
    await serial(() => run({ op: 'detect' }, { timeout: 60000, onLine: o => { if (o.devices) payload = o; } }));
    const list = parsePortableDevices(payload);
    known.clear(); for (const d of list) known.set(d.id, d);
    return list;
  }

  const target = ref => {
    if (ref && ref.folderRoot) return { folderRoot: path.resolve(String(ref.folderRoot)) }; // dossier ordinaire joué comme appareil (tests)
    const d = known.get(ref?.id ?? ref);
    if (!d) throw Object.assign(new Error('Appareil inconnu ou débranché : relancez la détection'), { status: 404 });
    return { devicePath: d.path };
  };

  /** Photos de l'appareil : [{ rel, name, size, mtime }], rel = « Stockage\DCIM\100APPLE\IMG_0001.JPG ». */
  async function list(ref, { limit = 5000, roots = PHONE_ROOTS } = {}) {
    const t = target(ref);
    const files = []; let truncated = false;
    await serial(() => run({ op: 'list', ...t, roots, limit }, {
      timeout: 15 * 60 * 1000,
      onLine: o => { if (o.f) files.push({ rel: String(o.f.rel), name: String(o.f.name), shown: String(o.f.shown ?? o.f.name), size: o.f.size ?? null, mtime: o.f.mtime ?? null }); if (o.done) truncated = !!o.truncated; },
    }));
    return { files, truncated };
  }

  /**
   * Copie des photos vers des dossiers temporaires : jobs = [{ rel, name, size, to }] (un dossier `to` par fichier).
   * `onFile({ rel, ok, error })` à chaque fichier ; `shouldStop()` interrompt. Renvoie { copied, failed, stopped }.
   */
  async function copy(ref, jobs, { onFile, shouldStop } = {}) {
    const t = target(ref);
    let copied = 0, failed = 0, stopped = false;
    const r = await serial(() => run({ op: 'copy', ...t, files: jobs }, {
      timeout: 60 * 60 * 1000, shouldStop,
      onLine: o => { if (o.rel !== undefined && o.ok !== undefined) { if (o.ok) copied++; else failed++; onFile?.({ rel: o.rel, ok: !!o.ok, error: o.error }); } },
    }));
    if (r.stopped) stopped = true;
    return { copied, failed, stopped };
  }

  return { detect, list, copy, known };
}

/**
 * Appareil de démonstration (Windows) : un dossier ordinaire joue le rôle d'un téléphone (DCIM, Pictures), lu par le
 * même code Shell que pour un vrai appareil. Activé par PHOTOTHEQUE_DEMO_PHONE=<dossier> : guide, essais, démonstration.
 */
export function createDemoPhones(dir, { name = 'Téléphone de démonstration' } = {}) {
  const real = createPhones({ platform: 'win32' });
  const dev = { id: 'ph-demo', name, path: 'demo', vid: '18d1', ...classifyPortable('18d1', name), storages: [], ready: false };
  const known = new Map();
  const ref = { folderRoot: dir };
  return {
    known,
    detect: async () => {
      dev.storages = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
      dev.ready = dev.storages.length > 0;
      known.clear(); known.set(dev.id, dev);
      return process.platform === 'win32' ? [dev] : [];
    },
    list: (_r, o) => real.list(ref, o),
    copy: (_r, jobs, o) => real.copy(ref, jobs, o),
  };
}
