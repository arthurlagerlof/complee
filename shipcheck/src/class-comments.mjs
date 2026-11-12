// Class comments: the comments a classification society (or flag) sends on a submission, tracked to closure.
// Each comment is linked to the elements and rules it is about, so the current rule check shows whether the
// design still has the finding. Pure functions over a plain store object: browser and Node.
//
// store: { comments: [{ id, ref, text, document, received, revision, links: { elements, rules },
//                       status, response, responsible, updated, created }] }

export const COMMENT_STATUSES = [
  { id: 'open', label: 'Open' },
  { id: 'answered', label: 'Answered, waiting for class' },
  { id: 'closed', label: 'Closed by class' },
];
export const COMMENT_STATUS_LABEL = Object.fromEntries(COMMENT_STATUSES.map((s) => [s.id, s.label]));

// ---------- import ----------

// CSV / TSV / semicolon lines with quotes ("a ""b"" c").
function splitDelimited(text, sep) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const HEADERS = {
  ref: /^(ref|no\.?|nr\.?|number|#|item|comment ?(no|nr|number|id)\.?|id)$/i,
  text: /^(comment|comments|text|description|remark|remarks|class comment|observation)$/i,
  document: /^(drawing|drawing no\.?|document|document no\.?|doc|doc\.? no\.?|plan|plan no\.?)$/i,
  status: /^(status|state)$/i,
  response: /^(response|reply|answer|yard response|designer response)$/i,
};

function fromTable(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const sep = ['\t', ';', ','].map((s) => [s, first.split(s).length]).sort((a, b) => b[1] - a[1])[0];
  if (sep[1] < 2) return null;
  const rows = splitDelimited(text, sep[0]);
  const head = rows[0].map((h) => h.trim());
  const col = Object.fromEntries(Object.entries(HEADERS).map(([k, re]) => [k, head.findIndex((h) => re.test(h))]));
  if (col.text < 0) return null; // no comment column: not a table we understand
  const status = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (/^(closed|accepted|ok|resolved)/.test(s)) return 'closed';
    if (/^(answered|replied|responded|pending class)/.test(s)) return 'answered';
    return 'open';
  };
  return rows.slice(1).filter((r) => r[col.text]?.trim()).map((r, i) => ({
    ref: (col.ref >= 0 ? r[col.ref] : '')?.trim() || String(i + 1),
    text: r[col.text].trim(),
    document: col.document >= 0 ? (r[col.document] ?? '').trim() : '',
    status: col.status >= 0 ? status(r[col.status]) : 'open',
    response: col.response >= 0 ? (r[col.response] ?? '').trim() : '',
  }));
}

// "1. ...", "1) ...", "2.3 ...", "Comment 4: ...", "Item 5 - ..." start a comment; following lines continue it.
const NUMBERED = /^\s*(?:(?:comment|item|remark|no\.?)\s*(?:no\.?\s*)?)?(\d+(?:\.\d+)*)\s*[.):-]?\s+(?=\S)/i;

function fromList(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = NUMBERED.exec(line);
    if (m && /[.):-]|comment|item|remark|no/i.test(line.slice(0, m[0].length))) {
      cur = { ref: m[1], text: line.slice(m[0].length).trim() };
      out.push(cur);
    } else if (cur && line.trim()) cur.text += ` ${line.trim()}`;
    // Text before the first numbered comment (letter head, salutation) is not a comment.
  }
  if (out.length) return out;
  // No numbering: one comment per paragraph.
  return text.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).map((t, i) => ({ ref: String(i + 1), text: t }));
}

