# syntax=docker/dockerfile:1
#
# U1.6 (#434): image ของ tenant API สำหรับ UAT first slice (profile `uat`, entry `dist/uat-main.js`)
# build จาก root ของ repository: docker build -f apps/api/Dockerfile --target runtime .
#
# target:
#   runtime — API ที่บูตได้เฉพาะ `DCONTACT_API_PROFILE=uat` (U1.2 #430) รันเป็น non-root
#   ops     — one-shot ของ operator: `prisma migrate deploy` (additive เท่านั้น), rls.sql,
#             ตั้งค่า Keycloak realm/บัญชี, readiness smoke และ provision tenant/บัญชี/fixture pack
#             ของ UAT (U1.8 #502: `/app/dist/uat-provision-main.js` ใช้ build เดียวกับ runtime) —
#             CMD/entry ไม่ใช่ API server
#
# base image pin ด้วย digest เสมอ (readiness U1.6 ล้มเมื่อพบ FROM ที่ไม่ pin)
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${NODE_IMAGE} AS runtime-base
# Prisma query engine ต้องใช้ OpenSSL ของ Debian bookworm
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
RUN pnpm install --frozen-lockfile --filter "@d-contact/api..."
# prisma generate ไม่ต่อฐานข้อมูล — URL นี้มีไว้ให้ schema parse ผ่านเท่านั้น
RUN DATABASE_URL=postgresql://build@localhost:5432/build pnpm --filter @d-contact/db generate \
  && pnpm --filter "@d-contact/api..." build
# runtime: production dependencies เท่านั้น แล้วคัด Prisma client ที่ generate แล้วตามไป
RUN pnpm --filter @d-contact/api deploy --prod /out/api \
  && pnpm --filter @d-contact/db deploy /out/ops \
  && node -e "const { cpSync, realpathSync, rmSync } = require('node:fs'); \
       const { resolve } = require('node:path'); \
       const client = (from) => resolve(require.resolve('@prisma/client/package.json', { paths: [realpathSync(from)] }), '../../../.prisma'); \
       const generated = client('/repo/packages/db'); \
       for (const target of ['/out/api/node_modules/@d-contact/db', '/out/ops']) { \
         rmSync(client(target), { recursive: true, force: true }); \
         cpSync(generated, client(target), { recursive: true }); \
       }" \
  && test -f /out/api/dist/uat-main.js \
  && test -f /out/api/dist/uat-provision-main.js

FROM runtime-base AS runtime
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-api-uat" \
  org.opencontainers.image.revision=$SOURCE_SHA
ENV NODE_ENV=production \
  DCONTACT_API_PROFILE=uat \
  PORT=3000 \
  DCONTACT_BUILD_SHA=$SOURCE_SHA
WORKDIR /app
COPY --from=build /out/api /app
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/uat-main.js"]

FROM runtime-base AS ops
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-uat-ops" \
  org.opencontainers.image.revision=$SOURCE_SHA
ENV NODE_ENV=production \
  DCONTACT_BUILD_SHA=$SOURCE_SHA \
  PATH=/ops/node_modules/.bin:$PATH
WORKDIR /ops
COPY --from=build /out/ops /ops
COPY scripts/u1-uat-keycloak-users.mjs scripts/u1-uat-readiness.mjs /ops/scripts/
COPY infra/keycloak/realm-dcontact.uat.json /ops/infra/keycloak/realm-dcontact.uat.json
# U1.8 (#502): CLI provision ต้องใช้ @d-contact/journey + Prisma client ที่ generate แล้ว — คัดชุด
# production dependencies ของ api (build เดียวกับ runtime) มาทั้งก้อนที่ /app; ไม่มีการรัน API server
COPY --from=build /out/api /app
USER 10001:10001
CMD ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]
