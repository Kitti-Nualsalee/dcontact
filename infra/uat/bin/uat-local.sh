#!/usr/bin/env bash
# ซ้อม deploy UAT บนเครื่องตัวเอง (macOS + Docker Desktop หรือ Linux + Docker Engine) — ดู docs/u1-uat-local.md
#
# ใช้ขั้นเดียวกับ VM จริง: build image → registry ในเครื่อง (อ้างด้วย digest) → `uat-deploy.sh`
# prepare/migrate/keycloak/deploy/smoke → render fixture pack `uat-first-slice.v1` (U1.9) → provision (U1.8)
# → สร้างบัญชี maker/reviewer (U1.6) แล้วเปิด stack ค้างไว้ให้เดิน Console ใน browser ได้
#
# ไม่ใช่หลักฐานของ UAT จริง: secret สุ่มเฉพาะเครื่อง, cert ของ CA ในเครื่อง, ไม่มี gateway/GHCR
# ไม่แตะ environment `uat-preview` และไม่ส่งอะไรออกนอกเครื่อง
#
#   bash infra/uat/bin/uat-local.sh up       build + deploy + provision (รันซ้ำได้ — ข้ามส่วนที่ทำแล้ว)
#   bash infra/uat/bin/uat-local.sh status   สถานะ container
#   bash infra/uat/bin/uat-local.sh logs [service...]
#   bash infra/uat/bin/uat-local.sh down     ลบ stack, volume, registry และโฟลเดอร์ทั้งหมด
#
# รองรับ bash 3.2 ของ macOS (ไม่ใช้ associative array)
set -euo pipefail
umask 077

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export UAT_ROOT="${UAT_ROOT:-$HOME/.dcontact-uat-local}"
UAT_HOST="${UAT_LOCAL_HOST:-uat.dcontact.test}"
REGISTRY_PORT="${UAT_LOCAL_REGISTRY_PORT:-5055}" # 5000 ชนกับ AirPlay Receiver ของ macOS
REGISTRY="localhost:${REGISTRY_PORT}"
REGISTRY_CONTAINER=dcontact-uat-local-registry
PACK_VERSION=local-1
# Caddy เห็น source ของ browser/smoke เป็น gateway ของ Docker (Docker Desktop: 192.168.65.0/24,
# bridge: 172.16.0.0/12) — ไม่เปิด 192.168.0.0/16 ทั้งช่วงเพราะมักทับ LAN บ้าน/ออฟฟิศ
ALLOWED_CIDRS="${UAT_LOCAL_ALLOWED_CIDRS:-127.0.0.1/32 172.16.0.0/12 192.168.65.0/24}"

log() { printf '\n==> %s\n' "$*" >&2; }
die() {
  printf 'uat-local: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "ต้องมี $1 ($2)"
}

sha="$(git -C "$REPO" rev-parse HEAD)"
release="$UAT_ROOT/releases/$sha"

deploy() { bash "$release/bin/uat-deploy.sh" "$@"; }

uatc() {
  docker compose --project-name dcontact-uat \
    --project-directory "$release" \
    --env-file "$UAT_ROOT/uat.env" \
    --env-file "$release/release.env" \
    -f "$release/docker-compose.uat.yml" "$@"
}

env_value() {
  sed -n "s/^$1=//p" "$UAT_ROOT/uat.env" | tail -n 1
}

secret() { openssl rand -hex "$1"; }

uuid() { node -e 'process.stdout.write(require("crypto").randomUUID())'; }

preflight() {
  need docker 'Docker Desktop หรือ Docker Engine'
  need node 'Node 20 — ใช้ render fixture pack'
  need openssl 'สร้าง secret/cert'
  need curl 'อ่าน digest จาก registry'
  docker info >/dev/null 2>&1 || die 'Docker daemon ไม่ทำงาน — เปิด Docker Desktop ก่อน'
  docker compose version >/dev/null 2>&1 || die 'ต้องมี docker compose plugin'
  if [[ -n "$(git -C "$REPO" status --porcelain)" ]]; then
    printf 'uat-local: เตือน — working tree มีการแก้ที่ยังไม่ commit; image จะ build จากไฟล์ปัจจุบันแต่ติดป้าย %s\n' "$sha" >&2
  fi
}

