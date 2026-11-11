#!/usr/bin/env python3
"""#868: หลักฐาน admission fence และ drain ของงาน People ก่อนสลับ API รุ่นบน UAT.

- `probe <base-url>`: ส่ง POST แบบไม่มี token ผ่าน proxy จริง; fence ทำงาน = proxy ตอบ 503 พร้อม
  `X-DContact-Admission-Fence: people` ก่อนถึง API. คำขอไม่มีสิทธิ์จึงไม่สร้างงานแม้ fence ปิด
- `drain`: บน VM2 อ่าน `tenant_people_*` ทุกตารางที่มี state/lease ผ่าน DB principal เดียวกับ
  release-evidence-observe (read-only, BYPASSRLS) แล้วยืนยันว่าไม่มีงานค้าง lease ที่ยังถือ หรือผลที่ต้องให้คนตัดสิน

ไม่เปิดหรือปิด fence เอง และไม่รับรอง rollback; ผลที่ไม่ใช่ DRAINED หมายถึงห้ามสลับ API
"""
import hashlib
import importlib.util
import json
import re
import sys
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
    if 'tenant_people_operations' not in {item['table'] for item in tables}:
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
    if not fence_present:
        status = 'FENCE_NOT_ARMED'
    elif blocking:
        status = 'NOT_DRAINED'
    else:
        status = 'DRAINED'
    tables_out = sorted(rows, key=lambda r: r['table'])
    return {'schema': 'UatPeopleDrainObservationV1', 'observedAt': now(), 'status': status,
            'fenceFilePresent': fence_present, 'blocking': blocking,
            'tablesSha256': digest(tables_out), 'tables': tables_out, 'rollbackCertified': False}


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
    elif argv == ['drain']:
        observer = load_module('release_evidence', DIRECTORY / 'release-evidence-observe.py')
        if hashlib.sha256(observer.HELPER.read_bytes()).hexdigest() != observer.HELPER_SHA:
            raise RuntimeError('REVIEWED_HELPER_CHANGED')
        helper = load_module('reviewed_helper', observer.HELPER)
        result = observe_drain(helper.database(), FENCE_FILE.is_file())
        ok = result['status'] == 'DRAINED'
    else:
        print('usage: b868-people-drain-observe.py probe https://<uat-host> | drain', file=sys.stderr)
        return 64
    print(json.dumps(result, sort_keys=True, ensure_ascii=False))
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
