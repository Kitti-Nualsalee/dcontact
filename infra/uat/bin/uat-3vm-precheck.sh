#!/usr/bin/env bash
# ตรวจความพร้อมของ VM ทั้ง 3 ก่อนติดตั้ง UAT (read-only — ไม่แก้ไขอะไรบน VM)
#
#   VM1 nginx      osdadmin@192.168.102.114  (หน้าเว็บ / reverse proxy / TLS)
#   VM2 docker     osdadmin@192.168.102.112  (compose stack)
#   VM3 postgresql osdadmin@192.168.102.113  (database)
#
# ใช้งาน (รันจากเครื่องที่ ssh เข้าทั้ง 3 VM ได้แบบไม่ใช้ password):
#   bash infra/uat/bin/uat-3vm-precheck.sh
#   PG_PASSWORD='...' bash infra/uat/bin/uat-3vm-precheck.sh   # ตรวจ login/สิทธิ์ของ Postgres ด้วย
#
# ตัวแปรที่ override ได้: VM_NGINX VM_DOCKER VM_PG SSH_USER UAT_HOST PG_USER PG_PORT SSH_OPTS
# password ไม่ถูกเขียนลงไฟล์ และไม่ส่งผ่าน argv (ส่งทาง stdin ของ ssh เท่านั้น)
set -u

VM_NGINX="${VM_NGINX:-192.168.102.114}"
VM_DOCKER="${VM_DOCKER:-192.168.102.112}"
VM_PG="${VM_PG:-192.168.102.113}"
SSH_USER="${SSH_USER:-osdadmin}"
UAT_HOST="${UAT_HOST:-dcontact-uat.osd.co.th}"
PG_USER="${PG_USER:-id24}"
PG_PORT="${PG_PORT:-5432}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new}"

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  [ OK ] %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf '  [WARN] %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*"; }
info() { printf '  [info] %s\n' "$*"; }
head_() { printf '\n== %s ==\n' "$*"; }

# rmt <host> <script...> : รันสคริปต์ bash บน VM (อ่านจาก stdin)
rmt() { local h="$1"; shift; ssh $SSH_OPTS "${SSH_USER}@${h}" 'bash -s' "$@" 2>&1; }

# tcp <from-host> <to-host> <port> : ทดสอบ TCP จาก VM หนึ่งไปอีก VM
tcp() {
  local from="$1" to="$2" port="$3"
  rmt "$from" <<EOF >/dev/null
timeout 5 bash -c 'exec 3<>/dev/tcp/${to}/${port}' 2>/dev/null
EOF
}

reach() {
  local name="$1" host="$2"
  if ssh $SSH_OPTS "${SSH_USER}@${host}" true 2>/dev/null; then
    ok "$name ($host): ssh ด้วย key ได้"; return 0
  fi
  bad "$name ($host): ssh ไม่ได้ (ตรวจ key/เครือข่าย) — ข้ามการตรวจ VM นี้"; return 1
}

common_checks() {
  local host="$1" out
  out=$(rmt "$host" <<'EOF'
. /etc/os-release 2>/dev/null
echo "os=${PRETTY_NAME:-unknown}"
echo "kernel=$(uname -r)"
echo "cpu=$(nproc)"
echo "mem_mb=$(awk '/MemTotal/{printf "%d",$2/1024}' /proc/meminfo)"
echo "disk_free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
echo "ntp=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
echo "tz=$(timedatectl show -p Timezone --value 2>/dev/null || echo unknown)"
if sudo -n true 2>/dev/null; then echo "sudo=nopasswd"; else echo "sudo=needs-password-or-none"; fi
echo "ufw=$(sudo -n ufw status 2>/dev/null | head -1 || echo n/a)"
echo "fw_pkgs=$(command -v ufw firewall-cmd 2>/dev/null | tr '\n' ' ')"
EOF
)
  local v
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  info "OS: $(get os) / kernel $(get kernel)"
  info "CPU $(get cpu) core, RAM $(get mem_mb) MB, disk ว่าง / $(get disk_free_gb) GB, timezone $(get tz)"
  v=$(get ntp); [ "$v" = yes ] && ok "เวลา sync (NTP)" || warn "NTP ยังไม่ sync ($v) — TLS/TOTP ของ Keycloak ไวต่อเวลา"
  v=$(get sudo); [ "$v" = nopasswd ] && ok "sudo แบบไม่ถาม password" || warn "sudo ต้องใช้ password หรือไม่มีสิทธิ์ — ขั้นติดตั้งอาจต้องใช้"
  info "firewall: ufw=$(get ufw) pkgs=$(get fw_pkgs)"
}

