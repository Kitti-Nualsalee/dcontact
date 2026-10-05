# syntax=docker/dockerfile:1
#
# U1.6 (#434): Console ของ UAT first slice + reverse proxy (Caddy) ใน image เดียว
# build จาก root ของ repository: docker build -f apps/console/Dockerfile .
#
# ค่า OIDC/UAT เป็น build-time `VITE_*` (Vite ฝังค่าตอน build) จึงต้อง build ใหม่ต่อ environment/host
# image ที่ได้ = static Console + Caddyfile ของ UAT (TLS, same-origin `/api/v1`, `/auth` ไป Keycloak,
# ปิด admin ของ Keycloak, allowlist) — rollback ด้วย digest จึงคืนทั้ง Console และ proxy config พร้อมกัน
#
# base image pin ด้วย digest เสมอ (readiness U1.6 ล้มเมื่อพบ FROM ที่ไม่ pin)
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
# ไม่ตั้ง VITE_API_BASE_URL = เรียก API แบบ same-origin (`/api/v1`) ผ่าน proxy ตัวเดียวกัน
ARG VITE_KC_ISSUER
ARG VITE_KC_CLIENT_ID=dcontact-uat-console
ARG VITE_CONSOLE_DEFAULT_VIEW=journeys
ARG VITE_UAT_ENVIRONMENT=uat
ARG VITE_UAT_PACK_VERSION
RUN test -n "$VITE_KC_ISSUER" && test -n "$VITE_UAT_PACK_VERSION" \
  || { echo 'VITE_KC_ISSUER and VITE_UAT_PACK_VERSION are required' >&2; exit 1; }
RUN VITE_KC_ISSUER="$VITE_KC_ISSUER" \
  VITE_KC_CLIENT_ID="$VITE_KC_CLIENT_ID" \
  VITE_CONSOLE_DEFAULT_VIEW="$VITE_CONSOLE_DEFAULT_VIEW" \
  VITE_UAT_ENVIRONMENT="$VITE_UAT_ENVIRONMENT" \
  VITE_UAT_PACK_VERSION="$VITE_UAT_PACK_VERSION" \
  pnpm --filter "@d-contact/console..." build \
  && pnpm --filter @d-contact/workspace build \
  && test -f apps/console/dist/index.html \
  && test -f apps/workspace/dist/embed/dphone-embed.js \
  && test -f apps/workspace/dist/embed/dphone-embed.css

FROM ${CADDY_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
ARG VITE_UAT_PACK_VERSION
LABEL org.opencontainers.image.title="d-contact-console-uat" \
  org.opencontainers.image.revision=$SOURCE_SHA \
  com.d-contact.uat.pack-version=$VITE_UAT_PACK_VERSION
# non-root: ฟังพอร์ตสูง (8080/8443) แล้ว compose map 80/443 ของ host เข้ามา — ไม่ต้องใช้ capability
RUN addgroup -S -g 10001 dcontact \
  && adduser -S -D -H -u 10001 -G dcontact -s /sbin/nologin dcontact \
  && mkdir -p /data /config \
  && chown -R 10001:10001 /data /config
ENV XDG_DATA_HOME=/data \
  XDG_CONFIG_HOME=/config
# caddy ใน image ทางการมี file capability cap_net_bind_service — เมื่อ compose ใช้ cap_drop: ALL +
# no-new-privileges kernel จะไม่ยอม exec binary นี้ (Caddy ตายทันทีแล้ว restart วน) เราฟังพอร์ตสูงอยู่แล้ว
# จึงใช้สำเนาที่ไม่มี file capability (`install` ไม่คัดลอก xattr) — พบจาก uat-image-smoke (#507)
RUN install -m 0755 /usr/bin/caddy /usr/local/bin/caddy-uat
COPY infra/uat/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/console/dist /srv/console
COPY --from=build /repo/apps/workspace/dist/embed /srv/workspace/embed
COPY examples/dphone-host/index.html /srv/examples/dphone-host/index.html
USER 10001:10001
EXPOSE 8080 8443
CMD ["/usr/local/bin/caddy-uat", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
