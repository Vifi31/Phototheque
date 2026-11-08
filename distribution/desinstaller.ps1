# Désinstallation de Photothèque : retire le programme, ses raccourcis et son inscription.
# Les DONNÉES (catalogue, sauvegardes, exports…) ne sont jamais effacées : leur dossier est indiqué à la fin.
#
#   powershell -ExecutionPolicy Bypass -File desinstaller.ps1 [-Destination dossier] [-SansRegistre] [-Silencieux]
param(
  [string]$Destination = '',
  [switch]$SansRegistre,
  [switch]$Silencieux,
  [switch]$Copie
)
$ErrorActionPreference = 'Stop'
$self = $MyInvocation.MyCommand.Path
if (-not $Destination) { $Destination = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $self)) }
$prog = Join-Path $Destination 'programme'
function Say([string]$m, [string]$c = 'Gray') { if (-not $Silencieux) { Write-Host $m -ForegroundColor $c } }
function Fail([string]$m) { Write-Host "La désinstallation n'a pas été faite : $m" -ForegroundColor Red; if (-not $Silencieux) { Read-Host 'Appuyez sur Entrée pour fermer' | Out-Null }; exit 1 }

if (-not (Test-Path (Join-Path $prog 'installation.json'))) { Fail "aucune installation de Photothèque dans $Destination." }

# le script se trouve dans le dossier à supprimer : il se relance depuis une copie temporaire
if (-not $Copie) {
  $tmp = Join-Path $env:TEMP ('phototheque-desinstaller-' + [guid]::NewGuid().ToString('N') + '.ps1')
  Copy-Item $self $tmp
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp, '-Destination', $Destination, '-Copie')
  if ($SansRegistre) { $a += '-SansRegistre' }; if ($Silencieux) { $a += '-Silencieux' }
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $a -Wait -PassThru -NoNewWindow
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  exit $p.ExitCode
}

$Host.UI.RawUI.WindowTitle = 'Désinstallation de Photothèque'
$info = Get-Content (Join-Path $prog 'installation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Say ''; Say "Désinstallation de Photothèque $($info.version)" 'Cyan'
Say "  Programme retiré : $Destination"
Say "  Données gardées  : $($info.donnees)"
if (-not $Silencieux) { $ok = Read-Host 'Désinstaller ? (O/N)'; if ($ok -notmatch '^[oOyY]') { Fail 'annulée.' } }

try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$($info.port)/api/ping" | Out-Null; Fail "Photothèque est ouverte : fermez sa fenêtre puis recommencez." } catch [System.Net.WebException] { }

$launcher = Join-Path $prog 'distribution\Phototheque.cmd'
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $f = Join-Path $dir 'Photothèque.lnk'
  if ((Test-Path $f) -and ($sh.CreateShortcut($f).TargetPath -eq $launcher)) { Remove-Item $f -Force }
}
if (-not $SansRegistre) { Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Phototheque' -Recurse -Force -ErrorAction SilentlyContinue }
foreach ($d in @($prog, "$prog.precedent")) { if (Test-Path $d) { try { Remove-Item -Recurse -Force $d } catch { Fail "fichiers utilisés dans $d (Photothèque est-elle ouverte ?)" } } }
if ((Test-Path $Destination) -and -not (Get-ChildItem $Destination -Force)) { Remove-Item $Destination -Force }

Say ''; Say 'Photothèque est désinstallée.' 'Green'
Say "Vos données sont toujours dans : $($info.donnees)"
if (-not $Silencieux) { Start-Sleep -Seconds 3 }
exit 0
