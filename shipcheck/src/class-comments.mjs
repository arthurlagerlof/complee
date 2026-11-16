// Class comments: the comments a classification society (or flag) sends on a submission, tracked to closure.
// Each comment is linked to the elements and rules it is about, so the current rule check shows whether the
// design still has the finding. Pure functions over a plain store object: browser and Node.
//
// store: { comments: [{ id, ref, text, document, received, revision, links: { elements, rules },
//                       status, response, responsible, updated, created }] }
import { csvCell } from './csv.mjs';

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

// Column headers of comment sheets, English and German (as class societies and yards write them). Compared after
// lower-casing and removing dots, so "Nr.", "No." and "Item No" all match.
const HEADERS = {
  ref: /^(ref|reference|no|nr|number|#|item|item no|item nr|comment no|comment nr|comment number|comment id|id|pos|position|lfd nr|nummer)$/,
  text: /^(comment|comments|text|description|remark|remarks|class comment|surveyor comment|surveyors comment|observation|finding|kommentar|bemerkung|anmerkung|beschreibung|befund|klassenkommentar)$/,
  document: /^(drawing|drawing no|drawing nr|document|document no|doc|doc no|plan|plan no|zeichnung|zeichnungs nr|zeichnungsnr|zeichnung nr|dokument|plan nr)$/,
  status: /^(status|state|zustand)$/,
  response: /^(response|reply|answer|yard response|yard reply|designer response|designer reply|antwort|stellungnahme|werft|antwort werft)$/,
};
const headerName = (h) => String(h).trim().toLowerCase().replace(/[.:]/g, '').replace(/[_\s]+/g, ' ').replace(/'/g, '');

function fromTable(text, notes) {
  // The header row may follow a title line ("Comment sheet, drawing 100-01"): it is the first of the first five lines
  // that has a comment column.
  const lines = text.split(/\r?\n/).slice(0, 5);
  for (let at = 0; at < lines.length; at++) {
    const sep = ['\t', ';', ','].map((x) => [x, lines[at].split(x).length]).sort((a, b) => b[1] - a[1])[0];
    if (sep[1] < 2) continue;
    const rows = splitDelimited(text.split(/\r?\n/).slice(at).join('\n'), sep[0]);
    const head = rows[0].map(headerName);
    const col = Object.fromEntries(Object.entries(HEADERS).map(([k, re]) => [k, head.findIndex((h) => re.test(h))]));
    if (col.text < 0) continue; // no comment column in this line
    if (at) notes.push(`${at} line${at === 1 ? '' : 's'} above the column headers ${at === 1 ? 'was' : 'were'} skipped (title).`);
    const unknownStatus = new Set();
    const status = (v) => {
      const st = String(v ?? '').trim().toLowerCase();
      if (!st) return 'open';
      if (/\?/.test(st)) { unknownStatus.add(st); return 'open'; } // "OK?" is a question, not a closure
      if (/^(closed|accepted|ok|okay|resolved|done|erledigt|geschlossen|akzeptiert|abgeschlossen)\b/.test(st)) return 'closed';
      if (/^(answered|replied|responded|pending class|beantwortet)\b/.test(st)) return 'answered';
      if (!/^(open|offen|pending|new|neu)\b/.test(st)) unknownStatus.add(st);
      return 'open';
    };
    const out = rows.slice(1).filter((r) => r[col.text]?.trim()).map((r, i) => ({
      ref: (col.ref >= 0 ? r[col.ref] : '')?.trim() || String(i + 1),
      text: r[col.text].trim(),
      document: col.document >= 0 ? (r[col.document] ?? '').trim() : '',
      status: col.status >= 0 ? status(r[col.status]) : 'open',
      response: col.response >= 0 ? (r[col.response] ?? '').trim() : '',
    }));
    if (unknownStatus.size) notes.push(`Status ${[...unknownStatus].map((x) => `"${x}"`).join(', ')} not understood: imported as open.`);
    return out;
  }
  return null;
}

// A comment starts with its reference: "1.", "1)", "2.3", "Comment 4:", "Item 5 -", "A1.", "a)", "HULL-003:", or a
// bullet ("-", "•"). Following lines continue it.
const REF_LINE = /^\s*(?:(comment|item|remark|no\.?|nr\.?|kommentar|punkt|pos\.?)\s*(?:no\.?\s*|nr\.?\s*)?)?((?:\d+(?:\.\d+)*)|(?:[A-Z]{1,6}[-.]?\d+(?:[.-]\d+)*)|[a-z])(\s*[.):-]|\s+(?=\S))\s*(?=\S)/i;
const BULLET = /^\s*[-–•*]\s+(?=\S)/;
// Units and words that follow a number in running text ("3.5 m clear height", "15.11.2026 was agreed"): not a reference.
const AFTER_NUMBER = /^(?:(?:mm|cm|m|m2|m3|kg|t|kn|kw|deg|bar|mpa|x|bis|to|and|und|was|is|wurde|ist)\b|m²|%|°|n\/mm)/i;
// End of the letter: nothing after the closing formula is a comment.
const CLOSING = /^\s*(yours (sincerely|faithfully)|kind regards|best regards|regards,?|sincerely,?|mit freundlichen gr(ü|ue)(ß|ss)en|viele gr(ü|ue)(ß|ss)e)\b/i;

function fromList(text, notes) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null, bullets = 0, cut = false;
  for (const line of lines) {
    if (CLOSING.test(line)) { cut = !!out.length; if (out.length) break; continue; }
    const m = REF_LINE.exec(line);
    let start = null;
    if (m) {
      const [whole, word, ref, delim] = m;
      const rest = line.slice(whole.length);
      const isNumber = /^\d/.test(ref);
      const explicit = !!word || /[.):-]/.test(delim);
      // A number at the start of a line is a reference when it is marked as one (a word before it, or ".", ")", ":"
      // or "-" after it) and not followed by a unit; a dotted number like a date continues the comment instead.
      if (isNumber && /^\d+(\.\d+){2,}$/.test(ref) && !word && ref.split('.').some((p) => p.length === 4)) start = null; // a date
      else if (isNumber && AFTER_NUMBER.test(rest)) start = null;
      else if (explicit || (isNumber && /\./.test(ref))) start = { ref, text: rest.trim() };
      else if (/^[A-Z]{1,6}[-.]?\d/.test(ref) && /\d$/.test(ref)) start = { ref, text: rest.trim() };
    }
    if (!start && BULLET.test(line)) { bullets++; start = { ref: String(out.length + 1), text: line.replace(BULLET, '').trim() }; }
    if (start) { cur = start; out.push(cur); }
    else if (cur && line.trim()) cur.text += ` ${line.trim()}`;
    // Text before the first comment (letter head, salutation) is not a comment.
  }
  if (cut) notes.push('The closing formula and signature at the end were not imported.');
  if (bullets && bullets === out.length) notes.push('The comments are bullets without numbers: numbered 1, 2, 3 ... in the order of the text.');
  if (out.length) return out;
  // No numbering: one comment per paragraph.
  return text.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).map((t, i) => ({ ref: String(i + 1), text: t }));
}

