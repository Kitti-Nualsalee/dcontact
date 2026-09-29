#!/usr/bin/env bash
# U1.6 (#434): ขั้นตอน deploy/rollback ของ UAT บน VM — workflow `uat-preview` เรียกทีละขั้นผ่าน SSH
#
# โครงบน VM (ดู docs/u1-uat-deployment.md):
#   $UAT_ROOT/uat.env                 secret + ค่าของ provisioning gate (operator วาง, chmod 600, ไม่อยู่ใน Git)
#   $UAT_ROOT/releases/<sha>/         compose + bin/ + release.env (digest ของ image) ของแต่ละ release
#   $UAT_ROOT/deployments/            deployment record (current.json, previous.json, <time>-<sha>.json)
#   $UAT_ROOT/backups/                pg_dump ก่อน migrate ทุกครั้ง
#   $UAT_ROOT/object-storage-migrated เวลาที่ย้ายหลักฐานจาก MinIO → SeaweedFS สำเร็จ (#540)
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

usage() {
  echo 'usage: uat-deploy.sh <prepare|backup|migrate|keycloak|provision|migrate-object-storage|deploy|smoke|record|current|rollback-target|rollback> [sha] [file|--token-stdin] [--check]' >&2
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

compose() {
  local dir="$1"
  shift
  docker compose --project-name "$PROJECT" \
    --project-directory "$dir" \
    --env-file "$UAT_ROOT/uat.env" \
    --env-file "$dir/release.env" \
    -f "$dir/docker-compose.uat.yml" "$@"
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
    chmod 700 "$dir/bin"/*.sh
    compose "$dir" config --quiet
    compose "$dir" --profile ops pull --quiet
    echo '{"type":"u1.uat.deploy","step":"prepare","status":"PASS"}'
    ;;

  backup)
    dir="$(release_dir "${1:?sha}")"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    if [[ -z "$(compose "$dir" ps --status running --quiet postgres)" ]]; then
      # ครั้งแรกยังไม่มีฐานข้อมูลให้สำรอง — บันทึกไว้ใน record แทนการข้ามเงียบ
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
    ;;

  migrate)
    dir="$(release_dir "${1:?sha}")"
    compose "$dir" up -d --wait postgres
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
    compose "$dir" up -d --wait postgres
    compose "$dir" --profile ops run --rm -T uat-provision ${mode[@]+"${mode[@]}"} --input - <"$file"
    ;;

  migrate-object-storage)
    # #540 (ADR-029): ย้ายหลักฐานจาก MinIO เดิม → SeaweedFS ครั้งเดียวก่อน `deploy` ของ release ใหม่
    # (runbook docs/u1-uat-deployment.md) — หยุด api ก่อนเพื่อไม่ให้มีหลักฐานใหม่เข้า MinIO ระหว่างคัดลอก
    # รันซ้ำได้: object ที่คัดลอกแล้ว (sha256 ตรง) ถูกข้าม; ต้องมี UAT_MINIO_ROOT_* เดิมใน uat.env
    dir="$(release_dir "${1:?sha}")"
    overlay="$dir/docker-compose.uat.migration.yml"
    [[ -f "$overlay" ]] || fail 'MIGRATION_OVERLAY_MISSING'
    compose "$dir" stop api || true
    compose "$dir" -f "$overlay" up -d --wait postgres minio object-storage
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
    compose "$dir" up -d --wait --no-deps --remove-orphans \
      object-storage-lifecycle object-storage-migrated-expiry api proxy
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
    # รันจากบน VM ผ่าน proxy ตัวจริง (127.0.0.1:443 + SNI ของ UAT_HOST) เพราะ allowlist ปิดทางอื่น
    # Docker Desktop (uat-local.sh บน macOS) ไม่มี host network แบบ Linux: ใช้ bridge + host.docker.internal แทน
    docker run --rm --network "${UAT_SMOKE_DOCKER_NETWORK:-host}" \
      -e "UAT_BASE_URL=https://${uat_host}" \
      -e "UAT_CONNECT_HOST=${UAT_SMOKE_CONNECT_HOST:-127.0.0.1}" \
      -e UAT_SMOKE_ACCESS_TOKEN \
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
