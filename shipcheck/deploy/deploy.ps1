# Deploy ShipCheck to one Linux server (e.g. Vultr) with Docker + Caddy, from Windows PowerShell.
# Usage:  powershell -ExecutionPolicy Bypass -File shipcheck\deploy\deploy.ps1
# Needs: deploy\deploy.env (copy deploy.env.example), the Windows OpenSSH client (ssh, scp), git and tar.
# Uploads the COMMITTED app (git archive of shipcheck/, so no local secrets or big files) and the model chunks.
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Sc = Split-Path -Parent $Here
$EnvFile = Join-Path $Here 'deploy.env'
if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile (copy deploy.env.example and fill it in)" }
$cfg = @{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim('"').Trim("'") }
}
if (-not $cfg['SERVER_HOST']) { throw 'SERVER_HOST is empty in deploy.env' }
if (-not $cfg['SERVER_USER']) { throw 'SERVER_USER is empty in deploy.env' }
$RemoteDir = if ($cfg['REMOTE_DIR']) { $cfg['REMOTE_DIR'] } else { '/opt/shipcheck' }
$Target = "$($cfg['SERVER_USER'])@$($cfg['SERVER_HOST'])"
$SshOpts = @('-o', 'StrictHostKeyChecking=accept-new')
if ($cfg['SSH_KEY']) { $SshOpts += @('-i', $cfg['SSH_KEY']) }

$dirty = git -C $Sc status --porcelain -- . | Where-Object { $_ -notmatch '^\?\?' }
if ($dirty) { Write-Host 'Note: uncommitted changes in shipcheck/ are NOT deployed (the archive uses the last commit).' }
if (-not (Test-Path (Join-Path $Sc 'model\manifest.json'))) { throw "Missing $Sc\model\manifest.json (run tools/export first)" }

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("shipcheck-deploy-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $Tmp | Out-Null
try {
  git -C $Sc archive --format=tar.gz -o (Join-Path $Tmp 'app.tgz') HEAD:shipcheck
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  tar -cf (Join-Path $Tmp 'model.tar') -C $Sc model
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  Set-Content -Encoding ascii -Path (Join-Path $Tmp 'server.env') -Value @("DOMAIN=$($cfg['DOMAIN'])", "ALLOWED_ORIGINS=$($cfg['ALLOWED_ORIGINS'])")
  $appMB = [math]::Round((Get-Item (Join-Path $Tmp 'app.tgz')).Length / 1MB, 1)
  $modelMB = [math]::Round((Get-Item (Join-Path $Tmp 'model.tar')).Length / 1MB, 1)
  Write-Host "Archive: app $appMB MB, model $modelMB MB"

  ssh @SshOpts $Target "mkdir -p '$RemoteDir'"
  if ($LASTEXITCODE -ne 0) { throw 'ssh failed' }
  scp @SshOpts (Join-Path $Tmp 'app.tgz') (Join-Path $Tmp 'model.tar') (Join-Path $Tmp 'server.env') "${Target}:$RemoteDir/"
  if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
  $remote = "set -e; cd '$RemoteDir' && tar -xzf app.tgz && rm -rf model && tar -xf model.tar && mv server.env deploy/server.env && rm -f app.tgz model.tar && docker compose --env-file deploy/server.env -f deploy/docker-compose.yml up -d --build && sleep 5 && curl -fsS http://127.0.0.1/api/health"
  ssh @SshOpts $Target $remote
  if ($LASTEXITCODE -ne 0) { throw 'remote deploy failed' }
  $hostName = if ($cfg['DOMAIN']) { $cfg['DOMAIN'] } else { $cfg['SERVER_HOST'] }
  Write-Host "`nDeployed. Check: curl -s http://$hostName/api/health"
} finally {
  Remove-Item -Recurse -Force $Tmp
}
