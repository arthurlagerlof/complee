// Rule view section "Official text": the provisions linked to a rule in the regulation database
// (GET api/regulations/text?rule=<id>, see src/regulation-text.mjs). Evidence for review only: it never changes
// the rule value or the pass/fail result. Uses the existing rule-view elements (muted label, blockquote, tags, note).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AVAILABILITY = { full: 'full text', summary: 'summary text', portal: 'portal reference' };

export function renderOfficialText(data) {
  const label = '<div class="muted" style="margin-top:10px">Official text · regulation database</div>';
  if (!data.linked) {
    return `${label}<p class="muted" title="${esc(data.loaded_instruments)}">${esc(data.note)} Loaded: SOLAS II-2, ADA 2010, DNV class guidelines.</p>`;
  }
  const note = data.note ? `<div class="note">${esc(data.note)}</div>` : '';
  if (!data.reachable) {
    return `${label}${note}<p class="muted">${esc(data.error)} Linked: ${data.provisions.map((p) => esc(p.clause)).join(', ')}.</p>`;
  }
  const items = data.provisions.map((p) => `
    <div class="muted" style="margin-top:6px"><b>${esc(p.document_code)} ${esc(p.clause)}</b>${p.note ? ` · ${esc(p.note)}` : ''}</div>
    <blockquote>“${esc(p.text)}”</blockquote>
    <div class="tags">
      <span class="tag grey" title="${esc(data.method)}">${p.match === 'exact' ? 'clause of this rule' : 'related clause'}</span>
      ${p.availability ? `<span class="tag grey">${esc(AVAILABILITY[p.availability] || p.availability)}</span>` : ''}
      <span class="tag grey" title="${esc(p.document_note || p.heading || '')}">${esc(p.edition || p.document)}</span>
    </div>`).join('');
  return `${label}${note}${items}<p class="muted">Shown for review; the result above comes only from the checker.</p>`;
}

export async function loadOfficialText(container, ruleId) {
  if (!container) return;
  container.innerHTML = '<div class="muted" style="margin-top:10px">Official text · loading from the regulation database…</div>';
  try {
    const res = await fetch(`api/regulations/text?rule=${encodeURIComponent(ruleId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    if (container.isConnected) container.innerHTML = renderOfficialText(data);
  } catch (e) {
    if (container.isConnected) container.innerHTML = `<div class="muted" style="margin-top:10px">Official text · not available (${esc(e.message)}).</div>`;
  }
}
