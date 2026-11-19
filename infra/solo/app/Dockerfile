# syntax=docker/dockerfile:1
#
# #923: image ของ VM app ใน UAT แบบ D-Contact Solo
# build จาก root ของ repository: docker build -f infra/solo/app/Dockerfile --target <target> .
#
# ต่างจาก apps/api/Dockerfile ของ UAT 3 VM ซึ่งบูตได้เฉพาะ profile `uat` (ไม่มี Router และปิด Kafka)
# Solo รันระบบเต็มแบบเดียวกับ dev stack: API (`dist/main.js`), Router และ Telephony
#
# target:
#   services — API, Router, Telephony แบบ production dependencies รันเป็น non-root
#   ops      — repository ทั้งชุดพร้อม dev dependencies สำหรับ migrate, rls, seed และ script ของ operator
#
# base image pin ด้วย digest เหมือน image ของ UAT
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
RUN pnpm install --frozen-lockfile
# prisma generate ไม่ต่อฐานข้อมูล — URL นี้มีไว้ให้ schema parse ผ่านเท่านั้น
RUN DATABASE_URL=postgresql://build@localhost:5432/build pnpm --filter @d-contact/db generate \
  && pnpm --filter "@d-contact/api..." build \
  && pnpm --filter "@d-contact/router..." build \
  && pnpm --filter "@d-contact/telephony..." build \
  && test -f apps/api/dist/main.js \
  && test -f apps/router/dist/main.js \
  && test -f apps/telephony/dist/main.js

# ops: ใช้ build stage ทั้งชุด เพิ่ม psql สำหรับ script ของ operator
FROM build AS ops
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM build AS deploy
# production dependencies เท่านั้น แล้วคัด Prisma client ที่ generate แล้วตามไปทุกตัว
RUN pnpm --filter @d-contact/api deploy --prod /out/api \
  && pnpm --filter @d-contact/router deploy --prod /out/router \
  && pnpm --filter @d-contact/telephony deploy --prod /out/telephony \
  && node -e "const { cpSync, realpathSync, rmSync } = require('node:fs'); \
       const { resolve } = require('node:path'); \
       const client = (from) => resolve(require.resolve('@prisma/client/package.json', { paths: [realpathSync(from)] }), '../../../.prisma'); \
       const generated = client('/repo/packages/db'); \
       for (const target of ['/out/api/node_modules/@d-contact/db', '/out/router/node_modules/@d-contact/db', '/out/telephony/node_modules/@d-contact/db']) { \
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
USER 10001:10001
# compose เลือก working_dir และคำสั่งต่อ service: /app/<service> + node dist/main.js
WORKDIR /app/api
CMD ["node", "dist/main.js"]