# ---------------------------------------------------------------- VM2 docker
check_docker() {
  head_ "VM2 docker — ${VM_DOCKER}"
  reach docker "$VM_DOCKER" || return
  common_checks "$VM_DOCKER"
  local out get
  out=$(rmt "$VM_DOCKER" <<'EOF'
echo "docker=$(docker --version 2>/dev/null || echo missing)"
echo "compose=$(docker compose version 2>/dev/null || echo missing)"
echo "daemon_active=$(systemctl is-active docker 2>/dev/null || echo unknown)"
echo "in_docker_group=$(id -nG | tr ' ' '\n' | grep -qx docker && echo yes || echo no)"
echo "docker_cli=$(docker info >/dev/null 2>&1 && echo ok || echo denied)"
echo "daemon_json=$(cat /etc/docker/daemon.json 2>/dev/null | tr -d '\n ' || echo none)"
echo "userland_proxy_false=$(grep -Eq '"userland-proxy"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json 2>/dev/null && echo yes || echo no)"
echo "opt_dir=$(ls -ld /opt/dcontact-uat 2>/dev/null || echo missing)"
echo "running_containers=$(docker ps -q 2>/dev/null | wc -l)"
echo "port80=$(ss -ltn 2>/dev/null | awk '$4 ~ /:80$/' | wc -l)"
echo "port443=$(ss -ltn 2>/dev/null | awk '$4 ~ /:443$/' | wc -l)"
echo "ghcr=$(curl -sS -o /dev/null -m 8 -w '%{http_code}' https://ghcr.io/v2/ 2>/dev/null || echo fail)"
echo "dns_uat=$(getent hosts UAT_HOST_PLACEHOLDER | awk '{print $1}' | head -1)"
EOF
)
  out=${out//UAT_HOST_PLACEHOLDER/$UAT_HOST}
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  case "$(get docker)" in missing) bad "ไม่พบ docker";; *) ok "$(get docker)";; esac
  case "$(get compose)" in missing) bad "ไม่พบ docker compose plugin";; *) ok "$(get compose)";; esac
  [ "$(get daemon_active)" = active ] && ok "docker daemon active" || bad "docker daemon ไม่ active ($(get daemon_active))"
  [ "$(get in_docker_group)" = yes ] && ok "${SSH_USER} อยู่ในกลุ่ม docker" || warn "${SSH_USER} ไม่อยู่ในกลุ่ม docker (ต้องใช้ sudo หรือเพิ่ม user)"
  [ "$(get docker_cli)" = ok ] || warn "รัน docker CLI ไม่ได้ในฐานะ ${SSH_USER} ($(get docker_cli))"
  if [ "$(get userland_proxy_false)" = yes ]; then
    ok "daemon.json ตั้ง userland-proxy=false แล้ว"
  else
    warn "ยังไม่ตั้ง \"userland-proxy\": false ใน /etc/docker/daemon.json (daemon.json=$(get daemon_json))"
  fi
  case "$(get opt_dir)" in missing) warn "ยังไม่มี /opt/dcontact-uat (ต้องสร้างตามข้อ 4.3 ของ runbook)";; *) ok "$(get opt_dir)";; esac
  info "containers ที่รันอยู่: $(get running_containers); port 80 listen=$(get port80), 443 listen=$(get port443)"
  case "$(get ghcr)" in 200|401|403) ok "เข้าถึง ghcr.io ได้ (HTTP $(get ghcr))";; *) bad "เข้า ghcr.io ไม่ได้ ($(get ghcr)) — ต้อง pull image (proxy/firewall?)";; esac
  [ -n "$(get dns_uat)" ] && info "DNS ${UAT_HOST} จาก VM นี้ -> $(get dns_uat)" || info "VM นี้ resolve ${UAT_HOST} ไม่ได้"
}

