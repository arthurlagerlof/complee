param([switch]$Restart, [switch]$Stop)
$ErrorActionPreference = 'Stop'
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RunDir = Join-Path $ProjectDir '.run'
$Port = 5173

function Test-ProjectProcess([int]$TaskId) {
  $task = Get-CimInstance Win32_Process -Filter "ProcessId = $TaskId" -ErrorAction SilentlyContinue
  return $task -and $task.Name -eq 'node.exe' -and $task.CommandLine -match [regex]::Escape($ProjectDir) -and $task.CommandLine -match 'vite'
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  if (-not (Test-ProjectProcess $listener.OwningProcess)) { throw 'Port 5173 is in use by another application; it was left running.' }
  if ($Stop -or $Restart) {
    Stop-Process -Id $listener.OwningProcess
    for ($i = 0; $i -lt 40; $i++) {
      if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
  } else {
    Write-Host 'App already running: http://localhost:5173/landing'
    Write-Host 'Inspection: http://localhost:5173/inspection/index.html'
    return
  }
}
if ($Stop) { Write-Host 'Project dev server stopped.'; return }

$ViteEntry = Join-Path $ProjectDir 'node_modules/vite/bin/vite.js'
$ThreeEntry = Join-Path $ProjectDir 'shipcheck/node_modules/three/build/three.module.js'
if (-not (Test-Path -LiteralPath $ViteEntry)) { throw 'Missing app dependencies. Run npm.cmd install from the project root.' }
if (-not (Test-Path -LiteralPath $ThreeEntry)) { throw 'Missing inspection dependencies. Run npm.cmd --prefix shipcheck install.' }
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$outLog = Join-Path $RunDir "vite-$stamp.out.log"
$errLog = Join-Path $RunDir "vite-$stamp.err.log"
# Hidden, detached from the assistant's command session; no .env or deployment settings are read here.
# MODEL_BASE_URL is optional: without it the app serves model files itself, so a second local server is unnecessary.
$task = Start-Process -FilePath $NodeExe -ArgumentList @('"' + $ViteEntry + '"', '--host', 'localhost', '--port', "$Port", '--strictPort') -WorkingDirectory $ProjectDir -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
for ($i = 0; $i -lt 120; $i++) {
  $task.Refresh()
  if ($task.HasExited) { throw "Dev server exited. Check the logs in $RunDir." }
  try {
    $health = Invoke-RestMethod -Uri "http://localhost:$Port/inspection/api/health" -TimeoutSec 1
    if ($health.status -eq 'ok') {
      Write-Host 'App ready: http://localhost:5173/landing'
      Write-Host 'Inspection: http://localhost:5173/inspection/index.html'
      Write-Host 'Stop: .\scripts\start-dev.ps1 -Stop'
      return
    }
  } catch { }
  Start-Sleep -Milliseconds 250
}
throw "Dev server did not become ready. Check the logs in $RunDir."
