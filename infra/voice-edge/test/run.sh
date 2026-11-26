#!/usr/bin/env bash
# test Kamailio voice edge with a real FreeSWITCH and SIPp as simulated trunks (ADR-038, #923)
# usage: bash infra/voice-edge/test/run.sh   (KEEP=1 to keep the stack after finishing)
set -euo pipefail
cd "$(dirname "$0")"

compose() { docker compose -f docker-compose.yml "$@"; }
fs() { compose exec -T freeswitch fs_cli -x "$1"; }
sipp_in() { local host="$1"; shift; compose exec -T "$host" sipp "$@"; }

KAM=172.30.50.20:5060
pass=0
fail=0
ok() { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { local name="$1"; shift; if "$@" >/tmp/voice-edge-check.log 2>&1; then ok "$name"; else bad "$name"; sed -n '1,40p' /tmp/voice-edge-check.log; fi; }

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

compose up -d --build --wait edge-db freeswitch kamailio trunk-a trunk-b stranger >/dev/null

# wait for Kamailio to see FreeSWITCH via OPTIONS (flag AP = active + probing)
for _ in $(seq 1 30); do
  if compose exec -T kamailio kamcmd -s unix:/tmp/kamailio_ctl dispatcher.list 2>/dev/null | grep -q 'FLAGS: AP'; then break; fi
  sleep 1
done

expect() { # expect <code> <host> <ip> <destination>
  sipp_in "$2" "$KAM" -sf "/scenarios/uac-expect-$1.xml" -s "$4" -i "$3" -p 5070 -m 1 -timeout 15s -timeout_error -nostdin -nr
}

check 'inbound call from an IP not in the trunk table is rejected with 403' expect 403 stranger 172.30.50.42 021000001
check 't1 trunk calling a t2 number is rejected with 403' expect 403 trunk-a 172.30.50.40 021000002
check 'non-numeric destination is rejected with 404' expect 404 trunk-a 172.30.50.40 'abc'
before=$(fs 'show channels count' | grep -o '^[0-9]*' || echo 0)
[ "${before:-0}" = "0" ] && ok 'rejected calls do not reach FreeSWITCH' || bad "rejected calls reached FreeSWITCH ($before channels)"

# a valid inbound call: hold the call while testing the ceiling, then answer and hang up through Record-Route
compose exec -T trunk-a sh -c "sipp $KAM -sf /scenarios/uac-answered.xml -s 021000001 -i 172.30.50.40 -p 5071 -m 1 -d 2000 -timeout 40s -timeout_error -nostdin -nr >/tmp/inbound.log 2>&1; echo \$? >/tmp/inbound.rc" &
inbound_pid=$!

uuid=''
for _ in $(seq 1 20); do
  uuid=$(fs 'show channels as json' | python3 -c 'import json,sys
d=json.load(sys.stdin)
print(next((r["uuid"] for r in d.get("rows",[]) if r.get("dest")=="2000"),""))' 2>/dev/null || true)
  [ -n "$uuid" ] && break
  sleep 0.5
done
if [ -z "$uuid" ]; then
  bad 'inbound call to number 021000001 reaches FreeSWITCH as DID 2000'
else
  ok 'inbound call to number 021000001 reaches FreeSWITCH as DID 2000'
  domain=$(fs "uuid_getvar $uuid domain_name" | tr -d '\r\n')
  [ "$domain" = 't1.sip.test' ] && ok 'FreeSWITCH got the domain of t1 (the forged header was removed)' || bad "domain_name = '$domain'"
  peer=$(fs "uuid_getvar $uuid sip_network_ip" | tr -d '\r\n')
  [ "$peer" = '172.30.50.20' ] && ok 'the call came from Kamailio' || bad "sip_network_ip = '$peer'"
  leftover=$(fs "uuid_getvar $uuid sip_h_X-DContact-Domain" | tr -d '\r\n')
  [ "$leftover" = '_undef_' ] || [ -z "$leftover" ] && ok 'the header was removed from the variables before park' || bad "sip_h_X-DContact-Domain = '$leftover'"

  check 'second t1 call over the ceiling of 1 is rejected with 503' expect 503 trunk-a 172.30.50.40 021000001

  fs "uuid_answer $uuid" >/dev/null
fi
wait "$inbound_pid" || true
rc=$(compose exec -T trunk-a cat /tmp/inbound.rc 2>/dev/null | tr -d '\r\n' || echo 1)
if [ "$rc" = '0' ]; then ok 'answered and hung up through Kamailio completely'; else bad "the inbound call did not complete (sipp rc=$rc)"; compose exec -T trunk-a cat /tmp/inbound.log | tail -20; fi

# outbound call: trunk-a is the destination; check it came from Kamailio and that no internal header leaked
compose exec -T trunk-a sh -c "sipp -sf /scenarios/uas-trunk.xml -i 172.30.50.40 -p 5060 -m 1 -timeout 30s -timeout_error -nostdin -nr >/tmp/outbound.log 2>&1; echo \$? >/tmp/outbound.rc" &
outbound_pid=$!
sleep 1
originate=$(fs "originate {sip_h_X-DContact-Domain=t1.sip.test,origination_caller_id_number=021000001,originate_timeout=10}sofia/pstn-sim/0899000001@$KAM &park" | tr -d '\r')
if [[ "$originate" == +OK* ]]; then
  ok 'outbound t1 call with a t1 number reaches the t1 trunk'
  fs "uuid_kill ${originate#+OK }" >/dev/null
else
  bad "outbound t1 call: $originate"
fi
wait "$outbound_pid" || true
rc=$(compose exec -T trunk-a cat /tmp/outbound.rc 2>/dev/null | tr -d '\r\n' || echo 1)
if [ "$rc" = '0' ]; then ok 'trunk got the call from Kamailio with no X-DContact- leaked and hung up completely'; else bad "outbound-side trunk (sipp rc=$rc)"; compose exec -T trunk-a cat /tmp/outbound.log | tail -20; fi

denied=$(fs "originate {sip_h_X-DContact-Domain=t1.sip.test,origination_caller_id_number=021000002,originate_timeout=5}sofia/pstn-sim/0899000001@$KAM &park" | tr -d '\r')
[[ "$denied" == -ERR* ]] && ok "t1 cannot call out with a t2 number ($denied)" || bad "t1 can call out with a t2 number: $denied"
nohdr=$(fs "originate {origination_caller_id_number=021000001,originate_timeout=5}sofia/pstn-sim/0899000001@$KAM &park" | tr -d '\r')
[[ "$nohdr" == -ERR* ]] && ok "outbound call without a tenant is rejected ($nohdr)" || bad "outbound call without a tenant passed: $nohdr"

echo "result: passed $pass failed $fail"
[ "$fail" = 0 ]
