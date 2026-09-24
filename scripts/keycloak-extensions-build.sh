#!/usr/bin/env bash
# A1.4b (#436): build Keycloak extension ใน Docker แล้ววาง jar ที่ infra/keycloak/providers
# (mount เข้า /opt/keycloak/providers) — compile เทียบกับ jar ใน image ของ Keycloak เวอร์ชันเดียวกับ
# runtime โดยตรง จึงไม่ต้องโหลด dependency จาก Maven Central และไม่ต้องมี JDK ในเครื่อง
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
extension="$root/infra/keycloak/extensions/invitation-guard"
keycloak_image="quay.io/keycloak/keycloak:26.0.0"
work="$(mktemp -d)"
trap 'rm -rf "$work"; docker rm -f dcontact-kc-libs >/dev/null 2>&1 || true' EXIT

docker create --name dcontact-kc-libs "$keycloak_image" >/dev/null
docker cp dcontact-kc-libs:/opt/keycloak/lib/lib/main "$work/lib"
mkdir -p "$root/infra/keycloak/providers" "$work/classes"
# รันด้วย uid/gid ของ host — บน Linux ไฟล์ที่ container สร้างจะไม่เป็นของ root (ลบ temp ได้)
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$extension/src/main":/src:ro \
  -v "$work":/work \
  eclipse-temurin:21-jdk \
  sh -c 'javac --release 21 -proc:none -nowarn -cp "/work/lib/*" -d /work/classes $(find /src/java -name "*.java") \
    && cp -r /src/resources/. /work/classes/ \
    && cd /work/classes && jar cf /work/dcontact-invitation-guard.jar .'
cp "$work/dcontact-invitation-guard.jar" "$root/infra/keycloak/providers/"
echo '{"type":"keycloak.extensions.build","status":"PASS","jar":"dcontact-invitation-guard.jar"}'
