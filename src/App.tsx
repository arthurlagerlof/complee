import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ArrowDown, ArrowRight, Check, ChevronDown, FileSearch, Layers3, Ship, Sparkles } from 'lucide-react'
import LandingScene from './LandingScene'
import './landing.css'

const EvidenceIntake = lazy(() => import('./EvidenceIntake'))
const AiWorkspace = lazy(() => import('./AiWorkspace'))
const FindingsWorkspace = lazy(() => import('./FindingsWorkspace'))
const workspaceFallback = <div className="workspace-loading" role="status"><span className="loading-spinner" /> Loading…</div>
const SHIPCHECK_REVIEW_URL = import.meta.env.VITE_SHIPCHECK_REVIEW_URL || '/inspection/index.html?scenario=rcrv-3d'

gsap.registerPlugin(ScrollTrigger)

const statistics = [
  {
    value: '3.0%',
    title: 'Global ship detention rate (2024)',
    description: 'Around 3% of inspected ships were detained worldwide in 2024 due to serious deficiencies, highlighting the ongoing challenge of maritime safety and regulatory compliance.',
    source: 'International Maritime Organization (IMO), 2024 Port State Control statistics.',
  },
  {
    value: '21%',
    title: 'Applications affected by approval issues',
    description: 'AMSA reported that 21% of applications in its 2023–2024 certification campaign experienced delays related to plan approval and fire-system issues, demonstrating how design compliance can become a bottleneck in the approval process.',
    source: 'Australian Maritime Safety Authority (AMSA), Survey Matters, June 2024.',
  },
  {
    value: '32%',
    title: 'Higher design and construction labour costs',
    description: 'A four-ship case study found that design rework was associated with a 32% increase in design and construction labour costs, illustrating the financial impact of identifying design problems too late.',
    source: 'Ship design and construction rework study, four-ship case study.',
  },
  {
    value: '200–1,000+',
    title: 'Drawings requiring approval',
    description: 'Depending on vessel complexity, class approval can involve hundreds or even over a thousand drawings, creating a substantial workload for engineers and reviewers.',
    source: 'International Institute of Marine Surveying, June 2025.',
  },
  {
    value: '200+ days',
    title: 'Plan approval delays',
    description: 'Some reported cases of class and flag plan approval have taken over 200 days to return with comments, highlighting the time-consuming nature of the review and revision process.',
    source: 'International Institute of Marine Surveying, June 2025.',
  },
]

