# syntax=docker/dockerfile:1
#
# U1.6 (#434): Console for the UAT first slice + reverse proxy (Caddy) in a single image
# build from the repository root: docker build -f apps/console/Dockerfile .
#
# OIDC/UAT values are build-time `VITE_*` (Vite embeds them at build), so a rebuild is needed per environment/host
# the resulting image = static Console + the UAT Caddyfile (TLS, same-origin `/api/v1`, `/auth` to Keycloak,
# Keycloak admin blocked, allowlist) — rolling back by digest restores both the Console and the proxy config together
#
# base images are always pinned by digest (the U1.6 readiness check fails on an unpinned FROM)
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG CADDY_IMAGE=caddy:2.8.4-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
  PATH=/pnpm:$PATH \
  CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@d-contact/console..." --filter "@d-contact/workspace..."
# without VITE_API_BASE_URL = call the API same-origin (`/api/v1`) through the same proxy
ARG VITE_KC_ISSUER
ARG VITE_KC_CLIENT_ID=dcontact-uat-console
ARG VITE_WORKSPACE_KC_CLIENT_ID=dcontact-uat-workspace
ARG VITE_CONSOLE_URL
ARG VITE_WORKSPACE_URL
# #684: compatibility argument for old deployments; the app uses Home when there is no explicit view/context
ARG VITE_CONSOLE_DEFAULT_VIEW=journeys
ARG VITE_UAT_ENVIRONMENT=uat
ARG VITE_UAT_PACK_VERSION
RUN test -n "$VITE_KC_ISSUER" && test -n "$VITE_UAT_PACK_VERSION" \
  || { echo 'VITE_KC_ISSUER and VITE_UAT_PACK_VERSION are required' >&2; exit 1; }
RUN VITE_KC_ISSUER="$VITE_KC_ISSUER" \
  VITE_KC_CLIENT_ID="$VITE_KC_CLIENT_ID" \
  VITE_CONSOLE_DEFAULT_VIEW="$VITE_CONSOLE_DEFAULT_VIEW" \
  VITE_WORKSPACE_URL="$VITE_WORKSPACE_URL" \
  VITE_UAT_ENVIRONMENT="$VITE_UAT_ENVIRONMENT" \
  VITE_UAT_PACK_VERSION="$VITE_UAT_PACK_VERSION" \
  pnpm --filter "@d-contact/console..." build \
  && VITE_KC_ISSUER="$VITE_KC_ISSUER" \
  VITE_KC_CLIENT_ID="$VITE_WORKSPACE_KC_CLIENT_ID" \
  VITE_CONSOLE_URL="$VITE_CONSOLE_URL" \
  VITE_WORKSPACE_URL="$VITE_WORKSPACE_URL" \
  pnpm --filter @d-contact/workspace build \
  && test -f apps/console/dist/index.html \
  && test -f apps/workspace/dist/embed/dphone-embed.js \
  && test -f apps/workspace/dist/embed/dphone-embed.css

FROM ${CADDY_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
ARG VITE_UAT_PACK_VERSION
LABEL org.opencontainers.image.title="d-contact-console-uat" \
  org.opencontainers.image.revision=$SOURCE_SHA \
  com.d-contact.uat.pack-version=$VITE_UAT_PACK_VERSION
# non-root: listen on high ports (8080/8443) and compose maps the host's 80/443 to them — no capability needed
RUN addgroup -S -g 10001 dcontact \
  && adduser -S -D -H -u 10001 -G dcontact -s /sbin/nologin dcontact \
  && mkdir -p /data /config \
  && chown -R 10001:10001 /data /config
ENV XDG_DATA_HOME=/data \
  XDG_CONFIG_HOME=/config
# the caddy in the official image has the file capability cap_net_bind_service — when compose uses cap_drop: ALL +
# no-new-privileges the kernel refuses to exec this binary (Caddy dies immediately and restarts in a loop); we already listen on high ports,
# so use a copy without the file capability (`install` does not copy xattrs) — found by uat-image-smoke (#507)
RUN install -m 0755 /usr/bin/caddy /usr/local/bin/caddy-uat
COPY infra/uat/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/console/dist /srv/console
COPY --from=build /repo/apps/workspace/dist /srv/workspace
COPY examples/dphone-host/index.html /srv/examples/dphone-host/index.html
USER 10001:10001
EXPOSE 8080 8443
CMD ["/usr/local/bin/caddy-uat", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
