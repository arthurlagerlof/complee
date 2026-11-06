import { useEffect, useRef, useState } from 'react'
import { Camera, Pause, Play, RotateCcw } from 'lucide-react'
import { inspectionPoints } from './inspectionData'

type VesselViewerProps = {
  className?: string
  initialAutoRotate?: boolean
  showMarkers?: boolean
  selectedPointId?: string
  onSelectPoint?: (id: string) => void
}

const MODEL_SRC = '/assets/models/rv-taani.glb'
const INITIAL_ORBIT = '35deg 72deg auto'

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function VesselViewer({
  className = '',
  initialAutoRotate = false,
  showMarkers = false,
  selectedPointId,
  onSelectPoint,
}: VesselViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const modelRef = useRef<HTMLElement | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [isRotating, setIsRotating] = useState(() => initialAutoRotate && !prefersReducedMotion())
  const isRotatingRef = useRef(isRotating)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let model: HTMLElement | null = null
    const handleLoad = () => {
      setLoaded(true)
      setFailed(false)
    }
    const handleError = () => {
      setFailed(true)
      setLoaded(false)
    }

    void import('@google/model-viewer').then(() => {
      if (disposed) return
      model = document.createElement('model-viewer')
      model.setAttribute('src', MODEL_SRC)
      model.setAttribute('alt', 'Interactive 3D model of the R/V Taani research vessel')
      model.setAttribute('camera-controls', '')
      model.setAttribute('camera-orbit', INITIAL_ORBIT)
      model.setAttribute('camera-target', 'auto auto auto')
      model.setAttribute('field-of-view', '30deg')
      model.setAttribute('environment-image', 'neutral')
      model.setAttribute('exposure', '0.95')
      model.setAttribute('shadow-intensity', '0.75')
      model.setAttribute('interaction-prompt', 'none')
      model.setAttribute('touch-action', 'pan-y')
      model.setAttribute('rotation-per-second', '2deg')
      model.setAttribute('loading', className.includes('inspection') ? 'lazy' : 'eager')
      if (isRotatingRef.current && !prefersReducedMotion()) model.setAttribute('auto-rotate', '')
      model.className = 'vessel-model'
      modelRef.current = model
      model.addEventListener('load', handleLoad)
      model.addEventListener('error', handleError)
      host.prepend(model)
    }).catch(() => {
      if (!disposed) setFailed(true)
    })

    return () => {
      disposed = true
      model?.removeEventListener('load', handleLoad)
      model?.removeEventListener('error', handleError)
      model?.remove()
      modelRef.current = null
    }
  }, [className])

  useEffect(() => {
    isRotatingRef.current = isRotating
    const model = modelRef.current
    if (!model) return
    if (isRotating) model.setAttribute('auto-rotate', '')
    else model.removeAttribute('auto-rotate')
  }, [isRotating])

  const resetCamera = () => {
    const model = modelRef.current
    if (!model) return
    model.setAttribute('camera-orbit', INITIAL_ORBIT)
    model.setAttribute('camera-target', 'auto auto auto')
  }

  return (
    <div className={`vessel-canvas ${className}`}>
      <div className="vessel-stage" ref={hostRef}>
        {!loaded && !failed && <div className="model-loading" role="status"><span className="loading-spinner" /> Loading vessel model…</div>}
        {failed && (
          <div className="model-fallback" role="alert">
            <Camera size={24} />
            <strong>Vessel model unavailable</strong>
            <span>The interactive model could not be loaded. Please try again later.</span>
          </div>
        )}
        {showMarkers && !failed && inspectionPoints.map((point) => (
          <button
            key={point.id}
            type="button"
            className={`vessel-marker${point.id === selectedPointId ? ' active' : ''}`}
            style={point.markerPosition}
            onClick={() => onSelectPoint?.(point.id)}
            aria-label={`Inspection point ${point.number}: ${point.shortLabel}`}
            aria-pressed={point.id === selectedPointId}
            title={`Illustrative inspection point ${point.number}`}
          >
            {point.number}
          </button>
        ))}
      </div>
      <div className="viewer-controls">
        <button type="button" onClick={resetCamera} aria-label="Reset vessel camera"><RotateCcw size={14} /><span>Reset view</span></button>
        <button
          type="button"
          onClick={() => setIsRotating((rotating) => !rotating)}
          aria-label={isRotating ? 'Stop vessel auto-rotation' : 'Start vessel auto-rotation'}
          aria-pressed={isRotating}
        >
          {isRotating ? <Pause size={14} /> : <Play size={14} />}
          <span>{isRotating ? 'Pause rotation' : 'Auto-rotate'}</span>
        </button>
      </div>
    </div>
  )
}
