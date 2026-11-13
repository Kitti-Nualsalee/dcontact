#!/usr/bin/env bash
# U1.6 (#434): ขั้นตอน deploy/rollback ของ UAT บน VM — workflow `uat-preview` เรียกทีละขั้นผ่าน SSH
#
# โครงบน VM (ดู docs/u1-uat-deployment.md):
#   $UAT_ROOT/uat.env                 secret + ค่าของ provisioning gate (operator วาง, chmod 600, ไม่อยู่ใน Git)
#   $UAT_ROOT/releases/<sha>/         compose + bin/ + release.env (digest ของ image) ของแต่ละ release
#   $UAT_ROOT/deployments/            deployment record (current.json, previous.json, <time>-<sha>.json)
#   $UAT_ROOT/backups/                pg_dump ก่อน migrate ทุกครั้ง
#   $UAT_ROOT/line-pilot.enabled      มีไฟล์ = ใส่ overlay `uat-line` (#565, ADR-031); ลบแล้ว deploy = ถอด LINE ออก
#   $UAT_ROOT/secrets/line/           secret ของ LINE (operator/vm2-line-secrets.sh) — ใช้เมื่อเปิด overlay เท่านั้น
#
# ไม่มีขั้น down migration และ rollback ไม่แตะฐานข้อมูล (redeploy digest เดิมของ Console/api เท่านั้น)
# ไม่พิมพ์ค่า secret: compose อ่านจาก env file เอง, script พิมพ์เฉพาะสถานะ/ชื่อไฟล์/digest
set -euo pipefail
umask 077

UAT_ROOT="${UAT_ROOT:-/opt/dcontact-uat}"
PROJECT=dcontact-uat
DIGEST_REF='^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'

# #565: overlay `uat-line` เปิดด้วยไฟล์ flag นอก release — release มีไฟล์ overlay เสมอแต่ไม่ถูกใช้ถ้าไม่มี flag
LINE_FLAG="$UAT_ROOT/line-pilot.enabled"
# #567: team trial ซ้อนบน overlay `uat-line` — ต้องมีทั้งสอง flag
TRIAL_FLAG="$UAT_ROOT/line-team-trial.enabled"
E1_FLAG="$UAT_ROOT/e1-acceptance.enabled"
E1_LAUNCHER_FLAG="$UAT_ROOT/e1-launcher-hosting.enabled"

usage() {
  echo 'usage: uat-deploy.sh <prepare|backup|migrate|keycloak|provision|ui-flag|deploy|smoke|record|current|compose-argv|e1-status|e1-enable|e1-disable|e1-voice-control|e1-voice-on|e1-voice-off|e1-launcher-enable|e1-launcher-status|e1-launcher-alias|line-status|line-run|line-reload|rollback-target|rollback> [sha] [...]' >&2
  exit 64
}

fail() {
  echo "{\"type\":\"u1.uat.deploy\",\"status\":\"FAIL\",\"reason\":\"$1\"}" >&2
  exit 1
}

release_dir() {
  local sha="$1"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'SOURCE_SHA_INVALID'
  local dir="$UAT_ROOT/releases/$sha"
  [[ -f "$dir/docker-compose.uat.yml" && -f "$dir/release.env" ]] || fail 'RELEASE_NOT_PREPARED'
  echo "$dir"
}

is_3vm() {
  [[ -f "$1/docker-compose.uat.3vm.yml" ]]
}

# LINE ต้องการ 3 VM (db-relay) และ overlay ใน release; flag มีแต่ release ไม่มี overlay = ล้ม ไม่ deploy แบบเงียบ
is_line() {
  [[ -f "$LINE_FLAG" ]] || return 1
  is_3vm "$1" || fail 'LINE_REQUIRES_3VM'
  [[ -f "$1/docker-compose.uat.line.yml" && -f "$1/Caddyfile.3vm.line" && -f "$1/haproxy-line-egress.cfg" ]] ||
    fail 'RELEASE_LINE_FILE_MISSING'
}

is_trial() {
  [[ -f "$TRIAL_FLAG" ]] || return 1
  is_line "$1" || fail 'TRIAL_REQUIRES_LINE'
  [[ -f "$1/docker-compose.uat.line-trial.yml" ]] || fail 'RELEASE_TRIAL_FILE_MISSING'
}

is_e1() {
  [[ -f "$E1_FLAG" ]] || return 1
  [[ -f "$1/docker-compose.uat.e1.yml" && -f "$1/Caddyfile.3vm.e1" && -x "$1/e1-freeswitch/entrypoint.sh" ]] ||
    fail 'E1_ACCEPTANCE_OVERLAY_MISSING'
}

is_e1_launcher() {
  is_e1 "$1" || return 1
  [[ -f "$E1_LAUNCHER_FLAG" ]] || return 1
  [[ -f "$1/docker-compose.uat.e1-launcher.yml" ]] || fail 'E1_LAUNCHER_OVERLAY_MISSING'
}

is_workspace() {
  [[ "$(release_value "$1" UAT_WORKSPACE_ENABLED)" == true ]] || return 1
  is_e1 "$1" || fail 'WORKSPACE_REQUIRES_E1'
  [[ ! -f "$LINE_FLAG" && ! -f "$TRIAL_FLAG" ]] || fail 'WORKSPACE_LINE_COMBINATION_NOT_SUPPORTED'
  [[ -f "$1/docker-compose.uat.workspace.yml" ]] || fail 'WORKSPACE_OVERLAY_MISSING'
  [[ -n "$(release_value "$1" UAT_WORKSPACE_HOST)" ]] || fail 'WORKSPACE_HOST_MISSING'
}

# ตั้ง array `prefix` ของผู้เรียก (dynamic scope) เป็นคำสั่ง compose ของ release นี้ ไม่รวม subcommand
compose_prefix() {
  local dir="$1"
  if is_3vm "$dir"; then
    local binary="$UAT_ROOT/bin/docker-compose"
    [[ -x "$binary" ]] || fail 'COMPOSE_3VM_BINARY_MISSING'
    local files=(-f "$dir/docker-compose.uat.yml" -f "$dir/docker-compose.uat.3vm.yml")
    if is_e1 "$dir"; then files+=(-f "$dir/docker-compose.uat.e1.yml"); fi
    if is_e1_launcher "$dir"; then files+=(-f "$dir/docker-compose.uat.e1-launcher.yml"); fi
    if is_workspace "$dir"; then files+=(-f "$dir/docker-compose.uat.workspace.yml"); fi
    if is_line "$dir"; then files+=(-f "$dir/docker-compose.uat.line.yml"); fi
    if is_trial "$dir"; then files+=(-f "$dir/docker-compose.uat.line-trial.yml"); fi
    prefix=("$binary")
  else
    local files=(-f "$dir/docker-compose.uat.yml")
    if is_e1 "$dir"; then files+=(-f "$dir/docker-compose.uat.e1.yml"); fi
    if is_e1_launcher "$dir"; then files+=(-f "$dir/docker-compose.uat.e1-launcher.yml"); fi
    if is_workspace "$dir"; then files+=(-f "$dir/docker-compose.uat.workspace.yml"); fi
    prefix=(docker compose)
  fi
  prefix+=(--project-name "$PROJECT" --project-directory "$dir"
    --env-file "$UAT_ROOT/uat.env" --env-file "$dir/release.env" "${files[@]}")
}

compose() {
  local dir="$1"
  shift
  local deadline=()
  if [[ "${1:-}" == --rollback-probe ]]; then
    deadline=(timeout --signal=TERM --kill-after=5s 45s)
    shift
  fi
  local prefix=()
  compose_prefix "$dir"
  ${deadline[@]+"${deadline[@]}"} "${prefix[@]}" "$@"
}

database_service() {
  if is_3vm "$1"; then echo db-relay; else echo postgres; fi
}

release_value() {
  local dir="$1" name="$2"
  sed -n "s/^${name}=//p" "$dir/release.env" | tail -n 1
}

# GNU (VM/runner) กับ BSD (macOS — ซ้อมบนเครื่องด้วย uat-local.sh) ใช้ option ของ stat/sha256 ต่างกัน
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

check_release_env() {
  local dir="$1" name value
  for name in API_IMAGE CONSOLE_IMAGE OPS_IMAGE KEYCLOAK_IMAGE; do
    value="$(release_value "$dir" "$name")"
    [[ "$value" =~ $DIGEST_REF ]] || fail "${name}_NOT_DIGEST_PINNED"
  done
  [[ "$(release_value "$dir" SOURCE_SHA)" =~ ^[0-9a-f]{40}$ ]] || fail 'SOURCE_SHA_INVALID'
}