# ---------------------------------------------------------------- VM1 nginx
check_nginx() {
  head_ "VM1 nginx — ${VM_NGINX}"
  reach nginx "$VM_NGINX" || return
  common_checks "$VM_NGINX"
  local out get
  out=$(rmt "$VM_NGINX" <<'EOF'
echo "nginx=$( (nginx -v 2>&1 || /usr/sbin/nginx -v 2>&1) | head -1)"
echo "active=$(systemctl is-active nginx 2>/dev/null || echo unknown)"
echo "conf_test=$(sudo -n nginx -t 2>&1 | tail -1 | tr -d '\n' || echo n/a)"
echo "port80=$(ss -ltn 2>/dev/null | awk '$4 ~ /:80$/' | wc -l)"
echo "port443=$(ss -ltn 2>/dev/null | awk '$4 ~ /:443$/' | wc -l)"
echo "sites=$(ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | tr '\n' ' ')"
echo "certs=$(sudo -n find /etc/nginx /etc/ssl /etc/letsencrypt -maxdepth 3 \( -name '*.crt' -o -name '*.pem' \) 2>/dev/null | head -8 | tr '\n' ' ')"
echo "ws_upgrade_map=$(grep -rqs 'Upgrade' /etc/nginx 2>/dev/null && echo yes || echo no)"
EOF
)
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  case "$(get nginx)" in *nginx/*) ok "$(get nginx)";; *) bad "ไม่พบ nginx";; esac
  [ "$(get active)" = active ] && ok "nginx active" || warn "nginx ไม่ active ($(get active))"
  info "nginx -t: $(get conf_test)"
  info "listen: 80=$(get port80) 443=$(get port443); sites: $(get sites)"
  [ -n "$(get certs)" ] && info "ไฟล์ cert ที่พบ: $(get certs)" || warn "ไม่พบไฟล์ cert ใต้ /etc/nginx|/etc/ssl|/etc/letsencrypt (ต้องมี cert ของ ${UAT_HOST})"
  # DNS ของ UAT_HOST ต้องชี้มาที่ VM1
  local resolved
  resolved=$(getent hosts "$UAT_HOST" 2>/dev/null | awk '{print $1}' | head -1)
  if [ -z "$resolved" ]; then
    warn "เครื่องที่รันสคริปต์ resolve ${UAT_HOST} ไม่ได้ (ต้องตั้ง DNS/hosts ให้ชี้ ${VM_NGINX})"
  elif [ "$resolved" = "$VM_NGINX" ]; then
    ok "DNS ${UAT_HOST} -> ${resolved}"
  else
    warn "DNS ${UAT_HOST} -> ${resolved} (ไม่ใช่ ${VM_NGINX})"
  fi
}

# ---------------------------------------------------------------- VM3 postgres
check_pg() {
  head_ "VM3 postgresql — ${VM_PG}"
  reach postgres "$VM_PG" || return
  common_checks "$VM_PG"
  local out get
  out=$(rmt "$VM_PG" <<EOF
echo "psql=\$(psql --version 2>/dev/null || echo missing) (client)"
echo "active=\$(systemctl is-active postgresql 2>/dev/null || echo unknown)"
echo "listen=\$(ss -ltn 2>/dev/null | awk '\$4 ~ /:${PG_PORT}\$/{print \$4}' | tr '\n' ' ')"
echo "hba=\$(sudo -n grep -hEv '^[[:space:]]*(#|\$)' /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | tr '\n' ';' | head -c 900)"
echo "listen_addresses=\$(sudo -n grep -hE '^[[:space:]]*listen_addresses' /etc/postgresql/*/main/postgresql.conf 2>/dev/null | tr -d ' ' | head -1)"
echo "max_connections=\$(sudo -n grep -hE '^[[:space:]]*max_connections' /etc/postgresql/*/main/postgresql.conf 2>/dev/null | tr -d ' ' | head -1)"
echo "disk_pg_gb=\$(df -BG --output=avail /var/lib/postgresql 2>/dev/null | tail -1 | tr -dc 0-9)"
EOF
)
  get() { printf '%s\n' "$out" | sed -n "s/^$1=//p" | head -1; }
  info "$(get psql); service=$(get active); listen=$(get listen)"
  [ "$(get active)" = active ] || warn "service postgresql ไม่ active ($(get active)) — ถ้าเป็น cluster ชื่ออื่นให้ตรวจเอง"
  [ -n "$(get listen)" ] || warn "ไม่พบ port ${PG_PORT} listen"
  info "$(get listen_addresses) $(get max_connections)"
  [ -n "$(get hba)" ] && info "pg_hba: $(get hba)" || info "อ่าน pg_hba.conf ไม่ได้ (ต้อง sudo หรือ path ต่าง)"
  info "disk ว่างที่ /var/lib/postgresql: $(get disk_pg_gb) GB"

  if [ -z "${PG_PASSWORD:-}" ]; then
    info "ไม่ได้ตั้ง PG_PASSWORD — ข้ามตรวจ login/สิทธิ์ (ตั้งแล้วรันใหม่เพื่อตรวจ)"
    return
  fi
  # ส่ง password ทาง stdin บรรทัดแรก ไม่ผ่าน argv/ไฟล์
  local q
  q=$(printf '%s\n' "$PG_PASSWORD" | ssh $SSH_OPTS "${SSH_USER}@${VM_PG}" "IFS= read -r PGPASSWORD; export PGPASSWORD; psql -X -A -t -F'|' -h 127.0.0.1 -p ${PG_PORT} -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 <<'SQL'
select 'version|'||version();
select 'role|super='||rolsuper||' createdb='||rolcreatedb||' createrole='||rolcreaterole||' bypassrls='||rolbypassrls from pg_roles where rolname=current_user;
select 'databases|'||string_agg(datname, ',' order by datname) from pg_database where not datistemplate;
select 'roles|'||string_agg(rolname, ',' order by rolname) from pg_roles where rolname !~ '^pg_';
select 'ext|'||string_agg(name, ',' order by name) from pg_available_extensions where name in ('pgcrypto','uuid-ossp','citext','pg_trgm','btree_gin','btree_gist');
SQL" 2>&1)
  if printf '%s' "$q" | grep -q '^version|'; then
    ok "login Postgres ด้วย ${PG_USER} สำเร็จ"
    printf '%s\n' "$q" | sed -n 's/^version|/  [info] /p'
    local r; r=$(printf '%s\n' "$q" | sed -n 's/^role|//p')
    info "สิทธิ์ ${PG_USER}: $r"
    case "$r" in
      *super=true*|*createrole=true*) ok "${PG_USER} สร้าง role ได้ (db-roles.sh ใช้ได้)";;
      *) bad "${PG_USER} ไม่มี superuser/createrole — สร้าง role dcontact_app/keycloak ไม่ได้";;
    esac
    case "$r" in
      *super=true*|*createdb=true*) ok "${PG_USER} สร้าง database ได้";;
      *) bad "${PG_USER} ไม่มี createdb";;
    esac
    info "databases: $(printf '%s\n' "$q" | sed -n 's/^databases|//p')"
    info "roles: $(printf '%s\n' "$q" | sed -n 's/^roles|//p')"
    info "extensions ที่พร้อมใช้: $(printf '%s\n' "$q" | sed -n 's/^ext|//p')"
  else
    bad "login Postgres ไม่สำเร็จ: $(printf '%s' "$q" | tail -2 | tr '\n' ' ')"
  fi
}