layout() {
  install -d -m 700 "$UAT_ROOT" "$UAT_ROOT/tls" "$release" "$release/bin"
  cp "$REPO/infra/uat/docker-compose.uat.yml" "$release/"
  cp "$REPO/infra/uat/bin/uat-deploy.sh" "$REPO/infra/uat/bin/db-roles.sh" "$REPO/infra/uat/bin/minio-init.sh" "$release/bin/"
}

start_registry() {
  if [[ -z "$(docker ps --quiet --filter "name=^${REGISTRY_CONTAINER}$")" ]]; then
    docker rm -f "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$REGISTRY_CONTAINER" -p "127.0.0.1:${REGISTRY_PORT}:5000" \
      docker.io/library/registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 >/dev/null
  fi
  for _ in $(seq 1 30); do
    curl -fsS "http://$REGISTRY/v2/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "registry ในเครื่องไม่พร้อมที่ $REGISTRY"
}

registry_digest() {
  local accept='application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json'
  curl -fsSI -H "Accept: $accept" "http://$REGISTRY/v2/dcontact-uat-$1/manifests/$sha" 2>/dev/null |
    tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p'
}

build_images() {
  local name ref digest upper
  echo "SOURCE_SHA=$sha" >"$release/release.env.partial"
  for name in api ops console keycloak; do
    ref="$REGISTRY/dcontact-uat-$name:$sha"
    digest="$(registry_digest "$name" || true)"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      log "build image $name ($sha)"
      case "$name" in
        api) docker build --file apps/api/Dockerfile --target runtime --build-arg "SOURCE_SHA=$sha" -t "$ref" "$REPO" ;;
        ops) docker build --file apps/api/Dockerfile --target ops --build-arg "SOURCE_SHA=$sha" -t "$ref" "$REPO" ;;
        console)
          docker build --file apps/console/Dockerfile \
            --build-arg "SOURCE_SHA=$sha" \
            --build-arg "VITE_KC_ISSUER=https://$UAT_HOST/auth/realms/dcontact" \
            --build-arg VITE_KC_CLIENT_ID=dcontact-uat-console \
            --build-arg VITE_CONSOLE_DEFAULT_VIEW=journeys \
            --build-arg VITE_UAT_ENVIRONMENT=uat \
            --build-arg "VITE_UAT_PACK_VERSION=$PACK_VERSION" \
            -t "$ref" "$REPO"
          ;;
        keycloak) docker build --file infra/keycloak/Dockerfile --build-arg "SOURCE_SHA=$sha" -t "$ref" "$REPO" ;;
      esac
      docker push --quiet "$ref" >/dev/null
      digest="$(registry_digest "$name")"
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "ไม่ได้ digest ของ $name จาก registry ในเครื่อง"
    fi
    upper="$(echo "$name" | tr '[:lower:]' '[:upper:]')"
    echo "${upper}_IMAGE=$REGISTRY/dcontact-uat-$name@$digest" >>"$release/release.env.partial"
  done
  mv "$release/release.env.partial" "$release/release.env"
}

tls_files() {
  local tls="$UAT_ROOT/tls"
  [[ -f "$tls/uat.crt" && -f "$tls/uat.key" && -f "$tls/ca.crt" ]] && return 0
  if command -v mkcert >/dev/null 2>&1; then
    # browser เชื่อ cert ทันทีถ้าเคย `mkcert -install`
    mkcert -cert-file "$tls/uat.crt" -key-file "$tls/uat.key" "$UAT_HOST" >/dev/null 2>&1
    cp "$(mkcert -CAROOT)/rootCA.pem" "$tls/ca.crt"
  else
    # CA ชั่วคราวของเครื่องนี้ (RSA + config file — ใช้ได้ทั้ง LibreSSL ของ macOS และ OpenSSL)
    printf '[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' >"$tls/ca.cnf"
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj '/CN=dcontact UAT local CA' \
      -config "$tls/ca.cnf" -extensions ca -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
    openssl req -newkey rsa:2048 -nodes -subj "/CN=$UAT_HOST" -config "$tls/ca.cnf" \
      -keyout "$tls/uat.key" -out "$tls/uat.csr" 2>/dev/null
    printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
      "$UAT_HOST" >"$tls/uat.ext"
    openssl x509 -req -in "$tls/uat.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial \
      -days 30 -extfile "$tls/uat.ext" -out "$tls/uat.crt" 2>/dev/null
    rm -f "$tls/ca.key" "$tls/ca.srl" "$tls/ca.cnf" "$tls/uat.csr" "$tls/uat.ext"
  fi
  chmod 644 "$tls/ca.crt" "$tls/uat.crt"
  # Caddy ใน image รันเป็น uid 10001 — บน VM จริงใช้ chown 10001 + 400 (runbook ข้อ 4.4);
  # key นี้ใช้แค่ในเครื่องและอยู่ในโฟลเดอร์ 700 จึงเปิดอ่านได้แทนการใช้ sudo chown
  chmod 644 "$tls/uat.key"
}

