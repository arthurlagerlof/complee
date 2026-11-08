import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { ArrowLeft, Box, Check, CircleAlert, LoaderCircle, Play, Search, Ship } from 'lucide-react'

// Step 03 "Manage findings": the engineer workspace. For one design revision it shows information completeness and
// source consistency (knowledge catalogue), runs the engineering checks, runs the AI-assisted review of retrieved
// provisions, and lets the engineer review every finding. Findings never declare compliance.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
const SHIPCHECK_REVIEW_URL = import.meta.env.VITE_SHIPCHECK_REVIEW_URL || '/inspection/index.html?scenario=rcrv-3d'

type DesignRevision = { id: string; revision_name: string; revision_number: number; status: string }
type CompletenessRow = {
  component_id: string; name: string; catalogue_type: string; key_properties: string[]; present: string[]
  missing_key_properties: string[]; complete: boolean; inconsistent_properties: { property: string; values: { as_written: string[] }[] }[]
}
type Completeness = { components: CompletenessRow[]; unclassified_components: { name: string; component_type: string }[]; summary: Record<string, number> }
type SourceValue = { value: unknown; unit: string | null; source: { source_name?: string; source_type?: string } }
type Finding = {
  id: string; finding_type: string; status: string; description: string; verification_method: string; component_ids: string[]
  requirement_snapshot: { instrument_code?: string; clause_key?: string; edition?: string; text?: string; provision_availability?: string }
  evidence: { capability?: string; check_id?: string; component?: { name: string }; values?: SourceValue[]; disagreement?: { as_written: string[] }[]; relevant_evidence?: { component_name: string; property?: string }[]; observations?: string[] }
  calculation_results: { explanation?: string; required?: { source_quote?: string }; calculations?: { explanation: string }[]; conditions_not_calculated?: { skipped: string }[] }
  assumptions: { scope?: string; applicability_to_vessel_type?: string; applicability_questions?: string[]; missing_information?: string[]; confidence?: number }
  suggested_action: string | null; reviewed_by: string | null; review_notes: string | null
}
type Provision = { id: string; document_code: string; clause_reference: string; text: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}/api/v1${path}`, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || body?.detail || `Request failed (${response.status})`)
  return body as T
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const TYPE_LABEL: Record<string, string> = {
  potential_issue: 'Potential issue', missing_information: 'Missing information', needs_engineering_review: 'Needs engineering review',
  evidence_found: 'Evidence supports requirement', needs_review: 'Needs review', verified_by_engineer: 'Verified by engineer',
}
const fmt = (v: SourceValue) => `${String(v.value)}${v.unit ? ` ${v.unit}` : ''} (${v.source.source_name || v.source.source_type || 'design record'})`

function FindingCard({ finding, onSaved }: { finding: Finding; onSaved: (f: Finding) => void }) {
  const [status, setStatus] = useState(finding.status)
  const [engineer, setEngineer] = useState(finding.reviewed_by || '')
  const [notes, setNotes] = useState(finding.review_notes || '')
  const [error, setError] = useState('')
  const r = finding.requirement_snapshot
  const save = async () => {
    setError('')
    try { onSaved(await api<Finding>(`/findings/${finding.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, reviewed_by: engineer || undefined, review_notes: notes || undefined }) })) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save the review.') }
  }
  return <article className={`findings-card findings-${finding.finding_type}`}>
    <div className="findings-card-head"><span className="findings-type">{TYPE_LABEL[finding.finding_type] || finding.finding_type}</span><span className="findings-clause">{r.instrument_code} {r.clause_key}</span><span className="findings-status">{finding.status}</span></div>
    <p className="findings-description">{finding.description}</p>
    <dl className="findings-details">
      {finding.evidence.values?.length ? <div><dt>Design values</dt><dd>{finding.evidence.values.map(fmt).join(' · ')}</dd></div> : null}
      {finding.evidence.disagreement?.length ? <div><dt>Sources disagree</dt><dd>{finding.evidence.disagreement.map((d) => d.as_written.join(', ')).join(' vs ')}</dd></div> : null}
      {finding.evidence.relevant_evidence?.length ? <div><dt>Relevant evidence</dt><dd>{finding.evidence.relevant_evidence.map((e) => `${e.component_name}${e.property ? ` · ${e.property}` : ''}`).join('; ')}</dd></div> : null}
      {finding.calculation_results.required?.source_quote && <div><dt>Requirement</dt><dd>“{finding.calculation_results.required.source_quote}”</dd></div>}
      {finding.calculation_results.calculations?.map((c, i) => <div key={i}><dt>Calculation</dt><dd>{c.explanation}</dd></div>)}
      {finding.calculation_results.conditions_not_calculated?.map((c, i) => <div key={i}><dt>Not calculated</dt><dd>{c.skipped}</dd></div>)}
      {finding.assumptions.missing_information?.length ? <div><dt>Missing</dt><dd>{finding.assumptions.missing_information.join('; ')}</dd></div> : null}
      {finding.assumptions.scope && <div><dt>Scope</dt><dd>{finding.assumptions.scope}</dd></div>}
      {finding.assumptions.applicability_to_vessel_type && <div><dt>Applicability</dt><dd>{finding.assumptions.applicability_to_vessel_type}</dd></div>}
      {finding.assumptions.applicability_questions?.length ? <div><dt>Questions</dt><dd>{finding.assumptions.applicability_questions.join(' ')}</dd></div> : null}
      {typeof finding.assumptions.confidence === 'number' && <div><dt>Confidence</dt><dd>{Math.round(finding.assumptions.confidence * 100)} %</dd></div>}
      <div><dt>Source</dt><dd>{r.edition || 'edition not recorded'}{r.provision_availability ? ` · ${r.provision_availability} text` : ''} · {finding.verification_method}</dd></div>
    </dl>
    {r.text && <details className="findings-provision"><summary>Provision text</summary><p>{r.text}</p></details>}
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
  const [revisionId, setRevisionId] = useState('')
  const [completeness, setCompleteness] = useState<Completeness | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [skipped, setSkipped] = useState<{ check_id: string; reason: string }[]>([])
  const [query, setQuery] = useState('')
  const [provisions, setProvisions] = useState<Provision[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [newRevision, setNewRevision] = useState({ project: '', vessel: '', vessel_type: 'research' })

  const loadRevisions = useCallback(() => api<DesignRevision[]>('/design-revisions?limit=100')
    .then(setRevisions).catch((e) => setMessage(e instanceof Error ? e.message : 'Could not load design revisions.')), [])
  useEffect(() => { void loadRevisions() }, [loadRevisions])

  const loadRevision = useCallback(async (id: string) => {
    setCompleteness(null); setFindings([]); setSkipped([])
    if (!id) return
    try {
      setCompleteness(await api<Completeness>(`/design-revisions/${id}/completeness`))
      const assessments = await api<{ id: string; created_at: string }[]>(`/assessments?revision_id=${id}&limit=100`)
      const all = await Promise.all(assessments.map((a) => api<Finding[]>(`/assessments/${a.id}/findings?limit=200`)))
      setFindings(all.flat().reverse())
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not load the revision.') }
  }, [])
  useEffect(() => { void loadRevision(revisionId) }, [revisionId, loadRevision])

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label); setMessage('')
    try { await work() } catch (e) { setMessage(e instanceof Error ? e.message : 'Request failed.') } finally { setBusy('') }
  }
  const runChecks = () => run('checks', async () => {
    const out = await api<{ findings: Finding[]; skipped_checks: { check_id: string; reason: string }[] }>('/engineering-checks/run', post({ revision_id: revisionId }))
    setFindings((current) => [...out.findings, ...current]); setSkipped(out.skipped_checks)
    setMessage(`${out.findings.length} finding${out.findings.length === 1 ? '' : 's'} from the engineering checks.`)
  })
  const search = () => run('search', async () => {
    const out = await api<{ results: Provision[] }>(`/regulations/search?query=${encodeURIComponent(query)}&mode=full_text&limit=8`)
    setProvisions(out.results); setSelected([])
    if (!out.results.length) setMessage('No provision matched. Try other words.')
  })
  const aiReview = () => run('ai', async () => {
    const out = await api<{ findings: Finding[] }>('/engineering-checks/ai-review', post({ revision_id: revisionId, requirement_ids: selected }))
    setFindings((current) => [...out.findings, ...current])
    setMessage(`AI-assisted review stored ${out.findings.length} finding${out.findings.length === 1 ? '' : 's'} for engineer review.`)
  })
  const createRevision = () => run('create', async () => {
    const project = await api<{ id: string }>('/projects', post({ name: newRevision.project }))
    const vessel = await api<{ id: string }>('/vessels', post({ project_id: project.id, name: newRevision.vessel, vessel_type: newRevision.vessel_type || null }))
    const revision = await api<DesignRevision>('/design-revisions', post({ vessel_id: vessel.id, revision_name: 'Revision 1', revision_number: 1 }))
    await loadRevisions(); setRevisionId(revision.id)
  })
  const back = (event: MouseEvent<HTMLAnchorElement>) => { event.preventDefault(); onBack() }
  const summary = completeness?.summary

  return <div className="evidence-app">
    <header className="evidence-header"><a className="brand" href="#top" onClick={back} aria-label="Complee home"><span className="brand-mark"><Ship size={17} strokeWidth={1.8} /></span>Complee</a><a className="evidence-return-link" href="#top" onClick={back}><ArrowLeft size={14} />Back to main page</a><nav className="evidence-steps" aria-label="Review workflow"><a href="#evidence"><span>01</span>Upload</a><i /><a href={SHIPCHECK_REVIEW_URL}><span>02</span>Review design</a><i /><b><span>03</span>Manage findings</b></nav><span className="evidence-local"><i />ENGINEER REVIEW</span></header>
    <main className="evidence-workspace findings-workspace">
      <div className="evidence-title"><div><span className="evidence-kicker">VESSEL DESIGN REVIEW / STEP 03</span><h1>Manage findings</h1><p>Completeness, consistency and requirement checks on the imported design data, with the official provision text. Every finding stays open until an engineer reviews it; nothing here declares compliance.</p></div>
        <a className="findings-model-link" href={SHIPCHECK_REVIEW_URL}><Box size={15} />Open the 3D model</a></div>

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
          <div className="evidence-card-header"><div><span className="evidence-kicker">01 / INFORMATION COMPLETENESS AND CONSISTENCY</span><h2>Key engineering properties per component</h2></div>
            {summary && <span className="findings-summary">{summary.complete}/{summary.classified} complete · {summary.with_inconsistent_sources} with disagreeing sources · {completeness?.unclassified_components.length} unclassified</span>}</div>
          {!completeness ? <div className="evidence-empty"><LoaderCircle className="ai-spin" size={16} />Loading…</div>
            : !completeness.components.length ? <div className="evidence-empty"><CircleAlert size={16} />No components in this revision yet. Import approved candidates in step 01.</div>
              : <table className="findings-table"><thead><tr><th>Component</th><th>Type</th><th>Present</th><th>Missing key properties</th><th>Sources disagree</th></tr></thead><tbody>
                {completeness.components.map((c) => <tr key={c.component_id} className={c.complete ? '' : 'is-incomplete'}><td>{c.name}</td><td>{c.catalogue_type.replace('_', ' ')}</td><td>{c.present.join(', ') || '–'}</td><td>{c.missing_key_properties.join(', ') || 'none'}</td><td>{c.inconsistent_properties.map((p) => `${p.property}: ${p.values.map((v) => v.as_written.join('/')).join(' vs ')}`).join('; ') || '–'}</td></tr>)}
              </tbody></table>}
        </section>

        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">02 / ENGINEERING CHECKS</span><h2>Deterministic checks against structured requirements</h2></div>
            <button type="button" className="findings-action" onClick={() => void runChecks()} disabled={!!busy}>{busy === 'checks' ? <LoaderCircle className="ai-spin" size={13} /> : <Play size={13} />}Run checks</button></div>
          <p className="evidence-extraction-note">Door and walking-surface clear width (ADA 404.2.3, 403.5.1), ramp slope (ADA 405.2), dead-end corridors (SOLAS II-2/13/3.3.4) and oil fuel pipe material (SOLAS II-2/4/2.2.5.1). Values are unit-converted and compared by a calculation tool, never by the AI.</p>
          {!!skipped.length && <p className="evidence-extraction-note">Not run: {skipped.map((s) => `${s.check_id} (${s.reason})`).join('; ')}</p>}
        </section>

        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">03 / AI-ASSISTED REVIEW</span><h2>Compare retrieved provisions with the design</h2></div></div>
          <div className="evidence-extraction-controls">
            <label>Search the regulation database<input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && query) void search() }} placeholder="e.g. dead-end corridors, oil fuel pipes" /></label>
            <button type="button" onClick={() => void search()} disabled={!query || !!busy}><Search size={12} /> Search</button>
            <button type="button" onClick={() => void aiReview()} disabled={!selected.length || !!busy}>{busy === 'ai' ? 'Reviewing…' : `Review ${selected.length || ''} with AI`}</button>
          </div>
          {provisions.map((p) => <label key={p.id} className="findings-provision-option"><input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, p.id].slice(0, 10) : s.filter((id) => id !== p.id))} /><b>{p.document_code} {p.clause_reference}</b><span>{p.text.slice(0, 220)}{p.text.length > 220 ? '…' : ''}</span></label>)}
          <p className="evidence-extraction-note">The AI maps evidence, missing information and applicability questions. A threshold is calculated only when the AI quotes it verbatim from the provision, using the design value from the database.</p>
        </section>

        <section className="evidence-file-card">
          <div className="evidence-card-header"><div><span className="evidence-kicker">FINDINGS</span><h2>{findings.length} finding{findings.length === 1 ? '' : 's'} for engineer review</h2></div></div>
          {findings.length ? <div className="findings-list">{findings.map((f) => <FindingCard key={f.id} finding={f} onSaved={(saved) => setFindings((all) => all.map((x) => x.id === saved.id ? saved : x))} />)}</div>
            : <div className="evidence-empty"><CircleAlert size={16} />No findings yet. Run the engineering checks or an AI-assisted review.</div>}
        </section>
      </>}
    </main>
  </div>
}

export default FindingsWorkspace
