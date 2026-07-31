# syntax=docker/dockerfile:1.7
#
# VROOM v1.15.0 is compiled without GLPK. The upstream makefile detects GLPK by
# /usr/include/glpk.h; this image intentionally never installs that header or
# runtime library. Plan-mode ETA validation is therefore excluded while the
# core VRP solver and custom matrices remain available.

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS builder

ARG VROOM_REF=43dd7d0b8b560431eb555bf335cf4797eb7343c4
ARG VROOM_VERSION=v1.15.0
ARG VROOM_EXPRESS_REF=5475901e60ec13ed9eec6cc87c811206a779eb03
ARG VROOM_EXPRESS_VERSION=v0.12.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      g++ \
      git \
      libasio-dev \
      libssl-dev \
      make \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git init vroom \
    && cd vroom \
    && git remote add origin https://github.com/VROOM-Project/vroom.git \
    && git fetch --depth 1 origin "${VROOM_REF}" \
    && test "$(git rev-parse FETCH_HEAD)" = "${VROOM_REF}" \
    && git checkout --detach FETCH_HEAD \
    && git submodule update --init --depth 1 \
    && test -z "$(git submodule status | grep '^-' || true)" \
    && test ! -e /usr/include/glpk.h \
    && make -C src -j"$(nproc)" \
    && ! ldd bin/vroom | grep -qi glpk \
    && bin/vroom --version | grep -F "${VROOM_VERSION#v}"

RUN git init vroom-express \
    && cd vroom-express \
    && git remote add origin https://github.com/VROOM-Project/vroom-express.git \
    && git fetch --depth 1 origin "${VROOM_EXPRESS_REF}" \
    && test "$(git rev-parse FETCH_HEAD)" = "${VROOM_EXPRESS_REF}" \
    && git checkout --detach FETCH_HEAD

FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS node-runtime

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS runtime

ARG VROOM_REF=43dd7d0b8b560431eb555bf335cf4797eb7343c4
ARG VROOM_VERSION=v1.15.0
ARG VROOM_EXPRESS_REF=5475901e60ec13ed9eec6cc87c811206a779eb03
ARG VROOM_EXPRESS_VERSION=v0.12.0

LABEL org.opencontainers.image.title="StoryOps AI VROOM service" \
      org.opencontainers.image.source="https://github.com/VROOM-Project/vroom" \
      org.opencontainers.image.version="${VROOM_VERSION}" \
      org.opencontainers.image.revision="${VROOM_REF}" \
      org.opencontainers.image.licenses="BSD-2-Clause" \
      storyops.vroom-express.version="${VROOM_EXPRESS_VERSION}" \
      storyops.vroom-express.revision="${VROOM_EXPRESS_REF}" \
      storyops.glpk="disabled"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3t64 \
    && groupadd --system --gid 10001 storyops \
    && useradd --system --uid 10001 --gid storyops --home-dir /nonexistent \
      --shell /usr/sbin/nologin storyops \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/vroom-express
COPY --from=node-runtime /usr/local /usr/local
COPY --from=builder /build/vroom/bin/vroom /usr/local/bin/vroom
COPY --from=builder /build/vroom/LICENSE /usr/share/licenses/vroom/LICENSE
COPY --from=builder /build/vroom/include/cxxopts/LICENSE /usr/share/licenses/vroom-dependencies/cxxopts.LICENSE
COPY --from=builder /build/vroom/include/polylineencoder/LICENSE /usr/share/licenses/vroom-dependencies/polylineencoder.LICENSE
COPY --from=builder /build/vroom/include/rapidjson/license.txt /usr/share/licenses/vroom-dependencies/rapidjson.LICENSE
COPY --from=builder /build/vroom-express/LICENSE /usr/share/licenses/vroom-express/LICENSE
COPY runtime-package/NPM_THIRD_PARTY_NOTICES.txt /usr/share/licenses/vroom-express-runtime/NPM_THIRD_PARTY_NOTICES.txt
COPY --from=builder /build/vroom-express ./
COPY runtime-package/package.json runtime-package/package-lock.json ./
COPY config.yml ./config.yml

RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && mkdir -p /tmp/vroom \
    && chown -R storyops:storyops /opt/vroom-express /tmp/vroom \
    && ! ldd /usr/local/bin/vroom | grep -qi glpk

ENV NODE_ENV=production \
    VROOM_ROUTER=osrm \
    VROOM_LOG=/tmp/vroom

USER storyops
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "src/index.js"]
