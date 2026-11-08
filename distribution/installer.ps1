# Installateur de Photothèque (Windows, sans droits d'administrateur).
#
# Lancé par Phototheque-<version>-installation.exe (IExpress), ou à la main :
#   powershell -ExecutionPolicy Bypass -File installer.ps1 [-Destination dossier] [-Donnees dossier] [-Port 3212]
#              [-SansRaccourcis] [-SansRegistre] [-NePasLancer] [-Silencieux]
#
# Étapes : contrôle du paquet (empreinte), extraction dans un dossier temporaire, vérification des
# empreintes et de la signature avec le Node.js livré (pour une mise à jour : avec la clé de la version
# déjà installée), remplacement du programme (l'ancien est gardé dans « programme.precedent »),
# raccourcis, inscription dans « Applications installées ». Les données ne sont jamais touchées.
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\Phototheque'),
  [string]$Donnees = '',
  [string]$Paquet = '',
  [int]$Port = 0,
  [switch]$SansRaccourcis,
  [switch]$SansRegistre,
  [switch]$NePasLancer,
  [switch]$Silencieux
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Host.UI.RawUI.WindowTitle = 'Installation de Photothèque'

function Say([string]$m, [string]$c = 'Gray') { if (-not $Silencieux) { Write-Host $m -ForegroundColor $c } }
function Fail([string]$m) {
  Write-Host ''; Write-Host "L'installation n'a pas été faite : $m" -ForegroundColor Red
  if (-not $Silencieux) { Read-Host 'Appuyez sur Entrée pour fermer' | Out-Null }
  exit 1
}
function Ask([string]$q, [string]$def) {
  if ($Silencieux) { return $def }
  $r = Read-Host "$q [$def]"
  if ([string]::IsNullOrWhiteSpace($r)) { return $def } else { return $r.Trim().Trim('"') }
}
function WriteUtf8([string]$file, [string]$text) { [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $false)) }

# ---------------------------------------------------------------- paquet
if (-not $Paquet) { $Paquet = Get-ChildItem -Path $here -Filter 'Phototheque-*-windows-x64.zip' | Select-Object -First 1 -ExpandProperty FullName }
if (-not $Paquet -or -not (Test-Path $Paquet)) { Fail 'paquet Phototheque-*-windows-x64.zip introuvable à côté de l''installateur.' }
$version = ([IO.Path]::GetFileName($Paquet) -replace '^Phototheque-(.+)-windows-x64\.zip$', '$1')
Say ''; Say "Photothèque $version — installation" 'Cyan'; Say ''

$sumFile = Join-Path (Split-Path -Parent $Paquet) 'paquet.sha256'
if (Test-Path $sumFile) {
  $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $Paquet).Hash.ToLower()
  if ($expected -ne $actual) { Fail 'le paquet est endommagé (empreinte SHA-256 différente).' }
  Say '✓ Paquet intact (SHA-256).' 'Green'
}

