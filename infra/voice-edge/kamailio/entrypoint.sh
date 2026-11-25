#!/bin/sh
# check the required env vars, then assemble the sqlops connection for kamailio.cfg (a modparam cannot concatenate strings itself)
set -eu
: "${KAMAILIO_SIP_IP:?KAMAILIO_SIP_IP is required}"
: "${KAMAILIO_DB_URL:?KAMAILIO_DB_URL is required}"
export KAMAILIO_SQLCON="edge=>${KAMAILIO_DB_URL}"
exec /usr/sbin/kamailio -DD -E -u kamailio -g kamailio -f /etc/kamailio/kamailio.cfg "$@"
