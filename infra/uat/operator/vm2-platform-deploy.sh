#!/usr/bin/env bash
# A1.9 (#574): deploy Platform UAT on VM2; the existing U1 release stays immutable
set -euo pipefail
umask 077
action="${1:-}"
sha="${2:-}"
[[ "$action" =~ ^(check|pull|keycloak|configure|start|update|operator|canary|rollback|status)$ ]] || {
  echo 'usage: vm2-platform-deploy.sh <check|pull|keycloak|configure|start|update|operator|canary|rollback|status> <source-sha> [platform-subject-uuid]' >&2; exit 64;
}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'invalid source SHA' >&2; exit 64; }
[[ "$(id -un)" == osdadmin ]] || { echo 'run as osdadmin on VM2' >&2; exit 1; }
ip -4 -o addr show | grep -F '192.168.102.112/' >/dev/null || { echo 'this machine is not VM2' >&2; exit 1; }

root=/opt/dcontact-uat
platform="$root/platform"
release="$platform/releases/$sha"
env_file="$platform/platform.env"
metadata="$release/platform-release.env"
current_sha="$(python3 -c 'import json; print(json.load(open("/opt/dcontact-uat/deployments/current.json"))["sourceSha"])')"
uat_release="$root/releases/$current_sha"
[[ -f "$env_file" && -f "$metadata" && -f "$release/docker-compose.platform.3vm.yml" && -f "$release/docker-compose.platform-keycloak.3vm.yml" ]] || {
  echo 'release/platform.env files are incomplete' >&2; exit 1;
}
[[ "$(stat -c %a "$env_file")" == 600 ]] || { echo 'platform.env must have mode 600' >&2; exit 1; }
[[ -f "$uat_release/docker-compose.uat.3vm.yml" ]] || { echo 'the U1 release has no 3VM overlay' >&2; exit 1; }
[[ "$(sed -n 's/^SOURCE_SHA=//p' "$metadata")" == "$sha" ]] || { echo 'release SHA mismatch' >&2; exit 1; }
for image in PLATFORM_API_IMAGE PLATFORM_CONSOLE_IMAGE PLATFORM_KEYCLOAK_IMAGE; do
  value="$(sed -n "s/^$image=//p" "$metadata")"
  [[ "$value" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || {
    echo "$image is not a digest ref" >&2; exit 1;
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
    [[ -f "$uat_release/docker-compose.uat.line.yml" ]] || { echo 'the U1 LINE overlay is missing' >&2; exit 1; }
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

# Compose may stop the dependent proxy while recreating Keycloak even with --no-deps (#804).
# start the existing container only: the helper's base compose file has no E1/Workspace proxy overlay.
uat_proxy=dcontact-uat-proxy-1
check_uat_proxy() {
  local expected actual
  expected="$(sed -n 's/^CONSOLE_IMAGE=//p' "$uat_release/release.env")"
  [[ "$expected" =~ @sha256:[a-f0-9]{64}$ ]] || { echo 'Tenant Console digest is incomplete' >&2; return 1; }
  actual="$(docker inspect --format '{{.Config.Image}}' "$uat_proxy")" || return 1
  [[ "$actual" == "$expected" ]] || { echo 'Tenant proxy image does not match the current release; stopping before changing Keycloak' >&2; return 1; }
}
resume_uat_proxy() {
  docker start "$uat_proxy" >/dev/null || return 1
  local attempt endpoint status ready
  for attempt in {1..15}; do
    ready=true
    for endpoint in /api/v1/runtime-profile /auth/realms/dcontact/.well-known/openid-configuration; do
      # VM2 has no DNS entry for UAT; still verifies the TLS certificate and goes through the real nginx/allowlist of VM1.
      status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' \
        --resolve dcontact-uat.osd.co.th:443:192.168.102.114 \
        "https://dcontact-uat.osd.co.th$endpoint")" || status=000
      if [[ "$status" != 200 ]]; then ready=false; break; fi
    done
    if [[ "$ready" == true ]]; then return 0; fi
    sleep 2
  done
  echo 'Tenant HTTP/OIDC through VM1 is not ready; do not enable the canary' >&2
  return 1
}
switch_keycloak() {
  local result=0
  "$@" || result=$?
  # restore the proxy even if Compose fails after stopping the dependent; the failure of the switch must still remain.
  resume_uat_proxy || return 1
  return "$result"
}

case "$action" in
  check)
    platform_compose --profile ops config --quiet
    uat_keycloak_overlay config --quiet
    echo "CHECK passed: Platform release $sha; U1 release $current_sha; containers not changed yet"
    ;;
  pull)
    platform_compose --profile ops pull --quiet
    uat_keycloak_overlay pull --quiet keycloak
    echo 'PULL passed: all images by digest are present'
    ;;
  keycloak)
    check_uat_proxy
    switch_keycloak uat_keycloak_overlay up -d --no-deps --wait keycloak
    echo 'KEYCLOAK passed: the new image is healthy; Tenant HTTP/OIDC is ready through VM1'
    ;;
  configure)
    platform_compose up -d --wait mailpit
    platform_compose --profile ops run --rm --no-deps -T platform-keycloak-config
    platform_compose --profile ops run --rm --no-deps -T platform-catalog-seed
    echo 'CONFIGURE passed: platform identity, invitation guard, SMTP and catalog'
    ;;
  start)
    grep -qx 'PLATFORM_PROVISIONING_ENABLED=false' "$env_file" || {
      echo 'rollout enabled before the preflight check; stopping' >&2; exit 1;
    }
    platform_compose up -d --wait platform-api platform-worker platform-console mailpit
    echo 'START passed: the Platform stack is up; provisioning is still off'
    ;;
  update)
    # #901: update the Platform API/worker/Console to this release while the stack is up
    # does not touch Keycloak, platform.env or the rollout values; roll back with `update <previous SHA>`
    # changing Keycloak still requires keycloak/rollback as before
    platform_compose config --quiet
    platform_compose pull --quiet platform-api platform-worker platform-console
    platform_compose up -d --no-deps --force-recreate --wait platform-api platform-worker platform-console
    echo "UPDATE passed: Platform API/worker/Console use release $sha; rollout and Keycloak unchanged"
    ;;
  operator)
    # takes the temporary password from stdin; never pass it as an argument or environment variable
    platform_compose --profile ops run --rm --no-deps -T platform-operator-setup
    ;;
  canary)
    subject="${3:-}"
    [[ "$subject" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || {
      echo 'invalid platform subject UUID' >&2; exit 64;
    }
    [[ -f "$platform/drill-$sha.ok" ]] || { echo 'the rollback drill has not passed' >&2; exit 1; }
    grep -qx 'PLATFORM_PROVISIONING_ENABLED=false' "$env_file" || { echo 'the rollout is not off' >&2; exit 1; }
    python3 - "$env_file" "$subject" <<'PY'
import os, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1]); subject = sys.argv[2]
lines = path.read_text().splitlines()
if sum(line.startswith('PLATFORM_OPERATOR_ALLOWLIST=') for line in lines) != 1 or sum(line.startswith('PLATFORM_PROVISIONING_ENABLED=') for line in lines) != 1:
    raise SystemExit('platform.env has a duplicated or missing rollout key')
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
      echo 'enabling the canary failed; turning the rollout back off immediately' >&2
      python3 - "$env_file" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1]); text = path.read_text().replace('PLATFORM_PROVISIONING_ENABLED=true', 'PLATFORM_PROVISIONING_ENABLED=false')
path.write_text(text)
PY
      platform_compose up -d --no-deps --force-recreate platform-api platform-worker
      exit 1
    fi
    echo "CANARY passed: subject $subject; API and worker use the same rollout"
    ;;
  rollback)
    rm -f "$platform/drill-$sha.ok"
    # turn off mutation/claim first, then restore the U1 Keycloak digest; the ledger/tenant are not deleted
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
    check_uat_proxy
    switch_keycloak uat_compose up -d --no-deps --wait keycloak
    printf '%s\n' "$sha" > "$platform/drill-$sha.ok"
    echo 'ROLLBACK passed: Platform stopped; the previous U1 Keycloak digest is back; DB/ledger unchanged'
    ;;
  status)
    platform_compose ps
    uat_compose ps keycloak
    ;;
esac
