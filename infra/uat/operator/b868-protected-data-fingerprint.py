#!/usr/bin/env python3
"""#868: fingerprint ของข้อมูลใน application DB ก่อน/หลังสลับ API เพื่อพิสูจน์ว่า user/identity/result/history/outbox/audit คงเดิม

`capture` อ่านทุกตารางใน schema public ด้วย statement เดียว (snapshot เดียว) ใน transaction read-only ของ owner ที่ BYPASSRLS
เก็บเฉพาะจำนวนแถวและ hash ต่อตาราง ไม่มีค่าข้อมูลออกจาก DB; `compare` รายงานตารางที่ต่างและแยกกลุ่มที่ต้องคุ้มครอง
ไม่เขียน DB, runtime หรือ deployment record และไม่รับรอง rollback
"""
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
TABLE = re.compile(r'[a-z_][a-z0-9_]{0,62}')
SCOPE_QUERY = """SELECT json_build_object('database',current_database(),'principal',current_user,
'readonly',current_setting('transaction_read_only'),
'bypassRls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),
'tables',(SELECT COALESCE(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_tables WHERE schemaname='public'));"""
# ชื่อกลุ่มตามเกณฑ์ #868: ตารางที่เข้ากลุ่มใดกลุ่มหนึ่งต้องไม่เปลี่ยนระหว่างสลับ API
PROTECTED = (
    ('ledger', re.compile(r'_prisma_migrations')),
    ('user', re.compile(r'users|teams|tenants')),
    ('identity', re.compile(r'.*identit.*|tenant_people_.*|agent_sip_credentials')),
    ('result', re.compile(r'.*result.*')),
    ('history', re.compile(r'.*histor.*|interactions|interaction_events')),
    ('outbox', re.compile(r'.*outbox.*')),
    ('audit', re.compile(r'.*audit.*')),
)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def group_of(table):
    for name, pattern in PROTECTED:
        if pattern.fullmatch(table):
            return name
    return None


def fingerprint_query(tables):
    parts = ["SELECT '%s' AS name, count(*) AS rows, md5(COALESCE(string_agg(md5(t::text), '' ORDER BY md5(t::text)), '')) "
             'AS digest FROM public."%s" t' % (table, table) for table in tables]
    return ("SELECT json_build_object('readonly',current_setting('transaction_read_only'),"
            "'tables',json_agg(json_build_object('name',name,'rows',rows,'digest',digest) ORDER BY name)) FROM ("
            + ' UNION ALL '.join(parts) + ') q;')


def capture(read):
    """`read(sql) -> bytes|str` ต้องรันใน transaction read-only ของ DB principal ที่ review แล้ว"""
    scope = json.loads(read(SCOPE_QUERY))
    if (scope.get('database'), scope.get('principal'), scope.get('readonly')) != (
            'dcontact_uat', 'dcontact_uat_owner', 'on'):
        raise RuntimeError('LEDGER_SCOPE_REQUIRED')
    if scope.get('bypassRls') is not True:
        raise RuntimeError('RLS_BYPASS_REQUIRED')
    tables = scope.get('tables')
    if (not isinstance(tables, list) or not tables or len(tables) > 2000
            or any(not isinstance(name, str) or not TABLE.fullmatch(name) for name in tables)
            or len(set(tables)) != len(tables)):
        raise RuntimeError('FINGERPRINT_TABLES_INVALID')
    result = json.loads(read(fingerprint_query(tables)))
    rows = result.get('tables')
    if (result.get('readonly') != 'on' or not isinstance(rows, list)
            or [row.get('name') for row in rows if isinstance(row, dict)] != sorted(tables)
            or any(type(row.get('rows')) is not int or row['rows'] < 0
                   or not isinstance(row.get('digest'), str) or not re.fullmatch('[0-9a-f]{32}', row['digest'])
                   for row in rows)):
        raise RuntimeError('FINGERPRINT_RESULT_INVALID')
    snapshot = {row['name']: {'rows': row['rows'], 'digest': row['digest']} for row in rows}
    return {'schema': 'UatProtectedDataFingerprintV1',
            'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'tableCount': len(snapshot), 'rowCount': sum(item['rows'] for item in snapshot.values()),
            'tablesSha256': hashlib.sha256(canonical(snapshot)).hexdigest(), 'tables': snapshot,
            'rollbackCertified': False}


def compare(before, after):
    for item in (before, after):
        if (not isinstance(item, dict) or item.get('schema') != 'UatProtectedDataFingerprintV1'
                or not isinstance(item.get('tables'), dict)
                or hashlib.sha256(canonical(item['tables'])).hexdigest() != item.get('tablesSha256')):
            raise RuntimeError('FINGERPRINT_INPUT_INVALID')
    changed = []
    for name in sorted(set(before['tables']) | set(after['tables'])):
        old, new = before['tables'].get(name), after['tables'].get(name)
        if old != new:
            changed.append({'table': name, 'group': group_of(name),
                            'rowsBefore': old['rows'] if old else None, 'rowsAfter': new['rows'] if new else None})
    protected = [item for item in changed if item['group']]
    return {'schema': 'UatProtectedDataComparisonV1',
            'status': 'PROTECTED_DATA_PRESERVED' if not protected else 'PROTECTED_DATA_CHANGED',
            'beforeSha256': before['tablesSha256'], 'afterSha256': after['tablesSha256'],
            'beforeObservedAt': before.get('observedAt'), 'afterObservedAt': after.get('observedAt'),
            'protectedTableCount': sum(1 for name in after['tables'] if group_of(name)),
            'protectedChanged': protected, 'otherChanged': [item for item in changed if not item['group']],
            'rollbackCertified': False}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv):
    if argv == ['capture']:
        observer = load_module('release_evidence', DIRECTORY / 'release-evidence-observe.py')
        if hashlib.sha256(observer.HELPER.read_bytes()).hexdigest() != observer.HELPER_SHA:
            raise RuntimeError('REVIEWED_HELPER_CHANGED')
        result = capture(load_module('reviewed_helper', observer.HELPER).database())
        ok = True
    elif len(argv) == 3 and argv[0] == 'compare':
        result = compare(json.loads(Path(argv[1]).read_bytes()), json.loads(Path(argv[2]).read_bytes()))
        ok = result['status'] == 'PROTECTED_DATA_PRESERVED'
    else:
        print('usage: b868-protected-data-fingerprint.py capture | compare <before.json> <after.json>', file=sys.stderr)
        return 64
    print(json.dumps(result, sort_keys=True))
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
