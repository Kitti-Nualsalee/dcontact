#!/usr/bin/env bash
# U1.6 (#434): ขั้นตอน deploy/rollback ของ UAT บน VM — workflow `uat-preview` เรียกทีละขั้นผ่าน SSH
#
# โครงบน VM (ดู docs/u1-uat-deployment.md):
#   $UAT_ROOT/uat.env                 secret + ค่าของ provisioning gate (operator วาง, chmod 600, ไม่อยู่ใน Git)
#   $UAT_ROOT/releases/<sha>/         compose + bin/ + release.env (digest ของ image) ของแต่ละ release
#   $UAT_ROOT/deployments/            deployment record (current.json, previous.json, <time>-<sha>.json)
#   $UAT_ROOT/backups/                pg_dump ก่อน migrate ทุกครั้ง
#   $UAT_ROOT/object-storage-migrated เวลาที่ย้ายหลักฐานจาก MinIO → SeaweedFS สำเร็จ (#540)
#   $UAT_ROOT/line-pilot.enabled      มีไฟล์ = ใส่ overlay `uat-line` (#565, ADR-031); ลบแล้ว deploy = ถอด LINE ออก
#   $UAT_ROOT/secrets/line/           secret ของ LINE (operator/vm2-line-secrets.sh) — ใช้เมื่อเปิด overlay เท่านั้น
#
# ไม่มีขั้น down migration และ rollback ไม่แตะฐานข้อมูล (redeploy digest เดิมของ Console/api เท่านั้น)
# ไม่พิมพ์ค่า secret: compose อ่านจาก env file เอง, script พิมพ์เฉพาะสถานะ/ชื่อไฟล์/digest
set -euo pipefail
umask 077

UAT_ROOT="${UAT_ROOT:-/opt/dcontact-uat}"
PROJECT=dcontact-uat
# #540: เขียนหลัง migrate-object-storage สำเร็จ — deploy บน VM ที่มี volume minio-data ต้องมีไฟล์นี้
MIGRATION_MARKER="$UAT_ROOT/object-storage-migrated"
DIGEST_REF='^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$'

# #565: overlay `uat-line` เปิดด้วยไฟล์ flag นอก release — release มีไฟล์ overlay เสมอแต่ไม่ถูกใช้ถ้าไม่มี flag
LINE_FLAG="$UAT_ROOT/line-pilot.enabled"
# #567: team trial ซ้อนบน overlay `uat-line` — ต้องมีทั้งสอง flag
TRIAL_FLAG="$UAT_ROOT/line-team-trial.enabled"
E1_FLAG="$UAT_ROOT/e1-acceptance.enabled"

usage() {
  echo 'usage: uat-deploy.sh <prepare|backup|migrate|keycloak|provision|ui-flag|migrate-object-storage|deploy|smoke|record|current|e1-status|e1-enable|e1-disable|line-status|line-run|line-reload|rollback-target|rollback> [sha] [...]' >&2
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
  [[ -f "$1/docker-compose.uat.e1.yml" ]] || fail 'E1_ACCEPTANCE_OVERLAY_MISSING'
}

