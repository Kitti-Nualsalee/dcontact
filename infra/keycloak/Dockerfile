# syntax=docker/dockerfile:1.7
# UAT: Keycloak image ของ D-Contact = Keycloak 26.0.0 (digest เดียวกับที่ compose ของ UAT pin ไว้) + login/email theme
# (#515/#522) — theme อยู่ใน image จึง deploy/rollback ด้วย digest ได้เหมือน image อื่นของ UAT ไม่ต้อง bind mount บน VM
#
# build context = root ของ repo:
#   docker build -f infra/keycloak/Dockerfile --build-arg SOURCE_SHA=<sha> .
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG KEYCLOAK_IMAGE=docker.io/keycloak/keycloak:26.0.0@sha256:db0d0f2c2eee8618a37a50e04affb69823e56687b4d1b676a847a4b85de62178
# UBI 9 ของ Keycloak 26 ต้องมี CPU x86-64-v2 แต่ VM2 UAT เป็น KVM รุ่นเก่าที่มีเพียง SSE2.
# ใช้ Temurin Java 21 แบบ baseline x86-64 เพื่อรัน invitation guard ของ A1 (`--release 21`)
# โดยยังคัดลอก Keycloak distribution ที่ pin digest เดิมทั้งหมด.
ARG KEYCLOAK_EXTENSION_BUILDER_IMAGE=docker.io/library/eclipse-temurin:21-jdk-jammy@sha256:6adefddd4a20bceef702cedb0b03952fcd7691f9c7ccffe27014992abc0b46bd
ARG KEYCLOAK_PLATFORM_RUNTIME_IMAGE=docker.io/library/eclipse-temurin:21-jre-jammy@sha256:e9aaf73145bbd1f9f6ec7f6867dd75a44f34b1a6c32a813504bf4129be2d09d7

# token/โลโก้ของ packages/ui → resources ของ theme และ dc-tokens.ftl ของ email (ไฟล์ที่สร้างไม่อยู่ใน Git)
FROM ${NODE_IMAGE} AS theme
WORKDIR /src
COPY scripts/keycloak-theme-build.mjs scripts/
COPY packages/ui/src/tokens.css packages/ui/src/
COPY packages/ui/assets/brand packages/ui/assets/brand
COPY infra/keycloak/themes infra/keycloak/themes
RUN node scripts/keycloak-theme-build.mjs

FROM ${KEYCLOAK_IMAGE} AS keycloak-distribution

# A1.9 (#574): invitation guard ต้อง compile กับ Keycloak 26 และรันด้วย Java 21
FROM ${KEYCLOAK_EXTENSION_BUILDER_IMAGE} AS platform-extension
COPY --from=keycloak-distribution /opt/keycloak/lib/lib/main /kc-libs
COPY infra/keycloak/extensions/invitation-guard/src/main /src
RUN mkdir -p /classes \
  && javac --release 21 -proc:none -nowarn -cp '/kc-libs/*' -d /classes $(find /src/java -name '*.java') \
  && cp -r /src/resources/. /classes/ \
  && cd /classes && jar cf /dcontact-invitation-guard.jar .

FROM ${KEYCLOAK_PLATFORM_RUNTIME_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-keycloak-uat" \
      org.opencontainers.image.revision=$SOURCE_SHA
ENV KC_RUN_IN_CONTAINER=true
COPY --from=keycloak-distribution --chown=1000:0 /opt/keycloak /opt/keycloak
COPY --from=theme --chown=1000:0 /src/infra/keycloak/themes/ /opt/keycloak/themes/
COPY --from=platform-extension --chown=1000:0 /dcontact-invitation-guard.jar /opt/keycloak/providers/
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