/** Pasted text or a CSV export of a comment sheet -> comment drafts { ref, text, document?, status?, response? }. */
export function parseComments(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trim();
  if (!t) return [];
  return fromTable(t) ?? fromList(t);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Element and rule ids written in the comment text. Exact ids only (case-insensitive, not part of a longer id):
 * a comment that names no id stays unlinked until the engineer links it.
 */
export function findLinks(text, elementIds, ruleIds) {
  const hit = (id) => new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(id)}(?![A-Za-z0-9_-])`, 'i').test(text);
  return { elements: elementIds.filter((id) => id.length >= 2 && hit(id)), rules: ruleIds.filter(hit) };
}

/** Adds imported comments to the store; refs already in the store for the same document are not added twice. */
export function addComments(store, drafts, { document = '', received = '', revision = '', elementIds = [], ruleIds = [] } = {}, now = new Date()) {
  const comments = [...(store?.comments ?? [])];
  const key = (c) => `${(c.document || '').toLowerCase()}|${String(c.ref).toLowerCase()}`;
  const seen = new Set(comments.map(key));
  let added = 0, skipped = 0;
  for (const d of drafts) {
    const c = {
      id: `c${now.getTime().toString(36)}${(comments.length + 1).toString(36)}`,
      ref: String(d.ref ?? comments.length + 1), text: d.text, document: d.document || document, received, revision,
      links: findLinks(d.text, elementIds, ruleIds),
      status: d.status || 'open', response: d.response || '', responsible: '',
      created: now.toISOString(), updated: now.toISOString(),
    };
    if (seen.has(key(c))) { skipped++; continue; }
    seen.add(key(c));
    comments.push(c);
    added++;
  }
  return { store: { ...store, comments }, added, skipped };
}

/** Returns a new store with one comment changed. Closing a comment needs a response on record. */
export function withComment(store, id, patch, now = new Date()) {
  const comments = (store?.comments ?? []).map((c) => {
    if (c.id !== id) return c;
    const next = { ...c, ...patch, links: { ...c.links, ...(patch.links ?? {}) }, updated: now.toISOString() };
    if (next.status !== 'open' && !String(next.response ?? '').trim()) throw new Error('Write the response before marking the comment answered or closed.');
    return next;
  });
  return { ...store, comments };
}

export function withoutComment(store, id) {
  return { ...store, comments: (store?.comments ?? []).filter((c) => c.id !== id) };
}

// ---------- evidence from the current rule check ----------

/**
 * What the current rule check says about the elements and rules a comment is linked to:
 *   state 'finding'   - at least one linked item still has a non-compliant result
 *   state 'missing'   - no non-compliant result, but missing information or an element not in the model
 *   state 'no_finding'- every linked item is checked without deviation
 *   state 'unlinked'  - nothing linked: the check cannot say anything
 */
export function commentEvidence(comment, results) {
  const els = comment.links?.elements ?? [], rules = comment.links?.rules ?? [];
  if (!els.length && !rules.length) return { state: 'unlinked', items: [] };
  const items = [];
  const targets = els.length ? els : Object.keys(results.elements).filter((id) => results.elements[id].results.some((r) => rules.includes(r.rule_id)));
  for (const id of targets) {
    const e = results.elements[id];
    if (!e) { items.push({ element: id, missing_element: true }); continue; }
    const rs = rules.length ? e.results.filter((r) => rules.includes(r.rule_id)) : e.results;
    if (!rs.length) { items.push({ element: id, name: e.name, status: null }); continue; }
    for (const r of rs) items.push({ element: id, name: e.name, rule_id: r.rule_id, status: r.status, measured: r.measured, required: r.required });
  }
  // An element that is gone, has missing data or no applicable rule cannot confirm anything: "missing".
  const state = items.some((i) => i.status === 'non_compliant') ? 'finding'
    : items.length && items.every((i) => i.status === 'compliant') ? 'no_finding' : 'missing';
  return { state, items };
}

export const EVIDENCE_LABEL = {
  finding: 'Rule check: finding still present',
  missing: 'Rule check: information missing',
  no_finding: 'Rule check: no deviation now',
  unlinked: 'Not linked to the model',
};

export function commentSummary(comments, results) {
  const list = comments ?? [];
  return {
    total: list.length,
    open: list.filter((c) => c.status === 'open').length,
    answered: list.filter((c) => c.status === 'answered').length,
    closed: list.filter((c) => c.status === 'closed').length,
    // Answered as resolved while the check still finds the deviation: the reply and the design disagree.
    contradicted: results ? list.filter((c) => c.status !== 'open' && commentEvidence(c, results).state === 'finding').length : 0,
  };
}

/** Comment resolution sheet (CSV), one row per comment. */
export function commentsCSV(comments, results) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['ref', 'document', 'received', 'comment', 'elements', 'rules', 'rule_check_now', 'status', 'response', 'responsible', 'updated', 'revision_received'];
  const lines = (comments ?? []).map((c) => {
    const ev = results ? commentEvidence(c, results) : { state: 'unlinked' };
    return [c.ref, c.document, c.received, c.text, (c.links?.elements ?? []).join(' '), (c.links?.rules ?? []).join(' '), EVIDENCE_LABEL[ev.state],
      COMMENT_STATUS_LABEL[c.status] ?? c.status, c.response, c.responsible, c.updated?.slice(0, 10), c.revision].map(q).join(',');
  });
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
