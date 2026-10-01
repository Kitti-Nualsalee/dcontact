#!/usr/bin/env bash
# #566 / ADR-031: server block ของ hostname สาธารณะสำหรับ LINE webhook บน VM1 เท่านั้น (รันด้วย sudo)
#
#   sudo UAT_LINE_PUBLIC_HOST=<host> bash vm1-nginx-line-webhook.sh [--check|--apply|--remove]
#
# hostname สาธารณะ (DNS + NAT 443 จากทีม network) เปิดได้แค่ `POST /webhook/line` — path อื่น 404, method อื่น 403
# server `dcontact-uat.osd.co.th` ของ LAN ไม่ถูกแตะ; ไฟล์ config แยกต่อ host และเพิ่มเท่านั้น (ADR-030)
# `--remove` = kill ขารับที่ edge: ถอด config แล้ว reload (LINE ได้ connection error และ redeliver ภายหลัง)
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply || "$mode" == --remove ]] || {
  echo 'usage: sudo UAT_LINE_PUBLIC_HOST=<host> bash vm1-nginx-line-webhook.sh [--check|--apply|--remove]' >&2
  exit 64
}
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM1' >&2; exit 1; }

host="${UAT_LINE_PUBLIC_HOST:?UAT_LINE_PUBLIC_HOST is required}"
[[ "$host" =~ ^[a-z0-9-]+\.osd\.co\.th$ ]] || { echo 'host ต้องอยู่ใต้ wildcard *.osd.co.th' >&2; exit 1; }
[[ "$host" != dcontact-uat.osd.co.th ]] || { echo 'ห้ามใช้ host ของ LAN เป็น host สาธารณะ' >&2; exit 1; }
vm1=192.168.102.114
vm2=192.168.102.112
cert=/etc/nginx/ssl/star.osd.co.th_bundle.crt
key=/etc/nginx/ssl/star.osd.co.th.key
config="/etc/nginx/conf.d/${host}.conf"

ip -4 -o addr show | grep -Fq "$vm1/" || { echo "เครื่องนี้ไม่มี IP $vm1" >&2; exit 1; }

if [[ "$mode" == --remove ]]; then
  [[ -e "$config" ]] || { echo "ไม่มี $config"; exit 0; }
  grep -Fq '# D-Contact UAT LINE webhook' "$config" || { echo "$config ไม่ใช่ของ script นี้; หยุด" >&2; exit 1; }
  rm -f "$config"
  nginx -t
  systemctl reload nginx
  printf 'REMOVE ผ่าน: %s\n' "$config"
  exit 0
fi

[[ -f "$cert" && -f "$key" ]] || { echo 'ไม่พบ cert/key ที่คาดไว้' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkhost "$host" | grep -q 'does match' || { echo 'cert ไม่ครอบคลุม host' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null || { echo 'cert จะหมดอายุภายใน 30 วัน' >&2; exit 1; }
nginx -t >/dev/null

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<NGINX
# D-Contact UAT LINE webhook (#566): host สาธารณะรับแค่ POST /webhook/line แล้วส่งต่อ Caddy บน VM2
server {
    listen 80;
    server_name ${host};
    return 404;
}

server {
    listen 443 ssl http2;
    server_name ${host};
    ssl_certificate ${cert};
    ssl_certificate_key ${key};
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;

    location = /webhook/line {
        limit_except POST { deny all; }
        client_max_body_size 1m;
        proxy_pass http://${vm2}:8080;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }

    location / {
        return 404;
    }
}
NGINX

if [[ -e "$config" ]] && ! cmp -s "$tmp" "$config"; then
  echo "พบ $config ที่เนื้อหาไม่ตรง; หยุดเพื่อให้ตรวจด้วยมือ" >&2
  exit 1
fi

printf 'host: %s\n' "$host"
printf 'nginx config: %s\n' "$config"
printf 'upstream: %s:8080 (POST /webhook/line เท่านั้น)\n' "$vm2"

if [[ "$mode" == --check ]]; then
  echo 'CHECK ผ่าน; --apply จะเพิ่ม config, ตรวจ nginx -t และ reload nginx'
  exit 0
fi

created=0
if [[ ! -e "$config" ]]; then
  install -o root -g root -m 0644 "$tmp" "$config"
  created=1
fi
if ! nginx -t; then
  if [[ "$created" -eq 1 ]]; then rm -f "$config"; fi
  echo 'nginx -t ไม่ผ่าน; ถอน config ที่เพิ่งเพิ่มแล้ว' >&2
  exit 1
fi
systemctl reload nginx
printf 'APPLY ผ่าน: %s\n' "$config"
