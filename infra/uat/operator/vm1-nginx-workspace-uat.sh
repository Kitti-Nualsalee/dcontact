#!/usr/bin/env bash
# #684: เพิ่ม vhost Workspace เท่านั้น ไม่แก้ Console หรือ permission ของ shared nginx
set -euo pipefail
mode="${1:---check}"
[[ "$mode" == --render || "$mode" == --check || "$mode" == --apply || "$mode" == --remove ]] || exit 64
candidate="$(mktemp)"
trap 'rm -f "$candidate"' EXIT
cat >"$candidate" <<'NGINX'
# D-Contact UAT: nginx บน VM1 ส่งต่อไป Caddy บน VM2; host อื่นไม่ถูกแก้
server {
    listen 80;
    server_name dcontact-workspace-uat.osd.co.th;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dcontact-workspace-uat.osd.co.th;
    ssl_certificate /etc/nginx/ssl/star.osd.co.th_bundle.crt;
    ssl_certificate_key /etc/nginx/ssl/star.osd.co.th.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    location / {
        proxy_pass http://192.168.102.112:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 5s;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
if [[ "$mode" == --render ]]; then cat "$candidate"; exit 0; fi
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM1' >&2; exit 1; }
ip -4 -o addr show | grep -Fq '192.168.102.114/' || exit 1
config=/etc/nginx/conf.d/dcontact-workspace-uat.osd.co.th.conf
[[ ! -L "$config" ]] || { echo 'พบ symlink; หยุด' >&2; exit 1; }
if [[ -e "$config" ]] && ! cmp -s "$candidate" "$config"; then
  echo 'พบ config ที่ต่างจากที่จัดการ; หยุดโดยไม่เขียนทับ' >&2; exit 1
fi
openssl x509 -in /etc/nginx/ssl/star.osd.co.th_bundle.crt -noout -checkhost dcontact-workspace-uat.osd.co.th | grep -q 'does match'
openssl x509 -in /etc/nginx/ssl/star.osd.co.th_bundle.crt -noout -checkend 2592000 >/dev/null
nginx -t
if [[ "$mode" == --check ]]; then echo 'CHECK ผ่าน: vhost แยก ใช้ cert เดิม upstream VM2:8080'; exit 0; fi
created=false
if [[ "$mode" == --apply ]]; then
  if [[ ! -e "$config" ]]; then
    install -o root -g root -m 0644 "$candidate" "$config"
    created=true
  fi
  if ! nginx -t || ! systemctl reload nginx; then
    if [[ "$created" == true ]]; then rm -f "$config"; nginx -t && systemctl reload nginx; fi
    exit 1
  fi
  echo 'APPLY ผ่าน: dcontact-workspace-uat.osd.co.th'
else
  [[ -f "$config" ]] || { echo 'ไม่มี vhost; REMOVE ผ่าน'; exit 0; }
  rm "$config"
  if ! nginx -t || ! systemctl reload nginx; then
    install -o root -g root -m 0644 "$candidate" "$config"
    nginx -t && systemctl reload nginx
    exit 1
  fi
  echo 'REMOVE ผ่าน: ถอนเฉพาะ vhost Workspace'
fi
