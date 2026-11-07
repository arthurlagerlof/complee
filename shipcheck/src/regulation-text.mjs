// Official regulation text for a rule, from the team's regulation database (Tiger Cloud / TimescaleDB), read
// through the backend API (backend/: GET /api/v1/regulations/{provision_id}). Which provisions belong to which rule
// is curated in regulation-links.json. Read-only: the text is evidence for review and never changes a rule value
// or a pass/fail result. When the backend is not reachable the rule view says so; nothing is invented.
import fs from 'node:fs';

const TTL_MS = 10 * 60_000;

export function createRegulationText({ linksFile, ruleIds, apiBase = 'http://127.0.0.1:8000', fetchImpl = fetch, timeoutMs = 8000 }) {
  const links = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
  const base = String(apiBase).replace(/\/+$/, '');
  const cache = new Map(); // provision id -> { until, value }

  async function provision(id) {
    const hit = cache.get(id);
    if (hit && hit.until > Date.now()) return hit.value;
    const res = await fetchImpl(`${base}/api/v1/regulations/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw Object.assign(new Error(`regulation database returned ${res.status}`), { upstream: res.status });
    const p = await res.json();
    const value = {
      provision_id: p.id,
      document: p.regulatory_document,
      document_code: p.document_code,
      edition: p.edition,
      heading: p.chapter,
      clause: p.clause_reference,
      text: p.text,
      availability: p.provision_availability || p.source_availability || null,
      document_note: p.metadata?.document_note || null,
    };
    cache.set(id, { until: Date.now() + TTL_MS, value });
    return value;
  }

  return {
    async forRule(ruleId) {
      if (!ruleId || !ruleIds().includes(ruleId)) throw Object.assign(new Error('Unknown rule'), { status: 404 });
      const entry = links.rules[ruleId];
      const head = { rule_id: ruleId, database: links.database, loaded_instruments: links.loaded_instruments, method: links.method };
      if (!entry) return { ...head, linked: false, note: 'No provision in the regulation database is linked to this rule.', provisions: [] };
      try {
        const provisions = await Promise.all(entry.links.map(async (l) => ({ ...(await provision(l.provision_id)), match: l.match, note: l.note || null })));
        return { ...head, linked: true, reachable: true, note: entry.note || null, provisions };
      } catch (e) {
        const reason = e.upstream ? e.message : e.name === 'TimeoutError' ? 'no answer in time' : 'backend not reachable';
        return { ...head, linked: true, reachable: false, note: entry.note || null, error: `Regulation database unavailable (${reason}).`, provisions: entry.links.map((l) => ({ provision_id: l.provision_id, clause: l.clause, match: l.match, note: l.note || null, text: null })) };
      }
    },
  };
}
