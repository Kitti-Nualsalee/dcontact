#!/usr/bin/env bash
# A1.9 (#574): vhost แยกของ Platform Console บน VM1; ไม่แก้ dcontact-uat เดิม
# รันบน VM1: sudo bash vm1-platform-nginx-uat.sh --check แล้ว --apply
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm1-platform-nginx-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" == 0 && "${SUDO_USER:-}" == osdadmin ]] || { echo 'ต้องรันด้วย sudo จาก osdadmin บน VM1' >&2; exit 1; }
ip -4 -o addr show | grep -F '192.168.102.114/' >/dev/null || { echo 'เครื่องนี้ไม่ใช่ VM1 ที่คาดไว้' >&2; exit 1; }

host=platform-uat.osd.co.th
cert=/etc/nginx/ssl/star.osd.co.th_bundle.crt
key=/etc/nginx/ssl/star.osd.co.th.key
config=/etc/nginx/conf.d/platform-uat.osd.co.th.conf
[[ -f "$cert" && -f "$key" ]] || { echo 'ไม่พบ wildcard cert/key' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkhost "$host" | grep -q 'does match' || { echo 'cert ไม่ครอบคลุม host' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null || { echo 'cert จะหมดอายุภายใน 30 วัน' >&2; exit 1; }
cert_pub="$(openssl x509 -in "$cert" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
key_pub="$(openssl pkey -in "$key" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
[[ "$cert_pub" == "$key_pub" ]] || { echo 'cert/key ไม่ตรงกัน' >&2; exit 1; }
nginx -t >/dev/null

tmp="$(mktemp)"
trap 'test ! -e "$tmp" || unlink "$tmp"' EXIT
cat >"$tmp" <<'NGINX'
# A1.9: Platform Console hostname แยกจาก Tenant Console; TLS จบที่ VM1
server {
    listen 80;
    server_name platform-uat.osd.co.th;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name platform-uat.osd.co.th;
    ssl_certificate /etc/nginx/ssl/star.osd.co.th_bundle.crt;
    ssl_certificate_key /etc/nginx/ssl/star.osd.co.th.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://192.168.102.112:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
NGINX

if [[ -e "$config" ]] && ! cmp -s "$tmp" "$config"; then
  echo "พบ $config ที่เนื้อหาไม่ตรง; หยุดเพื่อตรวจด้วยมือ" >&2
  exit 1
fi
printf 'cert: %s\n' "$(openssl x509 -in "$cert" -noout -enddate)"
printf 'nginx config: %s; upstream 192.168.102.112:8081\n' "$config"
if [[ "$mode" == --check ]]; then
  echo 'CHECK ผ่าน; --apply จะเพิ่ม vhost แล้ว reload nginx'
  exit 0
fi
if [[ ! -e "$config" ]]; then install -o root -g root -m 0644 "$tmp" "$config"; fi
nginx -t
systemctl reload nginx
printf 'APPLY ผ่าน: %s\n' "$config"
