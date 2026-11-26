"""#998 1B/2: boundary of UPDATE_PROFILE and ENABLE_ACCOUNT against Keycloak 26.7.5 + a real PostgreSQL

checks the receipt/fence/readback in the same transaction as the tenant gate, rejections that do not touch the identity,
logging in with the original password/TOTP after re-enabling, a concurrent enable, and a fault that makes the receipt fail must leave no mutation behind
"""
import concurrent.futures
import hashlib
import hmac
import json
import struct
import time
import urllib.parse
import uuid

TOTP_SECRET = 'JBSWY3DPEHPK3PXP'


def totp(secret=TOTP_SECRET, offset=0):
    # Keycloak stores secretData.value as the raw secret and computes the HMAC from the UTF-8 bytes (the QR uses the Base32 of these bytes)
    key = secret.encode('utf-8')
    counter = struct.pack('>Q', int(time.time() // 30) + offset)
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    start = digest[-1] & 0x0F
    return '%06d' % ((struct.unpack('>I', digest[start:start + 4])[0] & 0x7FFFFFFF) % 1000000)


def check_account_boundary(call, expect, adminbase, admin, tenant, foreign, sql):
    token = tenant['token']
    resource = adminbase.replace('/admin/realms/', '/realms/') + '/dc-tenant-people'
    token_path = resource.rsplit('/', 1)[0] + '/protocol/openid-connect/token'
    login_client = 'p998-account-' + uuid.uuid4().hex
    failures = []
    expect(adminbase + '/clients', admin, {'clientId': login_client, 'enabled': True,
           'publicClient': True, 'directAccessGrantsEnabled': True}, status=201)

    def provision(role, ready=True):
        user = str(uuid.uuid4())
        operation = str(uuid.uuid4())
        email = uuid.uuid4().hex + '@example.test'
        body = {'tenantId': tenant['id'], 'targetUserId': user,
                'payloadDigest': hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
                'fencingToken': '1', 'email': email, 'displayName': 'ชื่อเดิม P998', 'role': role} # allow-thai: Thai display name fixture
        for step in ('CREATE_IDENTITY', 'TENANT_ROLE', 'ORG_MEMBERSHIP', 'VERIFY_MAPPING', 'VERIFY_PROVISIONED'):
            proof, _ = expect(resource + '/operations/' + operation + '/steps/' + step, token, body, status=200)
            if proof['outcome'] != 'SUCCEEDED':
                raise RuntimeError('P998_PROVISION_FAILED')
        password = uuid.uuid4().hex
        if ready:
            path = adminbase + '/users/' + user
            expect(path, admin, {'emailVerified': True, 'requiredActions': [], 'firstName': 'ชื่อเดิม P998', # allow-thai: Thai display name fixture
                                'lastName': 'P998'}, method='PUT', status=204)
            expect(path + '/reset-password', admin, {'type': 'password', 'value': password,
                                                   'temporary': False}, method='PUT', status=204)
            expect(path, admin, {'credentials': [{'type': 'otp',
                   'secretData': json.dumps({'value': TOTP_SECRET}),
                   'credentialData': json.dumps({'subType': 'totp', 'digits': 6, 'counter': 0,
                                                'period': 30, 'algorithm': 'HmacSHA1'})}]},
                   method='PUT', status=204)
        return {'id': user, 'email': email, 'password': password}

    def identity(user):
        return expect(adminbase + '/users/' + user['id'], admin, status=200)[0]

    def set_enabled(user, enabled):
        expect(adminbase + '/users/' + user['id'], admin, {'enabled': enabled}, method='PUT', status=204)

    def command(step, user, role, name=None):
        body = {'tenantId': tenant['id'], 'targetUserId': user['id'], 'identityId': user['id'],
                'payloadDigest': hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
                'fencingToken': '1', 'role': role}
        if step == 'UPDATE_PROFILE':
            body['displayName'] = name
        return body

    def read(step, operation, body):
        query = {key: body[key] for key in ('tenantId', 'targetUserId', 'identityId', 'payloadDigest', 'role')}
        if 'displayName' in body:
    # the name is not in the URL: send the SHA-256 instead
            query['displayNameDigest'] = hashlib.sha256(body['displayName'].encode('utf-8')).hexdigest()
        return expect(resource + '/account/' + step + '/' + operation + '?' + urllib.parse.urlencode(query),
                      token, status=200)[0]

    def login(user, code=None):
        form = {'grant_type': 'password', 'client_id': login_client,
                'username': user['email'], 'password': user['password']}
        if code is not None:
            form['otp'] = code
        status, result, _ = call(token_path, form=form)
        failures.append((status, result.get('error') if isinstance(result, dict) else None,
                         result.get('error_description') if isinstance(result, dict) else None))
        return status

    def mutate(step, body, status=200):
        operation = str(uuid.uuid4())
        return operation, expect(resource + '/account/' + step + '/' + operation, token, body, status=status)[0]

    readiness = expect(resource + '/readiness?tenantId=' + tenant['id'], token, status=200)[0]
    if readiness.get('accountReady') is not True:
        raise RuntimeError('P998_READINESS_MISSING_ACCOUNT_READY')

    # --- UPDATE_PROFILE ---
    agent = provision('AGENT')
    profile = command('UPDATE_PROFILE', agent, 'AGENT', 'สมชาย ใจดี') # allow-thai: Thai display name fixture
    check = resource + '/account/UPDATE_PROFILE/check'
    expect(check, None, profile, status=401)
    expect(check, foreign['token'], profile, status=403)
    expect(check, token, {**profile, 'displayName': ' ชื่อมีช่องว่าง'}, status=400) # allow-thai: Thai display name fixture
    expect(check, token, {**profile, 'email': 'x@example.test'}, status=400)
    expect(resource + '/account/UNKNOWN_STEP/check', token, profile, status=404)
    ready = expect(check, token, profile, status=200)[0]
    if ready != {'version': 1, 'outcome': 'READY', 'reasonCode': 'READY', 'tenantId': tenant['id'],
                 'userId': agent['id'], 'identityId': agent['id'], 'payloadDigest': profile['payloadDigest']}:
        raise RuntimeError('P998_PROFILE_PREFLIGHT_MISMATCH')
    if identity(agent)['firstName'] != 'ชื่อเดิม P998': # allow-thai: Thai display name fixture
        raise RuntimeError('P998_PREFLIGHT_CHANGED_PROFILE')
    profile_operation = str(uuid.uuid4())
    profile_path = resource + '/account/UPDATE_PROFILE/' + profile_operation
    if read('UPDATE_PROFILE', profile_operation, profile) != {'outcome': 'UNKNOWN'}:
        raise RuntimeError('P998_MISSING_RECEIPT_NOT_UNKNOWN')
    proof = expect(profile_path, token, profile, status=200)[0]
    if proof['outcome'] != 'SUCCEEDED' or proof['reasonCode'] != 'PROFILE_UPDATED' or proof['identityId'] != agent['id']:
        raise RuntimeError('P998_PROFILE_FAILED')
    current = identity(agent)
    if current['firstName'] != 'สมชาย ใจดี' or current['email'] != agent['email'] or not current['enabled']: # allow-thai: Thai display name fixture
        raise RuntimeError('P998_PROFILE_READBACK_FAILED')
    if read('UPDATE_PROFILE', profile_operation, profile) != proof or expect(profile_path, token, profile, status=200)[0] != proof:
        raise RuntimeError('P998_PROFILE_REPLAY_CHANGED')
    # the same descriptor but a different name/identity = a correlation conflict; a retroactive fence is rejected
    expect(profile_path, token, {**profile, 'displayName': 'ชื่ออื่น'}, status=409) # allow-thai: Thai display name fixture
    profile_query = {k: profile[k] for k in ('tenantId', 'targetUserId', 'identityId', 'payloadDigest', 'role')}
    expect(profile_path + '?' + urllib.parse.urlencode({**profile_query,
           'displayNameDigest': hashlib.sha256('ชื่ออื่น'.encode('utf-8')).hexdigest()}), token, status=409) # allow-thai: Thai display name fixture
    # a raw name in the query is not accepted
    expect(profile_path + '?' + urllib.parse.urlencode({**profile_query, 'displayName': profile['displayName']}),
           token, status=400)
    expect(profile_path, token, {**profile, 'fencingToken': '2'}, status=200)
    expect(profile_path, token, profile, status=409)
    # editing the name outside the system after the receipt: the readback must be UNKNOWN and must not return the old marker
    expect(adminbase + '/users/' + agent['id'], admin, {'firstName': 'แก้มือ'}, method='PUT', status=204) # allow-thai: Thai display name fixture
    if read('UPDATE_PROFILE', profile_operation, profile) != {'outcome': 'UNKNOWN'}:
        raise RuntimeError('P998_PROFILE_DRIFT_FALSE_SUCCESS')
    expect(adminbase + '/users/' + agent['id'], admin, {'firstName': 'สมชาย ใจดี'}, method='PUT', status=204) # allow-thai: Thai display name fixture

    disabled = provision('SUPERVISOR')
    set_enabled(disabled, False)
    _, rejected = mutate('UPDATE_PROFILE', command('UPDATE_PROFILE', disabled, 'SUPERVISOR', 'ชื่อใหม่')) # allow-thai: Thai display name fixture
    if rejected['outcome'] != 'REJECTED_NO_EFFECT' or rejected['reasonCode'] != 'IDENTITY_STATE_CONFLICT' \
            or identity(disabled)['firstName'] != 'ชื่อเดิม P998': # allow-thai: Thai display name fixture
        raise RuntimeError('P998_DISABLED_PROFILE_CHANGED')
    protected = provision('AGENT')
    expect(adminbase + '/users/' + protected['id'], admin,
           {'attributes': {'dc_identity_class': ['PLATFORM_USER']}}, method='PUT', status=204)
    _, guarded = mutate('UPDATE_PROFILE', command('UPDATE_PROFILE', protected, 'AGENT', 'ชื่อใหม่')) # allow-thai: Thai display name fixture
    if guarded['outcome'] != 'REJECTED_NO_EFFECT' or guarded['reasonCode'] != 'PROTECTED_OR_FOREIGN_IDENTITY':
        raise RuntimeError('P998_PROTECTED_PROFILE_CHANGED')
    _, wrong_role = mutate('UPDATE_PROFILE', command('UPDATE_PROFILE', agent, 'ADMIN', 'ชื่อใหม่')) # allow-thai: Thai display name fixture
    if wrong_role['outcome'] != 'REJECTED_NO_EFFECT' or identity(agent)['firstName'] != 'สมชาย ใจดี': # allow-thai: Thai display name fixture
        raise RuntimeError('P998_ROLE_MISMATCH_PROFILE_CHANGED')
    print('P998_KEYCLOAK_UPDATE_PROFILE_BOUNDARY_PASS')

    # --- ENABLE_ACCOUNT ---
    returning = provision('AGENT')
    _, active = mutate('ENABLE_ACCOUNT', command('ENABLE_ACCOUNT', returning, 'AGENT'))
    if active['outcome'] != 'REJECTED_NO_EFFECT' or active['reasonCode'] != 'IDENTITY_STATE_CONFLICT':
        raise RuntimeError('P998_ENABLE_ACTIVE_ACCEPTED')
    if login(returning, totp()) != 200:
        raise RuntimeError('P998_BASELINE_LOGIN_FAILED_' + str(failures[-1]))
    # disable through the existing disable endpoint, then re-enable
    disable_body = {'tenantId': tenant['id'], 'targetUserId': returning['id'], 'identityId': returning['id'],
                    'payloadDigest': hashlib.sha256(uuid.uuid4().bytes).hexdigest(), 'fencingToken': '1',
                    'role': 'AGENT', 'adminCandidates': ''}
    if expect(resource + '/disable/' + str(uuid.uuid4()), token, disable_body, status=200)[0]['outcome'] != 'SUCCEEDED':
        raise RuntimeError('P998_DISABLE_SETUP_FAILED')
    if login(returning, totp()) == 200:
        raise RuntimeError('P998_DISABLED_LOGIN_ALLOWED')
    enable = command('ENABLE_ACCOUNT', returning, 'AGENT')
    enable_check = resource + '/account/ENABLE_ACCOUNT/check'
    expect(enable_check, token, {**enable, 'displayName': 'x'}, status=400)
    ready = expect(enable_check, token, enable, status=200)[0]
    if ready['outcome'] != 'READY' or identity(returning)['enabled']:
        raise RuntimeError('P998_ENABLE_PREFLIGHT_FAILED')
    # fault: a failed receipt must roll back the enable too
    enable_operation = str(uuid.uuid4())
    enable_path = resource + '/account/ENABLE_ACCOUNT/' + enable_operation
    sql("CREATE FUNCTION dc_tp_p998_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "IF NEW.step='ENABLE_ACCOUNT' AND NEW.identity_id='" + returning['id'] + "' THEN "
        "RAISE EXCEPTION 'P998_BOUNDARY_RECEIPT_FAULT'; END IF; RETURN NEW; END $$; "
        "CREATE TRIGGER dc_tp_p998_fault BEFORE INSERT ON dc_tenant_people_receipt "
        "FOR EACH ROW EXECUTE FUNCTION dc_tp_p998_fault();")
    try:
        failed, _, _ = call(enable_path, token, enable)
        if failed not in (500, 503):
            raise RuntimeError('P998_ATOMIC_FAULT_NOT_TRIGGERED')
        if identity(returning)['enabled']:
            raise RuntimeError('P998_IDENTITY_ENABLED_WITHOUT_RECEIPT')
        if read('ENABLE_ACCOUNT', enable_operation, enable) != {'outcome': 'UNKNOWN'}:
            raise RuntimeError('P998_ROLLED_BACK_RECEIPT_EXISTS')
    finally:
        sql('DROP TRIGGER dc_tp_p998_fault ON dc_tenant_people_receipt; DROP FUNCTION dc_tp_p998_fault();')
    enabled = expect(enable_path, token, enable, status=200)[0]
    if enabled['outcome'] != 'SUCCEEDED' or enabled['reasonCode'] != 'ENABLED':
        raise RuntimeError('P998_ENABLE_FAILED')
    if not identity(returning)['enabled'] or read('ENABLE_ACCOUNT', enable_operation, enable) != enabled:
        raise RuntimeError('P998_ENABLE_READBACK_FAILED')
    # use the original password and TOTP: no new required action, and the password alone is not enough
    # Keycloak does not allow a code to be reused within the same window: use the code of the next window (inside the normal look-around window)
    if login(returning) == 200 or login(returning, totp(offset=1)) != 200:
        raise RuntimeError('P998_ORIGINAL_CREDENTIALS_NOT_USABLE_' + str(failures[-2:]))
    role_query = {key: enable[key] for key in ('tenantId', 'targetUserId', 'identityId', 'payloadDigest')}
    if call(enable_path + '?' + urllib.parse.urlencode({**role_query, 'role': 'ADMIN'}), token)[0] != 409:
        raise RuntimeError('P998_ENABLE_ROLE_NOT_CORRELATED')
    # disabled by hand after the receipt: the readback must not return the old success
    set_enabled(returning, False)
    if read('ENABLE_ACCOUNT', enable_operation, enable) != {'outcome': 'UNKNOWN'}:
        raise RuntimeError('P998_ENABLE_DRIFT_FALSE_SUCCESS')
    set_enabled(returning, True)

    pending = provision('AGENT', ready=False)
    set_enabled(pending, False)
    no_credentials = command('ENABLE_ACCOUNT', pending, 'AGENT')
    preflight = expect(enable_check, token, no_credentials, status=200)[0]
    if preflight['outcome'] != 'REJECTED' or preflight['reasonCode'] != 'CREDENTIALS_NOT_READY':
        raise RuntimeError('P998_CREDENTIALS_PREFLIGHT_MISSED')
    _, missing = mutate('ENABLE_ACCOUNT', no_credentials)
    if missing['outcome'] != 'REJECTED_NO_EFFECT' or missing['reasonCode'] != 'CREDENTIALS_NOT_READY' \
            or identity(pending)['enabled']:
        raise RuntimeError('P998_ENABLED_WITHOUT_CREDENTIALS')

    # concurrent enable of the same identity: one succeeds, one is rejected
    racer = provision('SUPERVISOR')
    set_enabled(racer, False)
    attempts = [(resource + '/account/ENABLE_ACCOUNT/' + str(uuid.uuid4()), command('ENABLE_ACCOUNT', racer, 'SUPERVISOR'))
                for _ in range(2)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda attempt: call(attempt[0], token, attempt[1]), attempts))
    if any(result[0] != 200 for result in results) or \
            sorted(result[1]['outcome'] for result in results) != ['REJECTED_NO_EFFECT', 'SUCCEEDED']:
        raise RuntimeError('P998_CONCURRENT_ENABLE_FAILED')
    if not identity(racer)['enabled']:
        raise RuntimeError('P998_CONCURRENT_ENABLE_NOT_APPLIED')
    try:
        sql("UPDATE dc_tenant_people_receipt SET outcome=outcome WHERE step='ENABLE_ACCOUNT';")
    except Exception:
        pass
    else:
        raise RuntimeError('P998_RECEIPT_NOT_IMMUTABLE')
    print('P998_KEYCLOAK_ENABLE_ACCOUNT_BOUNDARY_PASS')
    return {'P998_PROFILE_OPERATION_ID': profile_operation, 'P998_PROFILE_USER_ID': agent['id'],
            'P998_PROFILE_PAYLOAD_DIGEST': profile['payloadDigest'], 'P998_PROFILE_DISPLAY_NAME': profile['displayName'],
            'P998_PROFILE_RECEIPT_REF': proof['receiptRef'],
            'P998_ENABLE_OPERATION_ID': enable_operation, 'P998_ENABLE_USER_ID': returning['id'],
            'P998_ENABLE_PAYLOAD_DIGEST': enable['payloadDigest'], 'P998_ENABLE_RECEIPT_REF': enabled['receiptRef']}