write_env() {
  [[ -f "$UAT_ROOT/uat.env" ]] && return 0
  local tenant_id
  tenant_id="$(uuid)"
  (
    echo "UAT_HOST=$UAT_HOST"
    echo "UAT_ALLOWED_CIDRS=$ALLOWED_CIDRS"
    echo "UAT_TLS_CERT_FILE=$UAT_ROOT/tls/uat.crt"
    echo "UAT_TLS_KEY_FILE=$UAT_ROOT/tls/uat.key"
    echo "UAT_TENANT_ID=$tenant_id"
    echo "UAT_TENANT_SLUG=uat-local-${tenant_id:0:8}"
    echo 'UAT_TENANT_NAME=UAT Local Tenant'
    echo "UAT_ORGANIZATION_DOMAIN=$UAT_HOST"
    echo "UAT_POSTGRES_USER=uat_owner_$(secret 4)"
    echo "UAT_POSTGRES_PASSWORD=$(secret 24)"
    echo "UAT_APP_DB_PASSWORD=$(secret 24)"
    echo "UAT_KEYCLOAK_DB_PASSWORD=$(secret 24)"
    echo "UAT_KEYCLOAK_ADMIN_USERNAME=kcadmin-$(secret 4)"
    echo "UAT_KEYCLOAK_ADMIN_PASSWORD=$(secret 24)"
    echo "UAT_MINIO_ROOT_USER=minioroot$(secret 4)"
    echo "UAT_MINIO_ROOT_PASSWORD=$(secret 24)"
    echo "UAT_MINIO_API_ACCESS_KEY=uatapi$(secret 6)"
    echo "UAT_MINIO_API_SECRET_KEY=$(secret 24)"
  ) >"$UAT_ROOT/uat.env"
  chmod 600 "$UAT_ROOT/uat.env"
}

hosts_entry() {
  awk -v host="$UAT_HOST" '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) if ($i == host) found = 1 }
    END { exit found ? 0 : 1 }' /etc/hosts && return 0
  log "เพิ่ม '127.0.0.1 $UAT_HOST' ใน /etc/hosts (ขอรหัสผ่าน sudo)"
  echo "127.0.0.1 $UAT_HOST" | sudo tee -a /etc/hosts >/dev/null
}

wait_api() {
  for _ in $(seq 1 60); do
    if curl -fsS --cacert "$UAT_ROOT/tls/ca.crt" --resolve "$UAT_HOST:443:127.0.0.1" -o /dev/null \
      "https://$UAT_HOST/api/v1/runtime-profile"; then
      return 0
    fi
    sleep 3
  done
  uatc ps -a || true
  uatc logs --no-color --tail 60 proxy api || true
  die 'API ไม่ตอบผ่าน proxy — ถ้า proxy ตอบ 403 ให้ดู IP ใน log ของ proxy แล้วตั้ง UAT_LOCAL_ALLOWED_CIDRS (ต้อง down ก่อน)'
}

