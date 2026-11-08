import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FileText, FolderUp, Search, Ship, Trash2, X } from 'lucide-react'
import VesselViewer from './VesselViewer'

type Review = { filename: string; extracted_characters: number; message: string; execution_id?: string | null; findings: { topic: string; relevance?: string; summary?: string; evidence: string[]; missing_information?: string[]; applicability_questions?: string[]; warnings?: string[]; candidates: { id?: string; provision_reference: string; title: string; text: string; source?: { kind?: string; pages?: number[]; edition?: string | null }; relevance?: string; review_summary?: string; provision_quotes?: string[] }[] }[] }
type DesignRevision = { id: string; revision_name: string; revision_number: number; status: string }
type Candidate = {
  component_type: string
  name: string
  tag?: string | null
  properties: Record<string, { value: unknown; unit?: string | null; evidence: { text: string; page?: number | null; source_id?: string | null }[]; confidence?: number | null; review_status: string }>
  geometry_reference?: Record<string, unknown> | null
  evidence: { text: string; page?: number | null; source_id?: string | null }[]
  confidence?: number | null
  review_status: string
}
type FactCandidate = {
  component_name?: string | null
  fact_type: string
  statement: string
  value: unknown
  evidence: { text: string; page?: number | null; source_id?: string | null }[]
  confidence?: number | null
  review_status: string
}
type RelationshipCandidate = {
  source_component_name: string
  target_component_name: string
  relationship_type: string
  evidence: { text: string; page?: number | null; source_id?: string | null }[]
  confidence?: number | null
  review_status: string
}
type Extraction = {
  id: string
  provider_id: string
  model_id: string
  source_reference: { source_type?: string; source_name?: string; extraction_method?: string }
  result: { components: Candidate[]; facts: FactCandidate[]; relationships: RelationshipCandidate[]; warnings: string[] }
}
type SourceDocument = {
  id: string
  filename: string
  file_extension: string
  sha256: string
  extraction_method: string | null
  processing_status: string
  error_message: string | null
  extraction_id: string | null
}
type SourceUpload = { source_document: SourceDocument; extraction: Extraction | null }

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
const ext = (name: string) => name.toLowerCase().match(/\.[^.]+$/)?.[0] || ''
const formatBytes = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
const fileKind = (name: string) => {
  const suffix = ext(name)
  if (suffix === '.dxf') return { label: 'DXF', kind: 'drawing', support: 'DXF entity, layer, block and dimension extraction' }
  if (['.glb', '.gltf'].includes(suffix)) return { label: suffix.slice(1).toUpperCase(), kind: 'model', support: 'glTF 2.0 hierarchy and geometry metadata extraction' }
  if (suffix === '.bin') return { label: 'BIN', kind: 'model', support: 'GLTF binary sidecar · select with its GLTF file' }
  if (suffix === '.docx') return { label: 'DOCX', kind: 'document', support: 'Text and table extraction' }
  if (suffix === '.txt') return { label: 'TXT', kind: 'document', support: 'UTF-8 text extraction' }
  if (suffix === '.pdf') return { label: 'PDF', kind: 'document', support: 'Text extraction with page references (text-based PDFs; no OCR)' }
  if (['.dwg', '.ifc', '.step', '.stp', '.iges', '.igs', '.nwd', '.nwc', '.rvt', '.3dm', '.obj', '.stl'].includes(suffix)) return { label: suffix.slice(1).toUpperCase(), kind: 'model', support: 'Not supported by the extraction pipeline yet' }
  return { label: suffix ? suffix.slice(1).toUpperCase() : 'FILE', kind: 'document', support: 'Not supported by the extraction pipeline yet' }
}

