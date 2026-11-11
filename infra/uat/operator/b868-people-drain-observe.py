#!/usr/bin/env python3
"""#868: หลักฐาน admission fence และ drain ของงาน People ก่อนสลับ API รุ่นบน UAT.

- `probe <base-url>`: ส่ง POST แบบไม่มี token ผ่าน proxy จริง; fence ทำงาน = proxy ตอบ 503 พร้อม
  `X-DContact-Admission-Fence: people` ก่อนถึง API. คำขอไม่มีสิทธิ์จึงไม่สร้างงานแม้ fence ปิด
- `drain`: บน VM2 อ่าน `tenant_people_*` ทุกตารางที่มี state/lease ผ่าน DB principal เดียวกับ
  release-evidence-observe (read-only, BYPASSRLS) แล้วยืนยันว่าไม่มีงานค้าง lease ที่ยังถือ หรือผลที่ต้องให้คนตัดสิน
  รวมงาน invitation ที่ยังไม่มี receipt และต้องได้ DRAINED ซ้ำหลังรอ settle (ค่าเริ่มต้น 60 วินาที)

ไม่เปิดหรือปิด fence เอง และไม่รับรอง rollback; ผลที่ไม่ใช่ DRAINED หมายถึงห้ามสลับ API
"""
import hashlib
import importlib.util
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
FENCE_FILE = Path('/opt/dcontact-uat/admission-fence/people-mutations')
PROBE_PATH = '/api/v1/tenant-voice/people/users'
TERMINAL = frozenset({'SUCCEEDED', 'REJECTED'})
TABLE = re.compile(r'tenant_people_[a-z_]{1,48}')
TABLES_QUERY = r"""SELECT json_build_object('database',current_database(),'principal',current_user,
'readonly',current_setting('transaction_read_only'),
'bypassRls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),
'tables',COALESCE((SELECT json_agg(json_build_object('table',table_name,'state',has_state,'lease',has_lease) ORDER BY table_name)
  FROM (SELECT table_name,bool_or(column_name='state') AS has_state,bool_or(column_name='lease_expires_at') AS has_lease
        FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'tenant\_people\_%'
        GROUP BY table_name) t WHERE has_state OR has_lease),'[]'::json));"""

# งาน invitation ไม่มีคอลัมน์ state ให้ดู; ใช้เงื่อนไขเดียวกับ worker (tenant-people-runtime.ts) ว่ายังต้องทำหรือยังไม่ชัด
NO_RECEIPT = ('NOT EXISTS(SELECT 1 FROM public.tenant_people_invitation_receipts r '
              'WHERE r.tenant_id=x.tenant_id AND r.provider_attempt_ref=x.provider_attempt_ref)')
INVITATION_QUERY = (
    "SELECT json_build_object('readonly',current_setting('transaction_read_only'),"
    "'intentsPendingDelivery',(SELECT count(*) FROM public.tenant_people_invitation_intents x "
    "JOIN public.tenant_people_operations o ON o.tenant_id=x.tenant_id AND o.id=x.operation_id AND o.target_user_id=x.user_id "
    "JOIN public.tenant_user_lifecycles l ON l.tenant_id=x.tenant_id AND l.user_id=x.user_id AND l.operation_id=x.operation_id "
    "WHERE x.generation=1 AND o.state='SUCCEEDED' AND l.account_state='PENDING_ACTIVATION' "
    "AND l.provisioning_state='PROVISIONED' AND l.activation_state='PENDING' AND " + NO_RECEIPT + "),"
    "'resendsWithoutReceipt',(SELECT count(*) FROM public.tenant_people_invitation_resends x WHERE " + NO_RECEIPT + "),"
    "'dispatchesWithoutReceipt',(SELECT count(*) FROM public.tenant_people_invitation_dispatches x WHERE " + NO_RECEIPT + "),"
    "'ambiguitiesWithoutReceipt',(SELECT count(*) FROM public.tenant_people_invitation_ambiguities x WHERE " + NO_RECEIPT + "));")
INVITATION_KEYS = ('intentsPendingDelivery', 'resendsWithoutReceipt', 'dispatchesWithoutReceipt',
                   'ambiguitiesWithoutReceipt')
INVITATION_TABLES = frozenset({'tenant_people_invitation_dispatches'})


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def counts_query(tables):
    parts = []
    for item in tables:
        name = item['table']
        states = (f"COALESCE((SELECT json_object_agg(state,n) FROM (SELECT state,count(*) AS n FROM public.{name} "
                  "GROUP BY state) s),'{}'::json)") if item['state'] else "'{}'::json"
        leases = (f"(SELECT count(*) FROM public.{name} WHERE lease_expires_at>clock_timestamp())"
                  if item['lease'] else '0')
        parts.append(f"SELECT json_build_object('table','{name}','states',{states},'liveLeases',{leases})")
    return ('SELECT json_build_object(\'readonly\',current_setting(\'transaction_read_only\'),\'tables\','
            "COALESCE((SELECT json_agg(x) FROM (" + ' UNION ALL '.join(parts) + ") AS r(x)),'[]'::json));")


