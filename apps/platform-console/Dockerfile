# syntax=docker/dockerfile:1
# A1.9 (#574): Platform Console แยก origin จาก Tenant Console
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG CADDY_IMAGE=caddy:2.8.4-alpine@sha256:af32e97399febea808609119bb21544d0265c58a02836576e32a2d082c262c17
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@d-contact/platform-console..."
ARG VITE_KC_ISSUER
RUN test -n "$VITE_KC_ISSUER" \
  && VITE_KC_ISSUER="$VITE_KC_ISSUER" VITE_KC_CLIENT_ID=platform-console \
     VITE_PLATFORM_API_URL='' pnpm --filter @d-contact/platform-console build \
  && test -f apps/platform-console/dist/index.html

FROM ${CADDY_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-platform-console-uat" \
  org.opencontainers.image.revision=$SOURCE_SHA
RUN addgroup -S -g 10001 dcontact \
  && adduser -S -D -H -u 10001 -G dcontact -s /sbin/nologin dcontact \
  && mkdir -p /data /config \
  && chown -R 10001:10001 /data /config \
  && install -m 0755 /usr/bin/caddy /usr/local/bin/caddy-uat
ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config
COPY infra/uat/Caddyfile.platform.3vm /etc/caddy/Caddyfile
COPY --from=build /repo/apps/platform-console/dist /srv/platform-console
USER 10001:10001
EXPOSE 8081
CMD ["/usr/local/bin/caddy-uat", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
