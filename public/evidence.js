const input = document.querySelector('#evidenceFiles');
const drop = document.querySelector('#dropZone');
const list = document.querySelector('#fileList');
const count = document.querySelector('#fileCount');
const clear = document.querySelector('#clearFiles');
const next = document.querySelector('#startReview');
const files = new Map();
const providerLabel = document.querySelector('#sourceProvider');
const sourceQuery = document.querySelector('#sourceQuery');
const sourceResults = document.querySelector('#sourceResults');
const sourceSearch = document.querySelector('#sourceSearch');
const reviewPanel = document.querySelector('#documentReview');
const reviewContent = document.querySelector('#documentReviewContent');

const icons = { document: 'DOC', drawing: 'DWG', model: '3D', unknown: 'FILE' };
const supported = {
  '.pdf': ['document', 'Text and page references'], '.doc': ['document', 'Document review'], '.docx': ['document', 'Document review'],
  '.xls': ['document', 'Document review'], '.xlsx': ['document', 'Document review'], '.ppt': ['document', 'Document review'], '.pptx': ['document', 'Document review'],
  '.dwg': ['drawing', 'Drawing review'], '.dxf': ['drawing', 'Drawing review'],
  '.ifc': ['model', '3D model review'], '.step': ['model', '3D model review'], '.stp': ['model', '3D model review'],
  '.iges': ['model', '3D model review'], '.igs': ['model', '3D model review'], '.nwd': ['model', '3D model review'], '.nwc': ['model', '3D model review'],
  '.rvt': ['model', '3D model review'], '.3dm': ['model', '3D model review'], '.obj': ['model', '3D model review'], '.stl': ['model', '3D model review'],
};
const extOf = (name) => name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function addFiles(fileList) {
  for (const file of fileList) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!files.has(key)) files.set(key, file);
  }
  render();
}

function render() {
  const values = [...files.values()];
  count.textContent = values.length ? `${values.length} file${values.length === 1 ? '' : 's'} selected` : 'No files selected';
  clear.disabled = !values.length;
  next.disabled = !values.length;
  if (!values.length) {
    list.innerHTML = '<div class="empty-state">Files you add will appear here with their detected type and review support.</div>';
    return;
  }
  list.innerHTML = values.map((file) => {
    const ext = extOf(file.name);
    const [kind, label] = supported[ext] || ['unknown', 'Not supported in this prototype'];
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    return `<article class="file-row"><span class="file-icon ${kind}">${icons[kind]}</span><span class="file-meta"><b title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</b><small>${escapeHTML(ext.slice(1).toUpperCase() || 'Unknown type')} · ${fmtSize(file.size)} · ${label}</small></span><button type="button" class="remove-file" data-key="${escapeHTML(key)}" aria-label="Remove ${escapeHTML(file.name)}">×</button></article>`;
  }).join('');
  list.querySelectorAll('.remove-file').forEach((button) => button.addEventListener('click', () => { files.delete(button.dataset.key); render(); }));
}

input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
clear.addEventListener('click', () => { files.clear(); render(); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
for (const event of ['dragenter', 'dragover']) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('dragover'); });
for (const event of ['dragleave', 'drop']) drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('dragover'); });
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
document.querySelector('#vessel').addEventListener('change', (e) => {
  if (e.target.value === 'new') {
    e.target.value = 'rcrv';
    window.alert('Adding vessel profiles is not connected in this prototype yet.');
  }
});
next.addEventListener('click', () => {
  reviewSelectedDocuments();
});

