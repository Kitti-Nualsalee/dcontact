#!/usr/bin/env bash
# #565 / ADR-031: ใส่ secret ของ LINE pilot บน VM2 สำหรับ overlay `uat-line` — รันบน VM2 ด้วย sudo
#
#   sudo infra/uat/operator/vm2-line-secrets.sh            ครั้งแรก: token + channel secret + สุ่ม payload key
#   sudo infra/uat/operator/vm2-line-secrets.sh --rotate   หมุน token/channel secret (เช่น v4 → v5) แล้วรัน
#                                                          `uat-deploy.sh line-reload <sha>`
#
# ค่ารับทาง stdin เท่านั้น (บน terminal ไม่ echo) จึงไม่อยู่ใน shell history หรือ argument ของ process
# บรรทัดที่ 1 = channel access token, บรรทัดที่ 2 = channel secret
# payload key สุ่มครั้งเดียวและไม่หมุน — key ใหม่ทำให้ payload ของ webhook ที่เก็บไว้ถอดรหัสไม่ได้
# ไฟล์เป็น 0400 ของ uid 10001 (user ใน image ของ api/ops) — script ไม่พิมพ์ค่าใด ๆ
set -euo pipefail
umask 077

CREDENTIAL_DIR="${UAT_LINE_CREDENTIAL_DIR:-/opt/dcontact-uat/secrets/line}"
OWNER=10001:10001
ACCESS_FILE=line-channel-access-token
CHANNEL_FILE=line-channel-secret
KEY_FILE=line-webhook-payload-key

fail() {
  echo "{\"type\":\"u1.uat.line-secrets\",\"status\":\"FAIL\",\"reason\":\"$1\"}" >&2
  exit 1
}

rotate=false
case "${1:-}" in
  '') ;;
  --rotate) rotate=true ;;
  *) echo 'usage: vm2-line-secrets.sh [--rotate]' >&2; exit 64 ;;
esac

[[ "$(id -u)" == 0 ]] || fail 'ROOT_REQUIRED'
if [[ "$rotate" == false && -e "$CREDENTIAL_DIR/$ACCESS_FILE" ]]; then fail 'ALREADY_PRESENT_USE_ROTATE'; fi
if [[ "$rotate" == true && ! -e "$CREDENTIAL_DIR/$ACCESS_FILE" ]]; then fail 'NOTHING_TO_ROTATE'; fi

read_secret() {
  local prompt="$1" value
  if [[ -t 0 ]]; then
    IFS= read -rs -p "$prompt: " value
    echo >&2
  else
    IFS= read -r value || true
  fi
  printf '%s' "$value"
}

token="$(read_secret 'channel access token')"
channel_secret="$(read_secret 'channel secret')"
# token: ตัวอักษรของ JWT/long-lived token เท่านั้น; channel secret ของ LINE = hex 32 ตัว
[[ "$token" =~ ^[A-Za-z0-9._~+/=-]{20,4096}$ ]] || fail 'TOKEN_FORMAT'
[[ "$channel_secret" =~ ^[0-9a-f]{32}$ ]] || fail 'CHANNEL_SECRET_FORMAT'

install -d -m 0700 -o root -g root "$CREDENTIAL_DIR"

write_secret() {
  local name="$1" value="$2" temporary
  temporary="$(mktemp "$CREDENTIAL_DIR/.$name.XXXXXX")"
  printf '%s' "$value" >"$temporary"
  chown "$OWNER" "$temporary"
  chmod 0400 "$temporary"
  mv -f "$temporary" "$CREDENTIAL_DIR/$name"
}

write_secret "$ACCESS_FILE" "$token"
write_secret "$CHANNEL_FILE" "$channel_secret"
unset token channel_secret
if [[ ! -e "$CREDENTIAL_DIR/$KEY_FILE" ]]; then
  write_secret "$KEY_FILE" "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
fi

for name in "$ACCESS_FILE" "$CHANNEL_FILE" "$KEY_FILE"; do
  [[ "$(stat -c '%a %u' "$CREDENTIAL_DIR/$name")" == "400 10001" ]] || fail 'PERMISSIONS'
done
echo "{\"type\":\"u1.uat.line-secrets\",\"status\":\"PASS\",\"rotated\":$rotate}"
if [[ "$rotate" == true ]]; then
  echo 'ขั้นต่อไป: uat-deploy.sh line-reload <sha ปัจจุบัน> แล้วลงทะเบียน credential ใหม่ด้วย line-pilot-setup credential' >&2
fi
