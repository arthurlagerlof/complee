// Optional AI layer. It drafts rule entries and rewrites explanations; it NEVER decides pass/fail.
// Every draft is checked against the pasted text (verbatim quote, value present) and stays
// verified:false until an engineer approves it in the UI.
//
// Configure in .env (see .env.example). Without a key the UI hides the AI features.
//   AI_PROVIDER=mistral | anthropic | openai-compatible   (default: first key found)
//   MISTRAL_API_KEY=...       EU-hosted (Mistral AI, Paris). MISTRAL_MODEL, MISTRAL_BASE_URL optional
//   ANTHROPIC_API_KEY=...     ANTHROPIC_MODEL optional
//   AI_BASE_URL=http://localhost:11434/v1  AI_MODEL=...   any OpenAI-compatible server (e.g. a local model)
//
// CLI: node rule-assistant.mjs "<rule paragraph>"   prints a draft (needs a key)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRule, CHECK_TYPES } from './src/checker.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APPROVED = path.join(ROOT, 'rules-approved.json');

export function providerConfig(env = process.env) {
  const want = (env.AI_PROVIDER || '').toLowerCase();
  const mistral = env.MISTRAL_API_KEY && {
    name: 'mistral', kind: 'openai', key: env.MISTRAL_API_KEY,
    base: env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1', model: env.MISTRAL_MODEL || 'mistral-large-latest',
  };
  const anthropic = env.ANTHROPIC_API_KEY && {
    name: 'anthropic', kind: 'anthropic', key: env.ANTHROPIC_API_KEY,
    base: 'https://api.anthropic.com/v1', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  };
  const compat = env.AI_BASE_URL && {
    name: 'openai-compatible', kind: 'openai', key: env.AI_API_KEY || '', base: env.AI_BASE_URL, model: env.AI_MODEL || 'default',
  };
  const all = { mistral, anthropic, 'openai-compatible': compat };
  return (want && all[want]) || mistral || anthropic || compat || null;
}

