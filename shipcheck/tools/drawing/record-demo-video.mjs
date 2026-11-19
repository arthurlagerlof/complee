// Records the in-app demo run-through ("▶ Demo run-through") as an MP4 video, with a short title card.
// Headless Chrome (GPU rendering, no window that could take keyboard input) records its own tab with
// getDisplayMedia + MediaRecorder (H.264, avc3), so the video runs in real time with the demo. No ffmpeg needed.
//
// Needs: the viewer running (node server.mjs, port 8080), for the AI chapter the backend (port 8000), the demo drawing
// demo/aurora-ga.pdf (local only), and Chrome. Usage:
//   node tools/drawing/record-demo-video.mjs [out.mp4] [--url http://localhost:8080/index.html] [--voice [dir]]
// --voice: the voice-over clips of demo-voiceover.mjs (default tools/drawing/out/voiceover) play at their captions
// (window.__demoVoice) and are recorded with the picture (MP4 H.264 + AAC); the demo waits for each line to end.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'tools', 'export', 'package.json'));
const { chromium } = require('playwright');
const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(ROOT, 'tools', 'drawing', 'out', 'video', 'complee-demo.mp4');
const URL = arg('url', 'http://localhost:8080/index.html');
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: true, args: ['--auto-accept-this-tab-capture'] });
// 1440 x 810 CSS px at 4/3 = 1920 x 1080 px: the layout of a laptop screen, recorded in full HD.
const page = await (await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3 })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL);
await page.waitForFunction(() => window.__shipcheck?.model && document.querySelector('#scenario option'), null, { timeout: 90000 });
await page.waitForFunction(() => !/AI …/.test(document.querySelector('#aiPill')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {});
await sleep(2500);
console.log('AI:', await page.$eval('#aiPill', (p) => p.textContent.trim()));

// Voice-over clips (optional), handed to the page as base64 with the lines that say when each one plays.
const voiceAt = process.argv.indexOf('--voice');
const VOICE_DIR = voiceAt > 0 ? path.resolve(ROOT, process.argv[voiceAt + 1] && !process.argv[voiceAt + 1].startsWith('--') ? process.argv[voiceAt + 1] : 'tools/drawing/out/voiceover') : null;
if (VOICE_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(VOICE_DIR, 'manifest.json'), 'utf8'));
  const lines = manifest.lines.map((l) => ({ id: l.id, chapter: l.chapter ?? null, match: l.match ?? null, intro: !!l.intro, b64: fs.readFileSync(path.join(VOICE_DIR, l.file)).toString('base64') }));
  await page.evaluate((ls) => { window.__voiceLines = ls; }, lines);
  console.log('voice-over:', lines.length, 'lines,', manifest.voice);
}

