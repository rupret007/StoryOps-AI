# syntax=docker/dockerfile:1.7

FROM node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS build

WORKDIR /app

COPY package*.json .npmrc ./
RUN if [ -f package-lock.json ]; then \
      npm ci --ignore-scripts; \
    else \
      npm install --ignore-scripts; \
    fi

COPY index.html vite.config.ts vitest.config.ts ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src

ARG VITE_STORYOPS_ENV=sandbox
ARG VITE_STORYOPS_DATA_MODE
ARG VITE_STORYOPS_TIME_ZONE=America/Chicago
ARG VITE_SUPABASE_URL=
ARG VITE_SUPABASE_ANON_KEY=
ARG VITE_STORYOPS_COMPANY_ID=
ARG VITE_INTEGRATION_HEALTH_REFRESH_SECONDS=60
ARG STORYOPS_BUILD_REVISION=local-uncommitted
ENV VITE_STORYOPS_ENV=${VITE_STORYOPS_ENV} \
    VITE_STORYOPS_DATA_MODE=${VITE_STORYOPS_DATA_MODE} \
    VITE_STORYOPS_TIME_ZONE=${VITE_STORYOPS_TIME_ZONE} \
    VITE_SUPABASE_URL=${VITE_SUPABASE_URL} \
    VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY} \
    VITE_STORYOPS_COMPANY_ID=${VITE_STORYOPS_COMPANY_ID} \
    VITE_INTEGRATION_HEALTH_REFRESH_SECONDS=${VITE_INTEGRATION_HEALTH_REFRESH_SECONDS} \
    STORYOPS_BUILD_REVISION=${STORYOPS_BUILD_REVISION}

RUN case "${VITE_STORYOPS_DATA_MODE}" in \
      sandbox) ;; \
      supabase) \
        test -n "${VITE_SUPABASE_URL}" \
        && test -n "${VITE_SUPABASE_ANON_KEY}" \
        && test -n "${VITE_STORYOPS_COMPANY_ID}" \
        || { echo "Supabase build requires VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, and VITE_STORYOPS_COMPANY_ID." >&2; exit 1; } ;; \
      *) echo "VITE_STORYOPS_DATA_MODE must be explicitly set to sandbox or supabase." >&2; exit 1 ;; \
    esac \
    && npm run build \
    && node -e 'const fs = require("node:fs"); const mode = process.env.VITE_STORYOPS_DATA_MODE; const revision = process.env.STORYOPS_BUILD_REVISION; if (!/^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/.test(revision)) throw new Error("STORYOPS_BUILD_REVISION is invalid."); fs.writeFileSync("dist/storyops-build.json", JSON.stringify({ dataMode: mode, revision }), { flag: "wx" });'

FROM node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS runtime

LABEL org.opencontainers.image.title="WashOps" \
      org.opencontainers.image.description="AI-first operations system for an owner-operated exterior-services company"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY --chown=node:node infra/runtime/server.mjs ./server.mjs
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node NOTICE.md LICENSE.atomic-crm.md THIRD_PARTY.md NPM_THIRD_PARTY_NOTICES.txt /usr/share/licenses/storyops-ai/

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
