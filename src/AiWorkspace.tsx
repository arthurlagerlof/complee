import { useEffect, useState } from 'react'
import { ArrowLeft, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

type BuiltInProvider = {
  id: 'ollama' | 'gemini'
  name: string
  provider_type: string
  endpoint: string | null
  configured: boolean
  models: string[]
  available_models?: string[]
  connection_status?: 'connected' | 'failed'
  last_tested_at?: string | null
  last_successful_test_at?: string | null
  missing_models?: string[]
  error?: string | null
}

async function loadProviders(): Promise<BuiltInProvider[]> {
  const response = await fetch(`${API_BASE}/api/v1/ai/built-in-providers`)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error?.message || 'Could not load built-in AI providers.')
  return body as BuiltInProvider[]
}

function AiWorkspace({ onBack }: { onBack: () => void }) {
  const [providers, setProviders] = useState<BuiltInProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<string | null>(null)
  const [error, setError] = useState('')

  async function refresh() {
    setError('')
    try {
      setProviders(await loadProviders())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load built-in AI providers.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function testConnection(provider: BuiltInProvider) {
    setError('')
    setTesting(provider.id)
    try {
      const response = await fetch(`${API_BASE}/api/v1/ai/built-in-providers/${provider.id}/test`, { method: 'POST' })
      if (!response.ok) {
        await loadProviders().then(setProviders)
        const body = await response.json().catch(() => null)
        throw new Error(body?.error?.message || `Could not connect to ${provider.name}.`)
      }
      const tested = await response.json() as BuiltInProvider
      setProviders((current) => current.map((item) => item.id === tested.id ? tested : item))
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : `Could not connect to ${provider.name}.`)
    } finally {
      setTesting(null)
    }
  }

  return (
    <main className="ai-workspace">
      <header className="ai-topbar">
        <button type="button" className="ai-back" onClick={onBack}><ArrowLeft size={16} /> Back to Complee</button>
        <a className="brand" href="#ai-settings"><span className="brand-mark"><ShieldCheck size={16} /></span>Complee <span className="ai-topbar-label">AI PROVIDERS</span></a>
        <span className="ai-local-label">Backend environment managed</span>
      </header>
      <div className="ai-content">
        <div className="ai-heading">
          <div>
            <span className="section-kicker">SETTINGS</span>
            <h1>AI Providers</h1>
            <p>Built-in inference providers configured by your backend administrator.</p>
          </div>
        </div>
        {error && <div className="ai-message ai-error" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
        <section className="ai-panel ai-builtins-panel" aria-labelledby="ai-builtins-heading">
          <div className="ai-panel-heading">
            <div><span className="ai-index">01 / BUILT-IN PROVIDERS</span><h2 id="ai-builtins-heading">Built-in providers</h2></div>
            <button type="button" className="ai-button" onClick={() => void refresh()} disabled={loading || testing !== null}>
              <RefreshCw size={14} /> Refresh status
            </button>
          </div>
          {loading ? <div className="ai-loading"><LoaderCircle className="ai-spin" size={20} /> Loading configured providers…</div> : (
            <div className="ai-builtin-list">
              {providers.map((provider) => {
                const status = !provider.configured
                  ? 'Not configured'
                  : provider.connection_status === 'connected'
                    ? 'Connected'
                    : provider.connection_status === 'failed'
                      ? 'Connection failed'
                      : 'Not tested'
                const statusClass = provider.connection_status === 'connected'
                  ? 'is-good'
                  : provider.connection_status === 'failed'
                    ? 'is-bad'
                    : ''
                return (
                  <article className="ai-builtin-card" key={provider.id}>
                    <div className="ai-provider-title">
                      <div><h3>{provider.name}</h3><span>{provider.provider_type === 'ollama' ? 'Local inference server' : 'Google Gemini cloud API'}</span></div>
                      <span className={`ai-status ${statusClass}`}>{status}</span>
                    </div>
                    <dl className="ai-builtin-details">
                      <div><dt>Endpoint</dt><dd>{provider.endpoint || 'Not set in backend environment'}</dd></div>
                      <div><dt>Configured models</dt><dd>{provider.models.length ? provider.models.join(', ') : 'None specified'}</dd></div>
                      {provider.available_models && <div><dt>Available models</dt><dd>{provider.available_models.length ? provider.available_models.join(', ') : 'No models discovered'}</dd></div>}
                      <div><dt>Credentials</dt><dd>Managed by backend environment; not visible or editable here</dd></div>
                      {provider.last_successful_test_at && <div><dt>Last successful test</dt><dd>{new Date(provider.last_successful_test_at).toLocaleString()}</dd></div>}
                      {provider.last_tested_at && provider.connection_status === 'failed' && <div><dt>Last test</dt><dd>{new Date(provider.last_tested_at).toLocaleString()}</dd></div>}
                    </dl>
                    {provider.error && <p className="ai-provider-error">{provider.error}</p>}
                    {!!provider.missing_models?.length && <p className="ai-provider-error">Configured models not found: {provider.missing_models.join(', ')}</p>}
                    <button
                      type="button"
                      className="ai-button ai-button-primary"
                      disabled={!provider.configured || testing !== null}
                      onClick={() => void testConnection(provider)}
                    >
                      {testing === provider.id ? <><LoaderCircle className="ai-spin" size={14} /> Testing connection…</> : 'Test connection'}
                    </button>
                    {!provider.configured && <p className="ai-muted ai-provider-hint">Ask your backend administrator to configure this provider.</p>}
                  </article>
                )
              })}
            </div>
          )}
        </section>
        <footer className="ai-footer">Provider endpoints, credentials, and model configuration are read-only and managed by the backend environment.</footer>
      </div>
    </main>
  )
}

export default AiWorkspace
