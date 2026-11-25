# syntax=docker/dockerfile:1
#
# U1.6 (#434): the tenant API image for the UAT first slice (profile `uat`, entry `dist/uat-main.js`)
# build from the repository root: docker build -f apps/api/Dockerfile --target runtime .
#
# target:
#   runtime — an API that boots only with `DCONTACT_API_PROFILE=uat` (U1.2 #430), runs as non-root
#             the same image also runs the `line-webhook` service of the `uat-line` overlay
#             `node dist/line-webhook-main.js` + `DCONTACT_API_PROFILE=uat-line` (#565, ADR-031)
#   ops     — the operator's one-shot: `prisma migrate deploy` (additive only), rls.sql,
#             Keycloak realm/account setup, the readiness smoke and provisioning the UAT tenant/accounts/fixture pack
#             (U1.8 #502: `/app/dist/uat-provision-main.js` uses the same build as runtime),
#             object storage init (#540: `scripts/uat-object-storage.mjs`) and the `line-pilot`
#             runner of the `uat-line` overlay (#565: the CLI in `@d-contact/delivery/dist`) —
#             CMD/entry is not the API server
#
# the base image is always pinned by digest (the U1.6 readiness fails when it finds an unpinned FROM)
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${NODE_IMAGE} AS runtime-base
# the Prisma query engine needs OpenSSL of Debian bookworm
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
RUN pnpm install --frozen-lockfile --filter "@d-contact/api..." --filter "@d-contact/platform-control..." --filter "@d-contact/router..." --filter "@d-contact/telephony..."
# prisma generate does not connect to the database — this URL exists only so the schema parses
RUN DATABASE_URL=postgresql://build@localhost:5432/build pnpm --filter @d-contact/db generate \
  && pnpm --filter "@d-contact/api..." build \
  && pnpm --filter @d-contact/platform-control build \
  && pnpm --filter @d-contact/router build \
  && pnpm --filter @d-contact/telephony build
# runtime: production dependencies only, then copy over the already generated Prisma client
RUN pnpm --filter @d-contact/api deploy --prod /out/api \
  && pnpm --filter @d-contact/db deploy /out/ops \
  && pnpm --filter @d-contact/platform-control deploy --prod /out/platform-control \
  && pnpm --filter @d-contact/telephony deploy --prod /out/e1-sandbox \
  && node -e "const { cpSync, realpathSync, rmSync } = require('node:fs'); \
       const { resolve } = require('node:path'); \
       const client = (from) => resolve(require.resolve('@prisma/client/package.json', { paths: [realpathSync(from)] }), '../../../.prisma'); \
       const generated = client('/repo/packages/db'); \
       for (const target of ['/out/api/node_modules/@d-contact/db', '/out/ops', '/out/platform-control/node_modules/@d-contact/db', '/out/e1-sandbox/node_modules/@d-contact/db']) { \
         rmSync(client(target), { recursive: true, force: true }); \
         cpSync(generated, client(target), { recursive: true }); \
       }" \
  && test -f /out/api/dist/uat-main.js \
  && test -f /out/api/dist/e1-uat-main.js \
  && test -f /out/api/dist/uat-provision-main.js \
  && test -f /out/api/dist/tenant-people-identity-evidence-main.js \
  && test -f /out/api/dist/line-webhook-main.js \
  && test -f /out/e1-sandbox/dist/e1-sandbox-main.js \
  && test -f /out/e1-sandbox/dist/e1-voice-control-main.js \
  && for cli in line-pilot-cli line-pilot-setup line-provider-runner; do \
       test -f "/out/api/node_modules/@d-contact/delivery/dist/$cli.js" || exit 1; \
     done

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
COPY --from=build /out/e1-sandbox /e1-sandbox
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
COPY --from=build /out/platform-control /platform-control
COPY scripts/u1-uat-keycloak-users.mjs scripts/keycloak-dphone-embedded-setup.mjs scripts/keycloak-branding-setup.mjs scripts/u1-uat-readiness.mjs scripts/uat-object-storage.mjs scripts/core-settings-organization-smoke.mjs /ops/scripts/
# #565: the registry digest of the LINE pilot proposal reads this file (`LINE_PILOT_REGISTRY_PATH`)
COPY scripts/cxa-s2-readiness.mjs /ops/scripts/
COPY infra/keycloak/realm-dcontact.uat.json /ops/infra/keycloak/realm-dcontact.uat.json
# U1.8 (#502): the provision CLI needs @d-contact/journey + the generated Prisma client — copy the whole set of
# production dependencies of api (the same build as runtime) to /app; the API server is never run
COPY --from=build /out/api /app
USER 10001:10001
CMD ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]