function App() {
  const [route, setRoute] = useState(() => window.location.hash)
  const [loginOpen, setLoginOpen] = useState(false)
  const [headerVisible, setHeaderVisible] = useState(false)
  const [statIndex, setStatIndex] = useState(0)
  const landingRef = useRef<HTMLDivElement>(null)
  const statRef = useRef<HTMLDivElement>(null)
  const isLanding = !['#findings', '#ai-settings', '#evidence'].includes(route)

  useEffect(() => {
    const syncRoute = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', syncRoute)
    return () => window.removeEventListener('hashchange', syncRoute)
  }, [])

  useEffect(() => {
    if (!isLanding) return
    const revealHeader = () => setHeaderVisible(true)
    window.addEventListener('pointermove', revealHeader, { once: true })
    window.addEventListener('scroll', revealHeader, { once: true })
    window.addEventListener('touchstart', revealHeader, { once: true })
    window.addEventListener('keydown', revealHeader, { once: true })
    if (window.scrollY > 0) revealHeader()
    return () => {
      window.removeEventListener('pointermove', revealHeader)
      window.removeEventListener('scroll', revealHeader)
      window.removeEventListener('touchstart', revealHeader)
      window.removeEventListener('keydown', revealHeader)
    }
  }, [isLanding])

  useEffect(() => {
    if (!isLanding) return
    const timer = window.setInterval(() => setStatIndex((index) => (index + 1) % statistics.length), 5000)
    return () => window.clearInterval(timer)
  }, [isLanding])

  useEffect(() => {
    if (!isLanding || !landingRef.current) return
    const context = gsap.context(() => {
      const motion = gsap.matchMedia()
      motion.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.landing-copy > *, .landing-actions, .landing-example-card, .landing-stat', {
          opacity: 0, y: 22, duration: 1.1, stagger: 0.1, ease: 'power3.out',
        })
        gsap.utils.toArray<HTMLElement>('.landing-reveal').forEach((element) => {
          gsap.from(element, {
            opacity: 0, y: 28, duration: 1, ease: 'power3.out',
            scrollTrigger: { trigger: element, start: 'top 88%', once: true },
          })
        })
      })
      motion.add('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)', () => {
        const panels = landingRef.current?.querySelectorAll<HTMLElement>('.landing-stat, .landing-example-card')
        if (!panels) return
        const cleanups = Array.from(panels, (panel) => {
          const animation = gsap.to(panel, { scale: 1.06, duration: 0.55, ease: 'power2.out', paused: true })
          const expand = () => animation.play()
          const shrink = () => animation.reverse()
          panel.addEventListener('mouseenter', expand)
          panel.addEventListener('mouseleave', shrink)
          return () => {
            panel.removeEventListener('mouseenter', expand)
            panel.removeEventListener('mouseleave', shrink)
          }
        })
        return () => cleanups.forEach((cleanup) => cleanup())
      })
      return () => motion.revert()
    }, landingRef)
    return () => context.revert()
  }, [isLanding])

  useEffect(() => {
    if (!isLanding || !statRef.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const animation = gsap.fromTo(statRef.current, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power2.out' })
    return () => { animation.kill() }
  }, [isLanding, statIndex])

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
      setRoute('#evidence')
      window.scrollTo({ top: 0 })
    }, reducedMotion ? 900 : 3800)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.clearTimeout(timer)
    }
  }, [loginOpen])

  const backToMain = () => {
    window.location.hash = 'top'
    setRoute('#top')
    window.scrollTo({ top: 0 })
  }

  if (route === '#findings') return <Suspense fallback={workspaceFallback}><FindingsWorkspace onBack={backToMain} /></Suspense>
  if (route === '#ai-settings') return <Suspense fallback={workspaceFallback}><AiWorkspace onBack={backToMain} /></Suspense>
  if (route === '#evidence') return <Suspense fallback={workspaceFallback}><EvidenceIntake onContinue={() => window.location.assign(SHIPCHECK_REVIEW_URL)} onBack={backToMain} /></Suspense>

  return (
    <div className="landing" id="top" ref={landingRef}>
      <header className={`landing-header${headerVisible ? ' is-visible' : ''}`}>
        <div className="landing-header-inner">
          <a className="landing-brand" href="#top" aria-label="Complee home">
            <span className="landing-brand-mark"><Ship size={17} strokeWidth={1.8} /></span>
            complee<span className="landing-brand-period">.</span>
          </a>
          <nav className="landing-nav" aria-label="Main navigation" inert={!headerVisible}>
            <a className="landing-nav-link" href="#how-it-works">How it works</a>
            <button type="button" className="landing-nav-cta" onClick={() => setLoginOpen(true)}>Login <ArrowRight size={15} /></button>
          </nav>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <LandingScene />
          <div className="landing-hero-inner">
            <div className="landing-copy">
              <h1>Find compliance gaps before it's too late.</h1>
            </div>
          </div>
          <div className="landing-actions">
            <button type="button" className="landing-primary" onClick={() => setLoginOpen(true)}>Start a review <ArrowRight size={17} /></button>
            <a className="landing-secondary" href="#how-it-works">See how it works <ArrowDown size={14} /></a>
          </div>
          <div className="landing-example-card">
            <div className="landing-card-heading"><span className="landing-card-icon"><Sparkles size={14} /></span><span>EXAMPLE CHECK</span><span className="landing-card-status">REVIEW</span></div>
            <strong>Stair clear width</strong>
            <div className="landing-card-values"><span>Drawing <b>751 mm</b></span><span>Example limit <b>900 mm</b></span></div>
            <p>Below the example limit. Confirm the measurement and applicable rule.</p>
          </div>
          <div className="landing-stat">
            <div className="landing-stat-heading"><span>THE SCALE OF THE CHALLENGE</span><span>0{statIndex + 1} / 05</span></div>
            <div className="landing-stat-content" ref={statRef} aria-live="off">
              <strong>{statistics[statIndex].value}</strong><span>{statistics[statIndex].title}</span>
            </div>
            <a href="#industry-context">Explore the numbers <ArrowRight size={13} /></a>
          </div>
          <div className="landing-demo-disclaimer">Illustrative geometry and values · not a real finding</div>
        </section>

        <section className="landing-process" id="how-it-works">
          <div className="landing-process-inner">
            <div className="landing-process-title landing-reveal">
              <span className="landing-section-label">A SIMPLER WAY TO REVIEW</span>
              <h2>From design to decision.</h2>
              <p>Bring the information together, see what needs attention, and keep the engineer in control.</p>
            </div>
            <div className="landing-steps">
              <article className="landing-reveal"><span className="landing-step-number">01</span><Layers3 size={22} /><h3>Bring your design</h3><p>Add your documents, drawings or model to a review.</p></article>
              <article className="landing-reveal"><span className="landing-step-number">02</span><FileSearch size={22} /><h3>See what matters</h3><p>Explore checks, source information and gaps in the design.</p></article>
              <article className="landing-reveal"><span className="landing-step-number">03</span><Check size={22} /><h3>Make the call</h3><p>Review the evidence, confirm the inputs and decide what comes next.</p></article>
            </div>
            <p className="landing-process-note">Complee supports engineering review; it does not provide class approval or a final compliance decision.</p>
          </div>
        </section>
        <section className="landing-technical" aria-labelledby="technical-title">
          <div className="landing-technical-inner">
            <div className="landing-technical-heading landing-reveal">
              <span className="landing-technical-label">UNDER THE HOOD</span>
              <h2 id="technical-title">Separate parts, one Complee review.</h2>
              <p>From model data to an explainable finding, every step is designed to keep the engineer in control.</p>
            </div>
            <div className="landing-technical-grid">
              <article className="landing-reveal">
                <span>01 / MODEL DATA</span>
                <h3>Turn the design into reviewable elements.</h3>
                <p>Complee reads IFC, DXF and ship JSON models. Revit files are converted to IFC through Autodesk Platform Services. Imported properties and geometry provide the values used in the review; an import report identifies what is still missing.</p>
              </article>
              <article className="landing-reveal">
                <span>02 / RULE CHECKING</span>
                <h3>Apply rules, not predictions.</h3>
                <p>A deterministic checker selects applicable rules using details such as vessel type, size, area, class and construction date. It compares available values with the rule requirements. Missing inputs are marked “not enough info” rather than guessed.</p>
              </article>
              <article className="landing-reveal">
                <span>03 / TRACEABLE FINDINGS</span>
                <h3>See the evidence in context.</h3>
                <p>Findings are linked to model elements in the 3D viewer, alongside the rule, measured and required values, and their sources. Engineers can inspect results, try what-if changes, compare revisions and export reports without changing the source model.</p>
              </article>
              <article className="landing-reveal">
                <span>04 / AI ASSISTANCE</span>
                <h3>Explain and explore, with a human in charge.</h3>
                <p>Optional AI can explain findings, suggest escape routes and draft replies to class comments. Suggested routes are recomputed by the checker. AI does not decide pass or fail, and the engineer remains responsible for the review.</p>
              </article>
            </div>
            <p className="landing-technical-note landing-reveal">Bundled rule texts are paraphrases marked unverified until checked against official sources. Complee is a pre-check; class and flag retain approval authority.</p>
          </div>
        </section>
        <section className="landing-context" id="industry-context">
          <div className="landing-context-inner landing-reveal">
            <span className="landing-section-label">THE BIGGER PICTURE</span>
            <details>
              <summary><span>The scale of the ship compliance problem</span><ChevronDown size={22} /></summary>
              <div className="landing-stat-list">
                {statistics.map((stat) => (
                  <article key={stat.title}>
                    <strong>{stat.value}</strong>
                    <div><h3>{stat.title}</h3><p>{stat.description}</p><small>Source: {stat.source}</small></div>
                  </article>
                ))}
              </div>
            </details>
          </div>
        </section>
      </main>
      {loginOpen && (
        <div className="login-overlay" onClick={() => setLoginOpen(false)}>
          <div className="login-card" role="dialog" aria-modal="true" aria-labelledby="login-title" tabIndex={-1} onClick={(event) => event.stopPropagation()}>
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
      <footer className="landing-footer"><span>complee<span>.</span></span><p>Design review with an engineer in the loop.</p><small>ILLUSTRATIVE DEMONSTRATION</small></footer>
    </div>
  )
}

export default App