compose() {
  local dir="$1"
  shift
  if is_3vm "$dir"; then
    local binary="$UAT_ROOT/bin/docker-compose"
    [[ -x "$binary" ]] || fail 'COMPOSE_3VM_BINARY_MISSING'
    local files=(-f "$dir/docker-compose.uat.yml" -f "$dir/docker-compose.uat.3vm.yml")
    if is_e1 "$dir"; then files+=(-f "$dir/docker-compose.uat.e1.yml"); fi
    if is_line "$dir"; then files+=(-f "$dir/docker-compose.uat.line.yml"); fi
    if is_trial "$dir"; then files+=(-f "$dir/docker-compose.uat.line-trial.yml"); fi
    "$binary" --project-name "$PROJECT" \
      --project-directory "$dir" \
      --env-file "$UAT_ROOT/uat.env" \
      --env-file "$dir/release.env" \
      "${files[@]}" "$@"
  else
    local files=(-f "$dir/docker-compose.uat.yml")
    if is_e1 "$dir"; then files+=(-f "$dir/docker-compose.uat.e1.yml"); fi
    docker compose --project-name "$PROJECT" \
      --project-directory "$dir" \
      --env-file "$UAT_ROOT/uat.env" \
      --env-file "$dir/release.env" \
      "${files[@]}" "$@"
  fi
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

cmd="${1:-}"
[[ -n "$cmd" ]] || usage
shift

[[ -f "$UAT_ROOT/uat.env" ]] || fail 'UAT_ENV_MISSING'
if [[ "$(file_mode "$UAT_ROOT/uat.env")" != '600' ]]; then fail 'UAT_ENV_PERMISSIONS'; fi
mkdir -p "$UAT_ROOT/deployments" "$UAT_ROOT/backups"

case "$cmd" in
  prepare)
    dir="$(release_dir "${1:?sha}")"
    check_release_env "$dir"
    if is_3vm "$dir"; then
      for file in "$dir/Caddyfile.3vm" "$dir/haproxy-db-relay.cfg" "$dir/bin/db-roles-3vm.sh"; do
        [[ -f "$file" ]] || fail 'RELEASE_3VM_FILE_MISSING'
      done
      [[ -x "$UAT_ROOT/bin/docker-compose" ]] || fail 'COMPOSE_3VM_BINARY_MISSING'
    fi
    chmod 700 "$dir/bin"/*.sh
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
    compose "$dir" up -d --wait "$(database_service "$dir")"
    compose "$dir" --profile ops run --rm -T db-roles >/dev/null
    compose "$dir" --profile ops run --rm -T migrate
    # rls.sql สร้าง role ที่ยังไม่มีด้วยรหัสผ่านของ dev — ตั้งทับ/ปิด login ทุกครั้งหลัง migrate
    compose "$dir" --profile ops run --rm -T db-roles
    ;;

  keycloak)
    dir="$(release_dir "${1:?sha}")"
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

  migrate-object-storage)
    # #540 (ADR-029): ย้ายหลักฐานจาก MinIO เดิม → SeaweedFS ครั้งเดียวก่อน `deploy` ของ release ใหม่
    # (runbook docs/u1-uat-deployment.md) — หยุด api ก่อนเพื่อไม่ให้มีหลักฐานใหม่เข้า MinIO ระหว่างคัดลอก
    # รันซ้ำได้: object ที่คัดลอกแล้ว (sha256 ตรง) ถูกข้าม; ต้องมี UAT_MINIO_ROOT_* เดิมใน uat.env
    dir="$(release_dir "${1:?sha}")"
    overlay="$dir/docker-compose.uat.migration.yml"
    [[ -f "$overlay" ]] || fail 'MIGRATION_OVERLAY_MISSING'
    compose "$dir" stop api || true
    compose "$dir" -f "$overlay" up -d --wait "$(database_service "$dir")" minio object-storage
    compose "$dir" -f "$overlay" run --rm -T object-storage-init
    compose "$dir" -f "$overlay" run --rm -T object-storage-migrate
    compose "$dir" -f "$overlay" stop minio
    date -u +%Y-%m-%dT%H:%M:%SZ >"$MIGRATION_MARKER"
    echo '{"type":"u1.uat.deploy","step":"migrate-object-storage","status":"PASS"}'
    ;;

  deploy)
    dir="$(release_dir "${1:?sha}")"
    # #540: VM ที่เคยมี MinIO ต้องย้ายหลักฐานก่อน (migrate-object-storage) — ไม่งั้น api บูตบน bucket ว่าง
    if docker volume inspect "${PROJECT}_minio-data" >/dev/null 2>&1 && [[ ! -f "$MIGRATION_MARKER" ]]; then
      fail 'OBJECT_STORAGE_MIGRATION_PENDING'
    fi
    # #540: object storage (SeaweedFS; s3.json + policy ของ API สร้างใน entrypoint) → bucket private
    # ก่อน api บูต (U1.5 #433: api ไม่บูตถ้า bucket ไม่พร้อม) แล้ว lifecycle/expiry ที่รันต่อเนื่อง
    compose "$dir" up -d --wait object-storage
    compose "$dir" run --rm -T object-storage-init
    # --no-deps: object-storage-init จบไปแล้วข้างบน และไม่ให้ `--wait` ไปรอ container one-shot ที่ exit แล้ว
    # --remove-orphans ไม่ลบ volume minio-data (ย้ายข้อมูล/rollback จนถึง #541)
    # #565: ไม่มี flag = container line-* เป็น orphan และถูกถอดที่นี่; runner/relay ไม่รันค้าง (profile line-pilot)
    services=(object-storage-lifecycle object-storage-migrated-expiry api proxy)
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
    release_dir "$sha" >/dev/null
    node_check="$(sed -n 's/.*"sourceSha" *: *"\([0-9a-f]\{40\}\)".*/\1/p' "$file" | head -n 1)"
    [[ "$node_check" == "$sha" ]] || fail 'RECORD_SHA_MISMATCH'
    target="$UAT_ROOT/deployments/$(date -u +%Y%m%dT%H%M%SZ)-${sha}.json"
    cp "$file" "$target"
    if [[ -f "$UAT_ROOT/deployments/current.json" ]]; then
      cp "$UAT_ROOT/deployments/current.json" "$UAT_ROOT/deployments/previous.json"
    fi
    cp "$target" "$UAT_ROOT/deployments/current.json"
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"record\",\"status\":\"PASS\",\"file\":\"deployments/$(basename "$target")\"}"
    ;;

  current)
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
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"e1-status\",\"enabled\":$enabled,\"runtimeProfile\":\"${profile:-unknown}\"}"
    ;;

  e1-enable)
    dir="$(release_dir "${1:?sha}")"
    [[ -f "$dir/docker-compose.uat.e1.yml" ]] || fail 'E1_ACCEPTANCE_OVERLAY_MISSING'
    : >"$E1_FLAG"
    compose "$dir" up -d --wait --no-deps --force-recreate api proxy
    echo '{"type":"u1.uat.deploy","step":"e1-enable","status":"PASS"}'
    ;;

  e1-disable)
    dir="$(release_dir "${1:?sha}")"
    rm -f "$E1_FLAG"
    compose "$dir" up -d --wait --no-deps --force-recreate api proxy
    echo '{"type":"u1.uat.deploy","step":"e1-disable","status":"PASS"}'
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
    # #565: หลัง vm2-line-secrets.sh --rotate — ไฟล์ secret เปลี่ยนแต่ compose config ไม่เปลี่ยน จึงต้อง recreate เอง
    dir="$(release_dir "${1:?sha}")"
    is_line "$dir" || fail 'LINE_NOT_ENABLED'
    compose "$dir" up -d --wait --no-deps --force-recreate line-webhook
    echo '{"type":"u1.uat.deploy","step":"line-reload","status":"PASS"}'
    ;;

  rollback-target)
    # ไม่ระบุ sha = record ก่อนหน้า (previous.json); ระบุ sha = record ล่าสุดของ sha นั้นที่เคย deploy สำเร็จ
    if [[ -n "${1:-}" ]]; then
      [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail 'SOURCE_SHA_INVALID'
      target="$(ls -1 "$UAT_ROOT/deployments/"*"-$1.json" 2>/dev/null | sort | tail -n 1 || true)"
      [[ -n "$target" ]] || fail 'NO_DEPLOYMENT_FOR_SHA'
      cat "$target"
    else
      [[ -f "$UAT_ROOT/deployments/previous.json" ]] || fail 'NO_PREVIOUS_DEPLOYMENT'
      cat "$UAT_ROOT/deployments/previous.json"
    fi
    ;;

  rollback)
    # redeploy digest ของ release ก่อนหน้า — Console/proxy + api เท่านั้น ไม่ migrate ไม่ restore DB
    sha="${1:?previous sha}"
    dir="$(release_dir "$sha")"
    check_release_env "$dir"
    compose "$dir" up -d --wait --no-deps api proxy
    echo "{\"type\":\"u1.uat.deploy\",\"step\":\"rollback\",\"status\":\"PASS\",\"sourceSha\":\"${sha}\"}"
    ;;

  *)
    usage
    ;;
esac
