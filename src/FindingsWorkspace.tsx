import { Fragment, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import { ArrowLeft, Box, Check, CircleAlert, FileText, LoaderCircle, Play, RotateCcw, Search, Ship } from 'lucide-react'
import UploadedModelViewer from './UploadedModelViewer'

// Step 03 "Manage findings": the results workspace for one design revision. It shows the uploaded sources and models,
// information completeness, the assessment runs (structured checks, retrieval, AI interpretation, scores; started
// automatically after an import) and the compliance matrix with rule ambiguity and estimated compliance likelihood.
// Every finding stays open until an engineer reviews it; nothing here declares compliance.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
const SHIPCHECK_REVIEW_URL = import.meta.env.VITE_SHIPCHECK_REVIEW_URL || '/inspection/index.html?scenario=rcrv-3d'
const REVISION_KEY = 'complee.revisionId'

type DesignRevision = { id: string; revision_name: string; revision_number: number; status: string }
type CompletenessRow = {
  component_id: string; name: string; catalogue_type: string; key_properties: string[]; present: string[]
  missing_key_properties: string[]; complete: boolean; inconsistent_properties: { property: string; values: { as_written: string[] }[] }[]
}
type Completeness = { components: CompletenessRow[]; unclassified_components: { name: string; component_type: string }[]; summary: Record<string, number> }
type SourceValue = { value: unknown; unit: string | null; review_status?: string; source: { source_name?: string; source_type?: string; evidence?: { page?: number | null } | null } }
type Factor = { factor: string; points?: number; effect?: number; detail: string; quote?: string }
type Score = { score: number | null; band?: string; label?: string; calibration?: string; explanation: string; factors: Factor[]; information_needed?: string[]; method: string }
type Finding = {
  id: string; finding_type: string; assessment_status?: string; review_status?: string; status: string; description: string
  verification_method: string; component_ids: string[]; requirement_id: string
  provision_reference?: { source?: string; chapter?: string; clause?: string; edition?: string }
  rule_ambiguity?: Score | null; compliance_likelihood?: Score | null
  requirement_snapshot: { instrument_code?: string; clause_key?: string; edition?: string; text?: string; provision_availability?: string }
  evidence: {
    capability?: string; values?: SourceValue[]; disagreement?: { as_written: string[] }[]; relevant_evidence?: { component_name: string; property?: string }[]
    observations?: string[]; applicability?: string; ai_interpretation?: string
    requirement_interpretation?: { description?: string; interpretation_source?: string; exceptions?: string[]; alternative_interpretations?: string[]; source_quote?: string }
    retrieval?: { groups: { component_type: string; method: string; rank: number }[]; catalogue_linked: boolean; requested_by_engineer: boolean }
    workflow?: { change?: string; previous_finding?: { finding_type: string; status: string; reviewed_by?: string | null } | null }
  }
  calculation_results: {
    explanation?: string; required?: { source_quote?: string }; calculations?: { explanation: string }[]; conditions_not_calculated?: { skipped: string }[]
    comparison?: { method: string | null; result: string; calculation_details?: { explanation?: string } | null }
  }
  assumptions: { scope?: string; applicability_to_vessel_type?: string; applicability_questions?: string[]; missing_information?: string[] }
  suggested_action: string | null; reviewed_by: string | null; review_notes: string | null
}
type Stage = { status?: string; error?: string; reason?: string | null; mode_used?: string | null; fallback_reason?: string | null; candidates?: number; interpreted?: number; errors?: string[]; skipped_checks?: { check_id: string; reason: string }[] }
type Run = {
  assessment_id: string; status: string; created_at: string; trigger?: string | null; findings: number; finding_types: Record<string, number>
  likelihood_labels: Record<string, number>; changes_vs_previous: Record<string, number>; removed_vs_previous: string[]
  stages: { structured_checks?: Stage; retrieval?: Stage; ai_interpretation?: Stage }; created?: boolean
}
type Component = { id: string; name: string; component_type: string; geometry_reference?: { source_document_id?: string; nodes?: { node_index: number }[] } | null }
type SourceDocument = { id: string; filename: string; file_extension: string; extraction_method: string | null; processing_status: string; error_message: string | null }
type Provision = { id: string; document_code: string; clause_reference: string; text: string }
type ViewerState = { url: string; filename: string; highlight: number[]; label?: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api/v1${path}`, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || body?.detail || `Request failed (${response.status})`)
  return body as T
}
// List endpoints return at most 100 items per page.
async function apiAll<T>(path: string): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await api<T[]>(`${path}${path.includes('?') ? '&' : '?'}limit=100&offset=${offset}`)
    out.push(...page)
    if (page.length < 100) break
  }
  return out
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const remember = (id: string) => { try { if (id) localStorage.setItem(REVISION_KEY, id) } catch { /* storage unavailable */ } }
const recall = () => { try { return localStorage.getItem(REVISION_KEY) || '' } catch { return '' } }
const TYPE_LABEL: Record<string, string> = {
  potential_issue: 'Potential issue', missing_information: 'Missing information', needs_engineering_review: 'Needs engineering review',
  evidence_found: 'Evidence found', needs_review: 'Needs review', verified_by_engineer: 'Verified by engineer',
}
const LIKELIHOOD_LABEL: Record<string, string> = {
  likely_satisfied: 'likely satisfied', uncertain: 'uncertain', likely_not_satisfied: 'likely not satisfied', not_estimable: 'not estimable',
}
const RUN_LABEL: Record<string, string> = {
  queued: 'Queued', running: 'Running', provisional: 'Provisional (revision still editable)', completed: 'Finalized (revision locked)',
  failed: 'Failed', superseded: 'Superseded by a newer run', stale: 'Stalled', in_progress: 'In progress',
}
const fmt = (v: SourceValue) => `${String(v.value)}${v.unit ? ` ${v.unit}` : ''} (${v.source.source_name || v.source.source_type || 'design record'}${v.source.evidence?.page ? `, p. ${v.source.evidence.page}` : ''})`
const methodLabel = (f: Finding) => f.verification_method.startsWith('engineering_check:') ? 'Deterministic check'
  : f.verification_method === 'ai_assisted_review' ? (f.calculation_results.comparison?.method?.includes('numeric') ? 'AI interpretation + calculation' : 'AI interpretation')
    : f.verification_method === 'retrieval_candidate' ? 'Retrieved, not interpreted' : f.verification_method

function ScoreCell({ score, kind }: { score?: Score | null; kind: 'ambiguity' | 'likelihood' }) {
  if (!score) return <span className="findings-score is-none">–</span>
  if (kind === 'likelihood' && score.score === null) return <span className="findings-score is-none" title={score.explanation}>not estimable</span>
  const level = kind === 'ambiguity' ? (score.score! <= 40 ? 'is-good' : score.score! <= 60 ? 'is-mid' : 'is-bad')
    : (score.label === 'likely_satisfied' ? 'is-good' : score.label === 'uncertain' ? 'is-mid' : 'is-bad')
  return <span className={`findings-score ${level}`} title={score.explanation}>{score.score}{kind === 'likelihood' ? ' %' : ''}<small>{kind === 'ambiguity' ? score.band?.replace(/_/g, ' ') : LIKELIHOOD_LABEL[score.label || ''] || score.label}</small></span>
}

function FindingCard({ finding, components, sources, onSaved, onView }: {
  finding: Finding; components: Map<string, Component>; sources: Map<string, SourceDocument>; onSaved: (f: Finding) => void; onView: (v: ViewerState) => void
}) {
  const [status, setStatus] = useState(finding.status)
  const [engineer, setEngineer] = useState(finding.reviewed_by || '')
  const [notes, setNotes] = useState(finding.review_notes || '')
  const [error, setError] = useState('')
  const r = finding.requirement_snapshot
  const ambiguity = finding.rule_ambiguity
  const likelihood = finding.compliance_likelihood
  const interpretation = finding.evidence.requirement_interpretation
  const comparison = finding.calculation_results.comparison
  const save = async () => {
    setError('')
    try { onSaved(await api<Finding>(`/findings/${finding.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, reviewed_by: engineer || undefined, review_notes: notes || undefined }) })) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the review.') }
  }
  const viewable = finding.component_ids.map((id) => components.get(id)).filter((c): c is Component => !!c?.geometry_reference?.source_document_id && !!c.geometry_reference.nodes?.length)
  return <article className={`findings-card findings-${finding.finding_type}`}>
    <p className="findings-description">{finding.description}</p>
    <dl className="findings-details">
      {interpretation?.description && <div><dt>Interpreted requirement</dt><dd>{interpretation.description} <i>({interpretation.interpretation_source})</i></dd></div>}
      {(interpretation?.source_quote || finding.calculation_results.required?.source_quote) && <div><dt>Provision words</dt><dd>“{interpretation?.source_quote || finding.calculation_results.required?.source_quote}”</dd></div>}
      {finding.evidence.values?.length ? <div><dt>Design values</dt><dd>{finding.evidence.values.map(fmt).join(' · ')}</dd></div> : null}
      {finding.evidence.disagreement?.length ? <div><dt>Sources disagree</dt><dd>{finding.evidence.disagreement.map((d) => d.as_written.join(', ')).join(' vs ')}</dd></div> : null}
      {finding.evidence.relevant_evidence?.length ? <div><dt>Relevant evidence</dt><dd>{finding.evidence.relevant_evidence.map((e) => `${e.component_name}${e.property ? ` · ${e.property}` : ''}`).join('; ')}</dd></div> : null}
      {comparison && <div><dt>Comparison</dt><dd>{comparison.method || 'none'} → {comparison.result.replace(/_/g, ' ')}{comparison.calculation_details?.explanation ? ` · ${comparison.calculation_details.explanation}` : ''}</dd></div>}
      {finding.calculation_results.conditions_not_calculated?.map((c, i) => <div key={i}><dt>Not calculated</dt><dd>{c.skipped}</dd></div>)}
      {finding.assumptions.missing_information?.length ? <div><dt>Missing</dt><dd>{finding.assumptions.missing_information.join('; ')}</dd></div> : null}
      {finding.assumptions.scope && <div><dt>Scope</dt><dd>{finding.assumptions.scope}</dd></div>}
      {(finding.evidence.applicability || finding.assumptions.applicability_to_vessel_type) && <div><dt>Applicability</dt><dd>{finding.evidence.applicability || finding.assumptions.applicability_to_vessel_type}</dd></div>}
      {finding.assumptions.applicability_questions?.length ? <div><dt>Questions</dt><dd>{finding.assumptions.applicability_questions.join(' ')}</dd></div> : null}
      {interpretation?.exceptions?.length ? <div><dt>Exceptions</dt><dd>{interpretation.exceptions.join('; ')}</dd></div> : null}
      {interpretation?.alternative_interpretations?.length ? <div><dt>Other readings</dt><dd>{interpretation.alternative_interpretations.join('; ')}</dd></div> : null}
      {finding.evidence.ai_interpretation && <div><dt>AI</dt><dd>{finding.evidence.ai_interpretation}</dd></div>}
      <div><dt>Source</dt><dd>{r.instrument_code} {r.clause_key} · {r.edition || 'edition not recorded'}{r.provision_availability ? ` · ${r.provision_availability} text` : ''} · {finding.verification_method}</dd></div>
    </dl>
    <div className="findings-scores">
      {ambiguity && <div><b>Rule ambiguity {ambiguity.score}/100</b><span>{ambiguity.explanation}</span>
        <ul>{ambiguity.factors.filter((f) => f.factor !== 'baseline' && f.points).map((f, i) => <li key={i}>+{f.points} {f.detail}{f.quote ? <q>{f.quote}</q> : null}</li>)}</ul></div>}
      {likelihood && <div><b>Estimated compliance likelihood: {likelihood.score === null ? 'not estimable' : `${likelihood.score} %`}</b><span>{likelihood.explanation}</span>
        {likelihood.information_needed?.length ? <ul>{likelihood.information_needed.map((n, i) => <li key={i}>Needed: {n}</li>)}</ul> : null}
        <small>Heuristic estimate, {likelihood.calibration?.replace('_', ' ')}; {likelihood.method}</small></div>}
    </div>
    {r.text && <details className="findings-provision"><summary>Provision text</summary><p>{r.text}</p></details>}
    {!!viewable.length && <div className="findings-view-links">{viewable.map((c) => {
      const source = sources.get(c.geometry_reference!.source_document_id!)
      return <button key={c.id} type="button" onClick={() => onView({ url: `${API_BASE}/api/v1/ai/source-documents/${c.geometry_reference!.source_document_id}/file`, filename: source?.filename || 'Uploaded model', highlight: c.geometry_reference!.nodes!.map((n) => n.node_index), label: c.name })}><Box size={12} />Show {c.name} in the uploaded model</button>
    })}</div>}
    {finding.evidence.workflow?.previous_finding && <p className="evidence-extraction-note">Previous run: {TYPE_LABEL[finding.evidence.workflow.previous_finding.finding_type] || finding.evidence.workflow.previous_finding.finding_type} · {finding.evidence.workflow.previous_finding.status}{finding.evidence.workflow.previous_finding.reviewed_by ? ` · reviewed by ${finding.evidence.workflow.previous_finding.reviewed_by}` : ''}</p>}
    <div className="findings-review">
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Review status">
        {['open', 'under_review', 'accepted', 'resolved', 'dismissed'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
      </select>
      <input value={engineer} onChange={(e) => setEngineer(e.target.value)} placeholder="Engineer name" aria-label="Engineer name" />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Review notes" aria-label="Review notes" />
      <button type="button" onClick={() => void save()}>Save review</button>
    </div>
    {finding.reviewed_by && <p className="findings-reviewed"><Check size={12} /> Reviewed by {finding.reviewed_by}</p>}
    {error && <p className="evidence-extraction-error">{error}</p>}
  </article>
}

function FindingsWorkspace({ onBack }: { onBack: () => void }) {
  const [revisions, setRevisions] = useState<DesignRevision[]>([])
  const [revisionId, setRevisionId] = useState(recall)
  const [completeness, setCompleteness] = useState<Completeness | null>(null)
  const [sources, setSources] = useState<SourceDocument[]>([])
  const [components, setComponents] = useState<Component[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [runId, setRunId] = useState('')
  const [findings, setFindings] = useState<Finding[]>([])
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState('')
  const [query, setQuery] = useState('')
  const [provisions, setProvisions] = useState<Provision[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [newRevision, setNewRevision] = useState({ project: '', vessel: '', vessel_type: 'research' })

  const loadRevisions = useCallback(() => api<DesignRevision[]>('/design-revisions?limit=100')
    .then((list) => { setRevisions(list); setRevisionId((id) => list.some((r) => r.id === id) ? id : '') })
    .catch((e) => setMessage(e instanceof Error ? e.message : 'Could not load design revisions.')), [])
  useEffect(() => { void loadRevisions() }, [loadRevisions])

  const loadRuns = useCallback(async (id: string, keepSelection = true) => {
    const list = await api<Run[]>(`/design-revisions/${id}/assessment-runs`)
    setRuns(list)
    setRunId((current) => keepSelection && list.some((r) => r.assessment_id === current) ? current
      : (list.find((r) => !['superseded', 'failed', 'queued', 'running'].includes(r.status)) || list[0])?.assessment_id || '')
    return list
  }, [])

  const loadRevision = useCallback(async (id: string) => {
    setCompleteness(null); setSources([]); setComponents([]); setRuns([]); setRunId(''); setFindings([]); setOpen('')
    if (!id) return
    remember(id)
    try {
      const [report, docs, parts] = await Promise.all([
        api<Completeness>(`/design-revisions/${id}/completeness`),
        api<SourceDocument[]>(`/ai/design-revisions/${id}/source-documents`),
        apiAll<Component>(`/design-revisions/${id}/components`),
      ])
      setCompleteness(report); setSources(docs); setComponents(parts)
      await loadRuns(id, false)
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not load the revision.') }
  }, [loadRuns])
  useEffect(() => { void loadRevision(revisionId) }, [revisionId, loadRevision])

  useEffect(() => {
    if (!runId) { setFindings([]); return }
    apiAll<Finding>(`/assessments/${runId}/findings`).then(setFindings).catch((e) => setMessage(e instanceof Error ? e.message : 'Could not load findings.'))
  }, [runId, runs])

  // A queued or running run (for example the one started by an import) is polled until it finishes.
  const active = runs.some((r) => r.status === 'queued' || r.status === 'running')
  useEffect(() => {
    if (!active || !revisionId) return
    const timer = window.setInterval(() => { void loadRuns(revisionId, false) }, 2500)
    return () => window.clearInterval(timer)
  }, [active, revisionId, loadRuns])

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setMessage('')
    try { await work() } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy('') }
  }
  const startRun = (force = false) => act('run', async () => {
    const out = await api<Run>(`/design-revisions/${revisionId}/assessment-runs`, post({ extra_requirement_ids: selected, force }))
    setMessage(out.created ? 'Assessment run started. Results appear here when it finishes.' : 'The design data has not changed since the last run, so its results are shown. Use "Run again" to force a new run.')
    setSelected([])
    await loadRuns(revisionId, false)
  })
  const retry = (id: string) => act('retry', async () => { await api<Run>(`/assessment-runs/${id}/retry`, post({})); await loadRuns(revisionId, false) })
  const finalize = (id: string) => act('finalize', async () => {
    await api<Run>(`/assessment-runs/${id}/finalize`, post({}))
    setMessage('Run finalized: the assessment is complete and this design revision is now locked. Create a new revision for further changes.')
    await loadRuns(revisionId)
  })
  const search = () => act('search', async () => {
    const out = await api<{ results: Provision[] }>(`/regulations/search?query=${encodeURIComponent(query)}&mode=full_text&limit=8`)
    setProvisions(out.results)
    if (!out.results.length) setMessage('No provision matched. Try other words.')
  })
  const createRevision = () => act('create', async () => {
    const project = await api<{ id: string }>('/projects', post({ name: newRevision.project }))
    const vessel = await api<{ id: string }>('/vessels', post({ project_id: project.id, name: newRevision.vessel, vessel_type: newRevision.vessel_type || null }))
    const revision = await api<DesignRevision>('/design-revisions', post({ vessel_id: vessel.id, revision_name: 'Revision 1', revision_number: 1 }))
    await loadRevisions(); setRevisionId(revision.id)
  })
  const back = (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onBack() }

  const componentMap = useMemo(() => new Map(components.map((c) => [c.id, c])), [components])
  const sourceMap = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources])
  const models = sources.filter((s) => ['.glb', '.gltf'].includes(s.file_extension.toLowerCase()) && s.processing_status === 'completed')
  const run = runs.find((r) => r.assessment_id === runId)
  const latest = runs[0]
  const shown = findings.filter((f) => !filter || f.finding_type === filter)
  const summary = completeness?.summary
  const stages = run?.stages || {}

  return <div className="evidence-app">
    <header className="evidence-header"><a className="brand" href="#top" onClick={back} aria-label="Complee home"><span className="brand-mark"><Ship size={17} strokeWidth={1.8} /></span>Complee</a><a className="evidence-return-link" href="#top" onClick={back}><ArrowLeft size={14} />Back to main page</a><nav className="evidence-steps" aria-label="Review workflow"><a href="#evidence"><span>01</span>Upload</a><i /><a href={SHIPCHECK_REVIEW_URL}><span>02</span>Review design</a><i /><b><span>03</span>Manage findings</b></nav><span className="evidence-local"><i />ENGINEER REVIEW</span></header>
    <main className="evidence-workspace findings-workspace">
      <div className="evidence-title"><div><span className="evidence-kicker">VESSEL DESIGN REVIEW / STEP 03</span><h1>Manage findings</h1><p>Approved design data is assessed automatically: structured checks, regulatory retrieval, AI interpretation and two separate scores per requirement. Every finding stays open until an engineer reviews it; nothing here declares compliance.</p></div>
        <a className="findings-model-link" href={SHIPCHECK_REVIEW_URL}><Box size={15} />Open the reference model</a></div>

      <section className="evidence-file-card">
        <div className="evidence-card-header"><div><span className="evidence-kicker">DESIGN REVISION</span><h2>Select the revision to review</h2></div></div>
        <div className="evidence-extraction-controls">
          <label>Design revision
            <select value={revisionId} onChange={(e) => setRevisionId(e.target.value)}>
              <option value="">{revisions.length ? 'Select a design revision' : 'No revision yet: create one below'}</option>
              {revisions.map((r) => <option key={r.id} value={r.id}>{r.revision_name} · Rev {r.revision_number} · {r.status}</option>)}
            </select>
          </label>
        </div>
        <div className="evidence-extraction-controls findings-new-revision">
          <label>New project<input value={newRevision.project} onChange={(e) => setNewRevision({ ...newRevision, project: e.target.value })} placeholder="e.g. OSU RCRV" /></label>
          <label>Vessel<input value={newRevision.vessel} onChange={(e) => setNewRevision({ ...newRevision, vessel: e.target.value })} placeholder="e.g. RCRV hull 1" /></label>
          <label>Vessel type<input value={newRevision.vessel_type} onChange={(e) => setNewRevision({ ...newRevision, vessel_type: e.target.value })} placeholder="research, cargo, passenger" /></label>
          <button type="button" onClick={() => void createRevision()} disabled={!newRevision.project || !newRevision.vessel || !!busy}>Create revision</button>
        </div>
        {message && <p className="evidence-extraction-message" role="status">{message}</p>}
      </section>

      {revisionId && <>
        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">01 / SOURCES AND MODELS</span><h2>Uploaded engineering information</h2></div>
            <a className="findings-action" href="#evidence"><FileText size={13} />Add sources</a></div>
          {!sources.length ? <div className="evidence-empty"><CircleAlert size={16} />No source files for this revision yet. Upload documents, drawings or models in step 01.</div>
            : <table className="findings-table"><thead><tr><th>File</th><th>Extraction</th><th>Status</th></tr></thead><tbody>
              {sources.map((s) => <tr key={s.id}><td>{s.filename}</td><td>{s.extraction_method || '–'}</td><td>{s.processing_status}{s.error_message ? ` · ${s.error_message}` : ''}</td></tr>)}
            </tbody></table>}
          <div className="findings-models">
            <span>Models:</span>
            <a href={SHIPCHECK_REVIEW_URL}><Box size={12} />Reference model (RCRV, streamed)</a>
            {models.map((m) => <button key={m.id} type="button" onClick={() => setViewer({ url: `${API_BASE}/api/v1/ai/source-documents/${m.id}/file`, filename: m.filename, highlight: [] })}><Box size={12} />{m.filename} (uploaded)</button>)}
            {!models.length && <i>No uploaded 3D model. The assessment does not need one.</i>}
          </div>
        </section>

        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">02 / INFORMATION COMPLETENESS AND CONSISTENCY</span><h2>Key engineering properties per component</h2></div>
            {summary && <span className="findings-summary">{summary.complete}/{summary.classified} complete · {summary.with_inconsistent_sources} with disagreeing sources · {completeness?.unclassified_components.length} unclassified</span>}</div>
          {!completeness ? <div className="evidence-empty"><LoaderCircle className="ai-spin" size={16} />Loading…</div>
            : !completeness.components.length ? <div className="evidence-empty"><CircleAlert size={16} />No components in this revision yet. Import approved candidates in step 01.</div>
              : <table className="findings-table"><thead><tr><th>Component</th><th>Type</th><th>Present</th><th>Missing key properties</th><th>Sources disagree</th></tr></thead><tbody>
                {completeness.components.map((c) => <tr key={c.component_id} className={c.complete ? '' : 'is-incomplete'}><td>{c.name}</td><td>{c.catalogue_type.replace('_', ' ')}</td><td>{c.present.join(', ') || '–'}</td><td>{c.missing_key_properties.join(', ') || 'none'}</td><td>{c.inconsistent_properties.map((p) => `${p.property}: ${p.values.map((v) => v.as_written.join('/')).join(' vs ')}`).join('; ') || '–'}</td></tr>)}
              </tbody></table>}
        </section>

        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">03 / ASSESSMENT RUN</span><h2>{latest ? RUN_LABEL[latest.status] || latest.status : 'Not assessed yet'}</h2></div>
            <div className="findings-run-actions">
              {latest && (latest.status === 'failed' || latest.status === 'stale') && <button type="button" className="findings-action" onClick={() => void retry(latest.assessment_id)} disabled={!!busy}><RotateCcw size={13} />Retry</button>}
              <button type="button" className="findings-action" onClick={() => void startRun(!!latest && !active)} disabled={!!busy || active}>{busy === 'run' || active ? <LoaderCircle className="ai-spin" size={13} /> : <Play size={13} />}{latest ? 'Run again' : 'Run assessment'}</button>
              {latest?.status === 'provisional' && <button type="button" className="findings-action is-secondary" onClick={() => void finalize(latest.assessment_id)} disabled={!!busy}><Check size={13} />Finalize</button>}
            </div></div>
          {latest && <p className="evidence-extraction-note">
            {latest.trigger === 'candidate_import' ? 'Started automatically after an import. ' : ''}
            {stages.structured_checks && `Structured checks: ${stages.structured_checks.status}${stages.structured_checks.error ? ` (${stages.structured_checks.error})` : ''}. `}
            {stages.retrieval && `Retrieval: ${stages.retrieval.mode_used || stages.retrieval.status}${stages.retrieval.candidates !== undefined ? `, ${stages.retrieval.candidates} candidate provisions` : ''}${stages.retrieval.fallback_reason ? ` (vector search unavailable, full-text used)` : ''}. `}
            {stages.ai_interpretation && `AI interpretation: ${stages.ai_interpretation.status}${stages.ai_interpretation.interpreted ? `, ${stages.ai_interpretation.interpreted} provisions` : ''}${stages.ai_interpretation.reason ? ` (${stages.ai_interpretation.reason})` : ''}${stages.ai_interpretation.errors?.length ? ` · ${stages.ai_interpretation.errors.length} failed` : ''}. `}
            {run && Object.keys(run.changes_vs_previous).length ? `Compared with the previous run: ${Object.entries(run.changes_vs_previous).map(([k, v]) => `${v} ${k}`).join(', ')}${run.removed_vs_previous.length ? `, ${run.removed_vs_previous.length} no longer raised` : ''}.` : ''}
          </p>}
          <div className="evidence-extraction-controls">
            <label>Add provisions to the next run<input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && query) void search() }} placeholder="e.g. dead-end corridors, oil fuel pipes" /></label>
            <button type="button" onClick={() => void search()} disabled={!query || !!busy}><Search size={12} /> Search</button>
          </div>
          {provisions.map((p) => <label key={p.id} className="findings-provision-option"><input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, p.id].slice(0, 10) : s.filter((id) => id !== p.id))} /><b>{p.document_code} {p.clause_reference}</b><span>{p.text.slice(0, 220)}{p.text.length > 220 ? '…' : ''}</span></label>)}
          <p className="evidence-extraction-note">Measurable checks use the calculation modules, never the AI. AI interpretation is used for language and evidence; a threshold it reports is calculated only when quoted verbatim from the provision. Runs stay provisional until finalized, so more sources can be added.</p>
        </section>

        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">04 / COMPLIANCE MATRIX</span><h2>{shown.length} requirement finding{shown.length === 1 ? '' : 's'} for engineer review</h2></div>
            <div className="findings-run-actions">
              <select value={runId} onChange={(e) => { setRunId(e.target.value); setOpen('') }} aria-label="Assessment run">
                {runs.map((r) => <option key={r.assessment_id} value={r.assessment_id}>{new Date(r.created_at).toLocaleString()} · {RUN_LABEL[r.status]?.split(' (')[0] || r.status} · {r.findings} findings</option>)}
              </select>
              <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
                <option value="">All statuses</option>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div></div>
          {!shown.length ? <div className="evidence-empty"><CircleAlert size={16} />{run ? 'No findings in this run.' : 'No assessment yet. Import approved candidates (the run starts automatically) or press Run assessment.'}</div>
            : <table className="findings-table findings-matrix"><thead><tr><th>Provision</th><th>Components</th><th>Method</th><th>Status</th><th>Rule ambiguity</th><th>Compliance likelihood</th><th>Change</th><th>Review</th></tr></thead><tbody>
              {shown.map((f) => {
                const ref = f.provision_reference || {}
                const names = f.component_ids.map((id) => componentMap.get(id)?.name).filter(Boolean) as string[]
                return <Fragment key={f.id}>
                  <tr className={`findings-row${open === f.id ? ' is-open' : ''}`} onClick={() => setOpen(open === f.id ? '' : f.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(open === f.id ? '' : f.id) }} aria-expanded={open === f.id}>
                    <td><b>{ref.source} {ref.clause}</b><small>{ref.edition || 'edition not recorded'}</small></td>
                    <td>{names.slice(0, 3).join(', ') || '–'}{names.length > 3 ? ` +${names.length - 3}` : ''}</td>
                    <td>{methodLabel(f)}</td>
                    <td><span className={`findings-badge findings-${f.finding_type}`}>{TYPE_LABEL[f.finding_type] || f.finding_type}</span></td>
                    <td><ScoreCell score={f.rule_ambiguity} kind="ambiguity" /></td>
                    <td><ScoreCell score={f.compliance_likelihood} kind="likelihood" /></td>
                    <td>{f.evidence.workflow?.change || '–'}</td>
                    <td>{f.review_status === 'pending' ? 'pending' : f.reviewed_by ? `${f.status} · ${f.reviewed_by}` : f.review_status}</td>
                  </tr>
                  {open === f.id && <tr className="findings-detail-row"><td colSpan={8}>
                    <FindingCard finding={f} components={componentMap} sources={sourceMap} onView={setViewer}
                      onSaved={(saved) => setFindings((all) => all.map((x) => x.id === saved.id ? saved : x))} />
                  </td></tr>}
                </Fragment>
              })}
            </tbody></table>}
          <p className="evidence-extraction-note">Rule ambiguity (0–100) rates how clear the provision and its applicability are. Estimated compliance likelihood is a heuristic estimate, not a calibrated probability; it is given only when a calculation actually ran, otherwise “not estimable” with the information needed.</p>
        </section>
      </>}
      {viewer && <UploadedModelViewer {...viewer} onClose={() => setViewer(null)} />}
    </main>
  </div>
}

export default FindingsWorkspace