# ใช้ lock เดียวกับ reconciliation สำหรับคำสั่ง deploy ที่เปลี่ยน runtime หรือ record
uat_mutation_lock() {
  [[ ! -L "$UAT_ROOT/operator" ]] || fail 'UAT_LOCK_DIRECTORY_INVALID'
  mkdir -p -m 700 "$UAT_ROOT/operator"
  [[ ! -L "$UAT_ROOT/operator/b714-cutover.lock" ]] || fail 'UAT_LOCK_INVALID'
  exec 9<>"$UAT_ROOT/operator/b714-cutover.lock"
  python3 - "$UAT_ROOT/operator" "$UAT_ROOT/operator/b714-cutover.lock" <<'PY'
import os
import fcntl
import stat
import sys

for path in sys.argv[1:]:
    info = os.lstat(path)
    if info.st_uid != os.geteuid() or info.st_mode & 0o077 or stat.S_ISLNK(info.st_mode):
        sys.exit('UAT_LOCK_INVALID')
if not stat.S_ISDIR(os.lstat(sys.argv[1]).st_mode) or not stat.S_ISREG(os.lstat(sys.argv[2]).st_mode):
    sys.exit('UAT_LOCK_INVALID')
opened, named = os.fstat(9), os.lstat(sys.argv[2])
if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino):
    sys.exit('UAT_LOCK_INVALID')
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit('UAT_MUTATION_LOCK_BUSY')
PY
  [[ ! -e "$UAT_ROOT/operator/b714-reconciliation.pending" && ! -L "$UAT_ROOT/operator/b714-reconciliation.pending" ]] || fail 'UAT_RECONCILIATION_PENDING'
  [[ ! -e "$UAT_ROOT/operator/uat-record-transaction" && ! -L "$UAT_ROOT/operator/uat-record-transaction" ]] || fail 'UAT_RECORD_TRANSACTION_PENDING'
  [[ ! -e "$UAT_ROOT/operator/uat-record-retirement.pending" && ! -L "$UAT_ROOT/operator/uat-record-retirement.pending" ]] || fail 'UAT_RECORD_RETIREMENT_PENDING'
  # #868: ระหว่างสลับ API runtime ไม่ตรง current record จึงห้าม deploy/record ทุกชนิดจน recover
  [[ ! -e "$UAT_ROOT/operator/uat-api-switch.pending" && ! -L "$UAT_ROOT/operator/uat-api-switch.pending" ]] || fail 'UAT_API_SWITCH_PENDING'
  if [[ "${1:-}" != allow-rollback-record ]]; then
    [[ ! -e "$UAT_ROOT/operator/uat-rollback.pending" && ! -L "$UAT_ROOT/operator/uat-rollback.pending" ]] || fail 'UAT_ROLLBACK_PENDING'
  fi
}