async function complete(system, user, cfg = providerConfig()) {
  if (!cfg) throw Object.assign(new Error('No AI provider configured (.env)'), { status: 503 });
  let res;
  if (cfg.kind === 'anthropic') {
    res = await fetch(`${cfg.base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1500, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`${cfg.name} API ${res.status}`);
    const j = await res.json();
    return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
    body: JSON.stringify({
      model: cfg.model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`${cfg.name} API ${res.status}`);
  return (await res.json()).choices[0].message.content;
}

function parseJSON(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI answer contained no JSON');
  return JSON.parse(m[0]);
}

const norm = (s) => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
export const isVerbatim = (quote, source) => !!quote && norm(source).includes(norm(quote));

// Grounding and structure checks for a drafted rule. Pure function (tested offline).
export function checkDraft(rule, pastedText, existingIds = []) {
  const numbers = (pastedText.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(',', '.')));
  const checks = [
    { label: 'Rule text is quoted verbatim from the pasted paragraph', ok: isVerbatim(rule.text, pastedText) },
    {
      label: rule.value == null ? 'No numeric value needed for this check type' : `Value ${rule.value} ${rule.unit ?? ''} appears in the pasted text`,
      ok: rule.value == null || numbers.includes(Number(rule.value)),
    },
    { label: `Check type "${rule.check}" is supported by the checker`, ok: CHECK_TYPES.includes(rule.check) },
    { label: `Id "${rule.id}" is not used by another rule`, ok: !!rule.id && !existingIds.includes(rule.id) },
  ];
  const errors = validateRule(rule);
  checks.push({ label: errors.length ? `Structure: ${errors.join('; ')}` : 'Structure is valid', ok: !errors.length });
  return { checks, valid: checks.every((c) => c.ok) };
}

const DRAFT_SYSTEM = `You convert one paragraph of a ship design regulation into a JSON rule for a deterministic checker.
Answer with JSON only. If the paragraph contains no single checkable requirement, answer {"found": false}.
Otherwise answer {"found": true, "rule": {...}} with these fields:
id (short, uppercase, e.g. "ADA-404.2.3"), source, clause, text (copy the requirement sentence VERBATIM from the paragraph, do not rephrase),
check (one of: ${CHECK_TYPES.join(', ')}), parameter (snake_case design property, e.g. clear_width, height, slope, sill_height, dead_end_length, escape_routes),
value (number exactly as written in the text, converted to the unit you give), unit ("mm", "in", "m", "ratio" or "count"),
applies_to: {"types": [element types such as corridor, door, stair, ramp, guard_rail, fuel_tank, escape_zone, machinery_space], "where": {optional exact property matches}, "ship": {optional "type_in": [...], "operating_area_any": [...]}},
related: [], verified: false.
Never invent a value that is not in the paragraph.`;

export async function draftRule(pastedText, sourceHint = '', existingIds = []) {
  const cfg = providerConfig();
  const user = `Source document: ${sourceHint || 'unknown'}\nParagraph:\n"""${pastedText}"""`;
  const out = parseJSON(await complete(DRAFT_SYSTEM, user, cfg));
  if (!out.found || !out.rule) return { found: false, provider: cfg.name };
  const rule = { ...out.rule, verified: false, text_status: 'verbatim', basis: 'explicit', drafted_by: `${cfg.name}:${cfg.model}`, source_text: pastedText };
  if (!rule.source && sourceHint) rule.source = sourceHint;
  return { found: true, provider: cfg.name, rule, ...checkDraft(rule, pastedText, existingIds) };
}

const EXPLAIN_SYSTEM = `You explain a compliance check result to a ship design engineer. The result is final and was computed by a deterministic checker: never change or question the status.
Answer with JSON only: {"quote": "...", "explanation": "...", "fix": "..."}.
quote: copy the relevant sentence of the rule text VERBATIM, or "not found" if the rule text does not support the finding.
explanation: two or three sentences in plain engineering language: what was measured, what the rule requires, why it matters.
fix: one concrete design change that would make it compliant, or what data is missing.`;

export async function explainResult(element, result) {
  const cfg = providerConfig();
  const user = JSON.stringify({ element, status: result.status, rule_id: result.rule_id, source: result.source, clause: result.clause,
    rule_text: result.rule_text, measured: result.measured, required: result.required, checker_explanation: result.explanation });
  const out = parseJSON(await complete(EXPLAIN_SYSTEM, user, cfg));
  const quoteOk = out.quote !== 'not found' && isVerbatim(out.quote, result.rule_text);
  return {
    provider: cfg.name,
    quote_ok: quoteOk,
    explanation: `${quoteOk ? `Rule: "${out.quote}"\n` : out.quote === 'not found' ? 'Rule: not found\n' : ''}${out.explanation}`,
    fix: out.fix,
  };
}

export function loadApproved() {
  return fs.existsSync(APPROVED) ? JSON.parse(fs.readFileSync(APPROVED, 'utf8')).rules : [];
}

export function approveRule(rule, existingIds = []) {
  const approved = loadApproved();
  const r = { ...rule, verified: false, approved_at: new Date().toISOString() };
  const errors = validateRule(r);
  if (errors.length) throw Object.assign(new Error(`Rule not valid: ${errors.join('; ')}`), { status: 400 });
  if ([...existingIds, ...approved.map((x) => x.id)].includes(r.id)) throw Object.assign(new Error(`Rule id ${r.id} already exists`), { status: 409 });
  approved.push(r);
  fs.writeFileSync(APPROVED, JSON.stringify({ note: 'Rules drafted by the AI assistant and approved in the UI. Still verified:false until checked against the official text.', rules: approved }, null, 2));
  return approved;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = process.argv.slice(2).join(' ');
  if (!text) { console.error('Usage: node --env-file=.env rule-assistant.mjs "<rule paragraph>"'); process.exit(1); }
  const out = await draftRule(text);
  console.log(JSON.stringify(out, null, 2));
}
