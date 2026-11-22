#!/usr/bin/env bash
# #923: ขึ้น UAT แบบ D-Contact Solo บน VM สามตัว — รันจากเครื่อง operator ที่ root ของ repository
#
#   bash infra/solo/bin/solo-uat.sh <init-env|build|data|app|voice|status> [--reset]
#
# ลำดับครั้งแรก: init-env → build → data → app → voice
#   init-env   สร้าง solo.env (secret ทั้งหมด) นอก repository ครั้งเดียว ไม่เขียนทับไฟล์เดิม
#   build      ส่งซอร์สของ working tree ไป build image บน VM app และ VM voice (ไม่มี registry)
#   data       เตรียมฐานบน VM data และตาราง voice edge (--reset = ลบฐานของ Solo แล้วสร้างใหม่)
#   app        ขึ้น stack บน VM app, migrate, seed แบบ Demo (owner อนุมัติ 19 พ.ย. 2569)
#   voice      ขึ้น nginx, Kamailio, FreeSWITCH บน VM voice
#   status     สถานะ container ทั้งสอง VM
#
# ค่าที่ปรับได้ผ่าน env: SOLO_ENV, SOLO_SSH_USER, SOLO_SIM_TRUNK_IP (ใช้ตอน init-env และ data)
# ไม่พิมพ์ค่า secret: ส่งไฟล์ด้วย scp แล้ว chmod 600 บนปลายทาง
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SOLO_ENV="${SOLO_ENV:-$HOME/.config/dcontact-solo/solo.env}"
SSH_USER="${SOLO_SSH_USER:-osdadmin}"
REMOTE_ROOT=/opt/dcontact-solo
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

log() { printf '# %s\n' "$*"; }
fail() { printf 'solo-uat: %s\n' "$*" >&2; exit 1; }

env_value() {
  sed -n "s/^$1=//p" "$SOLO_ENV" | tail -1
}

remote() { # remote <ip> <command>
  ssh "${SSH_OPTS[@]}" "$SSH_USER@$1" "$2"
}

load_hosts() {
  [[ -r "$SOLO_ENV" ]] || fail "ไม่มี $SOLO_ENV — รัน init-env ก่อน"
  VOICE_IP="$(env_value SOLO_VOICE_IP)"
  APP_IP="$(env_value SOLO_APP_IP)"
  DATA_IP="$(env_value SOLO_DATA_IP)"
  CONSOLE_HOST="$(env_value SOLO_CONSOLE_HOST)"
  WORKSPACE_HOST="$(env_value SOLO_WORKSPACE_HOST)"
  IMAGE_TAG="$(env_value SOLO_IMAGE_TAG)"
}

secret() {
  openssl rand -hex 24
}