def observe_drain(read, fence_present):
    """`read(sql) -> bytes|str` ต้องรันใน transaction read-only ของ DB principal ที่ review แล้ว"""
    scope = json.loads(read(TABLES_QUERY))
    if (scope.get('database'), scope.get('principal'), scope.get('readonly')) != (
            'dcontact_uat', 'dcontact_uat_owner', 'on'):
        raise RuntimeError('LEDGER_SCOPE_REQUIRED')
    if scope.get('bypassRls') is not True:
        raise RuntimeError('RLS_BYPASS_REQUIRED')
    tables = scope.get('tables')
    if (not isinstance(tables, list) or not tables or len(tables) > 64
            or any(not isinstance(item, dict) or set(item) != {'table', 'state', 'lease'}
                   or not isinstance(item['table'], str) or not TABLE.fullmatch(item['table'])
                   or type(item['state']) is not bool or type(item['lease']) is not bool for item in tables)
            or len({item['table'] for item in tables}) != len(tables)):
        raise RuntimeError('PEOPLE_TABLES_INVALID')
    if not {'tenant_people_operations'} | INVITATION_TABLES <= {item['table'] for item in tables}:
        raise RuntimeError('PEOPLE_TABLES_INVALID')
    result = json.loads(read(counts_query(tables)))
    rows = result.get('tables')
    if (result.get('readonly') != 'on' or not isinstance(rows, list)
            or sorted(row.get('table') for row in rows if isinstance(row, dict)) != sorted(i['table'] for i in tables)):
        raise RuntimeError('PEOPLE_COUNTS_INVALID')
    blocking = []
    for row in sorted(rows, key=lambda r: r['table']):
        states, leases = row.get('states'), row.get('liveLeases')
        if (not isinstance(states, dict) or type(leases) is not int or leases < 0
                or any(not isinstance(k, str) or type(v) is not int or v < 0 for k, v in states.items())):
            raise RuntimeError('PEOPLE_COUNTS_INVALID')
        open_states = {state: n for state, n in sorted(states.items()) if state not in TERMINAL and n}
        if open_states or leases:
            blocking.append({'table': row['table'], 'openStates': open_states, 'liveLeases': leases})
    invitations = json.loads(read(INVITATION_QUERY))
    if (not isinstance(invitations, dict) or set(invitations) != {'readonly', *INVITATION_KEYS}
            or invitations['readonly'] != 'on'
            or any(type(invitations[key]) is not int or invitations[key] < 0 for key in INVITATION_KEYS)):
        raise RuntimeError('PEOPLE_COUNTS_INVALID')
    invitations = {key: invitations[key] for key in INVITATION_KEYS}
    if any(invitations.values()):
        blocking.append({'invitations': {key: n for key, n in invitations.items() if n}})
    if not fence_present:
        status = 'FENCE_NOT_ARMED'
    elif blocking:
        status = 'NOT_DRAINED'
    else:
        status = 'DRAINED'
    tables_out = sorted(rows, key=lambda r: r['table'])
    return {'schema': 'UatPeopleDrainObservationV1', 'observedAt': now(), 'status': status,
            'fenceFilePresent': fence_present, 'blocking': blocking,
            'tablesSha256': digest(tables_out), 'tables': tables_out, 'invitations': invitations,
            'rollbackCertified': False}


def observe_settled(read, fence_present, settle_seconds, sleep=time.sleep):
    """คำขอที่ผ่าน proxy ก่อนเปิด fence อาจ commit ช้า จึงต้อง DRAINED สองครั้งห่างกันอย่างน้อย settle_seconds"""
    if type(settle_seconds) is not int or not 30 <= settle_seconds <= 3600:
        raise RuntimeError('SETTLE_SECONDS_INVALID')
    first = observe_drain(read, fence_present())
    if first['status'] != 'DRAINED':
        return dict(first, settledSeconds=0)
    sleep(settle_seconds)
    second = observe_drain(read, fence_present())
    return dict(second, settledSeconds=settle_seconds, firstObservedAt=first['observedAt'])


def probe(base_url, opener=urllib.request.urlopen):
    if not re.fullmatch(r'https://[A-Za-z0-9.-]+(:[0-9]{1,5})?', base_url):
        raise RuntimeError('PROBE_URL_INVALID')
    request = urllib.request.Request(base_url + PROBE_PATH, data=b'{}', method='POST',
                                     headers={'Content-Type': 'application/json'})
    try:
        response = opener(request, timeout=10)
        status, headers, body = response.status, response.headers, response.read(4096)
    except urllib.error.HTTPError as error:
        status, headers, body = error.code, error.headers, error.read(4096)
    marker = headers.get('X-DContact-Admission-Fence')
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    active = (status == 503 and marker == 'people'
              and payload == {'code': 'CAPABILITY_NOT_READY', 'reason': 'ADMISSION_FENCED'})
    return {'schema': 'UatPeopleFenceProbeV1', 'observedAt': now(), 'url': base_url + PROBE_PATH,
            'httpStatus': status, 'fenceHeader': marker,
            'status': 'FENCE_ACTIVE' if active else 'FENCE_INACTIVE'}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv):
    if len(argv) == 2 and argv[0] == 'probe':
        result = probe(argv[1])
        ok = result['status'] == 'FENCE_ACTIVE'
    elif argv[:1] == ['drain'] and len(argv) <= 2:
        settle = int(argv[1]) if len(argv) == 2 and argv[1].isdigit() else (60 if len(argv) == 1 else -1)
        observer = load_module('release_evidence', DIRECTORY / 'release-evidence-observe.py')
        if hashlib.sha256(observer.HELPER.read_bytes()).hexdigest() != observer.HELPER_SHA:
            raise RuntimeError('REVIEWED_HELPER_CHANGED')
        helper = load_module('reviewed_helper', observer.HELPER)
        result = observe_settled(helper.database(), FENCE_FILE.is_file, settle)
        ok = result['status'] == 'DRAINED'
    else:
        print('usage: b868-people-drain-observe.py probe https://<uat-host> | drain [settle-seconds]', file=sys.stderr)
        return 64
    print(json.dumps(result, sort_keys=True, ensure_ascii=False))
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
