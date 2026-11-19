#!/bin/sh
# #923 Solo: ประกอบ config ของ FreeSWITCH = config dev (infra/freeswitch/conf) + override ของ Solo
# แล้วแทนค่า IP และ secret จาก env ลง /etc/freeswitch ซึ่งเป็น tmpfs (secret ไม่ลงดิสก์)
set -eu
umask 077

require() { # require <name> <value> <pattern>
  if [ -z "$2" ]; then
    echo "$1 is required" >&2
    exit 64
  fi
  if ! printf '%s' "$2" | grep -Eq "$3"; then
    echo "$1 มีรูปแบบไม่ถูกต้อง" >&2
    exit 64
  fi
}
require SOLO_VOICE_IP "${SOLO_VOICE_IP:-}" '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
require SOLO_APP_IP "${SOLO_APP_IP:-}" '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
require TELEPHONY_NODE_ID "${TELEPHONY_NODE_ID:-}" '^[A-Za-z0-9_.-]{1,128}$'
require FREESWITCH_ESL_PASSWORD "${FREESWITCH_ESL_PASSWORD:-}" '^[A-Za-z0-9]{16,}$'
require FREESWITCH_DIRECTORY_PASSWORD "${FREESWITCH_DIRECTORY_PASSWORD:-}" '^[A-Za-z0-9]{16,}$'

cp -R /solo-freeswitch/base/. /etc/freeswitch/
cp -R /solo-freeswitch/overrides/. /etc/freeswitch/
mkdir -p /etc/freeswitch/tls
for file in $(find /etc/freeswitch -name '*.xml'); do
  sed -i \
    -e "s/__SOLO_VOICE_IP__/${SOLO_VOICE_IP}/g" \
    -e "s/__SOLO_APP_IP__/${SOLO_APP_IP}/g" \
    -e "s/__TELEPHONY_NODE_ID__/${TELEPHONY_NODE_ID}/g" \
    -e "s/__FREESWITCH_ESL_PASSWORD__/${FREESWITCH_ESL_PASSWORD}/g" \
    -e "s/__FREESWITCH_DIRECTORY_PASSWORD__/${FREESWITCH_DIRECTORY_PASSWORD}/g" \
    "$file"
done
if grep -rqE '__(SOLO|TELEPHONY|FREESWITCH)_[A-Z_]*__' /etc/freeswitch; then
  echo "ยังมี placeholder ที่ไม่ได้แทนค่าใน config" >&2
  exit 64
fi
unset FREESWITCH_ESL_PASSWORD FREESWITCH_DIRECTORY_PASSWORD

exec /docker-entrypoint.sh