cmd_init_env() {
  if [[ -e "$SOLO_ENV" ]]; then
    log "มี $SOLO_ENV อยู่แล้ว ไม่เขียนทับ"
    return
  fi
  mkdir -p "$(dirname "$SOLO_ENV")"
  local voice=192.168.31.206 app=192.168.31.207 data=192.168.31.208
  local console=dcontact-solo-uat.osd.co.th workspace=dcontact-solo-workspace-uat.osd.co.th
  local owner app_db platform provisioner directory esl
  owner="$(secret)"; app_db="$(secret)"; platform="$(secret)"; provisioner="$(secret)"
  directory="$(secret)"; esl="$(secret)"
  cat >"$SOLO_ENV" <<EOF
# UAT Solo (#923) — สร้างโดย solo-uat.sh init-env ห้าม commit / ห้ามแปะใน issue หรือแชท
SOLO_VOICE_IP=$voice
SOLO_APP_IP=$app
SOLO_DATA_IP=$data
SOLO_CONSOLE_HOST=$console
SOLO_WORKSPACE_HOST=$workspace
SOLO_IMAGE_TAG=dev
# IP ของเครื่องใน LAN ที่ใช้เป็นสายจำลอง (softphone/SIPp) — Kamailio รับสายเข้าจาก IP นี้เท่านั้น
SOLO_SIM_TRUNK_IP=${SOLO_SIM_TRUNK_IP:-}

SOLO_DB_OWNER_PASSWORD=$owner
SOLO_DB_APP_PASSWORD=$app_db
SOLO_DB_PLATFORM_PASSWORD=$platform
SOLO_DB_PROVISIONER_PASSWORD=$provisioner
SOLO_KEYCLOAK_DB_PASSWORD=$(secret)
SOLO_VOICE_EDGE_OWNER_PASSWORD=$(secret)
SOLO_KAMAILIO_DB_PASSWORD=$(secret)
# รหัสผ่านของผู้ใช้ demo (admin@demo.local, agent1000/1001@demo.local)
SOLO_ADMIN_PASSWORD=$(secret | cut -c1-16)
SOLO_AGENT_PASSWORD=$(secret | cut -c1-16)

# รันแบบ non-production เหมือน dev stack: consumer ของ Kafka ยังใช้ idempotency store ในหน่วยความจำ
# ซึ่ง guard ของ production ไม่ยอม — secret ทุกตัวตั้งค่าเองใน solo.env จึงไม่ใช้ค่า fallback ของ dev
NODE_ENV=development
DATABASE_URL=postgresql://dcontact:$owner@$data:5432/dcontact?schema=public
APPLICATION_DATABASE_URL=postgresql://dcontact_app:$app_db@$data:5432/dcontact?schema=public
PLATFORM_DATABASE_URL=postgresql://dcontact_platform:$platform@$data:5432/dcontact?schema=public
PROVISIONER_DATABASE_URL=postgresql://dcontact_provisioner:$provisioner@$data:5432/dcontact?schema=public
KAFKA_BROKERS=redpanda:29092
REDIS_URL=redis://redis:6379
KEYCLOAK_ISSUER=https://$console/auth/realms/dcontact
KEYCLOAK_JWKS_URI=http://keycloak:8080/auth/realms/dcontact/protocol/openid-connect/certs
KEYCLOAK_AUDIENCE=dcontact-api
KEYCLOAK_ADMIN_URL=http://keycloak:8080/auth
KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME=solo-admin
KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD=$(secret)
KEYCLOAK_C360_CLIENT_ID=dcontact-c360-introspection-dev
KEYCLOAK_C360_CLIENT_SECRET=$(secret)
KEYCLOAK_ACCOUNT_SERVICE_SECRET=$(secret)
ACCOUNT_SECRET_KEY=$(openssl rand -base64 32)
WORKSPACE_ORIGIN=https://$workspace
CONSOLE_PUBLIC_URL=https://$console
TELEPHONY_NODE_ID=fs-solo
SIP_BROWSER_NODES_JSON=[{"telephonyNodeId":"fs-solo","wssUrl":"wss://$workspace/sip-ws"}]
SIP_ICE_SERVERS_JSON=[]
FREESWITCH_DIRECTORY_PASSWORD=$directory
FREESWITCH_ESL_HOST=$voice
FREESWITCH_ESL_PORT=8021
FREESWITCH_ESL_PASSWORD=$esl
FS_ESL_PASSWORD=$esl
FREESWITCH_SIP_DOMAIN=dcontact.local
ROUTER_INBOUND_VOICE_GROUP_ID=dcontact-router-solo
IAM_SEGMENT_PROJECTION_GROUP_ID=dcontact-iam-segment-solo
S3_ENDPOINT=http://object-storage:9000
S3_REGION=us-east-1
S3_ACCESS_KEY=solo$(secret | cut -c1-12)
S3_SECRET_KEY=$(secret)
S3_FORCE_PATH_STYLE=true
S3_BUCKET_RECORDINGS=recordings
S3_BUCKET_GOVERNANCE_EXPORTS=governance-exports
S3_BUCKET_UAT_EVIDENCE=uat-evidence
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_FROM=no-reply@dcontact.local
SMTP_HELO=dcontact.local
LINE_WEBHOOK_TENANT_ID=00000000-0000-4000-8000-000000000000
LINE_WEBHOOK_SECRET_SOURCE=disabled
LINE_WEBHOOK_CHANNEL_ACCOUNT_ID=solo-disabled
LINE_WEBHOOK_DESTINATION=solo-disabled
LINE_WEBHOOK_PAYLOAD_KEY_REF=solo-disabled
QM_MEDIA_ENDPOINT=https://object-storage.example.internal
QM_TRANSCRIPTION_PROVIDER_ID=deployment-asr
QM_TRANSCRIPTION_ENDPOINT=https://asr.example.internal/transcribe
QM_TRANSCRIPTION_API_KEY=not-configured-in-solo-uat
QM_SCORING_PROVIDER_ID=deployment-scorer
QM_SCORING_ENDPOINT=https://scoring.example.internal/score
QM_SCORING_MODEL_ID=not-configured
QM_SCORING_PROMPT_VERSION=not-configured
QM_SCORING_API_KEY=not-configured-in-solo-uat
EOF
  chmod 600 "$SOLO_ENV"
  log "สร้าง $SOLO_ENV แล้ว (mode 600)"
}

