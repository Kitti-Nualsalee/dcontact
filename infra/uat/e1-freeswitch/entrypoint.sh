#!/bin/sh
# #490: render เฉพาะ credential ของ E1 sandbox ลง tmpfs ก่อน FreeSWITCH เริ่ม
set -eu
umask 077

require_secret() {
  name="$1"
  case "$name" in
    E1_DIRECTORY_PASSWORD) value="${E1_DIRECTORY_PASSWORD:-}" ;;
    E1_ESL_PASSWORD) value="${E1_ESL_PASSWORD:-}" ;;
    *)
      echo "ไม่รู้จักชื่อตัวแปร secret" >&2
      exit 64
      ;;
  esac
  case "$value" in
    ''|*[!A-Za-z0-9]*)
      echo "${name} ต้องเป็น alphanumeric ที่ไม่ว่าง" >&2
      exit 64
      ;;
  esac
  if [ "${#value}" -lt 16 ]; then
    echo "${name} ต้องยาวอย่างน้อย 16 ตัวอักษร" >&2
    exit 64
  fi
  printf '%s' "$value"
}

directory_password="$(require_secret E1_DIRECTORY_PASSWORD)"
esl_password="$(require_secret E1_ESL_PASSWORD)"

cp -R /e1-freeswitch/conf/. /etc/freeswitch/
sed -i "s/__E1_DIRECTORY_PASSWORD__/${directory_password}/g" /etc/freeswitch/autoload_configs/xml_curl.conf.xml
sed -i "s/__E1_ESL_PASSWORD__/${esl_password}/g" /etc/freeswitch/autoload_configs/event_socket.conf.xml
unset directory_password esl_password E1_DIRECTORY_PASSWORD E1_ESL_PASSWORD

exec /docker-entrypoint.sh