export default function EvidenceIntake({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [provider, setProvider] = useState('Connecting to Gemini and TigerData…')
  const [query, setQuery] = useState('')
  const [sourceResults, setSourceResults] = useState<any[]>([])
  const [sourceMessage, setSourceMessage] = useState('Source matches are passages for review, not compliance decisions.')
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewMessage, setReviewMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [revisions, setRevisions] = useState<DesignRevision[]>([])
  const [revisionId, setRevisionId] = useState('')
  const [sourceUploads, setSourceUploads] = useState<SourceUpload[]>([])
  const [extractionMessage, setExtractionMessage] = useState('')
  const [candidateEdits, setCandidateEdits] = useState<Record<string, { name: string; component_type: string }>>({})
  const [factEdits, setFactEdits] = useState<Record<string, { fact_type: string; statement: string; value: string }>>({})
  const [propertyEdits, setPropertyEdits] = useState<Record<string, { value: string; unit: string }>>({})
  const [relationshipEdits, setRelationshipEdits] = useState<Record<string, { source_component_name: string; target_component_name: string; relationship_type: string }>>({})

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/health/database`).then(async (response) => {
        const data = await response.json()
        if (!response.ok || data.status !== 'ok') throw new Error('TigerData database is unavailable')
        return data
      }),
      fetch(`${API_BASE}/api/v1/ai/built-in-providers`).then(async (response) => {
        if (!response.ok) throw new Error('Could not check Gemini configuration')
        return response.json()
      }),
    ]).then(([, providers]) => {
      const gemini = providers.find((item: { id: string }) => item.id === 'gemini')
      setProvider(`${gemini?.configured ? 'Gemini configured' : 'Gemini needs configuration'} · TigerData hybrid search`)
    }).catch((error) => setProvider(`Review services unavailable · ${error.message}`))
  }, [])

  useEffect(() => {
    fetch(`${API_BASE}/api/v1/design-revisions?limit=100`)
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body?.error?.message || 'Could not load design revisions.')
        const available = body as DesignRevision[]
        setRevisions(available)
        if (available.length) setRevisionId((current) => current || available[0].id)
      })
      .catch((error) => setExtractionMessage(error instanceof Error ? error.message : 'Could not load design revisions.'))
  }, [])

  useEffect(() => {
    let active = true
    setSourceUploads([])
    if (revisionId) {
      loadSourceUploads(revisionId).then((sources) => {
        if (active) setSourceUploads(sources)
      }).catch((error) => {
        if (active) setExtractionMessage(error instanceof Error ? error.message : 'Could not load source documents.')
      })
    }
    return () => { active = false }
  }, [revisionId])

  const loadSourceUploads = async (targetRevisionId: string) => {
    const response = await fetch(`${API_BASE}/api/v1/ai/design-revisions/${targetRevisionId}/source-documents`)
    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || 'Could not load source documents.')
    const sources = await Promise.all((body as SourceDocument[]).map(async (source) => {
      if (!source.extraction_id) return { source_document: source, extraction: null }
      const extractionResponse = await fetch(`${API_BASE}/api/v1/ai/extractions/${source.extraction_id}`)
      const extractionBody = await extractionResponse.json()
      if (!extractionResponse.ok) throw new Error(extractionBody?.error?.message || `Could not load candidates for ${source.filename}.`)
      return { source_document: source, extraction: extractionBody as Extraction }
    }))
    return sources
  }

  const extractSelectedFiles = async () => {
    if (!revisionId) { setExtractionMessage('Select a design revision before extracting candidate data.'); return }
    const supported = files.filter((file) => ['.docx', '.txt', '.pdf', '.dxf', '.glb', '.gltf', '.bin'].includes(ext(file.name)))
    if (!supported.some((file) => ['.docx', '.txt', '.pdf', '.dxf', '.glb', '.gltf'].includes(ext(file.name)))) {
      setExtractionMessage('Select a supported DOCX, TXT, PDF, DXF, GLB or GLTF source file.')
      return
    }
    setBusy(true)
    setExtractionMessage('Uploading files and extracting candidate engineering data…')
    try {
      const form = new FormData()
      form.append('revision_id', revisionId)
      supported.forEach((file) => form.append('files', file))
      const response = await fetch(`${API_BASE}/api/v1/ai/extractions/upload`, { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message || body?.detail || `Extraction failed (${response.status}).`)
      const results = body as SourceUpload[]
      setSourceUploads((current) => [...results, ...current.filter(
        (item) => !results.some((next) => next.source_document.id === item.source_document.id),
      )])
      const failures = results.filter((item) => item.source_document.processing_status === 'failed')
      setExtractionMessage(failures.length
        ? `${results.length - failures.length} file(s) processed; ${failures.length} failed. See each source record for details.`
        : `${results.length} file(s) processed. AI output is unverified until reviewed.`)
    } catch (error) {
      setExtractionMessage(error instanceof Error ? error.message : 'Could not extract candidate data.')
    } finally {
      setBusy(false)
    }
  }

  const updateExtraction = (sourceId: string, extraction: Extraction) => {
    setSourceUploads((current) => current.map((item) => item.source_document.id === sourceId
      ? { ...item, extraction }
      : item))
  }

  const reviewCandidate = async (item: SourceUpload, index: number, patch: Record<string, unknown>) => {
    if (!item.extraction) return
    const response = await fetch(`${API_BASE}/api/v1/ai/extractions/${item.extraction.id}/components/${index}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || 'Could not update component candidate.')
    updateExtraction(item.source_document.id, body as Extraction)
  }

  const reviewFact = async (item: SourceUpload, index: number, patch: Record<string, unknown>) => {
    if (!item.extraction) return
    const response = await fetch(`${API_BASE}/api/v1/ai/extractions/${item.extraction.id}/facts/${index}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || 'Could not update fact candidate.')
    updateExtraction(item.source_document.id, body as Extraction)
  }

  const reviewProperty = async (item: SourceUpload, index: number, name: string, patch: Record<string, unknown>) => {
    if (!item.extraction) return
    const response = await fetch(
      `${API_BASE}/api/v1/ai/extractions/${item.extraction.id}/components/${index}/properties/${encodeURIComponent(name)}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) },
    )
    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || 'Could not review the property fact.')
    updateExtraction(item.source_document.id, body as Extraction)
  }

  const reviewRelationship = async (item: SourceUpload, index: number, patch: Record<string, unknown>) => {
    if (!item.extraction) return
    const response = await fetch(`${API_BASE}/api/v1/ai/extractions/${item.extraction.id}/relationships/${index}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body?.error?.message || 'Could not update relationship candidate.')
    updateExtraction(item.source_document.id, body as Extraction)
  }

  const importApproved = async (item: SourceUpload) => {
    if (!item.extraction) return
    const candidateIndexes = item.extraction.result.components
      .map((candidate, index) => candidate.review_status === 'approved' ? index : -1)
      .filter((index) => index >= 0)
    const factIndexes = item.extraction.result.facts
      .map((fact, index) => fact.review_status === 'approved' ? index : -1)
      .filter((index) => index >= 0)
    try {
      const response = await fetch(`${API_BASE}/api/v1/ai/extractions/${item.extraction.id}/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate_indexes: candidateIndexes, fact_indexes: factIndexes }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message || 'Could not import approved candidates.')
      const ambiguous = body.ambiguous_matches?.length
        ? ` Ambiguous matches need engineer review: ${body.ambiguous_matches.map((match: { candidate_name?: string; component_name?: string; reason: string }) => `${match.candidate_name || match.component_name || 'fact'} (${match.reason})`).join('; ')}.`
        : ''
      setExtractionMessage(`Imported ${body.imported_count} component(s) and ${body.imported_fact_count} fact(s).${ambiguous}`)
    } catch (error) {
      setExtractionMessage(error instanceof Error ? error.message : 'Could not import approved candidates.')
    }
  }

  const safelyReview = async (action: () => Promise<void>) => {
    try {
      await action()
      setExtractionMessage('')
    } catch (error) {
      setExtractionMessage(error instanceof Error ? error.message : 'Could not save the review.')
    }
  }

  const addFiles = (incoming: FileList | File[]) => {
    setFiles((current) => {
      const entries = new Map(current.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]))
      for (const file of Array.from(incoming)) entries.set(`${file.name}:${file.size}:${file.lastModified}`, file)
      return [...entries.values()]
    })
    setReviews([])
    setReviewMessage('')
  }
  const search = async () => {
    if (!query.trim()) { setSourceMessage('Enter a topic or provision reference to search.'); return }
    setSourceMessage('Searching TigerData regulations…')
    try {
      const response = await fetch(`${API_BASE}/api/v1/regulations/search?query=${encodeURIComponent(query)}&mode=hybrid&limit=6`)
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error?.message || data?.detail || `HTTP ${response.status}`)
      const results = (data.results || []).map((item: any) => ({
        id: item.id,
        provision_reference: item.clause_reference || item.document_code || 'Provision',
        title: item.regulatory_document || item.document_code || 'Regulatory provision',
        text: item.text,
        source: { kind: 'TigerData', pages: item.page_number ? [item.page_number] : [], edition: item.edition },
      }))
      setSourceResults(results)
      setSourceMessage(results.length ? '' : 'No matches. Try shorter key terms.')
    } catch (error) { setSourceResults([]); setSourceMessage(`Could not search TigerData: ${(error as Error).message}`) }
  }
  const reviewDocuments = async () => {
    const docs = files.filter((file) => ['.docx', '.txt'].includes(ext(file.name)))
    if (!docs.length) { setReviewMessage('Select a DOCX or TXT file for document review.'); return }
    setBusy(true); setReviewMessage('Parsing documents, retrieving TigerData provisions, and asking Gemini to compare source evidence…'); setReviews([])
    try {
      const form = new FormData()
      docs.forEach((file) => form.append('files', file))
      const response = await fetch(`${API_BASE}/api/v1/ai/document-reviews`, { method: 'POST', body: form })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error?.message || data?.detail || `Review failed (${response.status})`)
      setReviews(data.results || []); setReviewMessage('')
    } catch (error) { setReviewMessage((error as Error).message) }
    finally { setBusy(false) }
  }
  const continueToReview = () => {
    sessionStorage.setItem('compleeEvidenceFiles', JSON.stringify(files.map((file) => ({ name: file.name, size: file.size, type: file.type }))))
    onContinue()
  }
  const returnToMain = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    sessionStorage.setItem('compleeEvidenceFiles', JSON.stringify(files.map((file) => ({ name: file.name, size: file.size, type: file.type }))))
    onBack()
  }

  return <div className="evidence-app">
    <header className="evidence-header"><a className="brand" href="#top" onClick={returnToMain} aria-label="Complee home"><span className="brand-mark"><Ship size={17} strokeWidth={1.8} /></span>Complee</a><a className="evidence-return-link" href="#top" onClick={returnToMain}><ArrowLeft size={14} />Back to main page</a><nav className="evidence-steps" aria-label="Review workflow"><b><span>01</span>Upload</b><i /><span><span>02</span>Review design</span><i /><span><span>03</span>Manage findings</span></nav><span className="evidence-local"><i />LOCAL WORKSPACE</span></header>
    <main className="evidence-workspace" id="top">
      <div className="evidence-title"><div><span className="evidence-kicker">VESSEL DESIGN REVIEW / STEP 01</span><h1>Add design documentation</h1><p>Upload the design documents, drawings, and models to prepare the OSU RCRV review.</p></div><div className="evidence-vessel-tag"><Ship size={15} /><span><small>REVIEW VESSEL</small>OSU RCRV · Demo model</span><Check size={15} /></div></div>
      <div className="evidence-layout">
        <section className="evidence-main-col">
          <label className={`evidence-dropzone${dragging ? ' is-dragging' : ''}`} htmlFor="evidence-file-input" onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}>
            <input ref={input} id="evidence-file-input" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.dwg,.dxf,.ifc,.step,.stp,.iges,.igs,.nwd,.nwc,.rvt,.3dm,.obj,.stl,.txt,.glb,.gltf,.bin" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
            <span className="evidence-drop-icon"><FolderUp size={23} /></span><strong>Drop your evidence files here</strong><span>or <button type="button" className="evidence-browse" onClick={(event) => { event.preventDefault(); input.current?.click() }}>browse files</button> from your computer</span><small>Supported extraction: <b>DOCX TXT DXF GLB GLTF</b> · other file types remain listed but are not parsed yet</small>
          </label>
          <section className="evidence-file-card"><div className="evidence-card-header"><div><span className="evidence-kicker">PROJECT FILES</span><h2>Selected evidence</h2></div><div className="evidence-card-actions"><span>{files.length} file{files.length === 1 ? '' : 's'}</span><button type="button" onClick={() => { setFiles([]); setReviews([]); setReviewMessage('') }} disabled={!files.length}><Trash2 size={13} />Clear all</button></div></div>
            {files.length ? <div className="evidence-file-list">{files.map((file) => { const info = fileKind(file.name); return <article className="evidence-file-row" key={`${file.name}:${file.size}:${file.lastModified}`}><span className={`evidence-file-type ${info.kind}`}>{info.label}</span><span className="evidence-file-info"><b>{file.name}</b><small>{formatBytes(file.size)} · {info.support}</small></span><button type="button" className="evidence-remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}><X size={16} /></button></article> })}</div> : <div className="evidence-empty"><FileText size={18} /><span>No evidence added yet. Add a document, drawing, or model to start.</span></div>}
            <div className="evidence-review-action"><span>Gemini compares document text with provisions retrieved from TigerData. Review output is advisory.</span><button type="button" onClick={() => void reviewDocuments()} disabled={!files.some((file) => ['.docx', '.txt'].includes(ext(file.name))) || busy}>{busy ? 'Reviewing…' : 'Review with Gemini + TigerData'}</button></div>
          </section>
          <section className="evidence-file-card evidence-extraction-card">
            <div className="evidence-card-header"><div><span className="evidence-kicker">AI-ASSISTED ENGINEERING DATA</span><h2>Extract review candidates</h2></div></div>
            <p className="evidence-extraction-note">Parsers preserve source locations and geometry metadata. AI output is unverified and is never imported without engineer approval.</p>
            <div className="evidence-extraction-controls">
              <label>Design revision
                <select value={revisionId} onChange={(event) => setRevisionId(event.target.value)} disabled={!revisions.length || busy}>
                  <option value="">Select a design revision</option>
                  {revisions.map((revision) => <option key={revision.id} value={revision.id}>{revision.revision_name} · Rev {revision.revision_number} · {revision.status}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => void extractSelectedFiles()} disabled={!files.length || !revisionId || busy}>
                {busy ? 'Processing…' : 'Extract candidate data'}
              </button>
            </div>
            {extractionMessage && <p className="evidence-extraction-message" role="status">{extractionMessage}</p>}
            {sourceUploads.map((item) => {
              const document = item.source_document
              const extraction = item.extraction
              return <article className="evidence-source-record" key={document.id}>
                <div className="evidence-source-record-header">
                  <div><b>{document.filename}</b><small>{document.extraction_method || document.file_extension} · {document.sha256.slice(0, 12)}… · {document.processing_status}</small></div>
                  <a href={`${API_BASE}/api/v1/ai/source-documents/${document.id}/file`} target="_blank" rel="noreferrer">Open source</a>
                </div>
                {document.error_message && <p className="evidence-extraction-error">{document.error_message}</p>}
                {extraction && <>
                  <p className="evidence-extraction-disclaimer">Provider/model: {extraction.provider_id} / {extraction.model_id}. Candidate data only — verify against the source before import. <a href={`${API_BASE}/api/v1/ai/source-documents/${document.id}/parsed-data`} target="_blank" rel="noreferrer">View parsed structure</a></p>
                  {!!extraction.result.warnings.length && <ul className="evidence-extraction-warnings">{extraction.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
                  {extraction.result.components.map((candidate, index) => {
                    const editKey = `${extraction.id}:component:${index}`
                    const edit = candidateEdits[editKey] || { name: candidate.name, component_type: candidate.component_type }
                    return <section className="evidence-candidate-record" key={editKey}>
                      <div className="evidence-candidate-fields">
                        <label>Name<input disabled={candidate.review_status !== 'pending'} value={edit.name} onChange={(event) => setCandidateEdits((current) => ({ ...current, [editKey]: { ...edit, name: event.target.value } }))} /></label>
                        <label>Type<input disabled={candidate.review_status !== 'pending'} value={edit.component_type} onChange={(event) => setCandidateEdits((current) => ({ ...current, [editKey]: { ...edit, component_type: event.target.value } }))} /></label>
                      </div>
                      <p><b>Component candidate {index + 1}</b> · confidence {candidate.confidence ?? 'not provided'} · {candidate.review_status}</p>
                      {candidate.evidence.map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}>{evidence.text}<small>{evidence.page ? `Page ${evidence.page}` : ''}{evidence.source_id ? ` · ${evidence.source_id}` : ''}</small></blockquote>)}
                      {candidate.geometry_reference && <pre className="evidence-geometry-reference">{JSON.stringify(candidate.geometry_reference, null, 2)}</pre>}
                      {Object.entries(candidate.properties).map(([name, property]) => {
                        const propertyKey = `${editKey}:property:${name}`
                        const propertyEdit = propertyEdits[propertyKey] || {
                          value: JSON.stringify(property.value ?? null),
                          unit: property.unit || '',
                        }
                        const editedValue = () => {
                          try { return JSON.parse(propertyEdit.value) as unknown } catch { return propertyEdit.value }
                        }
                        return <div className="evidence-fact-record" key={name}>
                        <span><b>{name}</b>: {String(property.value ?? 'not provided')} {property.unit || ''} · {property.review_status}</span>
                        {property.review_status === 'pending' && <div className="evidence-candidate-fields">
                          <label>Value<input value={propertyEdit.value} onChange={(event) => setPropertyEdits((current) => ({ ...current, [propertyKey]: { ...propertyEdit, value: event.target.value } }))} /></label>
                          <label>Unit<input value={propertyEdit.unit} onChange={(event) => setPropertyEdits((current) => ({ ...current, [propertyKey]: { ...propertyEdit, unit: event.target.value } }))} /></label>
                        </div>}
                        {property.evidence.map((evidence, evidenceIndex) => <small key={evidenceIndex}>{evidence.text}{evidence.page ? ` · page ${evidence.page}` : ''}{evidence.source_id ? ` · ${evidence.source_id}` : ''}</small>)}
                        {property.review_status === 'pending' && <span className="evidence-review-buttons">
                          <button type="button" onClick={() => void safelyReview(() => reviewProperty(item, index, name, { value: editedValue(), unit: propertyEdit.unit || null }))}>Save fact edits</button>
                          <button type="button" onClick={() => void safelyReview(() => reviewProperty(item, index, name, { review_status: 'approved' }))}>Approve fact</button>
                          <button type="button" onClick={() => void safelyReview(() => reviewProperty(item, index, name, { review_status: 'rejected' }))}>Reject fact</button>
                        </span>}
                      </div>})}
                      {candidate.review_status === 'pending' && <div className="evidence-review-buttons">
                        <button type="button" onClick={() => void safelyReview(() => reviewCandidate(item, index, edit))}>Save component edits</button>
                        <button type="button" onClick={() => void safelyReview(() => reviewCandidate(item, index, { review_status: 'approved' }))}>Approve component</button>
                        <button type="button" onClick={() => void safelyReview(() => reviewCandidate(item, index, { review_status: 'rejected' }))}>Reject component</button>
                      </div>}
                    </section>
                  })}
                  {extraction.result.facts.map((fact, index) => {
                    const editKey = `${extraction.id}:fact:${index}`
                    const edit = factEdits[editKey] || { fact_type: fact.fact_type, statement: fact.statement, value: JSON.stringify(fact.value ?? null) }
                    const editedValue = () => {
                      try { return JSON.parse(edit.value) as unknown } catch { return edit.value }
                    }
                    return <section className="evidence-candidate-record" key={editKey}>
                      <div className="evidence-candidate-fields">
                        <label>Fact type<input disabled={fact.review_status !== 'pending'} value={edit.fact_type} onChange={(event) => setFactEdits((current) => ({ ...current, [editKey]: { ...edit, fact_type: event.target.value } }))} /></label>
                        <label>Statement<input disabled={fact.review_status !== 'pending'} value={edit.statement} onChange={(event) => setFactEdits((current) => ({ ...current, [editKey]: { ...edit, statement: event.target.value } }))} /></label>
                        <label>Value (JSON or text)<input disabled={fact.review_status !== 'pending'} value={edit.value} onChange={(event) => setFactEdits((current) => ({ ...current, [editKey]: { ...edit, value: event.target.value } }))} /></label>
                      </div>
                      <p><b>Fact candidate {index + 1}</b>{fact.component_name ? ` · ${fact.component_name}` : ' · vessel'} · {fact.review_status} · value {JSON.stringify(fact.value)}</p>
                      {fact.evidence.map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}>{evidence.text}<small>{evidence.page ? `Page ${evidence.page}` : ''}{evidence.source_id ? ` · ${evidence.source_id}` : ''}</small></blockquote>)}
                      {fact.review_status === 'pending' && <div className="evidence-review-buttons">
                        <button type="button" onClick={() => void safelyReview(() => reviewFact(item, index, { fact_type: edit.fact_type, statement: edit.statement, value: editedValue() }))}>Save fact edits</button>
                        <button type="button" onClick={() => void safelyReview(() => reviewFact(item, index, { review_status: 'approved' }))}>Approve fact</button>
                        <button type="button" onClick={() => void safelyReview(() => reviewFact(item, index, { review_status: 'rejected' }))}>Reject fact</button>
                      </div>}
                    </section>
                  })}
                  {extraction.result.relationships.map((relationship, index) => {
                    const editKey = `${extraction.id}:relationship:${index}`
                    const edit = relationshipEdits[editKey] || {
                      source_component_name: relationship.source_component_name,
                      target_component_name: relationship.target_component_name,
                      relationship_type: relationship.relationship_type,
                    }
                    return <section className="evidence-candidate-record" key={editKey}>
                      <div className="evidence-candidate-fields">
                        <label>Source<input disabled={relationship.review_status !== 'pending'} value={edit.source_component_name} onChange={(event) => setRelationshipEdits((current) => ({ ...current, [editKey]: { ...edit, source_component_name: event.target.value } }))} /></label>
                        <label>Target<input disabled={relationship.review_status !== 'pending'} value={edit.target_component_name} onChange={(event) => setRelationshipEdits((current) => ({ ...current, [editKey]: { ...edit, target_component_name: event.target.value } }))} /></label>
                        <label>Relationship<input disabled={relationship.review_status !== 'pending'} value={edit.relationship_type} onChange={(event) => setRelationshipEdits((current) => ({ ...current, [editKey]: { ...edit, relationship_type: event.target.value } }))} /></label>
                      </div>
                      <p><b>Relationship candidate</b> · confidence {relationship.confidence ?? 'not provided'} · {relationship.review_status}</p>
                      {relationship.evidence.map((evidence, evidenceIndex) => <blockquote key={evidenceIndex}>{evidence.text}<small>{evidence.source_id || ''}</small></blockquote>)}
                      {relationship.review_status === 'pending' && <div className="evidence-review-buttons">
                        <button type="button" onClick={() => void safelyReview(() => reviewRelationship(item, index, { ...edit, review_status: 'pending' }))}>Save relationship edits</button>
                        <button type="button" onClick={() => void safelyReview(() => reviewRelationship(item, index, { review_status: 'approved' }))}>Approve relationship</button>
                        <button type="button" onClick={() => void safelyReview(() => reviewRelationship(item, index, { review_status: 'rejected' }))}>Reject relationship</button>
                      </div>}
                    </section>
                  })}
                  <button type="button" className="evidence-import-button" onClick={() => void importApproved(item)}>Import approved candidates to this revision</button>
                </>}
              </article>
            })}
          </section>
          {(reviews.length > 0 || reviewMessage) && <section className="evidence-review-results"><div className="evidence-kicker">GEMINI DOCUMENT REVIEW · TIGERDATA SOURCES</div>{reviewMessage && <p className="evidence-review-message">{reviewMessage}</p>}{reviews.map((review) => <div className="evidence-reviewed-file" key={review.filename}><p><b>{review.filename}</b> · {review.extracted_characters.toLocaleString()} characters read · AI-assisted, not a compliance decision</p><p>{review.message}</p>{review.findings.map((finding, index) => <article key={`${review.filename}:${finding.topic}:${index}`} className="evidence-finding"><h3>{finding.topic} <small>· {finding.relevance || 'uncertain'}</small></h3>{finding.summary && <p>{finding.summary}</p>}{finding.evidence.length > 0 && <><b>Document evidence</b><ul>{finding.evidence.map((line, quoteIndex) => <li key={quoteIndex}>{line}</li>)}</ul></>}{finding.missing_information?.length ? <p><b>Missing information:</b> {finding.missing_information.join('; ')}</p> : null}{finding.applicability_questions?.length ? <p><b>Applicability questions:</b> {finding.applicability_questions.join('; ')}</p> : null}{finding.warnings?.map((warning, warningIndex) => <p key={warningIndex} className="evidence-review-message">{warning}</p>)}{finding.candidates.map((candidate, candidateIndex) => <div className="evidence-candidate" key={candidate.id || `${candidate.provision_reference}:${candidateIndex}`}><b>{candidate.provision_reference} · {candidate.title}</b><small>{candidate.source?.kind || 'TigerData'} · edition {candidate.source?.edition || 'n/a'} · pages {(candidate.source?.pages || []).join(', ') || 'n/a'} · {candidate.relevance || 'unreviewed'}</small>{candidate.provision_quotes?.length ? <ul>{candidate.provision_quotes.map((line, quoteIndex) => <li key={quoteIndex}>{line}</li>)}</ul> : null}<p>{candidate.text.slice(0, 600)}{candidate.text.length > 600 ? '…' : ''}</p></div>)}</article>)}</div>)}</section>}
          <div className="evidence-next"><span>Continue opens the OSU RCRV design review.</span><button type="button" onClick={continueToReview}>Continue to design review <ArrowRight size={15} /></button></div>
        </section>
        <aside className="evidence-aside">
          <section className="evidence-side-card evidence-vessel-card"><div className="workspace-bar"><span><span className="live-dot" /> R/V TAANI · MODEL PREVIEW</span><span>HOMEPAGE MODEL</span></div><VesselViewer className="taani-evidence-viewer" initialAutoRotate /><div className="evidence-vessel-summary"><span className="evidence-kicker">VISUAL PREVIEW</span><h2>R/V Taani</h2><p>This is the same vessel model used on the Complee homepage.</p><dl><div><dt>Vessel type</dt><dd>Research vessel</dd></div><div><dt>Workflow use</dt><dd>Preview only</dd></div></dl><p className="evidence-side-note">The preview shows R/V Taani. Continue to design review opens the OSU RCRV model.</p></div></section>
          <section className="evidence-side-card evidence-source-card"><span className="evidence-kicker">REGULATORY SOURCE</span><h2>Search TigerData provisions</h2><p>{provider}</p><form className="evidence-search" onSubmit={(event) => { event.preventDefault(); void search() }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. fire detection alarms" aria-label="Search regulatory provisions" /><button aria-label="Search"><Search size={15} /></button></form><div className="evidence-source-list">{sourceResults.map((item) => <article key={item.id}><b>{item.provision_reference} · {item.title}</b><small>{item.source?.kind || 'TigerData'} · edition {item.source?.edition || 'n/a'} · pp. {(item.source?.pages || []).join(', ') || 'n/a'} · applicability unverified</small><p>{item.text}</p></article>)}{sourceMessage && <div className="evidence-source-empty">{sourceMessage}</div>}</div><p className="evidence-source-disclaimer">Passage matches are references for engineer review, not a compliance decision.</p></section>
        </aside>
      </div>
      <footer className="evidence-footnote">DOCX/TXT review sends document text to the configured Gemini service and searches TigerData regulations. Uploads are not stored by the document review endpoint.</footer>
    </main>
  </div>
}
