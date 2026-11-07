# Separate model server

The app can run on one host and retrieve model data from a second, read-only Node server. `model-server.mjs` imports only Node built-ins and `src/cors.mjs`; it does not load the app, APS configuration, credentials or environment files. No new account or deployment is required for local testing.

## App configuration contract

`GET /api/model/config` returns:

```json
{
  "base_url": "model/",
  "manifest": "stream-hp/manifest.json",
  "legacy_manifest": "manifest.json"
}
```

Set `MODEL_BASE_URL` on the **app process** to use another host, for example `https://model.example.com/`. Include a trailing slash. The default `model/` keeps the existing app model route, including when the app is mounted under `/inspection/`. All manifest, tile and property paths are relative to this base:

```text
MODEL_DIR/
  manifest.json                 # legacy model, optional
  context.glb                  # legacy chunk, optional
  stream/
    manifest.json              # streaming manifest with a chunks[] tile list
    tile-01.glb
    tile-02.glb
  props/
    1.json
```

The manifest is `stream-hp/manifest.json` (high-precision tiles) when `model/stream-hp/audit.json` reports a pass, else `stream/manifest.json`; `MODEL_MANIFEST` overrides it. For the external example the requests are `https://model.example.com/stream/manifest.json`, `https://model.example.com/stream/tile-01.glb` and `https://model.example.com/props/1.json`. The server does not add a `/model/` prefix. If a proxy mounts it under a versioned prefix, strip that prefix when forwarding and set `MODEL_BASE_URL` to that prefix with its trailing slash.

This change provides the configuration and file-hosting contract. Tile generation, viewport selection, loading and unloading belong to the viewer, which must consume the configuration endpoint. The standalone server serves files on request; it never loads ship geometry into memory.

## Local use: Windows PowerShell

Open a terminal in `shipcheck/` and run the model server:

```powershell
$env:MODEL_DIR = (Resolve-Path .\model).Path
$env:MODEL_PORT = '8081'
$env:ALLOWED_ORIGINS = 'http://localhost:5173,http://localhost:8080'
node .\model-server.mjs
```

In a **second terminal**, configure and start the app:

```powershell
$env:MODEL_BASE_URL = 'http://localhost:8081/'
npm.cmd start
```

For the Vite entry point, set `MODEL_BASE_URL` in the terminal that starts the root Vite process instead. Restart an already-running process after changing its environment. These commands set process environment variables only; no `.env` or `deploy.env` needs editing.

## Local use: Linux

From `shipcheck/`, start the independent model server:

```sh
MODEL_DIR="$PWD/model" MODEL_PORT=8081 \
ALLOWED_ORIGINS='http://localhost:5173,http://localhost:8080' \
node model-server.mjs
```

In a second terminal:

```sh
MODEL_BASE_URL='http://localhost:8081/' npm start
```

`MODEL_DIR` defaults to `shipcheck/model/` regardless of the launch directory; an explicitly supplied relative directory is resolved from the launch directory. `MODEL_PORT` defaults to `8081`. A model-only host needs Node 20 or newer and these files: `model-server.mjs`, `package.json`, `src/cors.mjs`, plus the model directory. It needs no npm dependencies, APS keys or app data.

## Container and production setup (instructions only)

The existing Docker image now includes `model-server.mjs` and the required CORS helper. It can run either process. To test a model-only container locally:

```sh
docker build -t shipcheck .
docker run --rm -p 8081:8081 \
  -e MODEL_DIR=/app/model -e MODEL_PORT=8081 \
  -e ALLOWED_ORIGINS=https://app.example.com \
  --mount type=bind,source="$(pwd)/model",target=/app/model,readonly \
  --health-cmd='node -e "fetch(\"http://127.0.0.1:8081/api/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"' \
  shipcheck node model-server.mjs
```

The existing image's default health check targets the app on port 8080, so override it as above for the model-only process. The app Compose service accepts `MODEL_BASE_URL`; for example, supply `MODEL_BASE_URL=https://model.example.com/` in the environment used to invoke Compose. No existing deployment file with credentials needs to be changed for local checks. A separate model service is deliberately not enabled in the existing Compose stack.

For an eventual separate host, point the placeholder DNS name `model.example.com` to that host and put an HTTPS proxy in front of port 8081. A Caddy configuration could be:

```caddyfile
model.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8081
}
```

Run the Node service with `MODEL_DIR=/path/to/model`, `MODEL_PORT=8081`, and `ALLOWED_ORIGINS=https://app.example.com`. Set `MODEL_BASE_URL=https://model.example.com/` on the app. Forward HTTP Range requests and retain the server's CORS, cache and MIME headers. HTTPS on both hosts avoids mixed-content blocking. These are deployment instructions only; no deployment is performed by this change.

## HTTP behavior and checks

- Only `.glb` and `.json` files inside `MODEL_DIR` are served, plus `GET`/`HEAD /api/health`. No directory listings, hidden paths, traversal, outside-directory links, scripts or write methods are served.
- GLBs use `model/gltf-binary`, `Accept-Ranges: bytes` and `Cache-Control: public, max-age=31536000, immutable`. Use new versioned URLs for changed GLBs; do not overwrite cached files at the same URL. JSON and health responses use `no-store`.
- Single closed, open-ended and suffix byte ranges return `206`; unsatisfiable, malformed or multiple ranges return `416`. `HEAD` returns the same headers without a body. An unverifiable `If-Range` request receives the whole file.
- `ALLOWED_ORIGINS` uses the app's existing policy: a comma-separated exact list, default localhost/loopback origins on any port. An explicit list replaces the default; `*` permits any origin. Allowed preflight requests receive `204`; disallowed origins receive `403` for preflight and no CORS permission on ordinary responses. CORS controls browser access, not authentication; model files are public to direct HTTP clients.
- Health reports `version`, `model_manifest`, `stream_manifest`, `legacy_chunks`, `streaming_tiles` (the streaming manifest's `chunks[]` length, with `tiles[]` also accepted), and `chunks` (legacy chunks plus streaming tiles). It does not disclose directory paths or host configuration. Counts describe manifest entries, not a geometry/file integrity audit. A missing model still returns `status: "ok"` with zero counts so server liveness can be checked before upload.

On Windows use `curl.exe` in place of `curl`:

```sh
curl --fail http://localhost:8080/api/model/config
curl --fail http://localhost:8081/api/health
curl --head http://localhost:8081/stream/manifest.json
curl --include --range 0-99 http://localhost:8081/stream/tile-01.glb
curl --include -X OPTIONS http://localhost:8081/stream/tile-01.glb \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: Range'
curl --include -X OPTIONS http://localhost:8081/stream/tile-01.glb \
  -H 'Origin: https://disallowed.example' \
  -H 'Access-Control-Request-Method: GET'
```

Replace the example tile filename with one present in the streaming manifest. The model server's startup and error messages contain no hostnames, IP addresses, filesystem paths or secrets.

## Tests

From `shipcheck/`:

```sh
node --test tests/model-server.test.mjs tests/model-config.test.mjs
npm test
```

The model-server tests create and remove their own temporary model fixtures. They cover the separate-origin CORS contract, default localhost policy, MIME/cache/GET/HEAD/Range behavior, traversal/hidden-file rejection, link containment and health counts for streaming-only and empty model directories. They do not need an exported RCRV model, Autodesk keys or a model deployment.
