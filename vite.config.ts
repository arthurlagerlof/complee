import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createEvidenceProvider } from './src/evidence-provider.mjs'
import { reviewDocumentEvidence } from './src/document-review.mjs'

const evidenceProvider = await createEvidenceProvider({ kind: process.env.EVIDENCE_PROVIDER || 'sinceai' })

function evidenceApi() {
  return {
    name: 'complee-local-evidence-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost')
        if (!url.pathname.startsWith('/api/evidence/')) return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        try {
          if (req.method === 'GET' && url.pathname === '/api/evidence/provider') {
            res.end(JSON.stringify({ id: evidenceProvider.id, metadata: evidenceProvider.metadata || null }))
            return
          }
          if (req.method === 'GET' && url.pathname === '/api/evidence/search') {
            const result = await evidenceProvider.search(url.searchParams.get('q') || '', { limit: url.searchParams.get('limit') || 8 })
            res.end(JSON.stringify(result))
            return
          }
          if (req.method === 'POST' && url.pathname === '/api/evidence/review') {
            let raw = ''
            for await (const chunk of req) {
              raw += chunk
              if (Buffer.byteLength(raw) > 12_000_000) throw Object.assign(new Error('Request too large'), { status: 413 })
            }
            const body = JSON.parse(raw || '{}')
            const result = await reviewDocumentEvidence({ ...body, provider: evidenceProvider })
            res.end(JSON.stringify(result))
            return
          }
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Evidence route not found' }))
        } catch (error) {
          res.statusCode = error.status || 500
          res.end(JSON.stringify({ error: error.message || 'Evidence request failed' }))
        }
      })
    },
  }
}

// Two pages on the Vite dev server:
//   /landing      the Complee landing page (this React app); / redirects here
//   /inspection/  ShipCheck (shipcheck/), served by its own request handler: checker, 3D viewer, evidence page
// ShipCheck is imported at runtime (not bundled into this config), so it finds its own files and its APS keys
// in shipcheck/3D_Since_AI/.env. Its pages use relative URLs, so they work under this prefix and on port 8080.
function shipcheckPages() {
  return {
    name: 'complee-shipcheck-pages',
    async configureServer(server) {
      const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'shipcheck/server.mjs')
      const { handleRequest } = await import(pathToFileURL(entry).href)
      server.middlewares.use((req, res, next) => {
        const url = req.url || '/'
        const [pathname, query = ''] = url.split('?')
        const q = query ? `?${query}` : ''
        if (pathname === '/' || pathname === '/index.html') {
          res.statusCode = 302
          res.setHeader('Location', `/landing${q}`)
          return res.end()
        }
        if (pathname === '/inspection') {
          res.statusCode = 302
          res.setHeader('Location', `/inspection/${q}`)
          return res.end()
        }
        if (url.startsWith('/inspection/')) {
          req.url = url.slice('/inspection'.length)
          return handleRequest(req, res)
        }
        if (pathname === '/landing' || pathname === '/landing/') req.url = `/index.html${q}`
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [evidenceApi(), shipcheckPages(), react()],
})