let bytes = 0;
const out = fs.openSync(OUT, 'w');
await page.exposeFunction('saveChunk', (b64) => { const b = Buffer.from(b64, 'base64'); bytes += b.length; fs.writeSync(out, b); });
await page.evaluate(() => {
  // Recording starts from a (trusted) click: getDisplayMedia needs a user gesture.
  const b = document.createElement('button');
  b.id = 'recStart';
  b.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;z-index:99999;opacity:0.01;border:0;padding:0';
  document.body.appendChild(b);
  b.onclick = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: 1920, height: 1080, resizeMode: 'crop-and-scale' }, audio: false, preferCurrentTab: true });
      const track = stream.getVideoTracks()[0];
      track.contentHint = 'detail'; // under load keep the resolution (readable text), drop frames instead
      await new Promise((r) => setTimeout(r, 1200));
      await track.applyConstraints({ width: 1920, height: 1080, frameRate: 30, resizeMode: 'crop-and-scale' });
      await new Promise((r) => setTimeout(r, 400));
      let recStream = stream, types = ['video/mp4;codecs=avc3.640028', 'video/webm;codecs=vp9'];
      if (window.__voiceLines?.length) {
        // The voice goes into the recording (not to speakers): Web Audio → a media stream track next to the video.
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const dest = ctx.createMediaStreamDestination();
        // An inaudible noise bed (about -68 dBFS): Chrome writes no audio frames for silence, and the MP4 audio
        // fragments carry no time of their own, so without it the voice would move earlier at every pause.
        const bed = ctx.createBufferSource(), bedBuf = ctx.createBuffer(1, 48000, 48000), bd = bedBuf.getChannelData(0);
        for (let i = 0; i < bd.length; i++) bd[i] = (Math.random() * 2 - 1) * 0.0004;
        bed.buffer = bedBuf; bed.loop = true; bed.connect(dest); bed.start();
        const buffers = new Map();
        for (const l of window.__voiceLines) {
          const bin = Uint8Array.from(atob(l.b64), (c) => c.charCodeAt(0));
          buffers.set(l.id, await ctx.decodeAudioData(bin.buffer));
        }
        const play = (id) => new Promise((resolve) => {
          const buf = buffers.get(id);
          if (!buf) { resolve(); return; }
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(dest);
          src.onended = () => setTimeout(resolve, 350); // a short breath between lines
          src.start();
          window.__syncLog?.push({ t: performance.now() - window.__recT0, kind: 'voice', id, seconds: buf.duration });
        });
        // The demo asks for the line of a caption: "<n> / 12 · Title|Caption text" (see tools/drawing/demo-narration.mjs).
        window.__demoVoice = (key) => {
          const [chap, ...rest] = String(key).split('|');
          const text = rest.join('|'), n = Number(/^(\d+)\s*\//.exec(chap)?.[1]);
          const l = window.__voiceLines.find((x) => !x.intro && (x.chapter == null || x.chapter === n) && new RegExp(x.match).test(text));
          return l ? play(l.id) : null;
        };
        window.__playIntro = () => play(window.__voiceLines.find((x) => x.intro)?.id);
        recStream = new MediaStream([...stream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        types = ['video/mp4;codecs=avc3.640028,mp4a.40.2', 'video/webm;codecs=vp9,opus'];
      }
      const type = types.find((t) => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(recStream, { mimeType: type, videoBitsPerSecond: 4_500_000, audioBitsPerSecond: 128_000 });
      window.pending = [];
      rec.ondataavailable = (e) => {
        if (!e.data.size) return;
        window.pending.push(e.data.arrayBuffer().then((ab) => {
          let s = '';
          const u = new Uint8Array(ab);
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          return window.saveChunk(btoa(s));
        }));
      };
      rec.start(1000);
      // Sync log on the recording's clock: when each caption appears and each line starts (written next to the video).
      window.__recT0 = performance.now();
      window.__syncLog = [];
      const cap = document.querySelector('#caption');
      let lastCap = '';
      if (cap) new MutationObserver(() => {
        const text = cap.hidden ? '' : (cap.innerText ?? '').split('\n').slice(0, 2).join(' | ');
        if (text && text !== lastCap) window.__syncLog.push({ t: performance.now() - window.__recT0, kind: 'caption', text });
        lastCap = text;
      }).observe(cap, { childList: true, subtree: true, characterData: true, attributes: true });
      window.rec = rec;
      window.recInfo = { type };
    } catch (e) { window.recInfo = { error: `${e.name}: ${e.message}` }; }
  };
  // Title card (in the video only).
  const d = document.createElement('div');
  d.id = 'videoTitle';
  d.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(17,24,39,.9);color:#fff;font:600 58px/1.15 system-ui,sans-serif;text-align:center;transition:opacity .8s';
  d.innerHTML = '<div>Complee</div><div style="font-size:27px;font-weight:500;opacity:.88;margin-top:14px">Class &amp; regulatory compliance pre-check for ship designs</div><div style="font-size:20px;font-weight:400;opacity:.62;margin-top:26px">From a 2D general arrangement to a checked 3D model · AI explains, the checker decides</div>';
  document.body.appendChild(d);
});
await page.click('#recStart');
await page.waitForFunction(() => window.recInfo, null, { timeout: 15000 });
const info = await page.evaluate(() => window.recInfo);
if (info.error) throw new Error(`Tab recording failed: ${info.error}`);
console.log('recording as', info.type);
// The title card stays at least 4 s, and until the intro line has been spoken.
await Promise.all([sleep(4000), page.evaluate(() => window.__playIntro?.())]);
await page.evaluate(() => { const d = document.getElementById('videoTitle'); d.style.opacity = '0'; setTimeout(() => d.remove(), 900); });
await sleep(900);

const t0 = Date.now();
await page.click('#demoBtn');
await page.waitForFunction(() => window.__shipcheck.demo, null, { timeout: 10000 });
let last = '';
while (await page.evaluate(() => !!window.__shipcheck.demo)) {
  const c = await page.evaluate(() => (document.querySelector('#caption')?.innerText ?? '').split('\n').slice(0, 2).join(' | '));
  if (c !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), c); last = c; }
  if (Date.now() - t0 > 420000) { console.log('The demo did not finish within 7 minutes: stopped.'); break; }
  await sleep(400);
}
await sleep(1500);
await page.evaluate(() => new Promise((r) => { window.rec.onstop = r; window.rec.stop(); }));
await page.evaluate(() => Promise.all(window.pending));
fs.closeSync(out);
const syncLog = await page.evaluate(() => window.__syncLog ?? []);
fs.writeFileSync(OUT.replace(/\.(mp4|webm)$/i, '') + '.sync.json', JSON.stringify(syncLog, null, 1));
// Each line against the caption it belongs to: the caption shown last before the line started.
const voices = syncLog.filter((e) => e.kind === 'voice');
if (voices.length) {
  let worst = 0;
  for (const v of voices) {
    const cap = syncLog.filter((e) => e.kind === 'caption' && e.t <= v.t + 1).at(-1);
    const d = cap ? v.t - cap.t : null;
    if (d != null) worst = Math.max(worst, Math.abs(d));
    console.log(`  voice ${v.id.padEnd(13)} at ${(v.t / 1000).toFixed(2).padStart(7)} s  ${cap ? `${d >= 0 ? '+' : ''}${(d / 1000).toFixed(3)} s after "${cap.text.split(' | ')[1]?.slice(0, 45) ?? ''}"` : '(title card)'}`);
  }
  console.log(`sync: ${voices.length} lines, largest gap between a caption and its line ${(worst / 1000).toFixed(3)} s`);
}
await browser.close();
console.log(`${OUT}: ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000 + 5).toFixed(0)} s`);
if (errors.length) { console.log('browser errors:', errors); process.exitCode = 1; }
