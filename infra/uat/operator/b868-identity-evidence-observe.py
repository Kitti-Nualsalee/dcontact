#!/usr/bin/env python3
"""#868: ผูกหลักฐาน identity ของ People กับ runtime ที่สังเกตได้บน VM2 ก่อน/หลังสลับ API

รัน `dist/tenant-people-identity-evidence-main.js` ใน API container เดิมด้วย `docker exec` เพื่อให้ client secret
อยู่ใน container แล้วผูกผลกับ Keycloak image/repository digest และ API image จาก release-record-inspect
ผลต้อง CONSISTENT และ runtime ต้องไม่เปลี่ยนระหว่างอ่าน; ไม่รับรอง rollback และไม่ส่ง mutation ใด
"""
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
API_CONTAINER = 'dcontact-uat-api-1'
COMMAND = ['docker', 'exec', API_CONTAINER, 'node', 'dist/tenant-people-identity-evidence-main.js']
STATUSES = ('CONSISTENT', 'INCONSISTENT')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def observe(inspect_runtime, execute=subprocess.run):
    runtime = inspect_runtime()
    for service in ('api', 'keycloak'):
        if service not in runtime:
            raise RuntimeError('RUNTIME_COMPONENT_REQUIRED')
    result = execute(COMMAND, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if result.returncode not in (0, 2):
        stderr = result.stderr.decode() if isinstance(result.stderr, bytes) else (result.stderr or '')
        stdout = result.stdout.decode() if isinstance(result.stdout, bytes) else (result.stdout or '')
        try:
            failure = json.loads(stderr.strip().splitlines()[-1]).get('error')
        except (ValueError, IndexError, AttributeError):
            failure = None
        if failure is None:
            # NOT_CONFIGURED เขียนลง stdout เป็น {"status":"NOT_CONFIGURED"}
            try:
                failure = json.loads(stdout.strip().splitlines()[-1]).get('status')
            except (ValueError, IndexError, AttributeError):
                failure = None
        # CLI เขียนเฉพาะ status/error code ไม่มี secret; แนบ code ที่ตรงรูปแบบไว้ให้ผู้ปฏิบัติงานเห็นสาเหตุ
        detail = failure if isinstance(failure, str) and re.fullmatch('[A-Z0-9_]{1,64}', failure) else 'UNKNOWN'
        raise RuntimeError('IDENTITY_EVIDENCE_UNAVAILABLE:' + detail)
    lines = result.stdout.decode().strip().splitlines() if isinstance(result.stdout, bytes) else (
        result.stdout.strip().splitlines())
    if len(lines) != 1:
        raise RuntimeError('IDENTITY_EVIDENCE_INVALID')
    evidence = json.loads(lines[0])
    if (not isinstance(evidence, dict) or evidence.get('schema') != 'UatPeopleIdentityEvidenceV1'
            or evidence.get('status') not in STATUSES or evidence.get('rollbackCertified') is not False
            or not isinstance(evidence.get('tenants'), list) or not evidence['tenants']):
        raise RuntimeError('IDENTITY_EVIDENCE_INVALID')
    if (evidence['status'] == 'CONSISTENT') != (result.returncode == 0):
        raise RuntimeError('IDENTITY_EVIDENCE_INVALID')
    if inspect_runtime() != runtime:
        raise RuntimeError('RUNTIME_CHANGED_DURING_IDENTITY_READ')
    identity_runtime = {service: {key: runtime[service].get(key) for key in
                                  ('imageId', 'repositoryDigests', 'sourceSha', 'containerId', 'configSha256')}
                        for service in ('api', 'keycloak')}
    return {'schema': 'UatPeopleIdentityObservationV1',
            'observedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'status': evidence['status'], 'runtimeSha256': digest(identity_runtime), 'runtime': identity_runtime,
            'evidenceSha256': evidence.get('evidenceSha256'), 'evidence': evidence, 'rollbackCertified': False}


def components(inspection):
    # release-record-inspect คืน UatReleaseInspectionV1; observe ใช้เฉพาะข้อมูลราย component
    if not isinstance(inspection, dict) or inspection.get('schema') != 'UatReleaseInspectionV1':
        raise RuntimeError('RUNTIME_INSPECTION_INVALID')
    return inspection['components']


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    inspector = load_module('release_inspector', DIRECTORY / 'release-record-inspect.py')
    result = observe(lambda: components(inspector.inspect()))
    print(json.dumps(result, sort_keys=True, ensure_ascii=False))
    return 0 if result['status'] == 'CONSISTENT' else 2


if __name__ == '__main__':
    sys.exit(main())
