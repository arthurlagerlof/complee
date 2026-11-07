import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = path.join(HERE, 'data', 'solas_ii2_revised_mca.jsonl');
const DEFAULT_META = path.join(HERE, 'data', 'solas_ii2_revised_mca_metadata.json');

const normalize = (s = '') => s.toLocaleLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = (s) => [...new Set(normalize(s).split(/\s+/).filter((x) => x.length > 1))];

function readRecords(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* keep usable rows; source report remains visible */ }
  }
  return rows;
}

/**
 * Read-only adapter over the SinceAI extracted SOLAS II-2 JSONL.
 * Search is deterministic lexical retrieval; no embeddings are generated or assumed.
 * Returned records use a provider-neutral evidence shape and preserve source citations.
 */
export function createSinceAIProvider(config = {}) {
  const dataPath = path.resolve(config.dataPath || DEFAULT_DATA);
  const metadataPath = path.resolve(config.metadataPath || DEFAULT_META);
  const records = fs.existsSync(dataPath) ? readRecords(dataPath) : [];
  const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : {};
  const corpus = records.map((record) => ({ record, words: new Set(tokens(`${record.provision_reference || ''} ${record.title || ''} ${record.search_text || record.text || ''}`)) }));
  const reportPath = path.join(path.dirname(dataPath), 'solas_ii2_revised_mca_report.json');
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;

  return {
    id: 'sinceai-solas-ii2-lexical-v1',
    metadata: {
      source: 'SinceAI extracted SOLAS II-2 JSONL',
      document_id: metadata.document_id || null,
      source_edition: metadata.source_edition || null,
      bundle_sha256: metadata.bundle_sha256 || null,
      record_count: records.length,
      quality: report?.quality || null,
      retrieval: 'deterministic lexical search; embeddings are not used',
    },
    async search(query, options = {}) {
      const queryTokens = tokens(query);
      if (!queryTokens.length) return { provider: this.id, results: [] };
      const limit = Math.max(1, Math.min(Number(options.limit) || 8, 30));
      const results = corpus.map(({ record, words }) => {
        const matched = queryTokens.filter((token) => words.has(token));
        if (!matched.length) return null;
        // Weight exact clause refs and titles above general body matches.
        const ref = normalize(record.provision_reference || '');
        const title = normalize(record.title || '');
        let score = matched.length / queryTokens.length;
        for (const token of matched) {
          if (ref.split(' ').includes(token)) score += 0.8;
          if (title.split(' ').includes(token)) score += 0.35;
        }
        if (options.sourceKind && record.source_kind !== options.sourceKind) return null;
        if (options.regulation && String(record.regulation) !== String(options.regulation)) return null;
        return { record, score, matched_terms: matched };
      }).filter(Boolean).sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id))).slice(0, limit);

      return {
        provider: this.id,
        results: results.map(({ record, score, matched_terms }) => ({
          id: record.id,
          text: record.text,
          title: record.title,
          provision_reference: record.provision_reference,
          source: {
            document_id: record.document_id,
            file: record.source_file,
            sha256: record.source_sha256,
            pages: record.pdf_pages || [],
            edition: record.source_edition,
            kind: record.source_kind || null,
          },
          applicability_status: record.applicability_status || 'unverified',
          review_required: Boolean(record.review_required),
          score: Number(score.toFixed(4)),
          matched_terms,
        })),
      };
    },
  };
}
