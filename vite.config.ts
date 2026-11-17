import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_BASE = (process.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

// Landing page on the Vite dev server (/landing; / redirects here).
// /inspection and /api requests are proxied to the single unified FastAPI backend.
function landingRoutes() {
  return {
    name: 'complee-landing-routes',
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
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
        if (pathname === '/landing' || pathname === '/landing/') req.url = `/index.html${q}`
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [landingRoutes(), react()],
  server: {
    proxy: {
      '/api': {
        target: API_BASE,
        changeOrigin: true,
      },
      '/inspection/': {
        target: API_BASE,
        changeOrigin: true,
      },
    },
  },
})
