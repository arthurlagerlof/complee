// Revit (.rvt) -> IFC through Autodesk Platform Services (APS) Model Derivative. Server side only: the APS keys
// never reach the browser. The browser then reads the IFC with the normal IFC import (src/ifc-convert.mjs).
//
// Steps: token -> transient bucket (files are deleted by Autodesk after 24 h) -> signed S3 upload in parts ->
// translation job (output "ifc") -> poll the manifest -> download the IFC derivative (signed cookies).
// Results are cached by the SHA-256 of the uploaded file, so the same file is converted only once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const APS_BASE = 'https://developer.api.autodesk.com';
export const MAX_RVT_BYTES = 1024 * 1024 * 1024; // 1 GB
const MIN_PART = 5 * 1024 * 1024, MAX_PARTS = 25;
const SCOPES = 'data:read data:write data:create bucket:create bucket:read';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Part size for a signed S3 upload: at least 5 MB, at most 25 parts in one request. */
export function partPlan(size) {
  const partSize = Math.max(MIN_PART, Math.ceil(size / MAX_PARTS));
  return { partSize, parts: Math.max(1, Math.ceil(size / partSize)) };
}

/** The node of an IFC derivative in a Model Derivative manifest, or null. */
export function findIfcDerivative(manifest) {
  for (const d of manifest?.derivatives ?? []) {
    if (String(d.outputType).toLowerCase() !== 'ifc') continue;
    const stack = [d];
    while (stack.length) {
      const n = stack.pop();
      if (n.urn && (String(n.role).toLowerCase() === 'ifc' || /\.ifc$/i.test(String(n.urn)))) return { derivative: d, node: n };
      stack.push(...(n.children ?? []));
    }
    return { derivative: d, node: null };
  }
  return null;
}

/** Readable reasons from a failed translation (the manifest's error messages). */
export function manifestErrors(manifest, derivative) {
  const out = [];
  const visit = (n) => {
    for (const m of n?.messages ?? []) if (m.type === 'error' || m.type === 'warning') out.push(String(m.message ?? m.code ?? '').replace(/<[^>]+>/g, '').trim());
    for (const c of n?.children ?? []) visit(c);
  };
  visit(derivative ?? manifest);
  return [...new Set(out.filter(Boolean))].slice(0, 5);
}

