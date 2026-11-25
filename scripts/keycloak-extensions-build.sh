#!/usr/bin/env bash
# A1.4b (#436): build the Keycloak extensions in Docker and place the jar in infra/keycloak/providers
# (mounted into /opt/keycloak/providers) - compile directly against the jars in the Keycloak image of the same version as the
# runtime, so no dependency is downloaded from Maven Central and no JDK is needed on the machine
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# extension -> jar name in providers/ (AC2 #595: dc-account pairs with invitation-guard)
extensions=("invitation-guard:dcontact-invitation-guard.jar" "dc-account:dcontact-account.jar" "tenant-people:dcontact-tenant-people.jar")
# #592: must match the runtime image (infra/docker/docker-compose.dev.yml, infra/keycloak/Dockerfile)
keycloak_image="docker.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85"
work="$(mktemp -d)"
trap 'rm -rf "$work"; docker rm -f dcontact-kc-libs >/dev/null 2>&1 || true' EXIT

docker create --name dcontact-kc-libs "$keycloak_image" >/dev/null
docker cp dcontact-kc-libs:/opt/keycloak/lib/lib/main "$work/lib"
mkdir -p "$root/infra/keycloak/providers"
built=()
for entry in "${extensions[@]}"; do
  name="${entry%%:*}"
  jar="${entry#*:}"
  mkdir -p "$work/$name/classes"
  # run with the host uid/gid - on Linux files the container creates are then not owned by root (the temp can be deleted)
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$root/infra/keycloak/extensions/$name/src/main":/src:ro \
    -v "$work":/work \
    -e JAR="$jar" -e NAME="$name" \
    eclipse-temurin:21-jdk \
    sh -c 'javac --release 21 -proc:none -nowarn -cp "/work/lib/*" -d "/work/$NAME/classes" $(find /src/java -name "*.java") \
      && cp -r /src/resources/. "/work/$NAME/classes/" \
      && cd "/work/$NAME/classes" && jar cf "/work/$JAR" .'
  cp "$work/$jar" "$root/infra/keycloak/providers/"
  built+=("\"$jar\"")
done
echo "{\"type\":\"keycloak.extensions.build\",\"status\":\"PASS\",\"jars\":[$(IFS=,; echo "${built[*]}")]}"