/**
 * Pasted text or a CSV export of a comment sheet -> comment drafts { ref, text, document?, status?, response? }.
 * The returned list carries `notes`: what was skipped or read in a way the engineer should check.
 */
export function parseComments(text) {
  const t = String(text ?? '').replace(/^﻿/, '').trim();
  const notes = [];
  const out = t ? (fromTable(t, notes) ?? fromList(t, notes)) : [];
  Object.defineProperty(out, 'notes', { value: notes, enumerable: false }); // the list itself stays a plain list of comments
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Ids made only of letters, digits, "_" and "-" are found by looking up the words of the comment in an index (one
// pass over the text, whatever the size of the model: a 35,000-part model used to take over a second per comment);
// other ids ("ADA-403.5.1") by a pattern each. Built once per id list.
const ID_WORD = /^[A-Za-z0-9_-]+$/;
const idIndexes = new WeakMap();
function idIndex(ids) {
  let hit = idIndexes.get(ids);
  if (!hit) {
    const words = new Map(), other = [];
    for (const id of ids) {
      if (String(id).length < 2) continue;
      if (ID_WORD.test(id)) { const k = String(id).toLowerCase(); if (!words.has(k)) words.set(k, []); words.get(k).push(id); }
      else other.push(id);
    }
    hit = { words, other };
    idIndexes.set(ids, hit);
  }
  return hit;
}
function idsIn(text, ids) {
  const { words, other } = idIndex(ids);
  const found = new Set();
  for (const w of String(text).match(/[A-Za-z0-9_-]+/g) ?? []) for (const id of words.get(w.toLowerCase()) ?? []) found.add(id);
  for (const id of other) if (new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(id)}(?![A-Za-z0-9_-])`, 'i').test(text)) found.add(id);
  return ids.filter((id) => found.has(id)); // in the order of the list
}

/**
 * Element and rule ids written in the comment text. Exact ids only (case-insensitive, not part of a longer id):
 * a comment that names no id stays unlinked until the engineer links it.
 */
export function findLinks(text, elementIds, ruleIds) {
  return { elements: idsIn(text, elementIds), rules: idsIn(text, ruleIds) };
}

/**
 * Adds imported comments to the store. A comment already in the list (same document, same reference and the same
 * text) is not added twice; the same reference with a different text is a new comment (a later letter numbers its
 * comments from 1 again) and is added.
 */
export function addComments(store, drafts, { document = '', received = '', revision = '', elementIds = [], ruleIds = [] } = {}, now = new Date()) {
  const comments = [...(store?.comments ?? [])];
  const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const key = (c) => `${(c.document || '').toLowerCase()}|${String(c.ref).toLowerCase()}|${norm(c.text)}`;
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

// Source of a value the engineer typed in the viewer (what-if): not part of the design.
const WHAT_IF = /what-if/i;

/**
 * What the current rule check says about the elements and rules a comment is linked to:
 *   state 'finding'    - at least one linked item still has a non-compliant result
 *   state 'missing'    - no non-compliant result, but missing information, an element not in the model, or a manual
 *                        check of the linked rule that nobody has confirmed
 *   state 'what_if'    - no deviation, but only with values typed in the viewer that are not in the design
 *   state 'unscoped'   - only elements are linked, and their rule results show no deviation: whether those rules are
 *                        what the comment is about, the check cannot tell (link the rule to make it say so)
 *   state 'no_finding' - every linked rule is checked on its elements without deviation
 *   state 'unlinked'   - nothing linked: the check cannot say anything
 * register (optional): manual-check confirmations, so a confirmed manual check counts as done.
 */
export function commentEvidence(comment, results, register = {}) {
  const els = comment.links?.elements ?? [], rules = comment.links?.rules ?? [];
  if (!els.length && !rules.length) return { state: 'unlinked', items: [] };
  const items = [];
  const targets = els.length ? els : Object.keys(results.elements).filter((id) => {
    const e = results.elements[id];
    return e.results.some((r) => rules.includes(r.rule_id)) || (e.manual ?? []).some((m) => rules.includes(m.rule_id));
  });
  let whatIf = false;
  for (const id of targets) {
    const e = results.elements[id];
    if (!e) { items.push({ element: id, missing_element: true }); continue; }
    const rs = rules.length ? e.results.filter((r) => rules.includes(r.rule_id)) : e.results;
    // Manual checks of the linked rules (or, when only the element is linked, all of its manual checks) are open
    // until someone confirmed them for this element.
    const ms = (e.manual ?? []).filter((m) => (rules.length ? rules.includes(m.rule_id) : true));
    for (const m of ms) {
      const d = register?.[`${id}|${m.rule_id}`];
      const done = d?.kind === 'manual' && d.done && String(d.responsible ?? '').trim();
      items.push({ element: id, name: e.name, rule_id: m.rule_id, status: done ? 'compliant' : 'manual_open', manual: true });
    }
    if (!rs.length && !ms.length) { items.push({ element: id, name: e.name, status: null }); continue; }
    for (const r of rs) {
      const typed = r.status !== 'non_compliant' && (r.inputs ?? []).some((i) => WHAT_IF.test(i.source ?? ''));
      if (typed) whatIf = true;
      items.push({ element: id, name: e.name, rule_id: r.rule_id, status: r.status, measured: r.measured, required: r.required, ...(typed ? { what_if: true } : {}) });
    }
  }
  // An element that is gone, has missing data, an open manual check or no applicable rule cannot confirm anything.
  const state = items.some((i) => i.status === 'non_compliant') ? 'finding'
    : !(items.length && items.every((i) => i.status === 'compliant')) ? 'missing'
      : whatIf ? 'what_if'
        : rules.length ? 'no_finding' : 'unscoped';
  return { state, items };
}

export const EVIDENCE_LABEL = {
  finding: 'Rule check: finding still present',
  missing: 'Rule check: information missing or manual check open',
  what_if: 'Rule check: no deviation only with what-if values (not in the design)',
  unscoped: 'Rule check: element has no deviation in its rules; link the rule to confirm this topic',
  no_finding: 'Rule check: no deviation now',
  unlinked: 'Not linked to the model',
};
// Display class per state (viewer and report).
export const EVIDENCE_CLASS = { finding: 'non_compliant', missing: 'not_enough_info', what_if: 'not_enough_info', unscoped: 'none', no_finding: 'compliant', unlinked: 'none' };

/**
 * Answered or closed while the rule check cannot confirm it (information missing, manual check open, only what-if
 * values): not a contradiction, but the reply rests on something the check does not show.
 */
export function isUnconfirmed(comment, results, register = {}) {
  if (!results || comment.status === 'open') return false;
  const st = commentEvidence(comment, results, register).state;
  return st === 'missing' || st === 'what_if';
}

// Dispositions that answer a deviation without changing the design; with a written justification they make an
// answered comment legitimate even though the rule check still finds the deviation.
const JUSTIFIED = new Set(['deviation', 'accepted', 'not_applicable']);

/**
 * A comment marked answered or closed while the design still has the deviation it is about, and the register holds
 * no justified deviation, acceptance or "not applicable" for it: the reply and the design disagree.
 */
export function isContradicted(comment, results, register = {}) {
  if (!results || comment.status === 'open') return false;
  const ev = commentEvidence(comment, results, register);
  if (ev.state !== 'finding') return false;
  return ev.items.some((i) => {
    if (i.status !== 'non_compliant') return false;
    const d = register?.[`${i.element}|${i.rule_id}`];
    return !(d && JUSTIFIED.has(d.disposition) && String(d.note ?? '').trim());
  });
}

export function commentSummary(comments, results, register = {}) {
  const list = comments ?? [];
  return {
    total: list.length,
    open: list.filter((c) => c.status === 'open').length,
    answered: list.filter((c) => c.status === 'answered').length,
    closed: list.filter((c) => c.status === 'closed').length,
    // Answered as resolved while the check still finds the deviation: the reply and the design disagree.
    contradicted: results ? list.filter((c) => isContradicted(c, results, register)).length : 0,
    unconfirmed: results ? list.filter((c) => isUnconfirmed(c, results, register)).length : 0,
  };
}

/** Comment resolution sheet (CSV), one row per comment. */
export function commentsCSV(comments, results, register = {}) {
  const q = csvCell; // quotes, and neutralises text Excel would run as a formula
  const head = ['ref', 'document', 'received', 'comment', 'elements', 'rules', 'rule_check_now', 'status', 'response', 'responsible', 'updated', 'revision_received'];
  const lines = (comments ?? []).map((c) => {
    const ev = results ? commentEvidence(c, results, register) : { state: 'unlinked' };
    return [c.ref, c.document, c.received, c.text, (c.links?.elements ?? []).join(' '), (c.links?.rules ?? []).join(' '), EVIDENCE_LABEL[ev.state],
      COMMENT_STATUS_LABEL[c.status] ?? c.status, c.response, c.responsible, c.updated?.slice(0, 10), c.revision].map(q).join(',');
  });
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
