// Generates the voice-over clips of the demo run-through with ElevenLabs (one MP3 per line of demo-narration.mjs).
// The API key is read from backend/.env (ELEVENLABS_API_KEY) and never printed. Clips that exist are kept unless
// --force; a changed text gets a new clip (the text hash is in the manifest).
//   node tools/drawing/demo-voiceover.mjs [--out tools/drawing/out/voiceover] [--force]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NARRATION, VOICE } from './demo-narration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(ROOT, arg('out', 'tools/drawing/out/voiceover'));
const FORCE = process.argv.includes('--force');
const envFile = path.resolve(ROOT, '..', 'backend', '.env');
const key = fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
if (!key) { console.error('ELEVENLABS_API_KEY is not set in backend/.env'); process.exit(1); }
const api = (p, opts = {}) => fetch(`https://api.elevenlabs.io${p}`, { ...opts, headers: { 'xi-api-key': key, ...(opts.headers || {}) } });

// The voice by name: the account's voices first, then the public library.
async function voiceId(name) {
  const own = (await (await api('/v1/voices')).json()).voices ?? [];
  const hit = own.find((v) => v.name === name);
  if (hit) return hit.voice_id;
  const q = encodeURIComponent(name.split(' ')[0]);
  const lib = (await (await api(`/v1/shared-voices?page_size=100&search=${q}`)).json()).voices ?? [];
  const v = lib.find((x) => x.name === name) ?? lib.find((x) => x.name.startsWith(name.split(' - ')[0]));
  if (!v) throw new Error(`Voice "${name}" not found`);
  return v.voice_id;
}

fs.mkdirSync(OUT, { recursive: true });
const manifestFile = path.join(OUT, 'manifest.json');
const old = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { lines: [] };
const id = await voiceId(VOICE.name);
const lines = [];
let chars = 0;
for (const l of NARRATION) {
  const hash = crypto.createHash('sha1').update(`${VOICE.name}|${VOICE.model}|${JSON.stringify(VOICE.settings)}|${l.text}`).digest('hex').slice(0, 12);
  const file = `${l.id}.mp3`;
  const prev = old.lines.find((x) => x.id === l.id);
  if (!FORCE && prev?.hash === hash && fs.existsSync(path.join(OUT, file))) { lines.push({ ...l, file, hash }); continue; }
  const r = await api(`/v1/text-to-speech/${id}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: l.text, model_id: VOICE.model, voice_settings: VOICE.settings }),
  });
  if (!r.ok) throw new Error(`${l.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(await r.arrayBuffer()));
  chars += l.text.length;
  lines.push({ ...l, file, hash });
  console.log('generated', l.id);
}
fs.writeFileSync(manifestFile, JSON.stringify({ voice: VOICE.name, lines }, null, 1));
const s = await (await api('/v1/user/subscription')).json().catch(() => ({}));
console.log(`${lines.length} lines in ${OUT}; ${chars} characters sent this run${s.character_count != null ? `; account: ${s.character_count} of ${s.character_limit} used` : ''}`);