export function createRvtConverter({ credentials, cacheDir, fetchImpl = fetch, base = APS_BASE, pollMs = 5000, timeoutMs = 60 * 60_000, region = 'US' }) {
  const jobs = new Map(); // job id -> job
  const bySha = new Map(); // sha -> running job (one conversion per file content)
  let token = null;
  fs.mkdirSync(cacheDir, { recursive: true });

  const configured = () => { const c = credentials(); return !!(c?.id && c?.secret); };
  const ifcPath = (sha) => path.join(cacheDir, `${sha}.ifc`);

  // One request with retries for throttling and server errors (429, 5xx, network failures).
  async function request(url, init = {}, { timeout = 60_000, tries = 4 } = {}) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
        if (res.status !== 429 && res.status < 500) return res;
        last = new Error(`${res.status} ${await res.text().catch(() => '')}`.trim());
        const wait = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 1000 * 2 ** i);
      } catch (e) {
        last = e;
        await sleep(1000 * 2 ** i);
      }
    }
    throw new Error(`Autodesk did not answer (${last?.message ?? 'no response'}).`);
  }

  async function bearer() {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const { id, secret } = credentials();
    const res = await request(`${base}/authentication/v2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPES }),
    });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 400 ? 'Autodesk rejected the APS keys (APS_CLIENT_ID / APS_CLIENT_SECRET).' : `Autodesk sign-in failed (${res.status}).`);
    const t = await res.json();
    token = { value: t.access_token, until: Date.now() + (t.expires_in ?? 3000) * 1000 };
    return token.value;
  }

  async function api(route, { method = 'GET', body, headers = {}, ok = [] } = {}) {
    const res = await request(base + route, {
      method,
      headers: { Authorization: `Bearer ${await bearer()}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !ok.includes(res.status)) {
      const text = await res.text().catch(() => '');
      throw new Error(`Autodesk ${method} ${route.split('?')[0]} failed (${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return res;
  }

  function bucketKey() {
    return `complee-convert-${crypto.createHash('sha256').update(String(credentials().id)).digest('hex').slice(0, 20)}`;
  }

  async function upload(job, file, size) {
    const bucket = bucketKey();
    await api('/oss/v2/buckets', { method: 'POST', headers: { region, 'x-ads-region': region }, body: { bucketKey: bucket, policyKey: 'transient' }, ok: [409] });
    const key = `${job.sha}.rvt`;
    const route = `/oss/v2/buckets/${bucket}/objects/${encodeURIComponent(key)}/signeds3upload`;
    const { partSize, parts } = partPlan(size);
    const signed = await (await api(`${route}?parts=${parts}&firstPart=1&minutesExpiration=60`)).json();
    const fh = await fs.promises.open(file, 'r');
    try {
      for (let i = 0; i < signed.urls.length; i++) {
        const start = i * partSize, len = Math.min(partSize, size - start);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, start);
        const put = await request(signed.urls[i], { method: 'PUT', body: buf }, { timeout: 15 * 60_000 });
        if (!put.ok) throw new Error(`Upload of part ${i + 1} failed (${put.status}).`);
        job.progress = Math.round(((i + 1) / signed.urls.length) * 100);
      }
    } finally { await fh.close(); }
    const done = await (await api(route, { method: 'POST', body: { uploadKey: signed.uploadKey } })).json();
    if (!done.objectId) throw new Error('Autodesk did not confirm the upload.');
    return Buffer.from(done.objectId).toString('base64url').replace(/=+$/, '');
  }

  async function translate(job, urn) {
    await api('/modelderivative/v2/designdata/job', {
      method: 'POST',
      headers: { region },
      body: { input: { urn }, output: { formats: [{ type: 'ifc' }] } },
    });
    const until = Date.now() + timeoutMs;
    for (;;) {
      const res = await api(`/modelderivative/v2/designdata/${urn}/manifest`, { ok: [202, 404] });
      if (res.ok && res.status === 200) {
        const manifest = await res.json();
        const found = findIfcDerivative(manifest);
        const st = String(found?.derivative?.status ?? manifest.status ?? '').toLowerCase();
        job.progress = Number.parseInt(found?.derivative?.progress ?? manifest.progress, 10) || job.progress;
        if (st === 'success' && found?.node) return found.node.urn;
        if (st === 'success') throw new Error('Autodesk finished, but the result contains no IFC file.');
        if (st === 'failed' || st === 'timeout') {
          const why = manifestErrors(manifest, found?.derivative);
          throw new Error(`Autodesk could not convert the file to IFC${why.length ? `: ${why.join(' ')}` : '.'}`);
        }
      }
      if (Date.now() > until) throw new Error('The conversion took longer than an hour and was stopped.');
      await sleep(pollMs);
    }
  }

  async function download(urn, derivativeUrn, target) {
    const encoded = encodeURIComponent(derivativeUrn);
    let res;
    const signed = await api(`/modelderivative/v2/designdata/${urn}/manifest/${encoded}/signedcookies?minutesExpiration=60`, { ok: [400, 404] });
    if (signed.ok) {
      const { url } = await signed.json();
      const cookies = (signed.headers.getSetCookie?.() ?? [signed.headers.get('set-cookie')].filter(Boolean)).map((c) => c.split(';')[0]).join('; ');
      res = await request(url, { headers: cookies ? { Cookie: cookies } : {} }, { timeout: 30 * 60_000 });
    } else {
      // Older accounts: direct download of the derivative with the bearer token.
      res = await request(`${base}/modelderivative/v2/designdata/${urn}/manifest/${encoded}`, { headers: { Authorization: `Bearer ${await bearer()}` } }, { timeout: 30 * 60_000 });
    }
    if (!res.ok || !res.body) throw new Error(`Download of the IFC file failed (${res.status}).`);
    const tmp = `${target}.${process.pid}.part`;
    const out = fs.createWriteStream(tmp);
    try {
      for await (const chunk of res.body) if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
      const head = Buffer.alloc(64);
      const fh = await fs.promises.open(tmp, 'r');
      try { await fh.read(head, 0, 64, 0); } finally { await fh.close(); }
      if (!/^\s*ISO-10303-21/.test(head.toString('latin1'))) throw new Error('Autodesk returned a file that is not IFC.');
      await fs.promises.rename(tmp, target);
    } catch (e) {
      out.destroy();
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
  }

  const view = (job) => ({ id: job.id, name: job.name, state: job.state, progress: job.progress, message: job.message, error: job.error, cached: job.cached, bytes: job.bytes });

  /** Starts a conversion of an uploaded file (it is moved into the converter's care and deleted afterwards). */
  function start(file, { name, sha, bytes }) {
    const id = crypto.randomUUID();
    const job = { id, name, sha, bytes, state: 'queued', progress: 0, message: 'Waiting', error: null, cached: false, created: Date.now() };
    jobs.set(id, job);
    // Forget finished jobs after a day.
    for (const [k, j] of jobs) if (Date.now() - j.created > 24 * 3600_000) jobs.delete(k);
    const target = ifcPath(sha);
    if (fs.existsSync(target)) {
      Object.assign(job, { state: 'done', progress: 100, message: 'Converted earlier: using the cached IFC file', cached: true });
      fs.promises.rm(file, { force: true });
      return view(job);
    }
    if (!configured()) {
      Object.assign(job, { state: 'failed', error: 'Revit conversion needs Autodesk Platform Services keys (APS_CLIENT_ID and APS_CLIENT_SECRET) on the server.' });
      fs.promises.rm(file, { force: true });
      return view(job);
    }
    const running = bySha.get(sha);
    const work = running ?? (async () => {
      job.state = 'uploading'; job.message = 'Uploading to Autodesk';
      const urn = await upload(job, file, bytes);
      job.state = 'converting'; job.progress = 0; job.message = 'Autodesk converts the model to IFC';
      const derivative = await translate(job, urn);
      job.state = 'downloading'; job.progress = 0; job.message = 'Downloading the IFC file';
      await download(urn, derivative, target);
    })().finally(() => { bySha.delete(sha); return fs.promises.rm(file, { force: true }); });
    if (!running) bySha.set(sha, work);
    else fs.promises.rm(file, { force: true });
    // Mirror the state of a shared run on this job.
    const mirror = running ? setInterval(() => { const first = [...jobs.values()].find((j) => j.sha === sha && j !== job && !j.cached); if (first) Object.assign(job, { state: first.state, progress: first.progress, message: first.message }); }, 500) : null;
    work.then(() => { Object.assign(job, { state: 'done', progress: 100, message: 'Converted' }); },
      (e) => { Object.assign(job, { state: 'failed', error: e.message }); })
      .finally(() => clearInterval(mirror));
    return view(job);
  }

  return {
    configured,
    start,
    job: (id) => (jobs.has(id) ? view(jobs.get(id)) : null),
    ifcFile: (id) => { const j = jobs.get(id); return j?.state === 'done' ? ifcPath(j.sha) : null; },
  };
}
