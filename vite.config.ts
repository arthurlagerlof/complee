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

export default defineConfig({
  plugins: [evidenceApi(), react()],
})
