import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronRight,
  CircleAlert,
  FileCheck2,
  FileText,
  Menu,
  ShieldCheck,
  Ship,
  X,
} from 'lucide-react'
import { inspectionPoints, reviewExamples } from './inspectionData'
import VesselViewer from './VesselViewer'
import EvidenceIntake from './EvidenceIntake'
import AiWorkspace from './AiWorkspace'
import FindingsWorkspace from './FindingsWorkspace'

gsap.registerPlugin(ScrollTrigger)

const SHIPCHECK_REVIEW_URL = import.meta.env.VITE_SHIPCHECK_REVIEW_URL || '/inspection/index.html?scenario=rcrv-3d'

function ProductName() {
  return (
    <a className="brand" href="#top" aria-label="Complee home">
      <span className="brand-mark"><Ship size={17} strokeWidth={1.8} /></span>
      Complee
    </a>
  )
}

function App() {
  const root = useRef<HTMLDivElement>(null)
  const [selectedId, setSelectedId] = useState(inspectionPoints[0].id)
  const [reviewId, setReviewId] = useState(reviewExamples[0].id)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [continuePromptOpen, setContinuePromptOpen] = useState(false)
  const loginOpenRef = useRef(false)
  const [showConcept, setShowConcept] = useState(() => window.location.hash !== '#evidence')
  const [showAi, setShowAi] = useState(() => window.location.hash === '#ai-settings')
  const [showFindings, setShowFindings] = useState(() => window.location.hash === '#findings')
  // Workflow step links (#evidence, #findings, #ai-settings, #top) switch views without a reload.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash
      setShowFindings(hash === '#findings')
      setShowAi(hash === '#ai-settings')
      setShowConcept(hash !== '#evidence')
    }
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])
  const [evidenceCount, setEvidenceCount] = useState(0)
  const selectedPoint = inspectionPoints.find((point) => point.id === selectedId) ?? inspectionPoints[0]
  const selectedReview = reviewExamples.find((item) => item.id === reviewId) ?? reviewExamples[0]

  useEffect(() => {
    if (!showConcept || showAi) return
    try { setEvidenceCount(JSON.parse(sessionStorage.getItem('compleeEvidenceFiles') || '[]').length) } catch { setEvidenceCount(0) }
    const context = gsap.context(() => {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

      if (!reducedMotion) {
        gsap.from('.hero-copy > *', {
          y: 22,
          opacity: 0,
          duration: 0.75,
          stagger: 0.12,
          ease: 'power2.out',
        })
        gsap.from('.hero-vessel', { y: 24, opacity: 0, duration: 0.9, delay: 0.25, ease: 'power2.out' })
        gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach((element) => {
          gsap.from(element, {
            y: 22,
            opacity: 0,
            duration: 0.65,
            ease: 'power2.out',
            scrollTrigger: { trigger: element, start: 'top 88%', once: true },
          })
        })
        gsap.from('.process-connector', {
          scaleX: 0,
          transformOrigin: 'left center',
          duration: 0.8,
          stagger: 0.2,
          ease: 'power2.out',
          scrollTrigger: { trigger: '.process-steps', start: 'top 78%', once: true },
        })
      }
    }, root)

    return () => context.revert()
  }, [showConcept, showAi])

  const closeMenu = () => setMenuOpen(false)
  const continueToInspection = () => {
    window.location.assign(SHIPCHECK_REVIEW_URL)
  }
  const backToMain = () => {
    window.history.pushState(null, '', '#top')
    setShowAi(false)
    setShowConcept(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const startLogin = () => {
    setMenuOpen(false)
    setContinuePromptOpen(false)
    setLoginOpen(true)
  }
  loginOpenRef.current = loginOpen

  useEffect(() => {
    if (!showConcept || showAi || showFindings) return
    if (sessionStorage.getItem('compleeLoginHint')) return
    const timer = window.setTimeout(() => {
      if (loginOpenRef.current) return
      setContinuePromptOpen(true)
      sessionStorage.setItem('compleeLoginHint', 'shown')
    }, 10000)
    return () => window.clearTimeout(timer)
  }, [showConcept, showAi, showFindings])

  useEffect(() => {
    if (!continuePromptOpen) return
    const mobile = window.matchMedia('(max-width: 800px)')
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      if (!mobile.matches) return
      timer = window.setTimeout(() => setContinuePromptOpen(false), 6000)
    }
    arm()
    mobile.addEventListener('change', arm)
    return () => {
      window.clearTimeout(timer)
      mobile.removeEventListener('change', arm)
    }
  }, [continuePromptOpen])

  useEffect(() => {
    if (!loginOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLoginOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.querySelector<HTMLElement>('.login-card')?.focus()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = window.setTimeout(() => {
      sessionStorage.setItem('compleeLoginHint', 'login')
      window.history.pushState(null, '', '#evidence')
      setLoginOpen(false)
      setShowAi(false)
      setShowFindings(false)
      setShowConcept(false)
      window.scrollTo({ top: 0 })
    }, reducedMotion ? 900 : 3800)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [loginOpen])
  if (showFindings) return <FindingsWorkspace onBack={() => { setShowFindings(false); backToMain() }} />
  if (showAi) return <AiWorkspace onBack={backToMain} />
  if (!showConcept) return <EvidenceIntake onContinue={continueToInspection} onBack={backToMain} />

  return (
    <div ref={root} id="top">
      <header className="site-header">
        <div className="header-inner">
          <ProductName />
          <nav className="desktop-nav" aria-label="Main navigation">
            <a href="#challenge">The challenge</a>
            <a href="#inspection">Vessel inspection</a>
            <a href="#workflow">How it works</a>
            <a href="#architecture">The platform</a>
          </nav>
          <div className="header-actions">
            <button type="button" className={continuePromptOpen ? 'nav-cta is-prompted' : 'nav-cta'} onClick={startLogin} aria-describedby={continuePromptOpen ? 'login-prompt' : undefined}>Login</button>
            <button
              type="button"
              className="menu-toggle"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
            >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
          </div>
        </div>
        <nav id="mobile-navigation" className={`mobile-nav${menuOpen ? ' menu-open' : ''}`} aria-label="Mobile navigation" aria-hidden={!menuOpen}>
          <a href="#challenge" onClick={closeMenu}>The challenge <ArrowRight size={16} /></a>
          <a href="#inspection" onClick={closeMenu}>Vessel inspection <ArrowRight size={16} /></a>
          <a href="#workflow" onClick={closeMenu}>How it works <ArrowRight size={16} /></a>
          <a href="#architecture" onClick={closeMenu}>The platform <ArrowRight size={16} /></a>
        </nav>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-grid" aria-hidden="true" />
          <div className="hero-wrap">
            <div className="hero-copy">
              <span className="eyebrow"><span className="eyebrow-dot" /> EARLIER DESIGN. CLEARER DECISIONS.</span>
              <h1>Find compliance gaps before they become <span>expensive engineering problems.</span></h1>
              <p className="hero-description">
                Complee connects the design model, engineering documents and the regulation library. An engineer adds a drawing or a 3D model, opens it in the 3D view, and sees the parts that need attention highlighted.
              </p>
              <ul className="hero-points">
                <li>See possible gaps earlier in the design.</li>
                <li>Read the requirement next to the evidence.</li>
                <li>Review the highlighted parts on the model.</li>
              </ul>
              <div className="hero-actions">
                <a className="button-primary" href="#inspection">Explore the vessel <ArrowRight size={16} /></a>
                <a className="text-link" href="#workflow">How it works <ArrowDown size={14} /></a>
              </div>
              <div className="hero-note"><ShieldCheck size={16} /><span>Complee prepares the review. <strong>The engineer checks it and decides.</strong></span></div>
            </div>
            <div className="hero-vessel">
              <div className="hero-vessel-label"><span>VESSEL MODEL</span><span>R/V TAANI · INTERACTIVE</span></div>
              <VesselViewer className="hero-viewer" initialAutoRotate />
              <div className="hero-vessel-caption"><span>Drag to inspect</span><span>Challenge model · not a Meyer Turku design</span></div>
            </div>
          </div>
          <a className="hero-scroll" href="#challenge"><span>01</span> THE DESIGN CHALLENGE <ArrowDown size={13} /></a>
        </section>

        <section className="challenge-section section-pad" id="challenge">
          <div className="section-container">
            <div className="section-heading" data-reveal>
              <span className="section-kicker">01 — THE CHALLENGE</span>
              <h2>Compliance becomes expensive when problems are found too late.</h2>
              <p className="section-intro">Early design brings together complex rules, incomplete information and decisions that shape the vessel. Finding a gap later can mean revisiting work that is already underway.</p>
            </div>
            <div className="challenge-grid">
              <article className="challenge-card" data-reveal><span className="card-index">01 / COMPLEXITY</span><h3>Many overlapping requirements</h3><p>Engineers navigate extensive regulations, standards and project-specific requirements.</p></article>
              <article className="challenge-card" data-reveal><span className="card-index">02 / SEARCH</span><h3>Manual document searching</h3><p>Finding relevant passages across large rule documents takes time and context.</p></article>
              <article className="challenge-card" data-reveal><span className="card-index">03 / CONTEXT</span><h3>Rules meet design decisions</h3><p>It can be difficult to see how a requirement connects to a specific design element.</p></article>
            </div>
            <div className="stage-track" data-reveal>
              {['Concept design', 'Detailed engineering', 'Procurement', 'Fabrication', 'Installation', 'Commissioning'].map((stage) => (
                <span key={stage}><i />{stage}</span>
              ))}
            </div>
            <p className="stage-caption" data-reveal>Earlier in this sequence, a change is still a design edit. Later, the same issue can disturb materials, schedule and work already underway.</p>
          </div>
        </section>

        <section className="inspection-section section-pad" id="inspection">
          <div className="section-container">
            <div className="section-heading inspection-heading" data-reveal>
              <span className="section-kicker section-kicker-light">02 — INTERACTIVE CONCEPT</span>
              <h2>Explore compliance in the design.</h2>
              <p>Connect physical design elements with regulatory requirements, supporting evidence and engineering decisions.</p>
            </div>
            <div className="inspection-workspace" data-reveal>
              <div className="inspection-vessel">
              <div className="workspace-bar"><span><span className="live-dot" /> R/V TAANI · DESIGN VIEW</span><span>{evidenceCount ? `${evidenceCount} EVIDENCE FILES · ` : ''}PRELOADED MODEL · ILLUSTRATIVE DEMO</span></div>
                <VesselViewer
                  className="inspection-viewer"
                  selectedPointId={selectedId}
                  onSelectPoint={setSelectedId}
                  showMarkers
                />
                <div className="inspection-footnote"><CircleAlert size={14} /><span>Numbered markers are illustrative, not geometry-verified locations or findings about this vessel.</span></div>
              </div>
              <aside className="inspection-panel" aria-live="polite">
                <div className="panel-overline"><span>ILLUSTRATIVE INSPECTION POINT {selectedPoint.number}</span><span className={`assessment-dot ${selectedPoint.statusTone}`} /></div>
                <h3>{selectedPoint.component}</h3>
                <div className={`assessment-badge ${selectedPoint.statusTone}`}>{selectedPoint.status}</div>
                <div className="inspection-detail"><span>DESIGN OBSERVATION</span><p>{selectedPoint.observation}</p></div>
                <div className="inspection-detail"><span>REGULATORY CONSIDERATION</span><p>{selectedPoint.regulatoryConsideration}</p></div>
                <div className="evidence-row"><FileText size={15} /><span><small>AVAILABLE EVIDENCE</small>{selectedPoint.evidence}</span></div>
                <div className="engineer-action"><span>Suggested engineer action</span><p>{selectedPoint.action}</p></div>
                <div className="point-selector" role="group" aria-label="Choose an illustrative inspection point">
                  {inspectionPoints.map((point) => (
                    <button
                      type="button"
                      key={point.id}
                      className={point.id === selectedId ? 'point-option selected' : 'point-option'}
                      onClick={() => setSelectedId(point.id)}
                      aria-pressed={point.id === selectedId}
                    >
                      <span>{point.number}</span>{point.shortLabel}<ChevronRight size={14} />
                    </button>
                  ))}
                </div>
              </aside>
            </div>
            <p className="demo-disclaimer"><ShieldCheck size={15} /> Demonstration scenarios only. These are not verified findings about R/V Taani or confirmed interpretations of class rules.</p>
          </div>
        </section>

        <section className="workflow-section section-pad" id="workflow">
          <div className="section-container">
            <div className="section-heading workflow-heading" data-reveal>
              <span className="section-kicker section-kicker-light">03 — THE PROPOSED WORKFLOW</span>
              <h2>From the design model to a review the engineer can check.</h2>
              <p className="section-intro">Complee reads the design, finds the provisions that may apply, and prepares a review. The engineer then checks that review.</p>
            </div>
            <div className="process-steps">
              <article className="process-step" data-reveal><span className="process-number">01</span><span className="process-icon"><FileText size={19} /></span><h3>Understand the design</h3><p>The engineer adds documents, a 2D drawing and the 3D model. Complee keeps the parts, the values and the file they came from.</p></article>
              <span className="process-connector" aria-hidden="true" />
              <article className="process-step" data-reveal><span className="process-number">02</span><span className="process-icon"><FileCheck2 size={19} /></span><h3>Find the provisions</h3><p>Search the regulation library for provisions that may apply to this design, and keep the source text.</p></article>
              <span className="process-connector" aria-hidden="true" />
              <article className="process-step" data-reveal><span className="process-number">03</span><span className="process-icon"><CircleAlert size={19} /></span><h3>Prepare the review</h3><p>Compare the design with those provisions. Measurable values are calculated. The review shows what matches, what is missing and what to inspect on the model.</p></article>
              <span className="process-connector" aria-hidden="true" />
              <article className="process-step" data-reveal><span className="process-number">04</span><span className="process-icon"><Check size={19} /></span><h3>Engineer check</h3><p>The engineer opens the highlighted part, reads the evidence and confirms or corrects the review.</p></article>
            </div>
            <div className="process-note"><span className="note-line" /> Complee prepares the review. The engineer checks it again before it is treated as decided.</div>
          </div>
        </section>

        <section className="integration-section section-pad" id="integration">
          <div className="section-container">
            <div className="section-heading" data-reveal>
              <span className="section-kicker">YOUR DESIGN FILES</span>
              <h2>The review sits beside the design work, not in place of it.</h2>
              <p className="section-intro">Complee is not another CAD system. Engineers bring the documents, the drawing and the model into the review, open the ship in the 3D view, and select a highlighted part to read the requirement and the evidence.</p>
            </div>
            <div className="challenge-grid">
              <article className="challenge-card" data-reveal><span className="card-index">01 / ADD</span><h3>Add the design files</h3><p>Documents, a 2D drawing and the 3D model go in with the revision. Each value keeps a link to the file it came from.</p></article>
              <article className="challenge-card" data-reveal><span className="card-index">02 / VIEW</span><h3>Select a part on the model</h3><p>The 3D view highlights the parts tied to the review. The engineer selects one and reads the requirement next to the evidence.</p></article>
              <article className="challenge-card" data-reveal><span className="card-index">03 / CONNECT</span><h3>Use it with the yard’s tools</h3><p>The design software stays in place. A yard system can send the same design information and open this review.</p></article>
            </div>
          </div>
        </section>

        <section className="finding-section section-pad" id="review">
          <div className="section-container finding-layout">
            <div className="section-heading" data-reveal>
              <span className="section-kicker">THE REVIEW</span>
              <h2>From the list to the requirement.</h2>
              <p className="section-intro">Each row is one check, with the same fields as the 3D review. Select a row to read the measured value, the required value, where the number came from, and the provision text.</p>
            </div>
            <div className="review-board" data-reveal>
              <div className="review-list" role="listbox" aria-label="Illustrative checks">
                {reviewExamples.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={item.id === selectedReview.id ? 'review-row selected' : 'review-row'}
                    onClick={() => setReviewId(item.id)}
                    aria-pressed={item.id === selectedReview.id}
                  >
                    <span className={`status-dot ${item.status}`} />
                    <span>
                      <strong>{item.part}</strong>
                      <small>{item.ruleId}</small>
                      <em>{item.statusLabel}</em>
                    </span>
                  </button>
                ))}
              </div>
              <article className="finding-card ship-result" aria-live="polite">
                <div className="finding-card-head">
                  <span className="finding-label">{selectedReview.ruleId}</span>
                  <span className={`ship-badge ${selectedReview.status}`}>{selectedReview.statusLabel}</span>
                </div>
                <p className="ship-source">{selectedReview.source} — {selectedReview.clause}</p>
                <h3>{selectedReview.part}</h3>
                <table className="ship-kv">
                  <tbody>
                    <tr><th>Measured</th><td>{selectedReview.measured}</td></tr>
                    <tr><th>Required</th><td>{selectedReview.required}</td></tr>
                  </tbody>
                </table>
                <p className="ship-expl">{selectedReview.explanation}</p>
                <p className="ship-inputs"><span>Inputs</span> {selectedReview.inputs}</p>
                <blockquote>“{selectedReview.provision}”</blockquote>
                <div className="ship-tags">
                  {selectedReview.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              </article>
            </div>
          </div>
          <div className="section-container"><p className="demo-disclaimer finding-disclaimer"><ShieldCheck size={15} /> Illustrative checks, using the review’s own fields. Rule values are not yet verified against the official text. Selecting a row does not move the model above.</p></div>
        </section>

        <section className="architecture-section section-pad" id="architecture">
          <div className="section-container architecture-layout">
            <div className="section-heading" data-reveal>
              <span className="section-kicker section-kicker-light">05 — THE PLATFORM</span>
              <h2>Separate parts, one Complee review.</h2>
              <p className="section-intro">These parts of Complee can change without rebuilding the rest. A new file reader does not require a new regulation search. A different language model does not require a new check. A local model can be used, so the design text need not be sent to an external service.</p>
            </div>
            <div className="architecture-points">
              <article data-reveal><span>01</span><h3>Design records</h3><p>Projects, revisions, parts and the file each value came from.</p></article>
              <article data-reveal><span>02</span><h3>File reading</h3><p>Documents, DXF drawings and glTF models are read into those records. A new file type is another reader.</p></article>
              <article data-reveal><span>03</span><h3>Regulation library</h3><p>Search for provisions that may apply, and keep the source text with the review.</p></article>
              <article data-reveal><span>04</span><h3>Engineering checks</h3><p>Distance, clearance and numeric comparisons run as their own checks, not inside a prompt.</p></article>
              <article data-reveal><span>05</span><h3>Language models</h3><p>The model that interprets a provision can be swapped. The readers and the checks stay.</p></article>
              <article data-reveal><span>06</span><h3>3D view</h3><p>The ship model in Complee, with the parts under review highlighted for the engineer.</p></article>
            </div>
          </div>
        </section>

        <section className="closing-section">
          <div className="closing-grid" aria-hidden="true" />
          <div className="closing-inner" data-reveal>
            <span className="section-kicker section-kicker-light">DESIGN AWARENESS, EARLIER</span>
            <h2>Better-informed design.<br /><span>Fewer unanswered questions.</span></h2>
            <p>Bring regulatory awareness into the earliest stages of ship design, where potential problems are easier to understand and resolve.</p>
          </div>
        </section>
      </main>

      {loginOpen && (
        <div className="login-overlay" onClick={() => setLoginOpen(false)}>
          <div
            className="login-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <span className="login-kicker">SIGNING IN</span>
            <h2 id="login-title">Demo session</h2>
            <p>Checking a sample engineer profile.</p>
            <div className="login-progress" aria-hidden="true"><i /></div>
            <div className="login-fields">
              <div><span>ENGINEER</span><strong>Eric Jacobsen</strong></div>
              <div><span>ROLE</span><strong>Development Engineer</strong></div>
              <div><span>PROJECT</span><strong>Concept study</strong></div>
            </div>
          </div>
        </div>
      )}
      {continuePromptOpen && !loginOpen && (
        <aside className="continue-prompt" id="login-prompt" role="status">
          <p><strong>Hey, hackathon participant.</strong> To view our solution, press Login.</p>
          <button type="button" className="continue-dismiss" onClick={() => setContinuePromptOpen(false)} aria-label="Dismiss">×</button>
        </aside>
      )}

      <footer className="site-footer">
        <div className="footer-main">
          <ProductName />
          <span className="footer-concept">HACKATHON CONCEPT</span>
          <p>Developed for the Meyer Turku challenge.<br /><span>No official endorsement is implied. R/V Taani is a challenge-provided model.</span></p>
        </div>
        <div className="footer-bottom"><span>© COMPLEE · DESIGN COMPLIANCE ASSISTANT</span><span>ILLUSTRATIVE DEMONSTRATION · ENGINEER REVIEW REQUIRED</span></div>
      </footer>
    </div>
  )
}

export default App