set_env_value() { # set_env_value <name> <value>
  local tmp
  tmp="$(mktemp)"
  awk -v name="$1" -v value="$2" -F= 'BEGIN { done = 0 }
    $1 == name { print name "=" value; done = 1; next }
    { print }
    END { if (!done) print name "=" value }' "$SOLO_ENV" >"$tmp"
  cat "$tmp" >"$SOLO_ENV"
  rm -f "$tmp"
}

ship_source() { # ship_source <ip> — ส่ง working tree (ไม่รวมไฟล์ที่ git ignore) ไปที่ /tmp/solo-build
  # ไม่พา metadata ของ macOS (ไฟล์ ._*) ไปด้วย — javac ของ Keycloak extension พยายาม compile ไฟล์เหล่านั้น
  ( cd "$ROOT" && git ls-files -co --exclude-standard -z |
    COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --null -cf - -T - ) |
    remote "$1" 'mkdir -p /tmp/solo-build && find /tmp/solo-build -mindepth 1 -delete && tar -xf - -C /tmp/solo-build'
}

cmd_build() {
  load_hosts
  local tag
  tag="$(cd "$ROOT" && git rev-parse --short=12 HEAD)"
  if [[ -n "$(cd "$ROOT" && git status --porcelain)" ]]; then tag="$tag-dirty"; fi
  log "build image tag $tag"
  ship_source "$APP_IP"
  remote "$APP_IP" "cd /tmp/solo-build && set -e
    docker build -q -f infra/solo/app/Dockerfile --target services --build-arg SOURCE_SHA=$tag -t dcontact-solo/services:$tag .
    docker build -q -f infra/solo/app/Dockerfile --target ops -t dcontact-solo/ops:$tag .
    docker build -q -f infra/keycloak/Dockerfile --build-arg SOURCE_SHA=$tag -t dcontact-solo/keycloak:$tag .
    docker build -q -f apps/console/Dockerfile \
      --build-arg SOURCE_SHA=$tag \
      --build-arg VITE_KC_ISSUER=https://$CONSOLE_HOST/auth/realms/dcontact \
      --build-arg VITE_KC_CLIENT_ID=agent-desktop \
      --build-arg VITE_WORKSPACE_KC_CLIENT_ID=agent-desktop \
      --build-arg VITE_CONSOLE_URL=https://$CONSOLE_HOST \
      --build-arg VITE_WORKSPACE_URL=https://$WORKSPACE_HOST \
      --build-arg VITE_UAT_ENVIRONMENT=solo-uat \
      --build-arg VITE_UAT_PACK_VERSION=solo-uat \
      -t dcontact-solo/web:$tag ."
  ship_source "$VOICE_IP"
  remote "$VOICE_IP" "cd /tmp/solo-build && docker build -q -t dcontact-solo/kamailio:$tag infra/voice-edge/kamailio"
  set_env_value SOLO_IMAGE_TAG "$tag"
  log "build เสร็จ ตั้ง SOLO_IMAGE_TAG=$tag ใน solo.env แล้ว"
}

prepare_remote_dir() { # prepare_remote_dir <ip> <subdir>
  remote "$1" "sudo install -d -o $SSH_USER -g $SSH_USER -m 700 $REMOTE_ROOT $REMOTE_ROOT/$2"
}

