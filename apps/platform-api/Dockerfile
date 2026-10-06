# syntax=docker/dockerfile:1
# A1.9 (#574): Platform API และ worker ใช้ image เดียว แต่รันคนละ process และ DB role
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@d-contact/platform-api..."
RUN DATABASE_URL=postgresql://build@localhost:5432/build pnpm --filter @d-contact/db generate \
  && pnpm --filter "@d-contact/platform-api..." build \
  && pnpm --filter @d-contact/platform-api deploy --prod /out/platform \
  && node -e "const { cpSync, realpathSync, rmSync } = require('node:fs'); \
       const { resolve } = require('node:path'); \
       const client = (from) => resolve(require.resolve('@prisma/client/package.json', { paths: [realpathSync(from)] }), '../../../.prisma'); \
       rmSync(client('/out/platform/node_modules/@d-contact/db'), { recursive: true, force: true }); \
       cpSync(client('/repo/packages/db'), client('/out/platform/node_modules/@d-contact/db'), { recursive: true });" \
  && test -f /out/platform/dist/main.js \
  && test -f /out/platform/node_modules/@d-contact/platform-control/dist/platform-worker-main.js

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-platform-uat" \
  org.opencontainers.image.revision=$SOURCE_SHA
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 dcontact \
  && useradd --system --uid 10001 --gid dcontact --home-dir /nonexistent --shell /usr/sbin/nologin dcontact
ENV NODE_ENV=production DCONTACT_BUILD_SHA=$SOURCE_SHA
WORKDIR /app
COPY --from=build /out/platform /app
COPY scripts/keycloak-platform-setup.mjs scripts/keycloak-provisioning-setup.mjs scripts/keycloak-account-service-setup.mjs scripts/platform-uat-create-operator.mjs scripts/platform-uat-seed-catalog.mjs /app/scripts/
USER 10001:10001
EXPOSE 3010
CMD ["node", "dist/main.js"]