# ตรวจตั้งแต่ก่อน migrate/deploy เพื่อไม่ให้ runtime เปลี่ยนก่อนพบว่า record เขียนไม่ได้
# #868: authorization จาก operator/b868-forward-authorize.py ใช้ได้กับ candidate เดียว, current/previous bytes เดิม,
# release.env ที่ prepare แล้ว และก่อน expiresAt เท่านั้น เมื่อ record ของ candidate ถูกเขียน current hash เปลี่ยน
# #901: operator/uat-additive-authorize.py ออก authorization แบบเบาให้ release ที่ migration guard ผ่าน
# ทับ deploy/rollback record ปกติ โดยผูก release.env, migration-guard.json และ current/previous bytes ชุดเดียวกัน
uat_forward_authorized() {
  local sha="${1:-}"
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || return 1
  python3 - "$UAT_ROOT" "$sha" <<'PY' 2>/dev/null
import hashlib, json, os, re, stat, sys
from datetime import datetime, timezone
root, sha = sys.argv[1:]
def private(path, mask=0o077):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & mask or info.st_size > 8388608:
            raise ValueError('invalid file')
        return stream.read()
def when(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z', value):
        raise ValueError('invalid time')
    return datetime.fromisoformat(value[:-1] + '+00:00')
try:
    data = json.loads(private(os.path.join(root, 'operator', 'uat-forward-deploy.authorization')))
    current = private(os.path.join(root, 'deployments', 'current.json'))
    previous = private(os.path.join(root, 'deployments', 'previous.json'))
    release = private(os.path.join(root, 'releases', sha, 'release.env'), 0o022)
    now = datetime.now(timezone.utc)
    validation = data.get('validation') or {}
    record = json.loads(current)
    common = (data.get('targetSha') == sha
              and data.get('releaseEnvSha256') == hashlib.sha256(release).hexdigest()
              and data.get('currentRecordSha256') == hashlib.sha256(current).hexdigest()
              and data.get('previousRecordSha256') == hashlib.sha256(previous).hexdigest()
              and data.get('rollbackCertified') is False
              and re.fullmatch(r'operator:[A-Za-z0-9][A-Za-z0-9._@-]{0,127}', str(data.get('actor', '')))
              and when(data.get('authorizedAt')).timestamp() <= now.timestamp() + 30
              and now < when(data.get('expiresAt')))
    if data.get('schema') == 'UatAdditiveDeployAuthorizationV1':
        # #901: release ที่ migration guard ผ่านทับ deploy/rollback record ปกติ ไม่ต้องซ้อม #868
        guard_raw = private(os.path.join(root, 'releases', sha, 'migration-guard.json'), 0o022)
        guard = json.loads(guard_raw)
        checks = guard.get('checks') or [{}]
        base = record.get('sourceSha')
        ok = (common and record.get('schema') == 'UatDeploymentRecordV1'
              and record.get('action') in ('deploy', 'rollback') and data.get('baseSha') == base != sha
              and data.get('migrationGuardSha256') == hashlib.sha256(guard_raw).hexdigest()
              and (guard.get('type'), guard.get('mode'), guard.get('status'), guard.get('base'), guard.get('head'))
                  == ('u1.uat.readiness', 'migration-guard', 'PASS', base, sha)
              and len(checks) == 1 and str(checks[0].get('id', '')).startswith('UAT-M01 ')
              and checks[0].get('status') == 'PASS')
        sys.exit(0 if ok else 1)
    ok = (data.get('schema') == 'UatForwardDeployAuthorizationV1' and data.get('targetSha') == sha
          and data.get('releaseEnvSha256') == hashlib.sha256(release).hexdigest()
          and data.get('currentRecordSha256') == hashlib.sha256(current).hexdigest()
          and data.get('previousRecordSha256') == hashlib.sha256(previous).hexdigest()
          and data.get('rollbackCertified') is False
          and re.fullmatch(r'operator:[A-Za-z0-9][A-Za-z0-9._@-]{0,127}', str(data.get('actor', '')))
          and validation.get('status') == 'ISOLATED_API_ROLLBACK_REHEARSAL_MATCHES_BASELINE'
          and validation.get('candidateSourceSha') == sha
          and validation.get('candidateReleaseEnvSha256') == data['releaseEnvSha256']
          and (record.get('schema'), record.get('action'), record.get('rollbackEligible')) == (
              'UatDeploymentReconciliationV1', 'reconciliation', False)
          and when(data.get('authorizedAt')).timestamp() <= now.timestamp() + 30
          and now < when(data.get('expiresAt')))
except (OSError, ValueError, TypeError, AttributeError):
    ok = False
sys.exit(0 if ok else 1)
PY
}

uat_require_recordable_current() {
  if [[ -n "${1:-}" ]] && uat_forward_authorized "$1"; then return 0; fi
  python3 - "$UAT_ROOT/deployments/current.json" <<'PY'
import json
import os
import re
import stat
import sys

path = sys.argv[1]
if os.path.lexists(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError('record permissions invalid')
            record = json.load(stream)
        if not isinstance(record, dict):
            raise ValueError('record must be an object')
    except (OSError, ValueError):
        sys.exit('RECORD_CURRENT_INVALID')
    if record.get('action') == 'reconciliation' or record.get('rollbackEligible') is False:
        sys.exit('RECORD_RECONCILIATION_REQUIRES_REVIEW')
    if (record.get('schema') != 'UatDeploymentRecordV1' or record.get('action') not in ('deploy', 'rollback')
            or not isinstance(record.get('sourceSha'), str) or not re.fullmatch('[0-9a-f]{40}', record['sourceSha'])):
        sys.exit('RECORD_CURRENT_INVALID')
PY
}

# release ที่เคย deploy แล้วต้องใช้ rollback guard ไม่ใช่สั่ง deploy ย้อนตรง
uat_require_nonhistorical_target() {
  local sha="$1" current='' recorded
  if [[ -f "$UAT_ROOT/deployments/current.json" ]]; then
    current="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceSha"])' "$UAT_ROOT/deployments/current.json")"
  else
    for recorded in "$UAT_ROOT"/deployments/*-*.json; do
      [[ ! -e "$recorded" && ! -L "$recorded" ]] || fail 'UAT_CURRENT_RECORD_REQUIRED'
    done
    return
  fi
  [[ "$current" != "$sha" ]] || return 0
  for recorded in "$UAT_ROOT"/deployments/*-"$sha".json; do
    [[ ! -e "$recorded" && ! -L "$recorded" ]] || fail 'UAT_PREVIOUS_RELEASE_REQUIRES_ROLLBACK'
  done
  # ยังไม่มีหลักฐาน compatibility ที่ผูกกับ target: ปฏิเสธไว้ก่อน ไม่เดาว่า SHA ที่ไม่รู้จักใหม่กว่า
  # ยกเว้น authorization ของ #868 ที่ผูกหลักฐาน candidate กับ current record ปัจจุบัน
  uat_forward_authorized "$sha" && return 0
  fail 'UAT_TARGET_COMPATIBILITY_EVIDENCE_REQUIRED'
}

# ตรวจ record และ image ที่รันจริงก่อนเขียน pointer; ไม่พิมพ์ Docker configuration
uat_verify_record_runtime() {
  local dir="$1" sha="$2" record="$3" mode="${4:-record}" e1=false
  if is_e1 "$dir"; then e1=true; fi
  python3 - "$record" "$sha" "$e1" "$mode" \
    "$(release_value "$dir" API_IMAGE)" "$(release_value "$dir" CONSOLE_IMAGE)" \
    "$(release_value "$dir" KEYCLOAK_IMAGE)" "$(release_value "$dir" OPS_IMAGE)" <<'PY'
import base64
import json
import os
import re
import stat
import subprocess
import sys

path, sha, e1, mode, api, console, keycloak, ops = sys.argv[1:]
expected = {'api': api, 'console': console, 'keycloak': keycloak, 'ops': ops}
try:
    if mode == 'record':
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > 8388608:
                raise ValueError('invalid record file')
            record_bytes = stream.read(8388609)
            if len(record_bytes) > 8388608:
                raise ValueError('record too large')
            record = json.loads(record_bytes)
        if (not isinstance(record, dict) or record.get('schema') != 'UatDeploymentRecordV1'
                or record.get('action') not in ('deploy', 'rollback') or record.get('sourceSha') != sha
                or record.get('images') != expected):
            sys.exit('RECORD_CONTENT_MISMATCH')
        refs = {'api': api, 'proxy': console, 'keycloak': keycloak}
    elif mode == 'untouched':
        refs = {'keycloak': keycloak}
    else:
        sys.exit('RECORD_VALIDATION_MODE_INVALID')
    if e1 == 'true':
        refs['e1-sandbox'] = api
    names = ['dcontact-uat-' + service + '-1' for service in refs]
    output = subprocess.run(['docker', 'inspect', *names], check=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=20)
    containers = json.loads(output.stdout)
    if len(containers) != len(names) or {x['Name'].lstrip('/') for x in containers} != set(names):
        sys.exit('RECORD_RUNTIME_INVENTORY_MISMATCH')
    expected_ids = {}
    for container in containers:
        service = container['Name'].lstrip('/')[len('dcontact-uat-'):-2]
        labels = container['Config'].get('Labels') or {}
        state = container['State']
        if (labels.get('org.opencontainers.image.revision') != sha
                or labels.get('com.docker.compose.project') != 'dcontact-uat'
                or state.get('Running') is not True
                or state.get('Health', {}).get('Status', 'healthy') != 'healthy'
                or not re.fullmatch('sha256:[0-9a-f]{64}', container.get('Image', ''))):
            sys.exit('RECORD_RUNTIME_COMPONENT_MISMATCH')
        expected_ids.setdefault(container['Image'], set()).add(refs[service])
    image_refs = sorted(expected_ids) + ([ops] if mode == 'record' else [])
    output = subprocess.run(['docker', 'image', 'inspect', *image_refs], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20)
    images = json.loads(output.stdout)
    if len(images) != len(image_refs):
        sys.exit('RECORD_IMAGE_INVENTORY_MISMATCH')
    for image, reference in zip(images, image_refs):
        wanted = expected_ids[reference] if reference in expected_ids else {ops}
        labels = image.get('Config', {}).get('Labels') or {}
        if (not wanted.issubset(set(image.get('RepoDigests') or []))
                or labels.get('org.opencontainers.image.revision') != sha
                or (reference in expected_ids and image.get('Id') != reference)):
            sys.exit('RECORD_IMAGE_DIGEST_MISMATCH')
    if mode == 'record':
        sys.stdout.write(base64.b64encode(record_bytes).decode('ascii'))
except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
    sys.exit('RECORD_RUNTIME_VALIDATION_FAILED')
PY
}

# ไม่ถือ proposal หรือ record schema ที่ไม่รู้จักว่าเป็น rollback target
uat_resolve_rollback_record() {
  local target="$1" expected_sha="${2:-}"
  if [[ $# -ge 2 ]]; then shift 2; else shift; fi
  python3 - "$target" "$expected_sha" "$@" <<'PY'
import json
import os
import re
import stat
import sys

try:
    descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, encoding='utf-8') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 8388608:
            raise ValueError('invalid file')
        record = json.load(stream)
    if not isinstance(record, dict):
        raise ValueError('invalid record')
except (OSError, ValueError):
    sys.exit('ROLLBACK_TARGET_INVALID')
if record.get('action') == 'reconciliation' or ('rollbackEligible' in record and record['rollbackEligible'] is not True):
    sys.exit('RECONCILIATION_NOT_ROLLBACK_CERTIFIED')
sha = record.get('sourceSha')
images = record.get('images')
if (record.get('schema') != 'UatDeploymentRecordV1' or record.get('action') not in ('deploy', 'rollback')
        or not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha)
        or (sys.argv[2] and sha != sys.argv[2]) or not isinstance(images, dict)
        or set(images) != {'api', 'console', 'ops', 'keycloak'}
        or any(not isinstance(ref, str) or not re.fullmatch(r'[a-z0-9.-]+(?::[0-9]+)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}', ref)
               for ref in images.values())):
    sys.exit('ROLLBACK_TARGET_INVALID')
if len(sys.argv) > 3:
    if len(sys.argv) != 7 or images != dict(zip(('api', 'console', 'ops', 'keycloak'), sys.argv[3:])):
        sys.exit('ROLLBACK_TARGET_RELEASE_MISMATCH')
print(json.dumps(record))
PY
}

# Archive ใหม่มีสิทธิ์เป็น target เมื่อบันทึก pointer และ marker ที่ผูก bytes ครบแล้วเท่านั้น
uat_require_committed_archive() {
  python3 - "$1" <<'PY'
import hashlib, os, stat, sys
path = sys.argv[1]
def read_private(name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > limit:
            raise ValueError('invalid file')
        return stream.read(limit + 1)
try:
    archive = read_private(path, 8388608)
    marker = read_private(path + '.committed', 65)
    if marker != (hashlib.sha256(archive).hexdigest() + '\n').encode():
        raise ValueError('digest mismatch')
except (OSError, ValueError):
    sys.exit('ROLLBACK_ARCHIVE_NOT_COMMITTED')
PY
}

uat_require_committed_pointer() {
  local pointer="$1" archive
  for archive in "$UAT_ROOT"/deployments/*-*.json; do
    [[ -f "$archive" && ! -L "$archive" ]] || continue
    uat_require_committed_archive "$archive" 2>/dev/null || continue
    cmp -s "$pointer" "$archive" && return 0
  done
  fail 'ROLLBACK_POINTER_NOT_COMMITTED'
}

rollback_probe_cleanup() {
  local name="$1" ownership remaining id
  if ownership="$(timeout --signal=TERM --kill-after=2s 5s docker inspect \
    --format '{{.Id}}|{{ index .Config.Labels "com.dcontact.rollback-probe" }}' "$name" 2>/dev/null)"; then
    id="${ownership%%|*}"
    [[ "$id" =~ ^[0-9a-f]{64}$ && "$ownership" == "$id|$name" ]] || return 1
    timeout --signal=TERM --kill-after=2s 5s docker rm -f "$id" >/dev/null 2>&1 || return 1
  fi
  remaining="$(timeout --signal=TERM --kill-after=2s 5s docker ps -aq \
    --filter "name=^/${name}$" 2>/dev/null)" || return 1
  [[ -z "$remaining" ]]
}

rollback_preflight() (
  local dir="$1" ledger capability database principal probe active_probe=''
  command -v timeout >/dev/null 2>&1 || fail 'ROLLBACK_TIMEOUT_REQUIRED'
  probe="dcontact-uat-rollback-$$-${RANDOM}-${RANDOM}"
  trap 'exit 143' TERM
  trap 'exit 130' INT
  trap 'exit 129' HUP
  trap 'if [[ -n "$active_probe" ]]; then
    rollback_probe_cleanup "$active_probe" || {
      echo "{\"type\":\"u1.uat.deploy\",\"status\":\"RECONCILIATION_REQUIRED\",\"reason\":\"ROLLBACK_PROBE_CLEANUP_UNKNOWN\",\"probe\":\"$active_probe\"}" >&2
      exit 1
    }
  fi' EXIT
  if is_3vm "$dir"; then
    database=dcontact_uat
    principal="AND current_user='dcontact_uat_owner'"
  else
    database=dcontact
    principal=''
  fi
  active_probe="$probe-ledger"
  if ! ledger="$(compose "$dir" --rollback-probe --profile ops run --rm -T --no-deps --pull never \
    --name "$probe-ledger" --label "com.dcontact.rollback-probe=$probe-ledger" \
    -e PGCONNECT_TIMEOUT=5 \
    -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000' \
    --entrypoint psql db-roles -X -qAt -v ON_ERROR_STOP=1 -f - 2>/dev/null <<SQL
BEGIN READ ONLY;
SELECT CASE
  WHEN NOT (current_database()='$database' $principal) THEN 'INVALID_SCOPE'
  WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE (finished_at IS NULL AND rolled_back_at IS NULL)
       OR (finished_at IS NOT NULL AND rolled_back_at IS NOT NULL)) THEN 'INVALID_LEDGER'
  WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20261103120000_tenant_provisioned_configuration_authority'
      AND checksum<>'f5feda4f26297ed4bc98aa85c1e298e43e7292e44d66791b0f708fa6d53c8c47') THEN 'INVALID_CHECKSUM'
  WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20261103120000_tenant_provisioned_configuration_authority'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN 'B7_AUTHORITY_APPLIED'
  WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20261022130000_tenant_voice_skill_scope'
      AND checksum<>'5e281f7a38bace24cf114dde5a0484a41a0e01d2b317ea95293fce41a8f825c9') THEN 'INVALID_CHECKSUM'
  WHEN (SELECT count(*) FROM public._prisma_migrations
    WHERE migration_name='20261022130000_tenant_voice_skill_scope'
      AND rolled_back_at IS NULL)>1 THEN 'AMBIGUOUS_LEDGER'
  WHEN EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20261022130000_tenant_voice_skill_scope'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN 'APPLIED'
  ELSE 'ABSENT' END;
COMMIT;
SQL
  )"; then
    fail 'ROLLBACK_LEDGER_QUERY_FAILED'
  fi
  rollback_probe_cleanup "$active_probe" || fail 'ROLLBACK_PROBE_CLEANUP_UNKNOWN'
  active_probe=''
  case "$ledger" in
    ABSENT) return ;;
    APPLIED) ;;
    B7_AUTHORITY_APPLIED) fail 'ROLLBACK_B7_COMPATIBILITY_NOT_CERTIFIED' ;;
    *) fail 'ROLLBACK_LEDGER_INVALID' ;;
  esac
  active_probe="$probe-capability"
  if ! capability="$(timeout --signal=TERM --kill-after=5s 30s docker run --rm --pull never \
    --name "$probe-capability" --label "com.dcontact.rollback-probe=$probe-capability" \
    --network none --read-only \
    --cap-drop ALL --security-opt no-new-privileges --memory 128m --cpus 0.5 --pids-limit 64 \
    --entrypoint /usr/bin/timeout "$(release_value "$dir" API_IMAGE)" 20s node -e '
const { Prisma } = require("/app/node_modules/@d-contact/db");
const models = Prisma.dmmf.datamodel.models;
const scoped = ["AgentSkill", "QueueSkill"].every(name => models.some(model =>
  model.name === name && model.fields.some(field => field.name === "tenantId" &&
    field.dbName === "tenant_id" && field.type === "String" && field.isRequired && field.kind === "scalar")));
process.stdout.write(scoped ? "SCOPED" : "UNSCOPED");
' 2>/dev/null)"; then
    fail 'ROLLBACK_CAPABILITY_QUERY_FAILED'
  fi
  rollback_probe_cleanup "$active_probe" || fail 'ROLLBACK_PROBE_CLEANUP_UNKNOWN'
  active_probe=''
  [[ "$capability" == SCOPED ]] || fail 'ROLLBACK_SKILL_SCOPE_INCOMPATIBLE'
)

prepare_mount_templates() {
  local dir="$1" file directory
  local configs=(Caddyfile Caddyfile.3vm Caddyfile.3vm.e1 haproxy-db-relay.cfg operator/e1-launcher-releases.mjs)
  local directories=(e1-freeswitch e1-freeswitch/conf e1-freeswitch/conf/autoload_configs
    e1-freeswitch/conf/dialplan e1-freeswitch/conf/directory e1-freeswitch/conf/sip_profiles)
  local e1_configs=(autoload_configs/acl.conf.xml autoload_configs/event_socket.conf.xml
    autoload_configs/modules.conf.xml autoload_configs/sofia.conf.xml
    autoload_configs/switch.conf.xml autoload_configs/xml_curl.conf.xml
    dialplan/default.xml directory/default.xml freeswitch.xml sip_profiles/internal.xml vars.xml)
  if [[ -d "$dir/e1-freeswitch" ]]; then
    for directory in "${directories[@]}"; do
      [[ -d "$dir/$directory" && ! -L "$dir/$directory" ]] || fail 'E1_SOURCE_TEMPLATE_INVALID'
    done
    for file in "${e1_configs[@]}"; do
      [[ -f "$dir/e1-freeswitch/conf/$file" && ! -L "$dir/e1-freeswitch/conf/$file" ]] || fail 'E1_SOURCE_TEMPLATE_INVALID'
    done
    grep -Fq '<param name="password" value="__E1_ESL_PASSWORD__"/>' "$dir/e1-freeswitch/conf/autoload_configs/event_socket.conf.xml" || fail 'E1_SOURCE_TEMPLATE_RENDERED'
    grep -Fq '<param name="gateway-credentials" value="e1-uat-sandbox:__E1_DIRECTORY_PASSWORD__"/>' "$dir/e1-freeswitch/conf/autoload_configs/xml_curl.conf.xml" || fail 'E1_SOURCE_TEMPLATE_RENDERED'
    for directory in "${directories[@]}"; do chmod 0755 "$dir/$directory"; done
    for file in "${e1_configs[@]}"; do chmod 0444 "$dir/e1-freeswitch/conf/$file"; done
  fi
  for file in "${configs[@]}"; do
    if [[ -e "$dir/$file" || -L "$dir/$file" ]]; then
      [[ -f "$dir/$file" && ! -L "$dir/$file" ]] || fail 'MOUNT_SOURCE_TEMPLATE_INVALID'
      chmod 0444 "$dir/$file"
    fi
  done
}

cmd="${1:-}"
[[ -n "$cmd" ]] || usage
shift

[[ -f "$UAT_ROOT/uat.env" ]] || fail 'UAT_ENV_MISSING'
if [[ "$(file_mode "$UAT_ROOT/uat.env")" != '600' ]]; then fail 'UAT_ENV_PERMISSIONS'; fi
mkdir -p "$UAT_ROOT/deployments" "$UAT_ROOT/backups"
# #868: directory ของ admission fence ต้องมีก่อน proxy mount; ไม่สร้างไฟล์ fence ให้อัตโนมัติ
mkdir -p -m 755 "$UAT_ROOT/admission-fence"

case "$cmd" in
  prepare)
    dir="$(release_dir "${1:?sha}")"
    check_release_env "$dir"
    prepare_mount_templates "$dir"
    if is_3vm "$dir"; then
      for file in "$dir/Caddyfile.3vm" "$dir/haproxy-db-relay.cfg" "$dir/bin/db-roles-3vm.sh"; do
        [[ -f "$file" ]] || fail 'RELEASE_3VM_FILE_MISSING'
      done
      [[ -x "$UAT_ROOT/bin/docker-compose" ]] || fail 'COMPOSE_3VM_BINARY_MISSING'
    fi
    chmod 700 "$dir/bin"/*.sh
    if [[ -d "$dir/e1-freeswitch" ]]; then chmod 0555 "$dir/e1-freeswitch/entrypoint.sh"; fi
    # #540: entrypoint ของ object storage ถูก mount เข้า container ที่รันเป็น uid 1000 (ไม่ใช่ root) — ต้องอ่านได้
    # ไฟล์ไม่มี secret (secret มาจาก env ของ container) และรันผ่าน `sh` จึงไม่ต้อง execute
    chmod 0444 "$dir/bin/object-storage-entrypoint.sh"
    compose "$dir" config --quiet
    compose "$dir" --profile ops pull --quiet
    echo '{"type":"u1.uat.deploy","step":"prepare","status":"PASS"}'
    ;;

  backup)
    dir="$(release_dir "${1:?sha}")"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    if is_3vm "$dir"; then
      # VM3 ใช้ PostgreSQL 15.4: dump ผ่าน relay ด้วย client v15 เท่านั้น
      compose "$dir" up -d --wait db-relay
      for database in dcontact_uat keycloak_uat; do
        file="$UAT_ROOT/backups/pg-${database}-${stamp}.dump"
        if [[ "$database" == dcontact_uat ]]; then
          compose "$dir" --profile ops run --rm -T --entrypoint pg_dump db-roles \
            -d "$database" --format=custom --no-owner >"$file.partial" || { rm -f "$file.partial"; fail 'BACKUP_FAILED'; }
        else
          compose "$dir" --profile ops run --rm -T keycloak-backup \
            -d "$database" --format=custom --no-owner >"$file.partial" || { rm -f "$file.partial"; fail 'BACKUP_FAILED'; }
        fi
        [[ -s "$file.partial" ]] || { rm -f "$file.partial"; fail 'BACKUP_EMPTY'; }
        mv "$file.partial" "$file"
      done
      digest="$(sha256_of "$UAT_ROOT/backups/pg-dcontact_uat-${stamp}.dump")"
      echo "{\"type\":\"u1.uat.deploy\",\"step\":\"backup\",\"status\":\"PASS\",\"file\":\"backups/pg-dcontact_uat-${stamp}.dump\",\"sha256\":\"${digest}\"}"
    else
      if [[ -z "$(compose "$dir" ps --status running --quiet postgres)" ]]; then
        echo '{"type":"u1.uat.deploy","step":"backup","status":"SKIPPED","reason":"NO_DATABASE_YET"}'
        exit 0
      fi
      for database in dcontact keycloak; do
        file="$UAT_ROOT/backups/pg-${database}-${stamp}.dump"
        compose "$dir" exec -T postgres sh -ec \
          "pg_dump -U \"\$POSTGRES_USER\" -d ${database} --format=custom --no-owner" >"$file.partial"
        mv "$file.partial" "$file"
        [[ -s "$file" ]] || fail 'BACKUP_EMPTY'
      done
      digest="$(sha256_of "$UAT_ROOT/backups/pg-dcontact-${stamp}.dump")"
      echo "{\"type\":\"u1.uat.deploy\",\"step\":\"backup\",\"status\":\"PASS\",\"file\":\"backups/pg-dcontact-${stamp}.dump\",\"sha256\":\"${digest}\"}"
    fi
    ;;

  migrate)
    dir="$(release_dir "${1:?sha}")"
    uat_mutation_lock
    uat_require_recordable_current "${1:?sha}"
    uat_require_nonhistorical_target "${1:?sha}"
    compose "$dir" up -d --wait "$(database_service "$dir")"
    compose "$dir" --profile ops run --rm -T db-roles >/dev/null
    compose "$dir" --profile ops run --rm -T migrate
    # rls.sql สร้าง role ที่ยังไม่มีด้วยรหัสผ่านของ dev — ตั้งทับ/ปิด login ทุกครั้งหลัง migrate
    compose "$dir" --profile ops run --rm -T db-roles
    ;;

  keycloak)
    dir="$(release_dir "${1:?sha}")"
    uat_mutation_lock
    uat_require_recordable_current "${1:?sha}"
    uat_require_nonhistorical_target "${1:?sha}"
    compose "$dir" up -d --wait keycloak
    compose "$dir" --profile ops run --rm -T keycloak-config
    ;;

  provision)
    # U1.8 (#502): tenant/บัญชี maker-reviewer/rollout/fixture pack จากไฟล์ `UatProvisionV1` ของ operator
    # ไฟล์มีอีเมลจริง → ต้อง chmod 600 และส่งทาง stdin (ไม่ mount เข้า container, ไม่ผ่าน command line)
    # `--check` = validate + preflight แบบ read-only; ผลเป็น JSON lines ที่มีแค่ id/สถานะ/digest
    dir="$(release_dir "${1:?sha}")"
    file="${2:?provision input file}"
    [[ -f "$file" ]] || fail 'PROVISION_INPUT_MISSING'
    if [[ "$(file_mode "$file")" != '600' ]]; then fail 'PROVISION_INPUT_PERMISSIONS'; fi
    case "${3:-}" in
      '') mode=() ;;
      --check) mode=(--check) ;;
      *) usage ;;
    esac
    compose "$dir" up -d --wait "$(database_service "$dir")"
    compose "$dir" --profile ops run --rm -T uat-provision ${mode[@]+"${mode[@]}"} --input - <"$file"
    ;;

  ui-flag)
    # E1.16 (#490): ใช้ domain CLI เดิมเพื่อให้ flag และ audit เปลี่ยนใน transaction เดียว
    dir="$(release_dir "${1:?sha}")"
    tenant="${2:?tenant slug}"
    action="${3:?on or off}"
    actor="${4:?operator actor}"
    case "$action" in
      on)
        mode=(--on --ack-voice-pilot)
        reason='E1.16 UAT acceptance'
        ;;
      off)
        mode=(--off)
        reason='E1.16 UAT rollback'
        ;;
      *) usage ;;
    esac
    compose "$dir" up -d --wait "$(database_service "$dir")"
    compose "$dir" --profile ops run --rm -T tenant-ui-flag \
      --tenant "$tenant" "${mode[@]}" --flag dphone.embed.enabled --reason "$reason" --actor "$actor"
    ;;

  deploy)
    dir="$(release_dir "${1:?sha}")"
    uat_mutation_lock
    uat_require_recordable_current "${1:?sha}"
    uat_require_nonhistorical_target "${1:?sha}"
    # #540: object storage (SeaweedFS; s3.json + policy ของ API สร้างใน entrypoint) → bucket private
    # ก่อน api บูต (U1.5 #433: api ไม่บูตถ้า bucket ไม่พร้อม) แล้ว lifecycle ที่รันต่อเนื่อง
    compose "$dir" up -d --wait object-storage
    compose "$dir" run --rm -T object-storage-init
    # --no-deps: object-storage-init จบไปแล้วข้างบน และไม่ให้ `--wait` ไปรอ container one-shot ที่ exit แล้ว
    # #565: ไม่มี flag = container line-* เป็น orphan และถูกถอดที่นี่; runner/relay ไม่รันค้าง (profile line-pilot)
    services=(object-storage-lifecycle api proxy)
    if is_e1 "$dir"; then services+=(freeswitch e1-sandbox); fi
    if is_line "$dir"; then services+=(line-webhook); fi
    # #567: trial = relay รันตลอด; ไม่มี trial = ถอด relay ที่อาจค้างจาก trial ก่อนหน้า (runner เรียกขึ้นใหม่เองได้)
    if is_trial "$dir"; then
      services+=(line-egress)
    elif is_line "$dir"; then
      compose "$dir" --profile line-pilot rm -sf line-egress >/dev/null
    fi
    compose "$dir" up -d --wait --no-deps --remove-orphans "${services[@]}"
    echo '{"type":"u1.uat.deploy","step":"deploy","status":"PASS"}'
    ;;

  smoke)
    dir="$(release_dir "${1:?sha}")"
    uat_host="$(sed -n 's/^UAT_HOST=//p' "$UAT_ROOT/uat.env" | tail -n 1)"
    # token ของบัญชีทดสอบ (ถ้ามี) รับทาง stdin เท่านั้น — ไม่ผ่าน command line/env ของ SSH
    if [[ "${2:-}" == '--token-stdin' ]]; then
      IFS= read -r UAT_SMOKE_ACCESS_TOKEN || true
      export UAT_SMOKE_ACCESS_TOKEN
    fi
    # โหมด 3 VM: TLS อยู่ที่ nginx VM1; โหมดเครื่องเดียว: TLS อยู่ใน proxy บน host เดียวกัน
    local_connect_host=127.0.0.1
    if is_3vm "$dir"; then local_connect_host=192.168.102.114; fi
    expected_profile=uat
    if is_e1 "$dir"; then expected_profile=uat-e1; fi
    if is_workspace "$dir"; then expected_profile=uat-workspace; fi
    # Docker Desktop (uat-local.sh บน macOS) ใช้ host.docker.internal ผ่าน env override
    docker run --rm --network "${UAT_SMOKE_DOCKER_NETWORK:-host}" \
      -e "UAT_BASE_URL=https://${uat_host}" \
      -e "UAT_CONNECT_HOST=${UAT_SMOKE_CONNECT_HOST:-$local_connect_host}" \
      -e UAT_SMOKE_ACCESS_TOKEN \
      -e "UAT_EXPECTED_API_PROFILE=$expected_profile" \
      -e NODE_EXTRA_CA_CERTS \
      ${NODE_EXTRA_CA_CERTS:+-v "$NODE_EXTRA_CA_CERTS:$NODE_EXTRA_CA_CERTS:ro"} \
      "$(release_value "$dir" OPS_IMAGE)" node scripts/u1-uat-readiness.mjs --live
    ;;

  record)
    # file = deployment record ที่ workflow สร้าง (JSON) — เก็บคู่ current/previous สำหรับ rollback
    sha="${1:?sha}"
    file="${2:?record file}"
    dir="$(release_dir "$sha")"
    check_release_env "$dir"
    [[ "$(release_value "$dir" SOURCE_SHA)" == "$sha" ]] || fail 'RELEASE_SOURCE_MISMATCH'
    uat_mutation_lock allow-rollback-record
    uat_require_recordable_current "$sha"
    validated_record="$(uat_verify_record_runtime "$dir" "$sha" "$file")" || fail 'RECORD_VALIDATION_FAILED'
    rollback_pending=false
    if [[ -e "$UAT_ROOT/operator/uat-rollback.pending" || -L "$UAT_ROOT/operator/uat-rollback.pending" ]]; then
      printf '%s' "$validated_record" | python3 -c '
import base64, hashlib, json, os, stat, sys
marker, current, sha = sys.argv[1:]
fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, "rb") as stream:
    info = os.fstat(stream.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        sys.exit("UAT_ROLLBACK_PENDING_INVALID")
    pending = json.load(stream)
fd = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, "rb") as stream:
    current_hash = hashlib.sha256(stream.read()).hexdigest()
record = json.loads(base64.b64decode(sys.stdin.buffer.read(), validate=True))
target = pending.get("targetRecord")
if not isinstance(target, dict):
    sys.exit("UAT_ROLLBACK_PENDING_INVALID")
target_digest = hashlib.sha256((json.dumps(target) + "\n").encode()).hexdigest()
if (pending.get("schema") != "UatRollbackPendingV1" or pending.get("targetSha") != sha
        or pending.get("currentRecordSha256") != current_hash
        or pending.get("targetRecordSha256") != target_digest
        or record.get("action") != "rollback" or record.get("sourceSha") != sha
        or record.get("images") != target.get("images")
        or record.get("environment") != target.get("environment")
        or record.get("realmConfigDigest") != target.get("realmConfigDigest")
        or record.get("fixturePackVersion") != target.get("fixturePackVersion")
        or record.get("rollbackOf") != {"recordedAt": target.get("deployedAt"), "runUrl": target.get("runUrl")}
        or not isinstance(record.get("smoke"), dict) or record["smoke"].get("status") != "PASS"):
    sys.exit("UAT_ROLLBACK_PENDING_MISMATCH")
' "$UAT_ROOT/operator/uat-rollback.pending" "$UAT_ROOT/deployments/current.json" "$sha"
      # status จาก record ที่ส่งมาไม่ใช่หลักฐาน smoke จาก runtime; ห้าม commit
      # จนกว่าจะมี receipt ที่ผูกกับ runtime และ recovery ของ pointer transaction
      fail 'UAT_ROLLBACK_SMOKE_RECEIPT_AND_RECOVERY_REQUIRED'
    fi
    target="$UAT_ROOT/deployments/$(date -u +%Y%m%dT%H%M%SZ)-${sha}.json"
    [[ ! -e "$target" && ! -L "$target" ]] || fail 'RECORD_ARCHIVE_EXISTS'
    printf '%s' "$validated_record" | python3 -c '
import base64, hashlib, json, os, stat, sys
operator, deployments, archive = sys.argv[1:]
transaction = os.path.join(operator, "uat-record-transaction")
desired = base64.b64decode(sys.stdin.buffer.read(), validate=True)
os.mkdir(transaction, 0o700)
def syncdir(path):
    fd = os.open(path, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
def save(name, data):
    fd = os.open(os.path.join(transaction, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
syncdir(operator)
snapshots = {}
for name in ("current.json", "previous.json"):
    path = os.path.join(deployments, name)
    if os.path.lexists(path):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 8388608:
                sys.exit("RECORD_SNAPSHOT_INVALID")
            data = stream.read()
        save(name, data)
        snapshots[name] = hashlib.sha256(data).hexdigest()
    else:
        snapshots[name] = None
save("desired.json", desired)
save("intent.json", json.dumps({"schema":"UatRecordIntentV1", "archive":os.path.basename(archive),
    "desiredSha256":hashlib.sha256(desired).hexdigest(), "snapshots":snapshots}).encode())
syncdir(transaction)
' "$UAT_ROOT/operator" "$UAT_ROOT/deployments" "$target"
    printf '%s' "$validated_record" | python3 -c '
import base64, os, sys, tempfile
target = sys.argv[1]
data = base64.b64decode(sys.stdin.buffer.read(), validate=True)
directory = os.path.dirname(target)
fd, staging = tempfile.mkstemp(prefix=".uat-archive-", dir=directory)
try:
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.link(staging, target, follow_symlinks=False)
    except FileExistsError:
        sys.exit("RECORD_ARCHIVE_EXISTS")
finally:
    if os.path.exists(staging): os.unlink(staging)
fd = os.open(directory, os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)
' "$target"
    python3 - "$UAT_ROOT/deployments" "$target" "$rollback_pending" "$UAT_ROOT/operator/uat-rollback.pending" <<'PY'
import hashlib, os, pathlib, sys, tempfile
directory, archive, pending, marker = sys.argv[1:]
directory = pathlib.Path(directory)
def replace(path, data):
    fd, name = tempfile.mkstemp(prefix='.uat-record-', dir=directory)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        fd = os.open(str(directory), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)
current = directory / 'current.json'
if current.exists():
    replace(directory / 'previous.json', current.read_bytes())
replace(current, pathlib.Path(archive).read_bytes())
if current.read_bytes() != pathlib.Path(archive).read_bytes():
    sys.exit('RECORD_READBACK_MISMATCH')
marker_path = archive + '.committed'
fd = os.open(marker_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'wb') as stream:
    stream.write((hashlib.sha256(pathlib.Path(archive).read_bytes()).hexdigest() + '\n').encode())
    stream.flush()
    os.fsync(stream.fileno())
fd = os.open(str(directory), os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
if pending == 'true':
    os.unlink(marker)
    fd = os.open(os.path.dirname(marker), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
PY
    python3 - "$UAT_ROOT/operator" <<'PY'
import os, shutil, sys
operator = sys.argv[1]
shutil.rmtree(os.path.join(operator, 'uat-record-transaction'))
fd = os.open(operator, os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)
PY
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"record\",\"status\":\"PASS\",\"file\":\"deployments/$(basename "$target")\"}"
    ;;

  compose-argv)
    # #868: คำสั่ง compose ของ release เป็น JSON (มีแต่ path ไม่มีค่า secret) ให้ b868-api-switch.py ใช้ชุดไฟล์เดียวกับ deploy
    dir="$(release_dir "${1:?sha}")"
    prefix=()
    compose_prefix "$dir"
    python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "${prefix[@]}"
    ;;

  current)
    uat_mutation_lock
    # record ปัจจุบัน (ไม่มี secret) — workflow ใช้หา SHA ฐานของ migration guard
    if [[ -f "$UAT_ROOT/deployments/current.json" ]]; then
      cat "$UAT_ROOT/deployments/current.json"
    else
      echo '{}'
    fi
    ;;

  e1-status)
    dir="$(release_dir "${1:?sha}")"
    if is_e1 "$dir"; then enabled=true; else enabled=false; fi
    profile="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${PROJECT}-api-1" 2>/dev/null | sed -n 's/^DCONTACT_API_PROFILE=//p' | tail -n 1 || true)"
    sandbox="$(docker inspect --format '{{.State.Status}}' "${PROJECT}-e1-sandbox-1" 2>/dev/null || true)"
    freeswitch="$(docker inspect --format '{{.State.Status}}' "${PROJECT}-freeswitch-1" 2>/dev/null || true)"
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"e1-status\",\"enabled\":$enabled,\"runtimeProfile\":\"${profile:-unknown}\",\"freeswitch\":\"${freeswitch:-absent}\",\"sandbox\":\"${sandbox:-absent}\"}"
    ;;

  e1-enable)
    uat_mutation_lock
    dir="$(release_dir "${1:?sha}")"
    [[ -f "$dir/docker-compose.uat.e1.yml" && -x "$dir/e1-freeswitch/entrypoint.sh" ]] || fail 'E1_ACCEPTANCE_OVERLAY_MISSING'
    : >"$E1_FLAG"
    if ! compose "$dir" up -d --wait --no-deps --force-recreate freeswitch api proxy e1-sandbox; then
      rm -f "$E1_FLAG"
      compose "$dir" up -d --wait --no-deps --force-recreate api proxy || true
      fail 'E1_ENABLE_FAILED'
    fi
    echo '{"type":"u1.uat.deploy","step":"e1-enable","status":"PASS"}'
    ;;

  e1-disable)
    uat_mutation_lock
    dir="$(release_dir "${1:?sha}")"
    [[ "$(release_value "$dir" UAT_WORKSPACE_ENABLED)" != true ]] || fail 'WORKSPACE_REQUIRES_E1_ROLLBACK_FIRST'
    # ต้องถอด daemon ขณะ overlay ยัง active; หลังลบ flag compose จะไม่รู้จัก service นี้แล้ว
    if is_e1 "$dir"; then compose "$dir" rm -sf e1-sandbox freeswitch >/dev/null || true; fi
    rm -f "$E1_FLAG"
    compose "$dir" up -d --wait --no-deps --force-recreate api proxy
    echo '{"type":"u1.uat.deploy","step":"e1-disable","status":"PASS"}'
    ;;

  e1-voice-control|e1-voice-on|e1-voice-off)
    # คำสั่งปิดฉุกเฉินต้องทำงานได้แม้มี transaction ค้าง
    if [[ "$cmd" == e1-voice-on || ( "$cmd" == e1-voice-control && "${2:-}" != off && "${2:-}" != status && "${2:-}" != idle ) ]]; then
      uat_mutation_lock
    fi
    sha="${1:?sha}"
    shift
    dir="$(release_dir "$sha")"
    is_e1 "$dir" || fail 'E1_ACCEPTANCE_DISABLED'
    for service in api e1-sandbox; do
      running_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${PROJECT}-${service}-1")"
      [[ "$running_sha" == "$sha" ]] || fail 'E1_VOICE_RUNTIME_SHA_MISMATCH'
    done
    if [[ "$cmd" == 'e1-voice-control' ]]; then
      compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js "$@"
    else
      [[ $# == 1 && "$1" =~ ^operator:[A-Za-z0-9_-]{1,64}$ ]] || fail 'E1_VOICE_ACTOR_REQUIRED'
      actor="$1"
      compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js off "$actor"
      compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js idle
      if [[ "$cmd" == 'e1-voice-on' ]]; then
        media_operator_sha="${UAT_E1_MEDIA_OPERATOR_SHA:-$sha}"
        [[ "$media_operator_sha" =~ ^[a-f0-9]{40}$ ]] || fail 'E1_MEDIA_OPERATOR_SHA_INVALID'
        media_operator="$UAT_ROOT/releases/$media_operator_sha/operator/vm2-e1-media-uat.py"
        [[ -f "$media_operator" ]] || fail 'E1_MEDIA_OPERATOR_MISSING'
        media_arguments=(--verify-snapshot --source-sha "$sha")
        if [[ -n "${UAT_E1_MEDIA_OPERATOR_SHA:-}" ]]; then
          media_arguments+=(--candidate-sha "$sha" --operator-sha "$media_operator_sha")
        fi
        exec 8</var/lib/dcontact-uat-e1-media/lock || fail 'E1_MEDIA_SNAPSHOT_MISSING_OR_STALE'
        flock -s -n 8 || fail 'E1_MEDIA_OPERATOR_BUSY'
        python3 "$media_operator" "${media_arguments[@]}"
        compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js on "$actor"
        if ! UAT_E1_OUTBOUND_VOICE_ENABLED=true compose "$dir" up -d --wait --no-deps --force-recreate api e1-sandbox; then
          UAT_E1_OUTBOUND_VOICE_ENABLED=false compose "$dir" up -d --wait --no-deps --force-recreate api e1-sandbox || true
          compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js off "$actor" || true
          fail 'E1_VOICE_ENABLE_FAILED'
        fi
      else
        # ปิด switch ก่อนเสมอ แม้ lock ถูกถืออยู่; recreate ต้องรอ transaction อื่นจบ
        (
          uat_mutation_lock
          for service in api e1-sandbox; do
            running_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${PROJECT}-${service}-1")"
            [[ "$running_sha" == "$sha" ]] || fail 'E1_VOICE_RUNTIME_SHA_MISMATCH'
          done
          UAT_E1_OUTBOUND_VOICE_ENABLED=false compose "$dir" up -d --wait --no-deps --force-recreate api e1-sandbox
        ) || fail 'E1_VOICE_OFF_RECREATE_BLOCKED_SWITCH_OFF'
      fi
      echo "{\"type\":\"u1.uat.deploy\",\"step\":\"$cmd\",\"status\":\"PASS\"}"
    fi
    ;;

  e1-launcher-enable|e1-launcher-status|e1-launcher-alias)
    if [[ "$cmd" != e1-launcher-status ]]; then uat_mutation_lock; fi
    sha="${1:?sha}"
    shift
    dir="$(release_dir "$sha")"
    exec 8>"$UAT_ROOT/e1-launcher.lock"
    flock -n 8 || fail 'E1_LAUNCHER_COMMAND_BUSY'
    is_e1 "$dir" || fail 'E1_ACCEPTANCE_DISABLED'
    docker exec "${PROJECT}-api-1" node -e 'if (!["uat-e1", "uat-workspace"].includes(process.env.DCONTACT_API_PROFILE)) process.exit(1)' || fail 'E1_LAUNCHER_PROFILE_REQUIRED'
    for service in api e1-sandbox; do
      running_sha="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${PROJECT}-${service}-1")"
      [[ "$running_sha" == "$sha" ]] || fail 'E1_VOICE_RUNTIME_SHA_MISMATCH'
    done
    helper="$dir/operator/e1-launcher-releases.mjs"
    [[ -f "$helper" && ! -L "$helper" && -f "$dir/docker-compose.uat.e1-launcher.yml" ]] || fail 'E1_LAUNCHER_OVERLAY_MISSING'
    volume="${PROJECT}_e1-launcher-releases"
    mode=ro
    if [[ "$cmd" == 'e1-launcher-enable' ]]; then
      [[ $# == 0 ]] || usage
      status="$(compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js status)"
      printf '%s' "$status" | python3 -c 'import json,sys; state=json.load(sys.stdin); sys.exit(1 if state["runtimeEnabled"] or state["technicalSwitchOn"] else 0)' || fail 'E1_LAUNCHER_REQUIRES_DEFAULT_OFF'
      compose "$dir" exec -T e1-sandbox node /e1-sandbox/dist/e1-voice-control-main.js idle
      docker volume create "$volume" >/dev/null
      args=(import)
      mode=rw
    else
      is_e1_launcher "$dir" || fail 'E1_LAUNCHER_HOSTING_DISABLED'
      if [[ "$cmd" == 'e1-launcher-alias' ]]; then
        [[ $# == 2 && "$1" == v1 && "$2" =~ ^1\.[0-9]+\.[0-9]+$ ]] || usage
        args=(alias "$1" "$2")
        mode=rw
      else
        [[ $# == 0 ]] || usage
        args=(check)
      fi
    fi
    docker volume inspect "$volume" >/dev/null
    docker run --rm --network none --read-only --user 0:0 --cap-drop ALL \
      --security-opt no-new-privileges:true \
      -e DPHONE_LAUNCHER_RELEASES_DIR=/launcher-releases \
      -v "$volume:/launcher-releases:$mode" -v "$helper:/operator-launcher.mjs:ro" \
      "$(release_value "$dir" API_IMAGE)" node /operator-launcher.mjs "${args[@]}"
    if [[ "$cmd" == 'e1-launcher-enable' ]]; then
      : >"$E1_LAUNCHER_FLAG"
      if ! compose "$dir" up -d --wait --no-deps --force-recreate api; then
        rm -f "$E1_LAUNCHER_FLAG"
        compose "$dir" up -d --wait --no-deps --force-recreate api || true
        fail 'E1_LAUNCHER_ENABLE_FAILED'
      fi
    fi
    ;;

  line-status)
    # #565: สถานะ overlay ของ release ที่ระบุ (ไม่มีค่า secret) — enabled ต้องตรงกับ container ที่รันอยู่
    dir="$(release_dir "${1:?sha}")"
    if is_line "$dir"; then enabled=true; else enabled=false; fi
    if is_trial "$dir"; then trial=true; else trial=false; fi
    running="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
      --filter 'label=com.docker.compose.service=line-webhook' --format '{{.Names}}' | wc -l | tr -d ' ')"
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"line-status\",\"enabled\":$enabled,\"teamTrial\":$trial,\"lineWebhookContainers\":$running}"
    ;;

  line-run)
    # #565: runner ของ LINE pilot — uat-deploy.sh line-run <sha> <line-pilot-setup|line-provider-runner|line-pilot-cli> <command> [...]
    # relay line-egress ขึ้นตาม depends_on และไม่รันค้าง (profile line-pilot); stdout มีแค่ ID/digest ตาม CLI
    dir="$(release_dir "${1:?sha}")"
    shift
    is_line "$dir" || fail 'LINE_NOT_ENABLED'
    compose "$dir" --profile line-pilot run --rm -T line-pilot "$@"
    ;;

  line-reload)
    uat_mutation_lock
    # #565: หลัง vm2-line-secrets.sh --rotate — ไฟล์ secret เปลี่ยนแต่ compose config ไม่เปลี่ยน จึงต้อง recreate เอง
    dir="$(release_dir "${1:?sha}")"
    is_line "$dir" || fail 'LINE_NOT_ENABLED'
    compose "$dir" up -d --wait --no-deps --force-recreate line-webhook
    echo '{"type":"u1.uat.deploy","step":"line-reload","status":"PASS"}'
    ;;

  rollback-target)
    uat_mutation_lock
    # ไม่ระบุ sha = record ก่อนหน้า (previous.json); ระบุ sha = record ล่าสุดของ sha นั้นที่เคย deploy สำเร็จ
    if [[ -n "${1:-}" ]]; then
      [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail 'SOURCE_SHA_INVALID'
      target="$(ls -1 "$UAT_ROOT/deployments/"*"-$1.json" 2>/dev/null | sort | tail -n 1 || true)"
      [[ -n "$target" ]] || fail 'NO_DEPLOYMENT_FOR_SHA'
      uat_require_committed_archive "$target"
      uat_resolve_rollback_record "$target" "$1"
    else
      [[ -f "$UAT_ROOT/deployments/previous.json" ]] || fail 'NO_PREVIOUS_DEPLOYMENT'
      uat_require_committed_pointer "$UAT_ROOT/deployments/previous.json"
      uat_resolve_rollback_record "$UAT_ROOT/deployments/previous.json"
    fi
    ;;

  rollback)
    # redeploy digest ของ release ก่อนหน้า — Console/proxy + api เท่านั้น ไม่ migrate ไม่ restore DB
    sha="${1:?previous sha}"
    dir="$(release_dir "$sha")"
    check_release_env "$dir"
    uat_mutation_lock
    # Record จาก reconciliation ไม่ได้พิสูจน์ compatibility ของ schema/identity สำหรับ rollback
    # แม้ operator ระบุ SHA ตรงก็ต้องหยุดจนกว่าจะมีเกต recovery ที่รับรองครบ
    if [[ ! -e "$UAT_ROOT/deployments/current.json" && ! -L "$UAT_ROOT/deployments/current.json" ]]; then
      fail 'ROLLBACK_CURRENT_RECORD_REQUIRED'
    fi
    if [[ -e "$UAT_ROOT/deployments/current.json" || -L "$UAT_ROOT/deployments/current.json" ]]; then
      python3 - "$UAT_ROOT/deployments/current.json" <<'PY'
import json
import os
import re
import stat
import sys

try:
    descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, encoding='utf-8') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError('record permissions invalid')
        record = json.load(stream)
    if not isinstance(record, dict):
        raise ValueError('record must be an object')
except (OSError, ValueError):
    sys.exit('ROLLBACK_CURRENT_RECORD_INVALID')
if record.get('action') == 'reconciliation' or record.get('rollbackEligible') is False:
    sys.exit('ROLLBACK_RECONCILIATION_REQUIRES_CERTIFICATION')
if (record.get('schema') != 'UatDeploymentRecordV1' or record.get('action') not in ('deploy', 'rollback')
        or not isinstance(record.get('sourceSha'), str) or not re.fullmatch('[0-9a-f]{40}', record['sourceSha'])):
    sys.exit('ROLLBACK_CURRENT_RECORD_INVALID')
PY
    fi
    expected_target_hash="${2:?rollback target record SHA-256 required}"
    [[ "$expected_target_hash" =~ ^[0-9a-f]{64}$ ]] || fail 'ROLLBACK_TARGET_HASH_INVALID'
    archive="$(ls -1 "$UAT_ROOT/deployments/"*"-$sha.json" 2>/dev/null | sort | tail -n 1 || true)"
    selected=''
    for candidate in "$archive" "$UAT_ROOT/deployments/previous.json"; do
      [[ -n "$candidate" && -e "$candidate" && ! -L "$candidate" ]] || continue
      if [[ "$candidate" == "$archive" ]]; then uat_require_committed_archive "$candidate" || continue; fi
      if [[ "$candidate" != "$archive" ]]; then uat_require_committed_pointer "$candidate" || continue; fi
      candidate_record="$(uat_resolve_rollback_record "$candidate" "$sha" 2>/dev/null)" || continue
      candidate_hash="$(printf '%s\n' "$candidate_record" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
      if [[ "$candidate_hash" == "$expected_target_hash" ]]; then
        selected="$candidate"
        break
      fi
    done
    [[ -n "$selected" ]] || fail 'ROLLBACK_TARGET_CHANGED'
    printf '%s' "$candidate_record" | python3 -c '
import json, sys
record = json.load(sys.stdin)
if record["images"] != dict(zip(("api", "console", "ops", "keycloak"), sys.argv[1:])):
    sys.exit("ROLLBACK_TARGET_RELEASE_MISMATCH")
' "$(release_value "$dir" API_IMAGE)" "$(release_value "$dir" CONSOLE_IMAGE)" \
      "$(release_value "$dir" OPS_IMAGE)" "$(release_value "$dir" KEYCLOAK_IMAGE)"
    rollback_preflight "$dir"
    # V1 record ไม่รองรับ mixed release; หยุดก่อนสลับ API หาก component ที่ไม่ rollback ต่างจาก target
    uat_verify_record_runtime "$dir" "$sha" '' untouched
    # หยุดก่อนแตะ runtime จนกว่าจะมี smoke receipt และ recovery ที่ตรวจสอบได้ครบ
    fail 'UAT_ROLLBACK_TRANSACTION_NOT_CERTIFIED'
    # คง pending แม้ compose ถูกขัดจังหวะ: ห้ามงานอื่นเขียน record ที่ไม่ตรง runtime
    UAT_ROLLBACK_SELECTED_RECORD="$candidate_record" python3 - "$UAT_ROOT/operator/uat-rollback.pending" "$UAT_ROOT/deployments/current.json" "$sha" "$expected_target_hash" <<'PY'
import hashlib, json, os, sys
marker, current, target, target_hash = sys.argv[1:]
fd = os.open(current, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as stream:
    current_hash = hashlib.sha256(stream.read()).hexdigest()
fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump({'schema': 'UatRollbackPendingV1', 'targetSha': target,
               'targetRecordSha256': target_hash, 'currentRecordSha256': current_hash,
               'targetRecord': json.loads(os.environ['UAT_ROLLBACK_SELECTED_RECORD'])}, stream)
    stream.flush()
    os.fsync(stream.fileno())
directory = os.open(os.path.dirname(marker), os.O_RDONLY)
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
    compose "$dir" up -d --wait --no-deps api proxy
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"rollback\",\"status\":\"PASS\",\"sourceSha\":\"${sha}\"}"
    ;;

  *)
    usage
    ;;
esac
