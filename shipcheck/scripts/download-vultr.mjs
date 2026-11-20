// Local, read-only bucket backup. Credentials are loaded by the same helper as the model gateway.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createS3ModelSource, s3ConfigFrom } from '../src/model-source-s3.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function validateKeys(objects) {
  const paths = new Map();
  for (const object of objects) {
    const key = object.Key;
    if (typeof key !== 'string' || !Number.isSafeInteger(object.Size) || object.Size < 0 || typeof object.ETag !== 'string')
      throw new Error('Bucket listing contains an invalid object.');
    const marker = key.endsWith('/');
    const parts = (marker ? key.slice(0, -1) : key).split('/');
    if (!parts.length || parts.some((s) => !s || s === '.' || s === '..' || /[<>:"\\|?*\x00-\x1f]/.test(s)
      || /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
      throw new Error(`Object key cannot safely be saved on Windows: ${JSON.stringify(key)}`);
    if (marker && object.Size !== 0) throw new Error(`Non-empty directory marker cannot be saved as a file: ${JSON.stringify(key)}`);
    const normalized = parts.join('/').toLowerCase();
    if (paths.has(normalized)) throw new Error(`Object paths conflict on Windows: ${JSON.stringify(key)}`);
    paths.set(normalized, marker ? 'directory' : 'file');
  }
  for (const [key] of paths) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (paths.get(parts.slice(0, i).join('/')) === 'file') throw new Error(`A bucket object conflicts with a directory: ${JSON.stringify(key)}`);
    }
  }
}

function awsArgs(cfg, args) {
  return [...args, '--endpoint-url', cfg.endpoint, '--region', cfg.region, '--no-cli-pager'];
}

function listing(cfg, env) {
  const p = spawnSync('aws', awsArgs(cfg, ['s3api', 'list-objects-v2', '--bucket', cfg.bucket, '--output', 'json']),
    { env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
  if (p.error) throw new Error(`Could not start AWS CLI: ${p.error.message}`);
  if (p.status !== 0) throw new Error(`Could not list bucket (AWS CLI exit ${p.status}): ${(p.stderr || '').trim()}`);
  const result = JSON.parse(p.stdout);
  if (result.IsTruncated === true) throw new Error('Bucket listing is incomplete.');
  return result.Contents ?? [];
}

function sync(cfg, env, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', awsArgs(cfg, ['s3', 'sync', `s3://${cfg.bucket}`, destination, '--no-progress', '--only-show-errors']),
      { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Bucket download failed (AWS CLI exit ${code}).`)));
  });
}

async function md5(file) {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function download(destination) {
  const cfg = s3ConfigFrom({ MODEL_SOURCE: 'vultr' }, path.join(root, 'deploy', 'deploy.env'));
  createS3ModelSource(cfg);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new Error('Invalid S3 bucket name.');
  const dest = path.resolve(destination);
  if (fs.existsSync(dest)) throw new Error('The destination already exists; choose a new folder to avoid overwriting files.');
  const parent = path.dirname(dest);
  if (!fs.statSync(parent).isDirectory()) throw new Error('The destination parent must exist.');
  const env = {
    ...process.env, AWS_ACCESS_KEY_ID: cfg.accessKey, AWS_SECRET_ACCESS_KEY: cfg.secretKey,
    AWS_DEFAULT_REGION: cfg.region, AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
    AWS_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    AWS_SHARED_CREDENTIALS_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  delete env.AWS_PROFILE;
  delete env.AWS_SESSION_TOKEN;
  const objects = listing(cfg, env);
  validateKeys(objects);
  const files = objects.filter((o) => !o.Key.endsWith('/'));
  const total = files.reduce((sum, o) => sum + o.Size, 0);
  const disk = fs.statfsSync(parent);
  if (total > disk.bavail * disk.bsize) throw new Error('Not enough free disk space for the bucket.');
  console.log(`Found ${files.length} files (${(total / 1024 ** 3).toFixed(2)} GiB); downloading to ${dest}.`);
  fs.mkdirSync(dest);
  await sync(cfg, env, dest);
  const after = listing(cfg, env);
  const snapshot = (items) => items.map((o) => [o.Key, o.Size, o.ETag]).sort((a, b) => a[0].localeCompare(b[0]));
  if (JSON.stringify(snapshot(objects)) !== JSON.stringify(snapshot(after))) throw new Error('The bucket changed during download; the backup is not verified.');
  let hashes = 0;
  for (const object of files) {
    const file = path.join(dest, ...object.Key.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size !== object.Size)
      throw new Error(`Downloaded file is missing or has the wrong size: ${JSON.stringify(object.Key)}`);
    const match = /^"([a-f0-9]{32})"$/i.exec(object.ETag);
    if (match) {
      if (await md5(file) !== match[1].toLowerCase()) throw new Error(`Downloaded file checksum differs: ${JSON.stringify(object.Key)}`);
      hashes++;
    }
  }
  console.log(`Verified ${files.length} files by size; ${hashes} also matched their MD5 ETags. ${objects.length - files.length} empty directory markers.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2] || path.join(root, 'vultr-download');
  download(destination).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
