#!/usr/bin/env bash
# A1.9 (#574): deploy Platform UAT บน VM2; U1 release เดิม immutable
set -euo pipefail
umask 077
action="${1:-}"
sha="${2:-}"
[[ "$action" =~ ^(check|pull|keycloak|configure|start|operator|canary|rollback|status)$ ]] || {
  echo 'usage: vm2-platform-deploy.sh <check|pull|keycloak|configure|start|operator|canary|rollback|status> <source-sha> [platform-subject-uuid]' >&2; exit 64;
}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'source SHA ไม่ถูกต้อง' >&2; exit 64; }
[[ "$(id -un)" == osdadmin ]] || { echo 'รันเป็น osdadmin บน VM2' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.112/' || { echo 'เครื่องนี้ไม่ใช่ VM2' >&2; exit 1; }

root=/opt/dcontact-uat
platform="$root/platform"
release="$platform/releases/$sha"
env_file="$platform/platform.env"
metadata="$release/platform-release.env"
current_sha="$(python3 -c 'import json; print(json.load(open("/opt/dcontact-uat/deployments/current.json"))["sourceSha"])')"
uat_release="$root/releases/$current_sha"
[[ -f "$env_file" && -f "$metadata" && -f "$release/docker-compose.platform.3vm.yml" && -f "$release/docker-compose.platform-keycloak.3vm.yml" ]] || {
  echo 'ไฟล์ release/platform.env ยังไม่ครบ' >&2; exit 1;
}
[[ "$(stat -c %a "$env_file")" == 600 ]] || { echo 'platform.env ต้อง mode 600' >&2; exit 1; }
[[ -f "$uat_release/docker-compose.uat.3vm.yml" ]] || { echo 'U1 release ไม่มี 3VM overlay' >&2; exit 1; }
[[ "$(sed -n 's/^SOURCE_SHA=//p' "$metadata")" == "$sha" ]] || { echo 'release SHA ไม่ตรง' >&2; exit 1; }
for image in PLATFORM_API_IMAGE PLATFORM_CONSOLE_IMAGE PLATFORM_KEYCLOAK_IMAGE; do
  value="$(sed -n "s/^$image=//p" "$metadata")"
  [[ "$value" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || {
    echo "$image ไม่ใช่ digest ref" >&2; exit 1;
  }
done

platform_compose() {
  "$root/bin/docker-compose" --project-name dcontact-platform-uat \
    --project-directory "$release" \
    --env-file "$root/uat.env" --env-file "$env_file" --env-file "$metadata" \
    -f "$release/docker-compose.platform.3vm.yml" "$@"
}
uat_compose() {
  local files=(-f "$uat_release/docker-compose.uat.yml" -f "$uat_release/docker-compose.uat.3vm.yml")
  if [[ -f "$root/line-pilot.enabled" ]]; then
    [[ -f "$uat_release/docker-compose.uat.line.yml" ]] || { echo 'U1 LINE overlay หาย' >&2; exit 1; }
    files+=(-f "$uat_release/docker-compose.uat.line.yml")
  fi
  "$root/bin/docker-compose" --project-name dcontact-uat \
    --project-directory "$uat_release" \
    --env-file "$root/uat.env" --env-file "$uat_release/release.env" --env-file "$metadata" \
    "${files[@]}" "$@"
}
uat_keycloak_overlay() {
  local files=(-f "$uat_release/docker-compose.uat.yml" -f "$uat_release/docker-compose.uat.3vm.yml")
  if [[ -f "$root/line-pilot.enabled" ]]; then
    files+=(-f "$uat_release/docker-compose.uat.line.yml")
  fi
  files+=(-f "$release/docker-compose.platform-keycloak.3vm.yml")
  "$root/bin/docker-compose" --project-name dcontact-uat \
    --project-directory "$uat_release" \
    --env-file "$root/uat.env" --env-file "$uat_release/release.env" --env-file "$metadata" \
    "${files[@]}" "$@"
}

case "$action" in
  check)
    platform_compose --profile ops config --quiet
    uat_keycloak_overlay config --quiet
    echo "CHECK ผ่าน: Platform release $sha; U1 release $current_sha; ยังไม่เปลี่ยน container"
    ;;
  pull)
    platform_compose --profile ops pull --quiet
    uat_keycloak_overlay pull --quiet keycloak
    echo 'PULL ผ่าน: image ตาม digest ครบ'
    ;;
  keycloak)
    uat_keycloak_overlay up -d --no-deps --wait keycloak
    echo 'KEYCLOAK ผ่าน: image ใหม่ healthy'
    ;;
  configure)
    platform_compose up -d --wait mailpit
    platform_compose --profile ops run --rm --no-deps -T platform-keycloak-config
    platform_compose --profile ops run --rm --no-deps -T platform-catalog-seed
    echo 'CONFIGURE ผ่าน: platform identity, invitation guard, SMTP และ catalog'
    ;;
  start)
    grep -qx 'PLATFORM_PROVISIONING_ENABLED=false' "$env_file" || {
      echo 'เปิด rollout ก่อนตรวจ preflight; หยุด' >&2; exit 1;
    }
    platform_compose up -d --wait platform-api platform-worker platform-console mailpit
    echo 'START ผ่าน: Platform stack เปิดอยู่; provisioning ยังปิด'
    ;;
  operator)
    # รับ temporary password จาก stdin; ห้ามส่งทาง argument หรือ environment
    platform_compose --profile ops run --rm --no-deps -T platform-operator-setup
    ;;
  canary)
    subject="${3:-}"
    [[ "$subject" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || {
      echo 'platform subject UUID ไม่ถูกต้อง' >&2; exit 64;
    }
    [[ -f "$platform/drill-$sha.ok" ]] || { echo 'rollback drill ยังไม่ผ่าน' >&2; exit 1; }
    grep -qx 'PLATFORM_PROVISIONING_ENABLED=false' "$env_file" || { echo 'rollout ไม่ได้ปิดอยู่' >&2; exit 1; }
    python3 - "$env_file" "$subject" <<'PY'
import os, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1]); subject = sys.argv[2]
lines = path.read_text().splitlines()
if sum(line.startswith('PLATFORM_OPERATOR_ALLOWLIST=') for line in lines) != 1 or sum(line.startswith('PLATFORM_PROVISIONING_ENABLED=') for line in lines) != 1:
    raise SystemExit('platform.env มี rollout key ซ้ำหรือขาด')
