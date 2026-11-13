// Verification status of rules, from the rule-verification database (backend). A status applies to a loaded rule only
// when the rule's logic is exactly the verified version (same SHA-256 of its canonical JSON); otherwise the viewer says
// that the database holds another version. Browser and Node (Web Crypto).

/** Sorted keys, no spaces: the same text as canonical_json in backend/app/services/rule_verification.py. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function logicSha256(logic) {
  const bytes = new TextEncoder().encode(canonicalJson(logic));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const LEVEL_LABEL = { draft: 'Draft: paraphrase, not verified', text_checked: 'Text checked against the official source', reviewed: 'Engineering reviewed', internal: 'Internal check (no official source)' };

/**
 * Status per rule id for the rules loaded in the viewer: { level, label, matches, ... } where matches says whether
 * the verified version is the one that is loaded. Rules unknown to the database get no entry.
 */
export async function statusForRules(rules, status) {
  const out = {};
  for (const r of rules) {
    const s = status?.rules?.[r.id];
    if (!s) continue;
    out[r.id] = { ...s, matches: (await logicSha256(r)) === s.logic_sha256 };
  }
  return out;
}

/** Counts for the coverage line: rules loaded and in the database with the same logic, by level. */
export function verificationCounts(ruleIds, byRule) {
  const c = { known: 0, text_checked: 0, reviewed: 0, other_version: 0 };
  for (const id of ruleIds) {
    const s = byRule?.[id];
    if (!s) continue;
    if (!s.matches) { c.other_version++; continue; }
    c.known++;
    if (s.level >= 1) c.text_checked++;
    if (s.level === 2) c.reviewed++;
  }
  return c;
}
