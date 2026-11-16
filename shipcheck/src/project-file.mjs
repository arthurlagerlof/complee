// Project file: the engineer's work on a project (findings register with manual-check confirmations, and class
// comments) as one JSON file, so it can be backed up, handed to a colleague or opened in another browser. The
// design model itself is not in it: the project file goes with whatever revision is opened.
import { DISPOSITION_LABEL } from './dispositions.mjs';
import { COMMENT_STATUS_LABEL } from './class-comments.mjs';

export const PROJECT_FORMAT = 'complee-project/1';

export function projectFile({ project, model, revision, register = {}, comments = [], revisions = [] }, now = new Date()) {
  return { format: PROJECT_FORMAT, project, model, revision, saved: now.toISOString(), revisions, register, comments };
}

const text = (v, max = 2000) => (v == null ? '' : String(v)).slice(0, max);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY = /^.+\|[^|]+$/;

// A register entry as the app writes it, or null when it cannot be one. Text fields become text, unknown
// dispositions "open", and a manual check counts as confirmed only with the name of who checked it.
function cleanEntry(key, d) {
  if (!KEY.test(key) || !isObj(d) || ['__proto__', 'constructor', 'prototype'].includes(key)) return null;
  const base = { responsible: text(d.responsible, 80), note: text(d.note, 600), updated: text(d.updated, 40), revision: text(d.revision, 200), name: text(d.name, 300), deck: text(d.deck, 80) };
  if (d.kind === 'manual') {
    return { ...base, kind: 'manual', done: d.done === true && !!base.responsible.trim(), ...(typeof d.fingerprint === 'string' ? { fingerprint: d.fingerprint.slice(0, 40) } : {}) };
  }
  // measured / status / required are compared with the current finding as they are (a disposition goes stale when
  // they differ): kept unchanged when they are plain values, left out otherwise.
  const kept = {};
  for (const k of ['measured', 'status', 'required']) if (['string', 'number', 'boolean'].includes(typeof d[k])) kept[k] = d[k];
  return {
    ...base, disposition: DISPOSITION_LABEL[d.disposition] ? d.disposition : 'open', ...kept,
    ...(d.moved_from ? { moved_from: text(d.moved_from, 200) } : {}),
  };
}

function cleanComment(c) {
  if (!isObj(c) || typeof c.id !== 'string' || typeof c.text !== 'string') return null;
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : []);
  return {
    id: c.id.slice(0, 80), ref: text(c.ref, 80), text: c.text.slice(0, 20000), document: text(c.document, 200), received: text(c.received, 40), revision: text(c.revision, 200),
    links: { elements: ids(c.links?.elements), rules: ids(c.links?.rules) },
    status: COMMENT_STATUS_LABEL[c.status] ? c.status : 'open', response: text(c.response, 20000), responsible: text(c.responsible, 80),
    created: text(c.created, 40), updated: text(c.updated, 40),
  };
}

/**
 * Parses and checks a project file. Throws with a message for the engineer when it is not one. Entries that cannot
 * be used are left out and listed in `problems` (a damaged or hand-edited file must not break the project).
 */
export function readProjectFile(raw, currentProject) {
  let data;
  try { data = JSON.parse(String(raw).replace(/^﻿/, '')); } catch { throw new Error('The file is not a Complee project file (not JSON).'); }
  if (data?.format !== PROJECT_FORMAT) throw new Error(`The file is not a Complee project file (format "${data?.format ?? 'missing'}", expected "${PROJECT_FORMAT}").`);
  const problems = [];
  const register = {};
  let badEntries = 0, unconfirmed = 0;
  for (const [key, d] of Object.entries(isObj(data.register) ? data.register : {})) {
    const e = cleanEntry(key, d);
    if (!e) { badEntries++; continue; }
    if (e.kind === 'manual' && d.done === true && !e.done) unconfirmed++;
    register[key] = e;
  }
  if (data.register !== undefined && !isObj(data.register)) problems.push('the register is not a list of entries');
  if (badEntries) problems.push(`${badEntries} register entr${badEntries === 1 ? 'y that is' : 'ies that are'} not readable`);
  if (unconfirmed) problems.push(`${unconfirmed} manual check${unconfirmed === 1 ? '' : 's'} marked done without the name of who checked (left unconfirmed)`);
  const comments = [], seen = new Set();
  let badComments = 0, duplicates = 0;
  for (const c of Array.isArray(data.comments) ? data.comments : []) {
    const clean = cleanComment(c);
    if (!clean) { badComments++; continue; }
    if (seen.has(clean.id)) { duplicates++; continue; }
    seen.add(clean.id);
    comments.push(clean);
  }
  if (badComments) problems.push(`${badComments} class comment${badComments === 1 ? ' that is' : 's that are'} not readable`);
  if (duplicates) problems.push(`${duplicates} class comment${duplicates === 1 ? '' : 's'} with an id that occurs twice`);
  return {
    register, comments, problems,
    project: data.project ?? null, model: data.model ?? null, revision: data.revision ?? null, saved: data.saved ?? null,
    revisions: Array.isArray(data.revisions) ? data.revisions.filter((r) => typeof r === 'string') : [],
    // Another project's file can still be opened (renamed ship, new model name), but the engineer is told.
    other_project: !!data.project && data.project !== currentProject,
  };
}
