#!/bin/sh
set -eu
umask 077

bind_ip="$(hostname -i)"
printf '%s\n' "$bind_ip" | awk -F. '
  NR != 1 || NF != 4 { exit 1 }
  { for (field=1; field<=4; field++) if ($field !~ /^[0-9]+$/ || $field > 255) exit 1 }
  $1 == 0 || $1 == 127 { exit 1 }
' || { echo 'LOCAL_FREESWITCH_BIND_IP_INVALID' >&2; exit 1; }

cp -R /e1-local-source/. /e1-freeswitch/
cp /e1-local-source/vars.local.xml /e1-freeswitch/conf/vars.xml
sed -i "/<include>/a\  <X-PRE-PROCESS cmd=\"set\" data=\"local_ip_v4=$bind_ip\"/>" /e1-freeswitch/conf/vars.xml
exec /bin/sh /e1-freeswitch/entrypoint.sh
