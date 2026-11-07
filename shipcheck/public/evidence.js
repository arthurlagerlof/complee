const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const input = $('#evidenceFiles');
const drop = $('#evidenceDrop');
const list = $('#evidenceFilesList');
const count = $('#evidenceCount');
const clear = $('#clearEvidence');
const reviewButton = $('#reviewEvidence');
const reviewPanel = $('#documentReview');
const reviewContent = $('#documentReviewContent');
const files = new Map();
let scenario = null;
const kinds = { '.pdf': ['document', 'PDF'], '.doc': ['document', 'DOC'], '.docx': ['document', 'DOCX'], '.xls': ['document', 'XLS'], '.xlsx': ['document', 'XLSX'], '.dwg': ['drawing', 'DWG'], '.dxf': ['drawing', 'DXF'], '.ifc': ['model', '3D'], '.step': ['model', '3D'], '.stp': ['model', '3D'], '.iges': ['model', '3D'], '.igs': ['model', '3D'], '.nwd': ['model', '3D'], '.nwc': ['model', '3D'], '.rvt': ['model', '3D'], '.3dm': ['model', '3D'], '.obj': ['model', '3D'], '.stl': ['model', '3D'] };
const extOf = (name) => name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
const sizeOf = (n) => n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;

input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
$('#clearEvidence').addEventListener('click', () => { files.clear(); render(); });
list.addEventListener('click', (event) => { const key = event.target.closest('[data-remove]')?.dataset.remove; if (key) { files.delete(key); render(); } });
drop.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('dragover'); });
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('dragover'); });
drop.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
reviewButton.addEventListener('click', reviewDocuments);
document.querySelector('.button-link').addEventListener('click', () => {
  sessionStorage.setItem('shipcheckEvidenceFiles', JSON.stringify([...files.values()].map((file) => ({ name: file.name, size: file.size, type: file.type }))));
});

function addFiles(selected) {
  for (const file of selected) files.set(`${file.name}:${file.size}:${file.lastModified}`, file);
  render();
}
function render() {
  const values = [...files.entries()];
  count.textContent = values.length ? `${values.length} file${values.length === 1 ? '' : 's'} selected` : 'No files selected';
  clear.disabled = !values.length;
  reviewButton.disabled = !values.length;
  list.innerHTML = values.length ? values.map(([key, file]) => {
    const ext = extOf(file.name); const [kind, label] = kinds[ext] || ['unknown', 'File'];
    const support = ext === '.docx' ? 'DOCX review available' : `${label} added · review support is not connected yet`;
    return `<article class="evidence-file"><span class="evidence-file-icon ${kind}">${kind === 'unknown' ? 'FILE' : label}</span><span class="evidence-file-meta"><b title="${esc(file.name)}">${esc(file.name)}</b><small>${esc(ext.slice(1).toUpperCase() || 'Unknown')} · ${sizeOf(file.size)} · ${support}</small></span><button type="button" data-remove="${esc(key)}" aria-label="Remove ${esc(file.name)}">×</button></article>`;
  }).join('') : '<div class="evidence-empty">Files you add will appear here.</div>';
}

async function loadProvider() {
  try {
    const response = await fetch('api/evidence/provider'); const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.status);
    $('#evidenceSourceStatus').textContent = `${payload.id} · ${payload.metadata?.record_count ?? 0} passages · ${payload.metadata?.retrieval || 'source retrieval'}`;
  } catch (error) { $('#evidenceSourceStatus').textContent = `Local source unavailable: ${error.message}`; }
}
$('#evidenceSearch').addEventListener('click', searchSources);
$('#evidenceQuery').addEventListener('keydown', (event) => { if (event.key === 'Enter') searchSources(); });
async function searchSources() {
  const query = $('#evidenceQuery').value.trim();
  if (!query) { $('#evidenceSourceResults').innerHTML = '<div class="evidence-empty">Enter a topic or provision reference to search.</div>'; return; }
  $('#evidenceSearch').disabled = true;
  $('#evidenceSourceResults').innerHTML = '<div class="evidence-empty">Searching local source…</div>';
  try {
    const response = await fetch(`api/evidence/search?q=${encodeURIComponent(query)}&limit=6`); const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.status);
    $('#evidenceSourceResults').innerHTML = payload.results?.length ? payload.results.map((item) => `<article class="evidence-source-result"><b>${esc(item.provision_reference || item.id)} · ${esc(item.title || '')}</b><small><br>${esc(item.source?.kind || 'source')} · pages ${esc((item.source?.pages || []).join(', ') || 'n/a')} · applicability unverified</small><p>${esc(item.text || '')}</p></article>`).join('') : '<div class="evidence-empty">No matches. Try shorter key terms.</div>';
  } catch (error) { $('#evidenceSourceResults').innerHTML = `<div class="evidence-empty">Could not search source: ${esc(error.message)}</div>`; }
  finally { $('#evidenceSearch').disabled = false; }
}

async function reviewDocuments() {
  const docs = [...files.values()].filter((file) => extOf(file.name) === '.docx');
  reviewPanel.hidden = false; reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  reviewContent.innerHTML = '<div class="evidence-empty">Reading DOCX and searching the local regulatory source…</div>';
  reviewButton.disabled = true;
  try {
    if (!docs.length) throw new Error('This demo can display supported document, drawing, and model files, but only DOCX text review is connected so far. Add a DOCX to run a review.');
    const results = [];
    for (const file of docs) {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const response = await fetch('api/evidence/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, dataBase64: btoa(binary) }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `Review failed (${response.status})`); results.push(payload);
    }
    reviewContent.innerHTML = results.map(renderReview).join('');
  } catch (error) { reviewContent.innerHTML = `<div class="evidence-note">${esc(error.message)}</div>`; }
  finally { reviewButton.disabled = files.size === 0; }
}
loadProvider();
function renderReview(result) {
  const excerpt = (text) => String(text || '').slice(0, 700) + (String(text || '').length > 700 ? '…' : '');
  return `<div class="review-summary"><b>${esc(result.filename)}</b> · ${Number(result.extracted_characters).toLocaleString()} characters read · ${result.findings.length} topic groups.<br>${esc(result.message)}</div>${result.findings.map((finding) => `<section class="review-finding"><h3>${esc(finding.topic)} · source candidates</h3><ul class="review-evidence">${finding.evidence.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>${finding.candidates.map((item) => `<article class="review-candidate"><b>${esc(item.provision_reference || item.id)} · ${esc(item.title || '')}</b><small><br>${esc(item.source?.kind || 'source')} · pages ${esc((item.source?.pages || []).join(', ') || 'n/a')} · applicability unverified</small><p>${esc(excerpt(item.text))}</p></article>`).join('')}</section>`).join('') || '<div class="evidence-empty">Text read, but no configured topics matched.</div>'}`;
}
