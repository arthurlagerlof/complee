import { useEffect, useRef, useState } from 'react'
import { Map, RotateCcw } from 'lucide-react'
import { createViewer, type ShipcheckViewer } from './shipcheck-viewer3d.js'
import modelData from './data/rcrv-layout.json'

const rawModel = modelData as {
  name: string
  units: string
  source?: string
  decks: Array<Record<string, any>>
  elements: Array<Record<string, any>>
}

const model = {
  ...rawModel,
  __normalized: true,
  decks: rawModel.decks.map((deck) => ({
    ...deck,
    elevation_mm: deck.elevation ?? 0,
    outline_mm: deck.outline ?? [],
  })),
  elements: rawModel.elements.map((element) => ({
    ...element,
    deck: element.deck ?? rawModel.decks[0]?.id,
    geom_mm: element.geom ?? null,
  })),
}

export default function RcrvModelPreview() {
  const host = useRef<HTMLDivElement>(null)
  const viewer = useRef<ShipcheckViewer | null>(null)
  const [planView, setPlanView] = useState(false)

  useEffect(() => {
    if (!host.current) return
    const nextViewer = createViewer(host.current)
    viewer.current = nextViewer
    nextViewer.build(model, { elements: {} })
    return () => {
      nextViewer.dispose()
      viewer.current = null
    }
  }, [])

  const togglePlan = () => {
    const next = !planView
    setPlanView(next)
    viewer.current?.setPlan(next)
  }

  return (
    <div className="rcrv-preview-wrap">
      <div className="rcrv-preview-canvas" ref={host} aria-label="Interactive reconstructed 3D model of the OSU RCRV" />
      <div className="viewer-controls rcrv-preview-controls">
        <button type="button" onClick={() => viewer.current?.overview()} aria-label="Reset model view"><RotateCcw size={13} /><span>Reset view</span></button>
        <button type="button" onClick={togglePlan} aria-label={planView ? 'Switch to 3D view' : 'Switch to plan view'} aria-pressed={planView}><Map size={13} /><span>{planView ? '3D view' : 'Plan view'}</span></button>
      </div>
      <span className="rcrv-preview-note">Drag to orbit · scroll to zoom</span>
    </div>
  )
}
