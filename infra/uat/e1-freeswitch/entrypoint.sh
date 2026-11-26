#!/bin/sh
# #490: render only the E1 sandbox credentials into tmpfs before FreeSWITCH starts
set -eu
umask 077

require_secret() {
  name="$1"
  case "$name" in
    E1_DIRECTORY_PASSWORD) value="${E1_DIRECTORY_PASSWORD:-}" ;;
    E1_ESL_PASSWORD) value="${E1_ESL_PASSWORD:-}" ;;
    *)
      echo "unknown secret variable name" >&2
      exit 64
      ;;
  esac
  case "$value" in
    ''|*[!A-Za-z0-9]*)
      echo "${name} must be a non-empty alphanumeric value" >&2
      exit 64
      ;;
  esac
  if [ "${#value}" -lt 16 ]; then
    echo "${name} must be at least 16 characters long" >&2
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
