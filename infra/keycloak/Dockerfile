# syntax=docker/dockerfile:1.7
# UAT: Keycloak image ของ D-Contact = Keycloak 26.0.0 (digest เดียวกับที่ compose ของ UAT pin ไว้) + login/email theme
# (#515/#522) — theme อยู่ใน image จึง deploy/rollback ด้วย digest ได้เหมือน image อื่นของ UAT ไม่ต้อง bind mount บน VM
#
# build context = root ของ repo:
#   docker build -f infra/keycloak/Dockerfile --build-arg SOURCE_SHA=<sha> .
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG KEYCLOAK_IMAGE=docker.io/keycloak/keycloak:26.0.0@sha256:db0d0f2c2eee8618a37a50e04affb69823e56687b4d1b676a847a4b85de62178

# token/โลโก้ของ packages/ui → resources ของ theme และ dc-tokens.ftl ของ email (ไฟล์ที่สร้างไม่อยู่ใน Git)
FROM ${NODE_IMAGE} AS theme
WORKDIR /src
COPY scripts/keycloak-theme-build.mjs scripts/
COPY packages/ui/src/tokens.css packages/ui/src/
COPY packages/ui/assets/brand packages/ui/assets/brand
COPY infra/keycloak/themes infra/keycloak/themes
RUN node scripts/keycloak-theme-build.mjs

FROM ${KEYCLOAK_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-keycloak-uat" \
      org.opencontainers.image.revision=$SOURCE_SHA
COPY --from=theme --chown=1000:0 /src/infra/keycloak/themes/ /opt/keycloak/themes/
USER 1000
