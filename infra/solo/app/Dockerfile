# syntax=docker/dockerfile:1
#
# #923: image of the app VM in the D-Contact Solo UAT
# build from the repository root: docker build -f infra/solo/app/Dockerfile --target <target> .
#
# Unlike apps/api/Dockerfile of the 3-VM UAT, which can only boot profile `uat` (no Router, and Kafka disabled)
# Solo runs the full system like the dev stack: API (`dist/main.js`), Router, Telephony and the QM worker
#
# target:
#   services — API, Router, Telephony, QM, Journey, Cases with production dependencies, run as non-root
#   ops      — the whole repository with dev dependencies for migrate, rls, seed and the operator scripts
#
# base image is pinned by digest like the UAT images
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${NODE_IMAGE} AS runtime-base
# the Prisma query engine needs the OpenSSL of Debian bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 dcontact \
  && useradd --system --uid 10001 --gid dcontact --home-dir /nonexistent --shell /usr/sbin/nologin dcontact

FROM runtime-base AS build
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# prisma generate does not connect to a database — this URL only lets the schema parse
RUN DATABASE_URL=postgresql://build@localhost:5432/build pnpm --filter @d-contact/db generate \
  && pnpm --filter "@d-contact/api..." build \
  && pnpm --filter "@d-contact/router..." build \
  && pnpm --filter "@d-contact/telephony..." build \
  && pnpm --filter "@d-contact/qm..." build \
  && pnpm --filter "@d-contact/journey..." build \
  && pnpm --filter "@d-contact/cases..." build \
  && test -f apps/api/dist/main.js \
  && test -f apps/router/dist/main.js \
  && test -f apps/telephony/dist/main.js \
  && test -f apps/qm/dist/main.js \
  && test -f apps/journey/dist/main.js \
  && test -f apps/cases/dist/main.js

# ops: uses the whole build stage, adds psql for the operator scripts
FROM build AS ops
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM build AS deploy
# production dependencies only, then pick up every generated Prisma client
RUN pnpm --filter @d-contact/api deploy --prod /out/api \
  && pnpm --filter @d-contact/router deploy --prod /out/router \
  && pnpm --filter @d-contact/telephony deploy --prod /out/telephony \
  && pnpm --filter @d-contact/qm deploy --prod /out/qm \
  && pnpm --filter @d-contact/journey deploy --prod /out/journey \
  && pnpm --filter @d-contact/cases deploy --prod /out/cases \
  && node -e "const { cpSync, realpathSync, rmSync } = require('node:fs'); \
       const { resolve } = require('node:path'); \
       const client = (from) => resolve(require.resolve('@prisma/client/package.json', { paths: [realpathSync(from)] }), '../../../.prisma'); \
       const generated = client('/repo/packages/db'); \
       for (const target of ['/out/api/node_modules/@d-contact/db', '/out/router/node_modules/@d-contact/db', '/out/telephony/node_modules/@d-contact/db', '/out/qm/node_modules/@d-contact/db', '/out/journey/node_modules/@d-contact/db', '/out/cases/node_modules/@d-contact/db']) { \
         rmSync(client(target), { recursive: true, force: true }); \
         cpSync(generated, client(target), { recursive: true }); \
       }"

FROM runtime-base AS services
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-solo-services" \
  org.opencontainers.image.revision=$SOURCE_SHA
ENV NODE_ENV=production \
  DCONTACT_BUILD_SHA=$SOURCE_SHA
COPY --from=deploy /out/api /app/api
COPY --from=deploy /out/router /app/router
COPY --from=deploy /out/telephony /app/telephony
COPY --from=deploy /out/qm /app/qm
COPY --from=deploy /out/journey /app/journey
COPY --from=deploy /out/cases /app/cases
USER 10001:10001
# compose chooses the working_dir and command per service: /app/<service> + node dist/main.js
WORKDIR /app/api
CMD ["node", "dist/main.js"]
