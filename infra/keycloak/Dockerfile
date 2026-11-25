# syntax=docker/dockerfile:1.7
# UAT: the D-Contact Keycloak image = Keycloak 26.7.5 (#592; the same digest pinned by the UAT compose) + the login/email theme
# (#515/#522) — the theme lives in the image, so deploy/rollback by digest works like the other UAT images, with no bind mount on the VM
#
# build context = repo root:
#   docker build -f infra/keycloak/Dockerfile --build-arg SOURCE_SHA=<sha> .
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG KEYCLOAK_IMAGE=docker.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85
# The UBI 9 of Keycloak 26 needs a CPU with x86-64-v2, but VM2 of the UAT is an old KVM that only has SSE2.
# Use Temurin Java 21 in its baseline x86-64 build to run the A1 invitation guard (`--release 21`)
# while still copying the whole Keycloak distribution with the same pinned digest.
ARG KEYCLOAK_EXTENSION_BUILDER_IMAGE=docker.io/library/eclipse-temurin:21-jdk-jammy@sha256:6adefddd4a20bceef702cedb0b03952fcd7691f9c7ccffe27014992abc0b46bd
ARG KEYCLOAK_PLATFORM_RUNTIME_IMAGE=docker.io/library/eclipse-temurin:21-jre-jammy@sha256:e9aaf73145bbd1f9f6ec7f6867dd75a44f34b1a6c32a813504bf4129be2d09d7

# tokens/logo of packages/ui → the theme resources and the email dc-tokens.ftl (generated files are not in Git)
FROM ${NODE_IMAGE} AS theme
WORKDIR /src
COPY scripts/keycloak-theme-build.mjs scripts/
COPY packages/ui/src/tokens.css packages/ui/src/
COPY packages/ui/assets/brand packages/ui/assets/brand
COPY infra/keycloak/themes infra/keycloak/themes
RUN node scripts/keycloak-theme-build.mjs

FROM ${KEYCLOAK_IMAGE} AS keycloak-distribution

# A1.9 (#574): the invitation guard must compile against Keycloak 26 and run on Java 21
# AC2 (#595): the extension `dc-account` (set TOTP on behalf of the user + enforce 2FA per Organization) is built alongside
FROM ${KEYCLOAK_EXTENSION_BUILDER_IMAGE} AS platform-extension
COPY --from=keycloak-distribution /opt/keycloak/lib/lib/main /kc-libs
COPY infra/keycloak/extensions/invitation-guard/src/main /src/invitation-guard
COPY infra/keycloak/extensions/dc-account/src/main /src/dc-account
COPY infra/keycloak/extensions/tenant-people/src/main /src/tenant-people
RUN set -e; for entry in invitation-guard:dcontact-invitation-guard.jar dc-account:dcontact-account.jar tenant-people:dcontact-tenant-people.jar; do \
    name="${entry%%:*}"; jar="${entry#*:}"; \
    mkdir -p "/classes/$name"; \
    javac --release 21 -proc:none -nowarn -cp '/kc-libs/*' -d "/classes/$name" $(find "/src/$name/java" -name '*.java'); \
    cp -r "/src/$name/resources/." "/classes/$name/"; \
    (cd "/classes/$name" && jar cf "/$jar" .); \
  done

FROM ${KEYCLOAK_PLATFORM_RUNTIME_IMAGE} AS runtime
ARG SOURCE_SHA=unknown
LABEL org.opencontainers.image.title="d-contact-keycloak-uat" \
      org.opencontainers.image.revision=$SOURCE_SHA
ENV KC_RUN_IN_CONTAINER=true
COPY --from=keycloak-distribution --chown=1000:0 /opt/keycloak /opt/keycloak
COPY --from=theme --chown=1000:0 /src/infra/keycloak/themes/ /opt/keycloak/themes/
COPY --from=platform-extension --chown=1000:0 /dcontact-invitation-guard.jar /opt/keycloak/providers/
COPY --from=platform-extension --chown=1000:0 /dcontact-account.jar /opt/keycloak/providers/
COPY --from=platform-extension --chown=1000:0 /dcontact-tenant-people.jar /opt/keycloak/providers/
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
