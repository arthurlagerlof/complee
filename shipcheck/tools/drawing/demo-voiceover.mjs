// Generates the voice-over clips of the demo run-through with ElevenLabs (one MP3 per line of demo-narration.mjs)
// and checks each clip against its script: the API returns the time every character is spoken (alignment), so a
// clip whose speech stops before the end of the text, skips text, or runs past the audio is rejected and generated
// again (up to 3 attempts). The API key is read from backend/.env (ELEVENLABS_API_KEY) and never printed. Clips
// that exist with the same text, voice and settings are kept unless --force.
//   node tools/drawing/demo-voiceover.mjs [--variant pro] [--out dir] [--force]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VARIANTS } from './demo-narration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const variant = VARIANTS[arg('variant', 'pro')];
if (!variant) { console.error(`Unknown --variant; use one of: ${Object.keys(VARIANTS).join(', ')}`); process.exit(1); }
const { voice: VOICE, lines: NARRATION } = variant;
const OUT = path.resolve(ROOT, arg('out', variant.out));
const FORCE = process.argv.includes('--force');
const envFile = path.resolve(ROOT, '..', 'backend', '.env');
const key = fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8').match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
if (!key) { console.error('ELEVENLABS_API_KEY is not set in backend/.env'); process.exit(1); }
const api = (p, opts = {}) => fetch(`https://api.elevenlabs.io${p}`, { ...opts, headers: { 'xi-api-key': key, ...(opts.headers || {}) } });

// The voice by name: the account's voices first, then the public library.
async function voiceId(name) {
  const own = (await (await api('/v1/voices')).json()).voices ?? [];
  const hit = own.find((v) => v.name === name) ?? own.find((v) => v.name.startsWith(`${name} `) || v.name.startsWith(`${name} -`));
  if (hit) return hit.voice_id;
  const q = encodeURIComponent(name.split(' ')[0]);
  const lib = (await (await api(`/v1/shared-voices?page_size=100&search=${q}`)).json()).voices ?? [];
  const v = lib.find((x) => x.name === name) ?? lib.find((x) => x.name.startsWith(name.split(' - ')[0]));
  if (!v) throw new Error(`Voice "${name}" not found`);
  return v.voice_id;
}

// Duration of an MP3 (CBR from the API): bytes × 8 / bitrate, read from the first frame header.
function mp3Seconds(buf) {
  let o = buf.indexOf(Buffer.from('ID3')) === 0 ? 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f)) : 0;
  while (o < buf.length - 4 && !(buf[o] === 0xff && (buf[o + 1] & 0xe0) === 0xe0)) o++;
  const rates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const kbps = rates[buf[o + 2] >> 4] || 128;
  return ((buf.length - o) * 8) / (kbps * 1000);
}

// The clip is the whole text: every character aligned in order, speech ending before the audio does.
function checkAlignment(text, al, seconds) {
  const problems = [];
  if (!al?.characters?.length) return ['no alignment returned'];
  const spoken = al.characters.join('');
  if (spoken.replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) problems.push('aligned text differs from the script');
  const ends = al.character_end_times_seconds, starts = al.character_start_times_seconds;
  for (let i = 1; i < starts.length; i++) if (starts[i] + 1e-6 < starts[i - 1]) { problems.push(`timing goes backwards at character ${i}`); break; }
  const last = ends[ends.length - 1];
  if (last > seconds + 0.05) problems.push(`speech (${last.toFixed(2)} s) runs past the audio (${seconds.toFixed(2)} s): cut off`);
  if (seconds - last > 1.5) problems.push(`${(seconds - last).toFixed(1)} s of audio after the last word`);
  // a pause longer than 1.6 s inside the text is a hesitation or a glitch, not a comma
  for (let i = 1; i < starts.length; i++) if (starts[i] - ends[i - 1] > 1.6) { problems.push(`pause of ${(starts[i] - ends[i - 1]).toFixed(1)} s before "${text.slice(i, i + 15)}"`); break; }
  return problems;
}

fs.mkdirSync(OUT, { recursive: true });
const manifestFile = path.join(OUT, 'manifest.json');
const old = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { lines: [] };
const id = await voiceId(VOICE.name);
const lines = [];
let chars = 0, failed = 0;
for (const l of NARRATION) {
  const hash = crypto.createHash('sha1').update(`${VOICE.name}|${VOICE.model}|${JSON.stringify(VOICE.settings)}|${l.text}`).digest('hex').slice(0, 12);
  const file = `${l.id}.mp3`;
  const prev = old.lines.find((x) => x.id === l.id);
  if (!FORCE && prev?.hash === hash && prev.ok && fs.existsSync(path.join(OUT, file))) { lines.push(prev); continue; }
  let entry = null;
  for (let attempt = 1; attempt <= 3 && !entry?.ok; attempt++) {
    const r = await api(`/v1/text-to-speech/${id}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: l.text, model_id: VOICE.model, voice_settings: VOICE.settings }),
    });
    if (!r.ok) throw new Error(`${l.id}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const audio = Buffer.from(j.audio_base64, 'base64');
    const seconds = mp3Seconds(audio);
    const problems = checkAlignment(l.text, j.alignment, seconds);
    chars += l.text.length;
    fs.writeFileSync(path.join(OUT, file), audio);
    const al = j.alignment;
    entry = { ...l, file, hash, ok: !problems.length, problems, seconds: +seconds.toFixed(2),
      speechEnd: +al.character_end_times_seconds.at(-1).toFixed(2), attempt };
    console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${l.id} (${seconds.toFixed(1)} s${attempt > 1 ? `, attempt ${attempt}` : ''})${problems.length ? `: ${problems.join('; ')}` : ''}`);
  }
  if (!entry.ok) failed++;
  lines.push(entry);
}
fs.writeFileSync(manifestFile, JSON.stringify({ voice: VOICE.name, lines }, null, 1));
const s = await (await api('/v1/user/subscription')).json().catch(() => ({}));
console.log(`${lines.length} lines, ${failed} failing, ${lines.reduce((a, l) => a + (l.seconds ?? 0), 0).toFixed(0)} s of speech in ${OUT}; ${chars} characters sent this run${s.character_count != null ? `; account: ${s.character_count} of ${s.character_limit} used` : ''}`);
if (failed) process.exitCode = 1;
