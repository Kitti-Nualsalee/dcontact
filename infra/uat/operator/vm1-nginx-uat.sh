#!/usr/bin/env bash
# #537: ติดตั้ง nginx edge ของ UAT บน VM1 เท่านั้น (รันด้วย sudo)
# ค่าเริ่มต้นเป็น read-only; ใช้ --apply หลังตรวจผล --check
set -euo pipefail

mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --apply ]] || { echo 'usage: sudo bash vm1-nginx-uat.sh [--check|--apply]' >&2; exit 64; }
[[ "$(id -u)" -eq 0 ]] || { echo 'ต้องรันด้วย sudo บน VM1' >&2; exit 1; }

host=dcontact-uat.osd.co.th
vm1=192.168.102.114
vm2=192.168.102.112
cert=/etc/nginx/ssl/star.osd.co.th_bundle.crt
key=/etc/nginx/ssl/star.osd.co.th.key
config=/etc/nginx/conf.d/dcontact-uat.osd.co.th.conf

ip -4 -o addr show | grep -Fq "$vm1/" || { echo "เครื่องนี้ไม่มี IP $vm1" >&2; exit 1; }
[[ -f "$cert" && -f "$key" ]] || { echo 'ไม่พบ cert/key ที่คาดไว้' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkhost "$host" | grep -q 'does match' || { echo 'cert ไม่ครอบคลุม host' >&2; exit 1; }
openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null || { echo 'cert จะหมดอายุภายใน 30 วัน' >&2; exit 1; }
cert_pub="$(openssl x509 -in "$cert" -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
key_pub="$(openssl pkey -in "$key" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)"
[[ "$cert_pub" == "$key_pub" ]] || { echo 'cert กับ key ไม่ตรงกัน' >&2; exit 1; }
nginx -t >/dev/null

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<'NGINX'
# D-Contact UAT: nginx บน VM1 ส่งต่อไป Caddy บน VM2; host อื่นไม่ถูกแก้
server {
    listen 80;
    server_name dcontact-uat.osd.co.th;
    return 308 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dcontact-uat.osd.co.th;
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
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }
}
NGINX

if [[ -e "$config" ]] && ! cmp -s "$tmp" "$config"; then
  echo "พบ $config ที่เนื้อหาไม่ตรง; หยุดเพื่อให้ตรวจด้วยมือ" >&2
  exit 1
fi

printf 'cert: %s\n' "$(openssl x509 -in "$cert" -noout -enddate)"
printf 'nginx config: %s\n' "$config"
printf 'upstream: %s:8080\n' "$vm2"
for path in /etc/nginx /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/ssl "$cert" "$key"; do
  stat -c '%a %U:%G %n' "$path"
done

if [[ "$mode" == --check ]]; then
  echo 'CHECK ผ่าน; --apply จะเพิ่ม config, ตรวจ nginx -t, ปรับ permission และ reload nginx'
  exit 0
fi

created=0
if [[ ! -e "$config" ]]; then
  install -o root -g root -m 0644 "$tmp" "$config"
  created=1
fi
if ! nginx -t; then
  if [[ "$created" -eq 1 ]]; then rm -f "$config"; fi
  echo 'nginx -t ไม่ผ่าน; ถอน config UAT ที่เพิ่งเพิ่มแล้ว' >&2
  exit 1
fi

# key อยู่บน shared VM: 777 เปิดให้อ่าน/แก้ไขได้; directory ที่ 777 ยังให้แทนไฟล์ได้
chmod 0755 /etc/nginx /etc/nginx/conf.d /etc/nginx/sites-enabled /etc/nginx/ssl
chmod 0644 "$cert"
chmod 0600 "$key"
chown root:root "$cert" "$key" "$config"
nginx -t
systemctl reload nginx
printf 'APPLY ผ่าน: %s\n' "$config"
