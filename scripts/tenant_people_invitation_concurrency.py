import concurrent.futures
import hashlib
import re
import threading
import urllib.parse
import uuid


def check_invitation_concurrency(call, expect, adminbase, admin, tenant, sql):
    resource = adminbase.replace('/admin/realms/', '/realms/') + '/dc-tenant-people'
    for iteration in range(50):
        operation = str(uuid.uuid4())
        target = str(uuid.uuid4())
        body = {
            'tenantId': tenant['id'], 'targetUserId': target,
            'payloadDigest': hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
            'fencingToken': '1', 'email': uuid.uuid4().hex + '@example.test',
            'displayName': 'Invitation concurrency synthetic', 'role': 'AGENT',
        }
        for step in ('CREATE_IDENTITY', 'TENANT_ROLE', 'ORG_MEMBERSHIP', 'VERIFY_MAPPING', 'VERIFY_PROVISIONED'):
            proof, _ = expect(resource + '/operations/' + operation + '/steps/' + step,
                              tenant['token'], body, status=200)
            if proof.get('outcome') != 'SUCCEEDED':
                raise RuntimeError('INTENT_CONCURRENCY_PROVISION_FAILED')
        expect(adminbase + '/users/' + target, admin, status=200)
        descriptor = {**body, 'providerAttemptRef': str(uuid.uuid4()), 'leaseOwner': 'concurrency-worker'}
        path = resource + '/operations/' + operation + '/invitations/1/intent'
        if iteration == 0:
            operation_key = sql("SELECT id FROM dc_tenant_people_operation WHERE operation_id='" + operation + "';").strip()
            if not re.fullmatch('[a-f0-9]{64}', operation_key):
                raise RuntimeError('CACHE_LAG_FIXTURE_OPERATION_INVALID')
            intent_id = hashlib.sha256((operation_key + ':SEND_INTENT:1').encode()).hexdigest()
            sql("BEGIN; INSERT INTO user_attribute(id,name,value,user_id) VALUES('" + str(uuid.uuid4()) + "','dc_invitation_not_before',floor(extract(epoch from now()))::bigint::text,'" + target + "'); "
                "INSERT INTO dc_tenant_people_invitation_intent(id,operation_key,generation,provider_attempt_ref,request_digest,fencing_token,lease_owner,not_before_epoch,created_at_epoch) "
                "SELECT '" + intent_id + "',id,1,'" + descriptor['providerAttemptRef'] + "',request_digest,1,'concurrency-worker',floor(extract(epoch from now()))::bigint,floor(extract(epoch from now()))::bigint FROM dc_tenant_people_operation WHERE id='" + operation_key + "'; COMMIT;")
            print('B3_COMMITTED_INTENT_WITH_USER_CACHE_LAG_FIXTURE', flush=True)
        barrier = threading.Barrier(2, timeout=10)

        def submit(_):
            barrier.wait()
            return call(path, tenant['token'], descriptor)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, range(2)))
        if [result[0] for result in results] != [200, 200]:
            codes = [(result[0], result[1].get('code', 'UNKNOWN') if isinstance(result[1], dict) else 'UNKNOWN') for result in results]
            raise RuntimeError('INTENT_CONCURRENCY_FAILED_ROUND_' + str(iteration) + '_' + str(codes))
        projections = [{key: value for key, value in result[1].items() if key != 'serverEpoch'} for result in results]
        if projections[0] != projections[1] or projections[0].get('outcome') != 'INTENT':
            raise RuntimeError('INTENT_CONCURRENCY_REPLAY_CHANGED')
        intent = projections[0]
        if not re.fullmatch('[a-f0-9]{64}', intent.get('intentRef', '')):
            raise RuntimeError('INTENT_CONCURRENCY_REF_INVALID')
        if sql("SELECT count(*) FROM dc_tenant_people_invitation_intent WHERE id='" + intent['intentRef'] + "';").strip() != '1':
            raise RuntimeError('INTENT_CONCURRENCY_RECEIPT_COUNT_INVALID')
        persisted = sql("SELECT value FROM user_attribute WHERE user_id='" + target + "' AND name='dc_invitation_not_before';").strip()
        if persisted != str(intent['notBeforeEpoch']):
            raise RuntimeError('INTENT_CONCURRENCY_PERSISTED_FENCE_MISMATCH')
        query = urllib.parse.urlencode({key: descriptor[key] for key in ('tenantId', 'targetUserId', 'payloadDigest', 'providerAttemptRef', 'fencingToken', 'leaseOwner')})
        readback, _ = expect(path + '?' + query, tenant['token'], status=200)
        if readback.get('intentRef') != intent['intentRef']:
            raise RuntimeError('INTENT_CONCURRENCY_READBACK_CHANGED')
        if iteration == 1:
            expect(adminbase + '/users/' + target, admin, status=200)
            sql("UPDATE user_attribute SET value='" + str(intent['notBeforeEpoch'] + 10) + "' WHERE user_id='" + target + "' AND name='dc_invitation_not_before';")
            for method in ('POST', 'GET'):
                rejected, _ = expect(path if method == 'POST' else path + '?' + query,
                                     tenant['token'], descriptor if method == 'POST' else None,
                                     method=method, status=409)
                if rejected.get('code') != 'GENERATION_FENCE_CONFLICT':
                    raise RuntimeError('INTENT_CONCURRENCY_REAL_DRIFT_NOT_REFUSED')
    print('B3_INVITATION_INTENT_CONCURRENCY_50_ROUNDS_PASS')
