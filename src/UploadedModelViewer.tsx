import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { X } from 'lucide-react'

// Viewer for a design model the engineer uploaded (GLB / self-contained glTF), separate from the streamed reference
// model. It highlights the glTF nodes a component's geometry reference points to (node indices from the parser).
// Draws only when something changes (camera, resize, load), accepts meshopt-compressed files, and releases every
// geometry, material and the GPU context when closed.
type Props = { url: string; filename: string; highlight: number[]; label?: string; onClose: () => void }

export default function UploadedModelViewer({ url, filename, highlight, label, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Loading model…')
  const highlightKey = highlight.join(',')

  useEffect(() => {
    const element = host.current
    if (!element) return
    const wanted = new Set(highlightKey ? highlightKey.split(',').map(Number) : [])
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(element.clientWidth, element.clientHeight)
    element.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#eef2ef')
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(5, 10, 7)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(45, element.clientWidth / Math.max(element.clientHeight, 1), 0.01, 1e7)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    let disposed = false
    let dirty = true
    let frame = 0
    // Render on demand: a frame is drawn only after the camera, the size or the model changed. Damping keeps
    // requesting frames while the controls are still moving.
    const invalidate = () => { dirty = true }
    controls.addEventListener('change', invalidate)
    const loop = () => {
      if (disposed) return
      frame = requestAnimationFrame(loop)
      const moving = controls.update()
      if (!dirty && !moving) return
      dirty = false
      renderer.render(scene, camera)
    }
    frame = requestAnimationFrame(loop)
    const materials: THREE.Material[] = []
    const accent = new THREE.MeshStandardMaterial({ color: '#e58b50', emissive: '#6b2a08', roughness: 0.5 })
    const ghost = new THREE.MeshStandardMaterial({ color: '#9fb0ad', transparent: true, opacity: 0.16, depthWrite: false })
    materials.push(accent, ghost)
    let loaded: THREE.Group | null = null

    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    loader.load(url, (gltf) => {
      if (disposed) {
        gltf.scene.traverse((object) => { (object as THREE.Mesh).geometry?.dispose() })
        return
      }
      const associations = gltf.parser.associations as Map<THREE.Object3D, { nodes?: number }>
      const target = new THREE.Box3()
      let hits = 0
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        // The file's own materials are replaced by the two viewer materials: release them right away.
        for (const material of ([] as THREE.Material[]).concat(mesh.material)) material.dispose()
        if (!wanted.size) { mesh.material = ghost; return }
        let current: THREE.Object3D | null = object
        let selected = false
        while (current) {
          const node = associations.get(current)?.nodes
          if (node !== undefined && wanted.has(node)) { selected = true; break }
          current = current.parent
        }
        mesh.material = selected ? accent : ghost
        if (selected) { hits += 1; target.expandByObject(mesh) }
      })
      loaded = gltf.scene
      scene.add(gltf.scene)
      const frameBox = hits ? target : new THREE.Box3().setFromObject(gltf.scene)
      const size = frameBox.getSize(new THREE.Vector3()).length() || 1
      const center = frameBox.getCenter(new THREE.Vector3())
      camera.position.copy(center).add(new THREE.Vector3(size * 0.9, size * 0.6, size * 0.9))
      // Depth range from the model's extent: a far/near ratio around 1e4 keeps the depth buffer precise.
      camera.near = Math.max(size / 500, 1e-4)
      camera.far = size * 20
      camera.updateProjectionMatrix()
      controls.target.copy(center)
      controls.update()
      invalidate()
      setStatus(!wanted.size ? '' : hits ? `${label ? `${label}: ` : ''}${hits} mesh${hits === 1 ? '' : 'es'} highlighted` : 'The referenced nodes are not in this file.')
    }, undefined, (error) => {
      const reason = error instanceof Error ? error.message : 'unknown error'
      setStatus(`Could not load the model (${reason}). glTF files with external buffers can only be inspected through their parsed data.`)
    })

    const resize = new ResizeObserver(() => {
      renderer.setSize(element.clientWidth, element.clientHeight)
      camera.aspect = element.clientWidth / Math.max(element.clientHeight, 1)
      camera.updateProjectionMatrix()
      invalidate()
    })
    resize.observe(element)
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      controls.removeEventListener('change', invalidate)
      controls.dispose()
      loaded?.traverse((object) => { (object as THREE.Mesh).geometry?.dispose() })
      materials.forEach((material) => material.dispose())
      renderer.dispose()
      renderer.forceContextLoss()
      element.removeChild(renderer.domElement)
    }
  }, [url, highlightKey, label])

  return <div className="findings-viewer" role="dialog" aria-label={`Uploaded model ${filename}`}>
    <div className="findings-viewer-head"><b>{filename}</b><span>{status}</span>
      <button type="button" onClick={onClose} aria-label="Close the model viewer"><X size={14} /></button></div>
    <div ref={host} className="findings-viewer-canvas" />
  </div>
}
