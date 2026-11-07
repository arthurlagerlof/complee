import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FileText, FolderUp, Search, Ship, Trash2, X } from 'lucide-react'
import RcrvModelPreview from './RcrvModelPreview'

type Review = { filename: string; extracted_characters: number; message: string; findings: { topic: string; evidence: string[]; candidates: { provision_reference: string; title: string; text: string; source?: { kind?: string; pages?: number[] } }[] }[] }

const ext = (name: string) => name.toLowerCase().match(/\.[^.]+$/)?.[0] || ''
const formatBytes = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`
const fileKind = (name: string) => {
  const suffix = ext(name)
  if (['.dwg', '.dxf'].includes(suffix)) return { label: suffix.slice(1).toUpperCase(), kind: 'drawing', support: 'Drawing · review support planned' }
  if (['.ifc', '.step', '.stp', '.iges', '.igs', '.nwd', '.nwc', '.rvt', '.3dm', '.obj', '.stl'].includes(suffix)) return { label: '3D', kind: 'model', support: '3D model · review support planned' }
  if (suffix === '.docx') return { label: 'DOCX', kind: 'document', support: 'Document review available' }
  return { label: suffix ? suffix.slice(1).toUpperCase() : 'FILE', kind: 'document', support: 'Evidence file · review support planned' }
}

export default function EvidenceIntake({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [dragging, setDragging] = useState(false)
  const [provider, setProvider] = useState('Connecting to local source…')
  const [query, setQuery] = useState('')
  const [sourceResults, setSourceResults] = useState<any[]>([])
  const [sourceMessage, setSourceMessage] = useState('Source matches are passages for review, not compliance decisions.')
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewMessage, setReviewMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/evidence/provider').then((response) => response.json()).then((data) => {
      setProvider(`${data.id} · ${data.metadata?.record_count ?? 0} passages · ${data.metadata?.retrieval || 'source retrieval'}`)
    }).catch((error) => setProvider(`Local source unavailable · ${error.message}`))
  }, [])

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
    setSourceMessage('Searching the local reference source…')
    try {
      const response = await fetch(`/api/evidence/search?q=${encodeURIComponent(query)}&limit=6`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      setSourceResults(data.results || [])
      setSourceMessage(data.results?.length ? '' : 'No matches. Try shorter key terms.')
    } catch (error) { setSourceResults([]); setSourceMessage(`Could not search source: ${(error as Error).message}`) }
  }
  const reviewDocuments = async () => {
    const docs = files.filter((file) => ext(file.name) === '.docx')
    if (!docs.length) { setReviewMessage('DOCX text review is available in this demo. Other selected files are listed as evidence, but need format-specific review support.'); return }
    setBusy(true); setReviewMessage('Reading DOCX files and finding candidate source passages…'); setReviews([])
    try {
      const results: Review[] = []
      for (const file of docs) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        const response = await fetch('/api/evidence/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, dataBase64: btoa(binary) }) })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || `Review failed (${response.status})`)
        results.push(data)
      }
      setReviews(results); setReviewMessage('')
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
    <header className="evidence-header"><a className="brand" href="#top"><span className="brand-mark"><Ship size={17} strokeWidth={1.8} /></span>Complee</a><a className="evidence-return-link" href="#top" onClick={returnToMain}><ArrowLeft size={14} />Back to main page</a><nav className="evidence-steps" aria-label="Review workflow"><b><span>01</span>Add evidence</b><i /><span><span>02</span>Review design</span><i /><span><span>03</span>Manage findings</span></nav><span className="evidence-local"><i />LOCAL WORKSPACE</span></header>
    <main className="evidence-workspace" id="top">
      <div className="evidence-title"><div><span className="evidence-kicker">VESSEL DESIGN REVIEW / STEP 01</span><h1>Add design evidence</h1><p>Start with the files behind your vessel design. Preview the OSU RCRV layout from the Complee demo.</p></div><div className="evidence-vessel-tag"><Ship size={15} /><span><small>VESSEL PROFILE</small>OSU RCRV · Demo vessel</span><Check size={15} /></div></div>
      <div className="evidence-layout">
        <section className="evidence-main-col">
          <label className={`evidence-dropzone${dragging ? ' is-dragging' : ''}`} htmlFor="evidence-file-input" onDragOver={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}>
            <input ref={input} id="evidence-file-input" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.dwg,.dxf,.ifc,.step,.stp,.iges,.igs,.nwd,.nwc,.rvt,.3dm,.obj,.stl" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = '' }} />
            <span className="evidence-drop-icon"><FolderUp size={23} /></span><strong>Drop your evidence files here</strong><span>or <button type="button" className="evidence-browse" onClick={(event) => { event.preventDefault(); input.current?.click() }}>browse files</button> from your computer</span><small>Documents · Drawings · 3D models <b>PDF DOCX XLSX DWG DXF IFC STEP IGES NWD</b></small>
          </label>
          <section className="evidence-file-card"><div className="evidence-card-header"><div><span className="evidence-kicker">PROJECT FILES</span><h2>Selected evidence</h2></div><div className="evidence-card-actions"><span>{files.length} file{files.length === 1 ? '' : 's'}</span><button type="button" onClick={() => { setFiles([]); setReviews([]); setReviewMessage('') }} disabled={!files.length}><Trash2 size={13} />Clear all</button></div></div>
            {files.length ? <div className="evidence-file-list">{files.map((file) => { const info = fileKind(file.name); return <article className="evidence-file-row" key={`${file.name}:${file.size}:${file.lastModified}`}><span className={`evidence-file-type ${info.kind}`}>{info.label}</span><span className="evidence-file-info"><b>{file.name}</b><small>{formatBytes(file.size)} · {info.support}</small></span><button type="button" className="evidence-remove" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}><X size={16} /></button></article> })}</div> : <div className="evidence-empty"><FileText size={18} /><span>No evidence added yet. Add a document, drawing, or model to start.</span></div>}
            <div className="evidence-review-action"><span>DOCX text review is enabled for this demo.</span><button type="button" onClick={() => void reviewDocuments()} disabled={!files.length || busy}>{busy ? 'Reviewing…' : 'Review selected DOCX files'}</button></div>
          </section>
          {(reviews.length > 0 || reviewMessage) && <section className="evidence-review-results"><div className="evidence-kicker">DOCUMENT REVIEW · SOURCE CANDIDATES</div>{reviewMessage && <p className="evidence-review-message">{reviewMessage}</p>}{reviews.map((review) => <div className="evidence-reviewed-file" key={review.filename}><p><b>{review.filename}</b> · {review.extracted_characters.toLocaleString()} characters read</p><p>{review.message}</p>{review.findings.map((finding) => <article key={`${review.filename}:${finding.topic}`} className="evidence-finding"><h3>{finding.topic}</h3><ul>{finding.evidence.map((line) => <li key={line}>{line}</li>)}</ul>{finding.candidates.map((candidate) => <div className="evidence-candidate" key={candidate.provision_reference}><b>{candidate.provision_reference} · {candidate.title}</b><small>{candidate.source?.kind || 'source'} · pages {(candidate.source?.pages || []).join(', ') || 'n/a'} · applicability unverified</small><p>{candidate.text.slice(0, 600)}{candidate.text.length > 600 ? '…' : ''}</p></div>)}</article>)}</div>)}</section>}
          <div className="evidence-next"><span>The interactive preview uses the locally reconstructed OSU RCRV layout.</span><button type="button" onClick={continueToReview}>Continue to design review <ArrowRight size={15} /></button></div>
        </section>
        <aside className="evidence-aside">
          <section className="evidence-side-card evidence-vessel-card"><div className="workspace-bar"><span><span className="live-dot" /> OSU RCRV · MODEL READY</span><span>DESIGN CONTEXT</span></div><RcrvModelPreview /><div className="evidence-vessel-summary"><span className="evidence-kicker">VESSEL CONTEXT</span><h2>OSU Regional Class Research Vessel</h2><p>Interactive deck and space model from the Complee RCRV demo, shown as the vessel context for this evidence intake.</p><dl><div><dt>Vessel type</dt><dd>Research vessel</dd></div><div><dt>Model source</dt><dd>Reconstructed layout</dd></div></dl><p className="evidence-side-note">Reconstructed demo geometry, not the Autodesk production model or a verified compliance result.</p></div></section>
          <section className="evidence-side-card evidence-source-card"><span className="evidence-kicker">REGULATORY SOURCE</span><h2>Find SOLAS II-2 passages</h2><p>{provider}</p><form className="evidence-search" onSubmit={(event) => { event.preventDefault(); void search() }}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. fire detection alarms" aria-label="Search regulatory provisions" /><button aria-label="Search"><Search size={15} /></button></form><div className="evidence-source-list">{sourceResults.map((item) => <article key={item.id}><b>{item.provision_reference} · {item.title}</b><small>{item.source?.kind || 'source'} · pp. {(item.source?.pages || []).join(', ') || 'n/a'} · applicability unverified</small><p>{item.text}</p></article>)}{sourceMessage && <div className="evidence-source-empty">{sourceMessage}</div>}</div><p className="evidence-source-disclaimer">Passage matches are references for engineer review, not a compliance decision.</p></section>
        </aside>
      </div>
      <footer className="evidence-footnote">Local demo · DOCX text is processed by the local dev server. File names carry into the design demo; source files remain local to this browser session.</footer>
    </main>
  </div>
}
