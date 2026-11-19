#!/bin/sh
# ตรวจ env ที่ต้องมี แล้วประกอบ connection ของ sqlops ให้ kamailio.cfg (modparam ต่อ string เองไม่ได้)
set -eu
: "${KAMAILIO_SIP_IP:?KAMAILIO_SIP_IP is required}"
: "${KAMAILIO_DB_URL:?KAMAILIO_DB_URL is required}"
export KAMAILIO_SQLCON="edge=>${KAMAILIO_DB_URL}"
exec /usr/sbin/kamailio -DD -E -u kamailio -g kamailio -f /etc/kamailio/kamailio.cfg "$@"