# ---------------------------------------------------------------- installation existante
$prog = Join-Path $Destination 'programme'
$old = $null
if (Test-Path (Join-Path $prog 'installation.json')) { $old = Get-Content (Join-Path $prog 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
$oldEnv = @{}
if (Test-Path (Join-Path $prog '.env')) {
  foreach ($l in Get-Content (Join-Path $prog '.env') -Encoding UTF8) { if ($l -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $oldEnv[$Matches[1]] = $Matches[2].Trim().Trim('"') } }
}
if (-not $Donnees) { $Donnees = if ($oldEnv['PHOTOTHEQUE_HOME']) { $oldEnv['PHOTOTHEQUE_HOME'] } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Photothèque' } }
if (-not $Port) { $Port = if ($oldEnv['PHOTOTHEQUE_PORT']) { [int]$oldEnv['PHOTOTHEQUE_PORT'] } else { 3212 } }

if ($old) { Say "Mise à jour de la version $($old.version) installée dans $Destination." }
else {
  $Destination = Ask 'Dossier du programme' $Destination
  $prog = Join-Path $Destination 'programme'
}
$Donnees = Ask 'Dossier de vos données (catalogue, sauvegardes, exports)' $Donnees
Say ''
Say "  Programme : $prog"
Say "  Données   : $Donnees (jamais effacées, ni par une mise à jour ni par la désinstallation)"
Say "  Adresse   : http://localhost:$Port"
Say ''
if (-not $Silencieux) { $ok = Read-Host 'Installer ? (O/N)'; if ($ok -notmatch '^[oOyY]') { Fail 'annulée.' } }

# l'application ne doit pas être ouverte pendant le remplacement du programme
if ($old) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$Port/api/ping" | Out-Null; Fail "Photothèque est ouverte (http://localhost:$Port) : fermez sa fenêtre puis relancez l'installation." } catch [System.Net.WebException] { }
}

# ---------------------------------------------------------------- extraction et vérification
$tmp = Join-Path $env:TEMP ('phototheque-installation-' + [guid]::NewGuid().ToString('N'))
try {
  Say 'Extraction…'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($Paquet, $tmp)
  $node = Join-Path $tmp 'node\node.exe'
  if (-not (Test-Path $node)) { Fail 'Node.js absent du paquet.' }
  $verifArgs = @((Join-Path $tmp 'scripts\verifier.mjs'), $tmp, '--json')
  $oldKey = Join-Path $prog 'distribution\cle-publique.pem'
  if ($old -and $old.signed -and (Test-Path $oldKey)) { $verifArgs += @('--cle', $oldKey, '--signature-obligatoire') }
  $json = & $node @verifArgs
  $verif = $json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { Fail "vérification de la distribution : $($verif.error)" }
  if ($verif.signed) { Say "✓ $($verif.files) fichiers vérifiés, signature valide (clé $($verif.keyId))." 'Green' }
  else { Say "✓ $($verif.files) fichiers vérifiés (distribution non signée)." 'Yellow' }

  # ---------------------------------------------------------------- remplacement du programme
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $prev = "$prog.precedent"
  if (Test-Path $prog) {
    if (Test-Path $prev) { Remove-Item -Recurse -Force $prev }
    try { Rename-Item -Path $prog -NewName (Split-Path -Leaf $prev) } catch { Fail "le dossier du programme est utilisé (Photothèque est-elle ouverte ?) : $prog" }
  }
  Move-Item -Path $tmp -Destination $prog
} finally { if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } }

New-Item -ItemType Directory -Force -Path $Donnees | Out-Null
WriteUtf8 (Join-Path $prog '.env') "PHOTOTHEQUE_HOME=$Donnees`r`nPHOTOTHEQUE_PORT=$Port`r`n"
$info = [ordered]@{ product = 'Photothèque'; version = $version; installedAt = (Get-Date).ToString('o'); programme = $prog; donnees = $Donnees; port = $Port
  signed = [bool]$verif.signed; keyId = $verif.keyId; previous = $(if ($old) { $old.version } else { $null }) }
WriteUtf8 (Join-Path $prog 'installation.json') ($info | ConvertTo-Json)
Say '✓ Programme installé.' 'Green'

# ---------------------------------------------------------------- raccourcis et inscription
$launcher = Join-Path $prog 'distribution\Phototheque.cmd'
$icon = Join-Path $prog 'distribution\phototheque.ico'
if (-not $SansRaccourcis) {
  $sh = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $lnk = $sh.CreateShortcut((Join-Path $dir 'Photothèque.lnk'))
    $lnk.TargetPath = $launcher; $lnk.WorkingDirectory = $prog; $lnk.IconLocation = "$icon,0"; $lnk.Description = 'Photothèque — gestion du fonds photographique'
    $lnk.WindowStyle = 7; $lnk.Save()
  }
  Say '✓ Raccourcis : menu Démarrer et Bureau.' 'Green'
}
if (-not $SansRegistre) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Phototheque'
  New-Item -Path $key -Force | Out-Null
  $size = [int]((Get-ChildItem -Recurse -File $prog | Measure-Object -Sum Length).Sum / 1KB)
  $props = @{ DisplayName = 'Photothèque'; DisplayVersion = $version; Publisher = 'Vincent Fillaux'; InstallLocation = $Destination; DisplayIcon = $icon
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$prog\distribution\desinstaller.ps1`""
    QuietUninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$prog\distribution\desinstaller.ps1`" -Silencieux" }
  foreach ($k in $props.Keys) { New-ItemProperty -Path $key -Name $k -Value $props[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in @('NoModify', 'NoRepair')) { New-ItemProperty -Path $key -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
  New-ItemProperty -Path $key -Name 'EstimatedSize' -Value $size -PropertyType DWord -Force | Out-Null
  Say '✓ Inscrite dans Paramètres > Applications installées (désinstallation).' 'Green'
}

Say ''; Say "Photothèque $version est installée." 'Cyan'
if ($old) { Say "La version précédente ($($old.version)) reste dans $prog.precedent jusqu'à la prochaine mise à jour." }
if (-not $NePasLancer) { Start-Process -FilePath $launcher -WorkingDirectory $prog }
if (-not $Silencieux) { Start-Sleep -Seconds 3 }
exit 0