smoke() {
  local out="$UAT_ROOT/smoke.json" docker_os
  docker_os="$(docker info --format '{{.OperatingSystem}}')"
  set +e
  if [[ "$docker_os" == *'Docker Desktop'* ]]; then
    UAT_SMOKE_DOCKER_NETWORK=bridge UAT_SMOKE_CONNECT_HOST=host.docker.internal \
      NODE_EXTRA_CA_CERTS="$UAT_ROOT/tls/ca.crt" deploy smoke "$sha" >"$out"
  else
    NODE_EXTRA_CA_CERTS="$UAT_ROOT/tls/ca.crt" deploy smoke "$sha" >"$out"
  fi
  set -e
  # UAT-L07 (พอร์ตภายในต้องปิดบน host) บนเครื่อง dev มักล้มเพราะ service อื่นในเครื่อง เช่น dev stack ของ repo นี้
  # (5433/3000/8080/9000) ไม่ใช่ของ UAT stack — เครื่องนี้จึงเตือนแทนการหยุด; ข้ออื่นต้อง PASS ตาม CI
  node --input-type=module - "$REPO/scripts/u1-uat-ci-assert.mjs" "$out" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [assertPath, reportPath] = process.argv.slice(2);
const { assertSmoke } = await import(pathToFileURL(assertPath).href);
let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch {
  console.error('smoke: อ่านผลไม่ได้ —', readFileSync(reportPath, 'utf8').slice(-2000));
  process.exit(1);
}
const failures = assertSmoke(report);
const l07 = failures.filter((failure) => failure.startsWith('UAT-L07'));
const blocking = failures.filter((failure) => !failure.startsWith('UAT-L07') && failure !== 'status:FAIL');
const statusOnlyFromL07 = failures.includes('status:FAIL') && report.checks
  .filter((check) => check.status === 'FAIL')
  .every((check) => String(check.id).startsWith('UAT-L07'));
for (const check of report.checks ?? []) console.error(`  ${check.status.padEnd(7)} ${check.id}`);
if (l07.length > 0) {
  const detail = report.checks.find((check) => String(check.id).startsWith('UAT-L07'));
  console.error('smoke: เตือน — UAT-L07 พบพอร์ตเปิดบนเครื่อง (ตรวจว่าไม่ใช่ของ dcontact-uat):', JSON.stringify(detail?.failures ?? detail));
}
if (blocking.length > 0 || (failures.includes('status:FAIL') && !statusOnlyFromL07)) {
  console.error('smoke: ไม่ผ่าน —', blocking.join(', ') || 'status:FAIL');
  process.exit(1);
}
NODE
}

