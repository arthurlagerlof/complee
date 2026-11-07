import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BYTES = 8 * 1024 * 1024;
const XML_PARAGRAPH = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
const XML_TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function extractDocxText(buffer) {
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Document is larger than the 8 MB demo limit.'), { status: 413 });
  const temp = path.join(os.tmpdir(), `shipcheck-review-${process.pid}-${Date.now()}.docx`);
  try {
    fs.writeFileSync(temp, buffer, { flag: 'wx' });
    const { stdout } = await execFileAsync('unzip', ['-p', temp, 'word/document.xml'], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    const paragraphs = [...stdout.matchAll(XML_PARAGRAPH)].map((paragraph) =>
      [...paragraph[1].matchAll(XML_TEXT)].map((part) => decodeXml(part[1])).join(' ').replace(/[\t\r ]+/g, ' ').trim(),
    ).filter(Boolean);
    const text = paragraphs.join('\n');
    if (!text) throw Object.assign(new Error('No readable text was found in this DOCX.'), { status: 422 });
    return text;
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error('Could not read this DOCX. Try a text-based PDF or DOCX file.'), { status: 422 });
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

const unique = (values) => [...new Set(values)];

export async function reviewDocumentEvidence({ filename, dataBase64, provider }) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext !== '.docx') throw Object.assign(new Error('This demo reviewer currently extracts DOCX files only.'), { status: 415 });
  if (typeof dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw Object.assign(new Error('The document payload is invalid.'), { status: 400 });
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (!buffer.length) throw Object.assign(new Error('The selected file is empty.'), { status: 400 });
  const text = await extractDocxText(buffer);
  const statements = text.split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 45).slice(0, 200);
  const topics = [
    { id: 'fire-suppression', label: 'Fixed fire suppression', query: 'fixed fire extinguishing machinery space', terms: /fire|suppression|extinguish|agent|machinery/i },
    { id: 'fuel-piping', label: 'Oil-fuel piping', query: 'oil fuel pipes material approval', terms: /fuel|pipe|hose|valve|oil/i },
    { id: 'alarms-controls', label: 'Fire alarms and controls', query: 'fire detection alarm warning release controls', terms: /alarm|warning|detector|release|ventilation|shutdown/i },
  ];
  const findings = [];
  for (const topic of topics) {
    const evidence = statements.filter((s) => topic.terms.test(s) && !/^(DEMO EVIDENCE|FICTIONAL TEST DOCUMENT|Document control|Review focus:|Regional Class Research Vessel|This brief records)/i.test(s)).slice(0, 3);
    if (!evidence.length) continue;
    const search = await provider.search(topic.query, { limit: 3 });
    findings.push({ topic: topic.label, evidence, candidates: search.results });
  }
  return {
    filename: path.basename(String(filename || 'document.docx')),
    extracted_characters: text.length,
    status: findings.length ? 'source_candidates_found' : 'text_extracted_no_topic_matches',
    message: 'Potential source passages only. ShipCheck has not decided whether any requirement applies or whether the design is compliant.',
    findings,
  };
}
