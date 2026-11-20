import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'

export default function LandingScene() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let cleanup = () => {}

    void import('three').then((THREE) => {
      if (disposed) return

      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      host.appendChild(renderer.domElement)

      const scene = new THREE.Scene()
      const camera = new THREE.OrthographicCamera(-5, 5, 4, -4, 0.1, 100)
      camera.position.set(8, 8, 10)
      camera.lookAt(0, 0, 0)
      camera.updateMatrixWorld()
      scene.add(new THREE.HemisphereLight(0xf3efff, 0x303d68, 2.2))
      const sun = new THREE.DirectionalLight(0xffffff, 2)
      sun.position.set(-4, 10, 5)
      scene.add(sun)

      const model = new THREE.Group()
      model.rotation.y = Math.PI - 0.15
      scene.add(model)
      const material = (color: number, extra: Partial<import('three').MeshStandardMaterialParameters> = {}) =>
        new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra })
      const hullMat = material(0x66789d)
      const deckMat = material(0xbac7df)
      const wallMat = material(0xe3e9f5)
      const darkMat = material(0x53668d)
      const stairMat = material(0xf0a875)
      const accentMat = material(0xa58ad8)
      const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: import('three').Material) => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
        mesh.position.set(x, y, z)
        model.add(mesh)
        return mesh
      }

      const outline = new THREE.Shape()
      outline.moveTo(-3.5, -1.35)
      outline.lineTo(2.5, -1.35)
      outline.quadraticCurveTo(3.35, -1.1, 4, 0)
      outline.quadraticCurveTo(3.35, 1.1, 2.5, 1.35)
      outline.lineTo(-3.5, 1.35)
      outline.lineTo(-3.8, 0.95)
      outline.lineTo(-3.8, -0.95)
      outline.closePath()
      const hull = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: 0.3, bevelEnabled: false, curveSegments: 12 }), hullMat)
      hull.rotation.x = -Math.PI / 2
      hull.position.y = -0.3
      model.add(hull)
      const deck = new THREE.Mesh(new THREE.ShapeGeometry(outline, 12), deckMat)
      deck.rotation.x = -Math.PI / 2
      deck.position.y = 0.008
      model.add(deck)

      box(5.2, 0.12, 0.07, -0.6, 0.08, -1.05, darkMat)
      box(5.2, 0.12, 0.07, -0.6, 0.08, 1.05, darkMat)
      box(3.7, 0.85, 0.075, -1.35, 0.43, -0.52, wallMat)
      box(2.1, 0.85, 0.075, -1.85, 0.43, 0.55, wallMat)
      box(0.075, 0.85, 1.15, -3.15, 0.43, 0, wallMat)
      box(0.075, 0.85, 0.75, -0.75, 0.43, -0.15, wallMat)
      box(0.075, 0.85, 0.6, 0.5, 0.43, -0.78, wallMat)
      box(0.8, 0.1, 0.35, -2.35, 0.12, -0.12, accentMat)
      box(0.55, 0.1, 0.42, -1.5, 0.12, 0.08, accentMat)
      box(0.65, 0.08, 0.6, 1.3, 0.06, -0.55, darkMat)
      for (let i = 0; i < 6; i++) box(0.19, 0.09 + i * 0.08, 0.72, 0.15 + i * 0.19, 0.045 + i * 0.04, 0.42, stairMat)

      const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
      const entrance = { progress: motion.matches ? 1 : 0 }
      const screenRight = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const updateEntrance = () => {
        const remaining = 1 - entrance.progress
        model.position.copy(screenRight).multiplyScalar((camera.right - camera.left) * 0.3 * remaining)
        model.scale.setScalar(0.65 + 0.35 * entrance.progress)
        renderer.domElement.style.opacity = String(entrance.progress)
      }

      const resize = () => {
        const width = host.clientWidth
        const height = host.clientHeight
        if (!width || !height) return
        const aspect = width / height
        const halfHeight = Math.max(3.1, (width > 900 ? 4.2 : 4.6) / aspect)
        const halfWidth = halfHeight * aspect
        const centerX = width > 900 ? -halfWidth * 0.36 : 0
        const centerY = width > 900 ? 0.7 : 0
        camera.left = centerX - halfWidth
        camera.right = centerX + halfWidth
        camera.top = centerY + halfHeight
        camera.bottom = centerY - halfHeight
        camera.updateProjectionMatrix()
        updateEntrance()
        renderer.setSize(width, height, false)
        renderer.render(scene, camera)
      }
      const observer = new ResizeObserver(resize)
      observer.observe(host)
      resize()
      setState('ready')

      let entranceTween: gsap.core.Tween | undefined
      if (!motion.matches) {
        entranceTween = gsap.to(entrance, { progress: 1, duration: 1.8, ease: 'power2.out', onUpdate: updateEntrance })
      }
      let frame = 0
      let last = 0
      const animate = (time: number) => {
        if (last && entrance.progress === 1) model.rotation.y += Math.min(time - last, 50) * 0.00008
        last = time
        renderer.render(scene, camera)
        frame = requestAnimationFrame(animate)
      }
      const updateMotion = () => {
        cancelAnimationFrame(frame)
        last = 0
        if (!motion.matches) frame = requestAnimationFrame(animate)
        else {
          entranceTween?.kill()
          entrance.progress = 1
          updateEntrance()
          renderer.render(scene, camera)
        }
      }
      motion.addEventListener('change', updateMotion)
      updateMotion()
      cleanup = () => {
        cancelAnimationFrame(frame)
        entranceTween?.kill()
        motion.removeEventListener('change', updateMotion)
        observer.disconnect()
        const geometries = new Set<import('three').BufferGeometry>()
        const materials = new Set<import('three').Material>()
        model.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            geometries.add(object.geometry)
            for (const mat of Array.isArray(object.material) ? object.material : [object.material]) materials.add(mat)
          }
        })
        geometries.forEach((geometry) => geometry.dispose())
        materials.forEach((mat) => mat.dispose())
        renderer.dispose()
        renderer.domElement.remove()
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        console.error('Landing example could not be rendered:', error)
        setState('unavailable')
      }
    })

    return () => { disposed = true; cleanup() }
  }, [])

  return (
    <div className="landing-scene" ref={hostRef} data-scene-state={state} role="img" aria-label="Illustrative ship deck model with an orange stair under review">
      {state === 'loading' && <span className="landing-scene-message">Preparing the example…</span>}
      {state === 'unavailable' && <span className="landing-scene-message">3D example unavailable in this browser.</span>}
    </div>
  )
}