provision() {
  [[ -f "$UAT_ROOT/credentials.txt" ]] && {
    log 'provision/บัญชีทำไปแล้ว — ข้าม (ดู credentials.txt)'
    return 0
  }
  local filled="$UAT_ROOT/uat-provision.filled.json" input="$UAT_ROOT/uat-provision.json"
  local maker_password reviewer_password
  # ต้องผ่าน passwordPolicy ของ realm UAT: ยาว 12+ มีตัวพิมพ์ใหญ่/เล็ก/ตัวเลข
  maker_password="Uat7$(secret 12)"
  reviewer_password="Uat7$(secret 12)"

  # กรอก placeholder ของ infra/uat/uat-provision.example.json ด้วยค่าสังเคราะห์ของเครื่องนี้ (ขั้นเดียวกับ runbook §5.2)
  UAT_TENANT_ID="$(env_value UAT_TENANT_ID)" UAT_TENANT_SLUG="$(env_value UAT_TENANT_SLUG)" \
    UAT_TENANT_NAME="$(env_value UAT_TENANT_NAME)" OWNER_TEAM_ID="$(uuid)" \
    MAKER_ID="$(uuid)" REVIEWER_ID="$(uuid)" UAT_HOST="$UAT_HOST" PACK_VERSION="$PACK_VERSION" \
    MAKER_PASSWORD="$maker_password" REVIEWER_PASSWORD="$reviewer_password" \
    node - "$REPO/infra/uat/uat-provision.example.json" "$filled" "$UAT_ROOT/accounts.json" <<'NODE'
const fs = require('fs');
const [example, filledPath, accountsPath] = process.argv.slice(2);
const e = process.env;
const maker = `maker@${e.UAT_HOST}`;
const reviewer = `reviewer@${e.UAT_HOST}`;
const values = {
  __UAT_TENANT_ID__: e.UAT_TENANT_ID,
  __UAT_TENANT_SLUG__: e.UAT_TENANT_SLUG,
  __UAT_TENANT_NAME__: e.UAT_TENANT_NAME,
  __UAT_OWNER_TEAM_ID__: e.OWNER_TEAM_ID,
  __UAT_OWNER_TEAM_NAME__: 'UAT Local Journey Owners',
  __UAT_MAKER_DC_USER_ID__: e.MAKER_ID,
  __UAT_REVIEWER_DC_USER_ID__: e.REVIEWER_ID,
  __UAT_MAKER_EMAIL__: maker,
  __UAT_REVIEWER_EMAIL__: reviewer,
  __UAT_MAKER_DISPLAY_NAME__: 'Local Maker',
  __UAT_REVIEWER_DISPLAY_NAME__: 'Local Reviewer',
  __UAT_ROLLOUT_EVIDENCE_REF__: 'uat-local-rehearsal',
  __UAT_FIXTURE_PACK_VERSION__: e.PACK_VERSION,
};
const filled = JSON.parse(fs.readFileSync(example, 'utf8'), (_key, value) =>
  typeof value === 'string' && value in values ? values[value] : value,
);
fs.writeFileSync(filledPath, JSON.stringify(filled), { mode: 0o600 });
const account = (role, dcUserId, email, temporaryPassword, lastName) => ({
  role, username: email, email, firstName: 'Local', lastName, dcUserId, temporaryPassword,
});
fs.writeFileSync(
  accountsPath,
  JSON.stringify({
    accounts: [
      account('maker', e.MAKER_ID, maker, e.MAKER_PASSWORD, 'Maker'),
      account('reviewer', e.REVIEWER_ID, reviewer, e.REVIEWER_PASSWORD, 'Reviewer'),
    ],
  }),
  { mode: 0o600 },
);
NODE

  log 'render fixture pack uat-first-slice.v1'
  rm -f "$input"
  node "$REPO/scripts/u1-uat-fixture-render.mjs" --input "$filled" --build-sha "$sha" --output "$input"
  rm -f "$filled"

  log 'provision --check แล้ว apply'
  deploy provision "$sha" "$input" --check
  deploy provision "$sha" "$input"
  rm -f "$input"

  log 'สร้างบัญชี maker/reviewer ใน Keycloak'
  uatc --profile ops run --rm -T keycloak-config \
    node scripts/u1-uat-keycloak-users.mjs --users /dev/stdin <"$UAT_ROOT/accounts.json"
  rm -f "$UAT_ROOT/accounts.json"

  (
    echo "URL:      https://$UAT_HOST/?tenant=$(env_value UAT_TENANT_SLUG)"
    echo "maker:    maker@$UAT_HOST / $maker_password"
    echo "reviewer: reviewer@$UAT_HOST / $reviewer_password"
    echo 'รหัสผ่านเป็นแบบชั่วคราว: login ครั้งแรกต้องตั้งรหัสใหม่และผูก authenticator app (TOTP)'
  ) >"$UAT_ROOT/credentials.txt"
  chmod 600 "$UAT_ROOT/credentials.txt"
}

up() {
  preflight
  cd "$REPO"
  layout
  log "registry ในเครื่อง ($REGISTRY)"
  start_registry
  build_images
  tls_files
  write_env
  hosts_entry
  log 'prepare → migrate → keycloak → deploy'
  deploy prepare "$sha"
  deploy migrate "$sha"
  deploy keycloak "$sha"
  deploy deploy "$sha"
  wait_api
  log 'smoke (u1-uat-readiness.mjs --live)'
  smoke
  provision
  log 'พร้อมใช้งาน'
  cat "$UAT_ROOT/credentials.txt"
  if ! command -v mkcert >/dev/null 2>&1; then
    printf '\nbrowser จะเตือนเรื่อง cert — ให้เชื่อ CA ของเครื่องนี้ (macOS):\n  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain %s\n' \
      "$UAT_ROOT/tls/ca.crt"
  fi
}

down() {
  if [[ -f "$release/release.env" && -f "$UAT_ROOT/uat.env" ]]; then
    uatc --profile ops down -v --remove-orphans || true
  fi
  docker rm -f "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$UAT_ROOT"
  printf 'ลบ stack และ %s แล้ว — ถ้าไม่ใช้อีก ลบบรรทัด %s ออกจาก /etc/hosts เอง\n' "$UAT_ROOT" "$UAT_HOST"
}

case "${1:-}" in
  up) up ;;
  status) uatc ps -a ;;
  logs)
    shift
    uatc logs --no-color --tail 200 "$@"
    ;;
  down) down ;;
  *)
    echo 'usage: uat-local.sh <up|status|logs [service...]|down>' >&2
    exit 64
    ;;
esac
