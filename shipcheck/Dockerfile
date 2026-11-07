# ShipCheck server: UI, checker API, evidence API and the local 3D model chunks.
# Build (from shipcheck/):  docker build -t shipcheck .
# The model chunks are NOT in the image (too big for Git); they are mounted at /app/model (see deploy/),
# or, with MODEL_SOURCE=vultr, streamed from the Vultr Object Storage bucket (cached in /app/.cache).
# No Autodesk keys are needed: the UI uses the local viewer when /app/model/manifest.json exists.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=8080 MODEL_DIR=/app/model

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.mjs model-server.mjs rules.json scenarios.json regulation-links.json ./
COPY src ./src
COPY public ./public
COPY ships ./ships
COPY tests/expected ./tests/expected
COPY integrations ./integrations
COPY demo ./demo

RUN mkdir -p /app/model /app/.cache && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server.mjs"]