lines = [f'PLATFORM_OPERATOR_ALLOWLIST={subject}' if line.startswith('PLATFORM_OPERATOR_ALLOWLIST=') else
         'PLATFORM_PROVISIONING_ENABLED=true' if line.startswith('PLATFORM_PROVISIONING_ENABLED=') else line for line in lines]
fd, temporary = tempfile.mkstemp(prefix='.platform.env.', dir=path.parent)
try:
    with os.fdopen(fd, 'w') as out:
        out.write('\n'.join(lines) + '\n'); out.flush(); os.fsync(out.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
    if ! platform_compose up -d --no-deps --force-recreate --wait platform-api platform-worker; then
      echo 'เปิด canary ไม่ผ่าน; ปิด rollout กลับทันที' >&2
      python3 - "$env_file" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1]); text = path.read_text().replace('PLATFORM_PROVISIONING_ENABLED=true', 'PLATFORM_PROVISIONING_ENABLED=false')
path.write_text(text)
PY
      platform_compose up -d --no-deps --force-recreate platform-api platform-worker
      exit 1
    fi
    echo "CANARY ผ่าน: subject $subject; API และ worker ใช้ rollout เดียวกัน"
    ;;
  rollback)
    # ปิด mutation/claim ก่อน แล้วคืน Keycloak digest ของ U1; ledger/tenant ไม่ถูกลบ
    python3 - "$env_file" <<'PY'
import os, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1]); text = path.read_text()
lines = text.splitlines()
lines = ['PLATFORM_PROVISIONING_ENABLED=false' if line.startswith('PLATFORM_PROVISIONING_ENABLED=') else line for line in lines]
fd, temporary = tempfile.mkstemp(prefix='.platform.env.', dir=path.parent)
try:
    with os.fdopen(fd, 'w') as out:
        out.write('\n'.join(lines) + '\n'); out.flush(); os.fsync(out.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PY
    platform_compose up -d --no-deps --force-recreate platform-api platform-worker
    platform_compose stop platform-worker platform-api platform-console mailpit
    uat_compose up -d --no-deps --wait keycloak
    printf '%s\n' "$sha" > "$platform/drill-$sha.ok"
    echo 'ROLLBACK ผ่าน: Platform หยุด; Keycloak U1 digest เดิมกลับมา; DB/ledger คงเดิม'
    ;;
  status)
    platform_compose ps
    uat_compose ps keycloak
    ;;
esac