cmd_data() {
  load_hosts
  local reset="${1:-}"
  prepare_remote_dir "$DATA_IP" data
  scp -q "${SSH_OPTS[@]}" "$ROOT/infra/solo/data/init-db.sh" "$ROOT/infra/voice-edge/schema.sql" \
    "$ROOT/infra/voice-edge/grant-kamailio.sql" "$SOLO_ENV" "$SSH_USER@$DATA_IP:$REMOTE_ROOT/data/"
  remote "$DATA_IP" "cd $REMOTE_ROOT/data && chmod 600 solo.env && sudo SOLO_ENV=$REMOTE_ROOT/data/solo.env sh init-db.sh $reset"
  # ตาราง voice edge และ role อ่านอย่างเดียวของ Kamailio
  # ส่ง SQL ทาง stdin เพราะ user postgres อ่านไฟล์ใน directory mode 700 ของ operator ไม่ได้
  remote "$DATA_IP" "cd $REMOTE_ROOT/data && sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d dcontact_voice_edge <schema.sql \
    && sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d dcontact_voice_edge -v kamailio_password=\"\$(sed -n 's/^SOLO_KAMAILIO_DB_PASSWORD=//p' solo.env)\" <grant-kamailio.sql"
  local sim
  sim="$(env_value SOLO_SIM_TRUNK_IP)"
  if [[ -n "$sim" ]]; then
    [[ "$sim" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "SOLO_SIM_TRUNK_IP ไม่ใช่ IPv4"
    remote "$DATA_IP" "sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d dcontact_voice_edge -c \"
      INSERT INTO tenant_edge (tenant_domain, max_channels) VALUES ('dcontact.local', 35)
        ON CONFLICT (tenant_domain) DO UPDATE SET max_channels = EXCLUDED.max_channels, enabled = true;
      INSERT INTO trunk (id, name, tenant_domain, source_ip, host) VALUES ('lan-sim', 'สายจำลองใน LAN', 'dcontact.local', '$sim', '$sim')
        ON CONFLICT (id) DO UPDATE SET source_ip = EXCLUDED.source_ip, host = EXCLUDED.host, enabled = true;
      INSERT INTO number (e164, tenant_domain, trunk_id, route_to) VALUES
        ('021000001', 'dcontact.local', 'lan-sim', '2000'), ('021000002', 'dcontact.local', 'lan-sim', '2001'),
        ('021000004', 'dcontact.local', 'lan-sim', '2002')
        ON CONFLICT (e164) DO NOTHING;\""
    log "trunk จำลอง lan-sim รับสายจาก $sim: 021000001 → คิว (2000), 021000002 → IVR (2001), 021000004 → คิว managed (2002)"
  else
    log "ยังไม่ตั้ง SOLO_SIM_TRUNK_IP ใน solo.env — ข้ามการสร้าง trunk จำลอง"
  fi
  remote "$DATA_IP" "shred -u $REMOTE_ROOT/data/solo.env"
  log "ฐานบน VM data พร้อม"
}

ops() { # ops <shell command> — รันใน container ops บน network ของ stack
  remote "$APP_IP" "cd $REMOTE_ROOT/app && docker run --rm --network dcontact-solo_default --env-file solo.env \
    -e DCONTACT_LINK_DATABASE_URL=\"\$(sed -n 's/^DATABASE_URL=//p' solo.env)\" \
    -e DCONTACT_LINK_ADMIN_PASSWORD=\"\$(sed -n 's/^SOLO_ADMIN_PASSWORD=//p' solo.env)\" \
    -e DCONTACT_LINK_AGENT_PASSWORD=\"\$(sed -n 's/^SOLO_AGENT_PASSWORD=//p' solo.env)\" \
    -e SOLO_API_ORIGIN=http://api:3000 \
    dcontact-solo/ops:$IMAGE_TAG sh -ec '$1'"
}

wait_healthy() { # wait_healthy <service> <tries>
  local tries="$2"
  for _ in $(seq 1 "$tries"); do
    if remote "$APP_IP" "docker inspect -f '{{.State.Health.Status}}' dcontact-solo-$1-1 2>/dev/null" | grep -q healthy; then
      return 0
    fi
    sleep 5
  done
  fail "$1 ไม่ healthy"
}

cmd_app() {
  load_hosts
  [[ "$IMAGE_TAG" != dev ]] || log "SOLO_IMAGE_TAG=dev (ยังไม่ได้ build ด้วยสคริปต์นี้)"
  prepare_remote_dir "$APP_IP" app
  local work
  work="$(mktemp -d)"
  mkdir -p "$work/keycloak-import"
  node "$ROOT/infra/solo/bin/render-realm.mjs" "$CONSOLE_HOST" "$WORKSPACE_HOST" >"$work/keycloak-import/realm-dcontact.json"
  cp "$ROOT/infra/solo/app/docker-compose.yml" "$ROOT/infra/solo/app/Caddyfile" "$work/"
  cp "$SOLO_ENV" "$work/solo.env"
  ( cd "$work" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -cf - . ) | remote "$APP_IP" "tar -xf - -C $REMOTE_ROOT/app && chmod 600 $REMOTE_ROOT/app/solo.env && chmod 755 $REMOTE_ROOT/app/keycloak-import && chmod 644 $REMOTE_ROOT/app/keycloak-import/realm-dcontact.json $REMOTE_ROOT/app/Caddyfile"
  rm -rf "$work"
  local compose="cd $REMOTE_ROOT/app && docker compose --env-file solo.env"
  remote "$APP_IP" "$compose up -d redis redpanda redpanda-init object-storage mailpit keycloak"
  wait_healthy keycloak 60
  log "migrate, rls, seed ฐานแอป และเชื่อมผู้ใช้ใน Keycloak"
  ops 'pnpm db:migrate && pnpm db:rls && pnpm db:seed && node scripts/link-keycloak-dev-identity.mjs'
  remote "$APP_IP" "$compose up -d"
  for _ in $(seq 1 60); do
    if remote "$APP_IP" "docker exec dcontact-solo-api-1 node -e \"fetch('http://127.0.0.1:3000/api/v1/me/navigation').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))\"" 2>/dev/null; then
      break
    fi
    sleep 5
  done
  log "seed แบบ Demo (ทีม, identity binding, scope, CONTACT_CREATE)"
  ops 'node scripts/solo-uat-seed.mjs'
  remote "$APP_IP" "$compose ps --format 'table {{.Service}}\t{{.Status}}'"
}

cmd_voice() {
  load_hosts
  prepare_remote_dir "$VOICE_IP" voice
  local work
  work="$(mktemp -d)"
  mkdir -p "$work/freeswitch/base" "$work/freeswitch/overrides"
  cp -R "$ROOT/infra/freeswitch/conf/." "$work/freeswitch/base/"
  cp -R "$ROOT/infra/solo/voice/freeswitch/overrides/." "$work/freeswitch/overrides/"
  cp "$ROOT/infra/solo/voice/freeswitch/entrypoint.sh" "$work/freeswitch/"
  cp "$ROOT/infra/solo/voice/docker-compose.yml" "$work/"
  sed -e "s/__SOLO_APP_IP__/$APP_IP/g" -e "s/__SOLO_CONSOLE_HOST__/$CONSOLE_HOST/g" \
    -e "s/__SOLO_WORKSPACE_HOST__/$WORKSPACE_HOST/g" "$ROOT/infra/solo/voice/nginx.conf" >"$work/nginx.conf"
  printf '# set 1 = FreeSWITCH profile pstn-sim บน VM เดียวกัน\n1 sip:%s:5080 0 0\n' "$VOICE_IP" >"$work/dispatcher.list"
  # voice ได้เฉพาะค่าที่ใช้ ไม่ได้ secret ของฐานแอป
  grep -E '^(SOLO_VOICE_IP|SOLO_APP_IP|SOLO_DATA_IP|SOLO_IMAGE_TAG|SOLO_KAMAILIO_DB_PASSWORD|TELEPHONY_NODE_ID|FREESWITCH_ESL_PASSWORD|FREESWITCH_DIRECTORY_PASSWORD)=' \
    "$SOLO_ENV" >"$work/.env"
  ( cd "$work" && COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -cf - . ) | remote "$VOICE_IP" "tar -xf - -C $REMOTE_ROOT/voice && cd $REMOTE_ROOT/voice && chmod 600 .env && chmod -R a+rX freeswitch nginx.conf dispatcher.list"
  rm -rf "$work"
  # cert ของ star.osd.co.th วางที่ tls/server.crt และ tls/server.key; ถ้ายังไม่มีใช้ self-signed ชั่วคราว
  remote "$VOICE_IP" "cd $REMOTE_ROOT/voice && mkdir -p tls && if [ ! -s tls/server.crt ] || [ ! -s tls/server.key ]; then
      openssl req -x509 -newkey rsa:2048 -nodes -days 90 -subj '/CN=$CONSOLE_HOST' \
        -addext 'subjectAltName=DNS:$CONSOLE_HOST,DNS:$WORKSPACE_HOST' \
        -keyout tls/server.key -out tls/server.crt 2>/dev/null && echo '# ใช้ cert self-signed ชั่วคราว';
    fi; chmod 644 tls/server.crt; chmod 640 tls/server.key; sudo chgrp 101 tls/server.key"
  remote "$VOICE_IP" "cd $REMOTE_ROOT/voice && docker compose up -d && sleep 15 && docker compose ps --format 'table {{.Service}}\t{{.Status}}'"
  # Telephony ต่อ ESL ครั้งเดียวตอนเริ่มและไม่ลองใหม่ จึงเริ่มใหม่หลัง FreeSWITCH ขึ้นแล้ว
  remote "$APP_IP" "docker restart dcontact-solo-telephony-1 >/dev/null"
  log "เริ่ม Telephony ใหม่ให้ต่อ ESL ของ FreeSWITCH"
}

cmd_status() {
  load_hosts
  for ip in "$APP_IP" "$VOICE_IP"; do
    log "$ip"
    remote "$ip" "docker ps --format 'table {{.Names}}\t{{.Status}}'"
  done
}

case "${1:-}" in
  init-env) cmd_init_env ;;
  build) cmd_build ;;
  data) cmd_data "${2:-}" ;;
  app) cmd_app ;;
  voice) cmd_voice ;;
  status) cmd_status ;;
  *) sed -n '2,15p' "$0"; exit 64 ;;
esac
