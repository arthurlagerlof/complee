import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
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
import { inspectionPoints } from './inspectionData'
import VesselViewer from './VesselViewer'
import EvidenceIntake from './EvidenceIntake'

gsap.registerPlugin(ScrollTrigger)

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
  const [menuOpen, setMenuOpen] = useState(false)
  const [showConcept, setShowConcept] = useState(false)
  const [evidenceCount, setEvidenceCount] = useState(0)
  const selectedPoint = inspectionPoints.find((point) => point.id === selectedId) ?? inspectionPoints[0]

  useEffect(() => {
    if (!showConcept) return
    try { setEvidenceCount(JSON.parse(sessionStorage.getItem('compleeEvidenceFiles') || '[]').length) } catch { setEvidenceCount(0) }
    requestAnimationFrame(() => document.querySelector('#inspection')?.scrollIntoView({ behavior: 'smooth' }))
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
  }, [showConcept])

  const closeMenu = () => setMenuOpen(false)
  if (!showConcept) return <EvidenceIntake onContinue={() => setShowConcept(true)} />

  return (
    <div ref={root} id="top">
      <header className="site-header">
        <div className="header-inner">
          <ProductName />
          <nav className="desktop-nav" aria-label="Main navigation">
            <a href="#challenge">The challenge</a>
            <a href="#inspection">Vessel inspection</a>
            <a href="#workflow">How it works</a>
            <a href="#architecture">Deployment</a>
          </nav>
          <a className="nav-cta" href="/">Add evidence <ArrowUpRight size={14} /></a>
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
        <nav id="mobile-navigation" className={`mobile-nav${menuOpen ? ' menu-open' : ''}`} aria-label="Mobile navigation" aria-hidden={!menuOpen}>
          <a href="#challenge" onClick={closeMenu}>The challenge <ArrowRight size={16} /></a>
          <a href="#inspection" onClick={closeMenu}>Vessel inspection <ArrowRight size={16} /></a>
          <a href="#workflow" onClick={closeMenu}>How it works <ArrowRight size={16} /></a>
          <a href="#architecture" onClick={closeMenu}>Deployment <ArrowRight size={16} /></a>
        </nav>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-grid" aria-hidden="true" />
          <div className="hero-wrap">
            <div className="hero-copy">
              <span className="eyebrow"><span className="eyebrow-dot" /> EARLIER DESIGN. CLEARER DECISIONS.</span>
              <h1>Design with compliance in mind. <span>From the very beginning.</span></h1>
              <p className="hero-description">
                An AI-assisted engineering tool that connects ship design information with applicable regulations, helping engineers identify potential compliance gaps during the earliest stages of design.
              </p>
              <div className="hero-actions">
                <a className="button-primary" href="#inspection">Explore the vessel <ArrowRight size={16} /></a>
                <a className="text-link" href="#workflow">How it works <ArrowDown size={14} /></a>
              </div>
              <div className="hero-note"><ShieldCheck size={16} /><span>Engineer-led review. <strong>Not automated certification.</strong></span></div>
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
            <div className="timing-comparison" data-reveal>
              <div className="timing-stage early-stage"><span>EARLY DESIGN</span><strong>Easier to understand and correct</strong><span className="stage-line"><i /></span></div>
              <ArrowRight className="timing-arrow" size={19} />
              <div className="timing-stage late-stage"><span>CONSTRUCTION</span><strong>Changes can become significantly more expensive</strong><span className="stage-line"><i /></span></div>
            </div>
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
              <h2>From design information to actionable compliance insight.</h2>
              <p className="section-intro">A traceable self-check to help engineers understand what may apply, what is missing and what to review next.</p>
            </div>
            <div className="process-steps">
              <article className="process-step" data-reveal><span className="process-number">01</span><span className="process-icon"><FileText size={19} /></span><h3>Understand the design</h3><p>Engineers provide initial design information, documents and relevant vessel context.</p></article>
              <span className="process-connector" aria-hidden="true" />
              <article className="process-step" data-reveal><span className="process-number">02</span><span className="process-icon"><FileCheck2 size={19} /></span><h3>Identify applicable requirements</h3><p>Search provided rule documents for potentially relevant requirements.</p></article>
              <span className="process-connector" aria-hidden="true" />
              <article className="process-step" data-reveal><span className="process-number">03</span><span className="process-icon"><CircleAlert size={19} /></span><h3>Perform a self-check</h3><p>Compare design information to find potential issues, missing evidence and uncertainties.</p></article>
              <span className="process-connector" aria-hidden="true" />
              <article className="process-step" data-reveal><span className="process-number">04</span><span className="process-icon"><Check size={19} /></span><h3>Review and resolve</h3><p>Engineers inspect traceable findings, provide information and confirm assessments.</p></article>
            </div>
            <div className="process-note"><span className="note-line" /> A decision-support concept. Engineers remain responsible for review and confirmation.</div>
          </div>
        </section>

        <section className="finding-section section-pad">
          <div className="section-container finding-layout">
            <div className="section-heading" data-reveal>
              <span className="section-kicker">04 — TRACEABLE FINDINGS</span>
              <h2>Not just a warning. Understand why.</h2>
              <p className="section-intro">A useful finding connects a design observation to its source, supporting evidence and a clear next step—without hiding uncertainty.</p>
            </div>
            <article className="finding-card" data-reveal>
              <div className="finding-card-head"><span className="finding-label"><CircleAlert size={14} /> ILLUSTRATIVE FINDING</span><span className="review-state">ENGINEER REVIEW · PENDING</span></div>
              <h3>Ventilation arrangement</h3>
              <div className="finding-reference"><span>REQUIREMENT ID</span><strong>DEMO-VA-02</strong><span>SOURCE REFERENCE</span><strong>Example rule source · paragraph to verify</strong></div>
              <div className="finding-observation"><span>DESIGN OBSERVATION</span><p>The available design information does not fully describe the ventilation arrangement.</p></div>
              <div className="finding-reason"><span>WHY THIS NEEDS REVIEW</span><p>Applicable requirements depend on the relevant spaces and systems. The current example does not include enough design detail to assess them.</p></div>
              <div className="finding-bottom">
                <div><span>SUPPORTING EVIDENCE</span><p>Ventilation drawings or design specifications required.</p></div>
                <div><span>NEXT ACTION</span><p>Provide the ventilation arrangement for assessment.</p></div>
              </div>
              <div className="finding-source-note"><FileText size={14} /> Reference shown as a placeholder; verify the governing source and paragraph with an engineer.</div>
            </article>
          </div>
          <div className="section-container"><p className="demo-disclaimer finding-disclaimer"><ShieldCheck size={15} /> Illustrative example only—not a verified rule interpretation or finding about R/V Taani.</p></div>
        </section>

        <section className="architecture-section section-pad" id="architecture">
          <div className="section-container architecture-layout">
            <div className="section-heading" data-reveal>
              <span className="section-kicker section-kicker-light">05 — PROPOSED ARCHITECTURE</span>
              <h2>Your design data stays under your control.</h2>
              <p className="section-intro">The concept is designed around local-first deployment for engineering environments—not a claim of an already certified or fully deployed enterprise solution.</p>
            </div>
            <div className="architecture-points">
              <article data-reveal><span>01</span><h3>Local infrastructure</h3><p>Designed to run within an organisation's own environment.</p></article>
              <article data-reveal><span>02</span><h3>Controlled design data</h3><p>Design documents and models need not be sent to external AI services.</p></article>
              <article data-reveal><span>03</span><h3>Adaptable AI choices</h3><p>Local AI models can be used, with architecture adapted to organisational IT needs.</p></article>
            </div>
          </div>
        </section>

        <section className="closing-section">
          <div className="closing-grid" aria-hidden="true" />
          <div className="closing-inner" data-reveal>
            <span className="section-kicker section-kicker-light">DESIGN AWARENESS, EARLIER</span>
            <h2>Better-informed design.<br /><span>Fewer unanswered questions.</span></h2>
            <p>Bring regulatory awareness into the earliest stages of ship design, where potential problems are easier to understand and resolve.</p>
            <a href="#inspection" className="button-primary">Explore the vessel inspection <ArrowRight size={16} /></a>
          </div>
        </section>
      </main>

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