async function reviewSelectedDocuments() {
  const documents = [...files.values()].filter((file) => extOf(file.name) === '.docx');
  reviewPanel.hidden = false;
  reviewContent.innerHTML = '<div class="empty-state">Reading selected DOCX files and searching the local regulatory source…</div>';
  reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  next.disabled = true;
  try {
    if (!documents.length) throw new Error('The demo reviewer currently reads DOCX files only. Add a DOCX to run document review.');
    const results = [];
    for (const file of documents) {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const dataBase64 = btoa(binary);
      const response = await fetch('/api/evidence/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, dataBase64 }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Review failed (${response.status})`);
      results.push(payload);
    }
    reviewContent.innerHTML = results.map(renderDocumentReview).join('');
  } catch (error) {
    reviewContent.innerHTML = `<div class="note">${escapeHTML(error.message)}</div>`;
  } finally {
    next.disabled = files.size === 0;
  }
}

function renderDocumentReview(result) {
  const findings = result.findings || [];
  const excerpt = (text) => {
    const value = String(text || '');
    return value.length > 720 ? `${value.slice(0, 720).trimEnd()}…` : value;
  };
  return `<div class="review-summary"><b>${escapeHTML(result.filename)}</b> · ${Number(result.extracted_characters).toLocaleString()} characters read · ${findings.length} topic group${findings.length === 1 ? '' : 's'} with candidate source passages.<br>${escapeHTML(result.message)}</div>` +
    (findings.length ? findings.map((finding) => `<section class="review-finding">
      <h3>${escapeHTML(finding.topic)} · source candidates</h3>
      <div class="muted">Statements extracted from the document:</div>
      <ul class="review-evidence">${finding.evidence.map((line) => `<li>${escapeHTML(line)}</li>`).join('')}</ul>
      ${finding.candidates.map((candidate) => `<article class="review-candidate"><b>${escapeHTML(candidate.provision_reference || candidate.id)} · ${escapeHTML(candidate.title || '')}</b><small>${escapeHTML(candidate.source?.kind || 'source')} · pages ${escapeHTML((candidate.source?.pages || []).join(', ') || 'not identified')} · applicability ${escapeHTML(candidate.applicability_status || 'unverified')}</small><p>${escapeHTML(excerpt(candidate.text))}</p></article>`).join('')}
    </section>`).join('') : '<div class="empty-state">Text was read, but no configured review topics matched.</div>');
}

async function loadProvider() {
  try {
    const response = await fetch('/api/evidence/provider');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { id, metadata } = await response.json();
    providerLabel.textContent = `${id} · ${metadata?.record_count ?? 0} passages · ${metadata?.retrieval || 'source retrieval'}`;
  } catch (error) {
    providerLabel.textContent = `Source search unavailable (${error.message})`;
  }
}

async function searchSources() {
  const q = sourceQuery.value.trim();
  if (!q) {
    sourceResults.innerHTML = '<div class="empty-state">Enter a phrase, topic, or provision reference to search.</div>';
    return;
  }
  sourceSearch.disabled = true;
  sourceResults.innerHTML = '<div class="empty-state">Searching the local reference source…</div>';
  try {
    const response = await fetch(`/api/evidence/search?q=${encodeURIComponent(q)}&limit=8`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const results = payload.results || [];
    if (!results.length) {
      sourceResults.innerHTML = '<div class="empty-state">No lexical matches. Try a shorter phrase or key terms from the design claim.</div>';
      return;
    }
    sourceResults.innerHTML = results.map((r) => `<article class="source-result">
      <div class="source-result-head"><b>${escapeHTML(r.provision_reference || r.id)}</b><span class="source-status">${r.applicability_status === 'verified' ? 'Applicability verified' : 'Applicability unverified'}</span></div>
      <small>${escapeHTML(r.title || '')} · ${escapeHTML((r.source?.kind || 'source').replaceAll('_', ' '))} · pp. ${escapeHTML((r.source?.pages || []).join(', ') || 'n/a')}</small>
      <p>${escapeHTML(r.text || '')}</p>
      <small>Match score ${r.score} · terms: ${escapeHTML((r.matched_terms || []).join(', '))}</small>
      ${r.review_required ? '<div class="source-empty-note">Source extraction flagged for review.</div>' : ''}
    </article>`).join('');
  } catch (error) {
    sourceResults.innerHTML = `<div class="empty-state">Could not search source: ${escapeHTML(error.message)}</div>`;
  } finally {
    sourceSearch.disabled = false;
  }
}

sourceSearch.addEventListener('click', searchSources);
sourceQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchSources(); });
loadProvider();
