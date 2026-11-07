import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RotateCcw, Pause, Play } from 'lucide-react'

const MODEL_SRC = '/assets/models/rv-taani.glb'

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export default function TaaniModelPreview() {
  const host = useRef<HTMLDivElement>(null)
  const controls = useRef<OrbitControls | null>(null)
  const camera = useRef<THREE.PerspectiveCamera | null>(null)
  const defaultCamera = useRef(new THREE.Vector3())
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [rotating, setRotating] = useState(() => !prefersReducedMotion())

  useEffect(() => {
    const element = host.current
    if (!element) return

    let disposed = false
    let renderer: THREE.WebGLRenderer | null = null
    let resizeObserver: ResizeObserver | null = null

    try {
      const scene = new THREE.Scene()
      const viewCamera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000)
      camera.current = viewCamera

      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.setClearColor(0x102b45, 0)
      element.appendChild(renderer.domElement)

      scene.add(new THREE.HemisphereLight(0xe8f2f5, 0x203447, 2.1))
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.4)
      keyLight.position.set(4, 8, 6)
      scene.add(keyLight)
      const fillLight = new THREE.DirectionalLight(0x9bd6d1, 1.1)
      fillLight.position.set(-6, 3, -5)
      scene.add(fillLight)

      const orbit = new OrbitControls(viewCamera, renderer.domElement)
      orbit.enableDamping = true
      orbit.dampingFactor = 0.08
      orbit.autoRotate = !prefersReducedMotion()
      orbit.autoRotateSpeed = 0.55
      orbit.enablePan = false
      controls.current = orbit

      const resize = () => {
        if (!renderer || disposed) return
        const width = Math.max(element.clientWidth, 1)
        const height = Math.max(element.clientHeight, 1)
        renderer.setSize(width, height, false)
        viewCamera.aspect = width / height
        viewCamera.updateProjectionMatrix()
      }
      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(element)
      resize()

      renderer.setAnimationLoop(() => {
        if (disposed || !renderer) return
        orbit.update()
        renderer.render(scene, viewCamera)
      })

      new GLTFLoader().load(MODEL_SRC, (gltf) => {
        if (disposed) return
        const model = gltf.scene
        model.updateMatrixWorld(true)
        const bounds = new THREE.Box3().setFromObject(model)
        const center = bounds.getCenter(new THREE.Vector3())
        const size = bounds.getSize(new THREE.Vector3())
        const maxDimension = Math.max(size.x, size.y, size.z, 1)
        model.position.sub(center)
        scene.add(model)

        const distance = (maxDimension * 0.62) / Math.tan(THREE.MathUtils.degToRad(viewCamera.fov / 2))
        const cameraPosition = new THREE.Vector3(distance * 0.88, distance * 0.48, distance)
        defaultCamera.current.copy(cameraPosition)
        viewCamera.position.copy(cameraPosition)
        viewCamera.near = Math.max(maxDimension / 1000, 0.01)
        viewCamera.far = maxDimension * 100
        viewCamera.updateProjectionMatrix()
        orbit.target.set(0, 0, 0)
        orbit.minDistance = maxDimension * 0.65
        orbit.maxDistance = maxDimension * 6
        orbit.update()
        setLoading(false)
      }, undefined, () => {
        if (disposed) return
        setFailed(true)
        setLoading(false)
      })
    } catch {
      setFailed(true)
      setLoading(false)
    }

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      controls.current?.dispose()
      controls.current = null
      renderer?.setAnimationLoop(null)
      renderer?.dispose()
      renderer?.domElement.remove()
      camera.current = null
    }
  }, [])

  useEffect(() => {
    if (controls.current) controls.current.autoRotate = rotating && !prefersReducedMotion()
  }, [rotating])

  const resetView = () => {
    const viewCamera = camera.current
    const orbit = controls.current
    if (!viewCamera || !orbit) return
    viewCamera.position.copy(defaultCamera.current)
    orbit.target.set(0, 0, 0)
    orbit.update()
  }

  return (
    <div className="taani-preview">
      <div ref={host} className="taani-preview-canvas" aria-label="Interactive 3D model preview of the R/V Taani">
        {loading && <div className="taani-preview-state" role="status"><span className="loading-spinner" />Loading R/V Taani model…</div>}
        {failed && <div className="taani-preview-state" role="alert"><strong>Model preview unavailable</strong><span>The homepage vessel model could not be loaded.</span></div>}
      </div>
      <div className="viewer-controls taani-preview-controls">
        <button type="button" onClick={resetView} aria-label="Reset Taani model view"><RotateCcw size={13} /><span>Reset view</span></button>
        <button type="button" onClick={() => setRotating((value) => !value)} aria-label={rotating ? 'Pause Taani model rotation' : 'Start Taani model rotation'} aria-pressed={rotating}>
          {rotating ? <Pause size={13} /> : <Play size={13} />}<span>{rotating ? 'Pause rotation' : 'Auto-rotate'}</span>
        </button>
      </div>
      <span className="taani-preview-hint">Drag to orbit · scroll to zoom</span>
    </div>
  )
}
