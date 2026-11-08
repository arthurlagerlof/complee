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
  if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $cfg[$Matches[1]] = $Matches[2].Trim('"').Trim("'") }
}
if (-not $cfg['SERVER_HOST']) { throw 'SERVER_HOST is empty in deploy.env' }
if (-not $cfg['SERVER_USER']) { throw 'SERVER_USER is empty in deploy.env' }
$RemoteDir = if ($cfg['REMOTE_DIR']) { $cfg['REMOTE_DIR'] } else { '/opt/shipcheck' }
$Target = "$($cfg['SERVER_USER'])@$($cfg['SERVER_HOST'])"
$SshOpts = @('-o', 'StrictHostKeyChecking=accept-new')
if ($cfg['SSH_KEY']) { $SshOpts += @('-i', $cfg['SSH_KEY']) }

$dirty = git -C $Sc status --porcelain -- . | Where-Object { $_ -notmatch '^\?\?' }
if ($dirty) { Write-Host 'Note: uncommitted changes in shipcheck/ are NOT deployed (the archive uses the last commit).' }
$FromBucket = $cfg['MODEL_SOURCE'] -eq 'vultr'
if ($FromBucket) {
  foreach ($v in 'VULTR_S3_ENDPOINT', 'VULTR_S3_BUCKET', 'VULTR_S3_ACCESS_KEY', 'VULTR_S3_SECRET_KEY') { if (-not $cfg[$v]) { throw "MODEL_SOURCE=vultr needs $v in deploy.env" } }
} elseif (-not (Test-Path (Join-Path $Sc 'model\manifest.json'))) { throw "Missing $Sc\model\manifest.json (run tools/export first)" }

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("shipcheck-deploy-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $Tmp | Out-Null
try {
  git -C $Sc archive --format=tar.gz -o (Join-Path $Tmp 'app.tgz') HEAD:shipcheck
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  # diagnostic audit reports (hundreds of MB) are not served: left out of the upload
  if ($FromBucket) {
    # model tiles are streamed from the bucket: upload an empty model/ folder
    New-Item -ItemType Directory -Force (Join-Path $Tmp 'empty\model') | Out-Null
    tar -cf (Join-Path $Tmp 'model.tar') -C (Join-Path $Tmp 'empty') model
  } else {
    tar -cf (Join-Path $Tmp 'model.tar') --exclude=model/source-coverage.json --exclude=model/tile-integrity.json -C $Sc model
  }
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  $modelSource = if ($FromBucket) { 'vultr' } else { 'local' }
  Set-Content -Encoding ascii -Path (Join-Path $Tmp 'server.env') -Value @("DOMAIN=$($cfg['DOMAIN'])", "ALLOWED_ORIGINS=$($cfg['ALLOWED_ORIGINS'])",
    "SHIPCHECK_DATA_API_URL=$($cfg['SHIPCHECK_DATA_API_URL'])",
    "MODEL_SOURCE=$modelSource", "VULTR_S3_ENDPOINT=$($cfg['VULTR_S3_ENDPOINT'])", "VULTR_S3_BUCKET=$($cfg['VULTR_S3_BUCKET'])",
    "VULTR_S3_ACCESS_KEY=$($cfg['VULTR_S3_ACCESS_KEY'])", "VULTR_S3_SECRET_KEY=$($cfg['VULTR_S3_SECRET_KEY'])", "VULTR_S3_REGION=$($cfg['VULTR_S3_REGION'])")
  $appMB = [math]::Round((Get-Item (Join-Path $Tmp 'app.tgz')).Length / 1MB, 1)
  $modelMB = [math]::Round((Get-Item (Join-Path $Tmp 'model.tar')).Length / 1MB, 1)
  # model/ = the 6 main chunks, the rest sub-chunks (rest-NN.glb, Full model), manifest.json and props/ (rest part data)
  if ($FromBucket) {
    Write-Host "Model: streamed from bucket $($cfg['VULTR_S3_BUCKET']) (not uploaded)"
  } else {
    $glb = @(Get-ChildItem (Join-Path $Sc 'model') -Filter *.glb)
    $restGlb = @($glb | Where-Object { $_.Name -like 'rest-*' })
    $propsDir = Join-Path $Sc 'model/props'
    $props = if (Test-Path $propsDir) { @(Get-ChildItem $propsDir).Count } else { 0 }
    Write-Host "Model: $($glb.Count) chunk files ($($restGlb.Count) rest sub-chunks), $props property files"
  }
  Write-Host "Archive: app $appMB MB, model $modelMB MB"
  Write-Host "Total upload: $([math]::Round($appMB + $modelMB, 1)) MB"

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