# ---------------------------------------------------------------- เครือข่ายระหว่าง VM
check_links() {
  head_ "การเชื่อมต่อระหว่าง VM"
  local h
  for h in "$VM_NGINX" "$VM_DOCKER" "$VM_PG"; do
    if ! ssh $SSH_OPTS "${SSH_USER}@${h}" true 2>/dev/null; then
      warn "ssh เข้า ${h} ไม่ได้ — ข้ามการตรวจการเชื่อมต่อระหว่าง VM (ผลจะไม่น่าเชื่อถือ)"
      return
    fi
  done
  if tcp "$VM_DOCKER" "$VM_PG" "$PG_PORT"; then
    ok "VM2 (docker) -> VM3 (postgres) :${PG_PORT}"
  else
    bad "VM2 (docker) เข้า VM3 :${PG_PORT} ไม่ได้ (pg_hba/listen_addresses/firewall)"
  fi
  for p in 80 443; do
    if tcp "$VM_NGINX" "$VM_DOCKER" "$p"; then
      ok "VM1 (nginx) -> VM2 (docker) :${p} (เปิดอยู่)"
    else
      info "VM1 -> VM2 :${p} ยังไม่เปิด (ปกติถ้ายังไม่ deploy — ต้องกำหนดพอร์ตที่ proxy ของ stack จะ publish)"
    fi
  done
  if tcp "$VM_NGINX" "$VM_PG" "$PG_PORT"; then
    warn "VM1 (nginx) เข้า Postgres :${PG_PORT} ได้ — ควรจำกัดให้เฉพาะ VM2"
  else
    ok "VM1 (nginx) เข้า Postgres ตรง ๆ ไม่ได้ (ดีแล้ว)"
  fi
}

echo "UAT 3-VM precheck — $(date '+%F %T')  (read-only)"
check_docker
check_nginx
check_pg
check_links

head_ "สรุป"
printf '  OK=%d  WARN=%d  FAIL=%d\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ]
