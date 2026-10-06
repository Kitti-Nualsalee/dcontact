#!/usr/bin/env bash
# A1.4b (#436): build Keycloak extension ใน Docker แล้ววาง jar ที่ infra/keycloak/providers
# (mount เข้า /opt/keycloak/providers) — compile เทียบกับ jar ใน image ของ Keycloak เวอร์ชันเดียวกับ
# runtime โดยตรง จึงไม่ต้องโหลด dependency จาก Maven Central และไม่ต้องมี JDK ในเครื่อง
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# extension → ชื่อ jar ใน providers/ (AC2 #595: dc-account คู่กับ invitation-guard)
extensions=("invitation-guard:dcontact-invitation-guard.jar" "dc-account:dcontact-account.jar")
# #592: ต้องตรงกับ image ของ runtime (infra/docker/docker-compose.dev.yml, infra/keycloak/Dockerfile)
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
  # รันด้วย uid/gid ของ host — บน Linux ไฟล์ที่ container สร้างจะไม่เป็นของ root (ลบ temp ได้)
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
