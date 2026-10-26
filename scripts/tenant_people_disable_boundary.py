import concurrent.futures
import hashlib
import json
import urllib.parse
import uuid


def check_disable_boundary(call, expect, adminbase, admin, tenant, foreign, sql):
    token = tenant['token']
    resource = adminbase.replace('/admin/realms/', '/realms/') + '/dc-tenant-people'
    login_client = 'b6-disable-' + uuid.uuid4().hex
    expect(adminbase + '/clients', admin, {'clientId': login_client, 'enabled': True,
           'publicClient': True, 'directAccessGrantsEnabled': True}, status=201)
    login_configuration = expect(adminbase + '/clients?clientId=' + login_client, admin, status=200)[0][0]

    def offline_sessions(user):
        return expect(adminbase + '/users/' + user + '/offline-sessions/' + login_configuration['id'], admin, status=200)[0]

    def provision(role, pending=False, with_session=False):
        user = str(uuid.uuid4())
        operation = str(uuid.uuid4())
        body = {'tenantId': tenant['id'], 'targetUserId': user,
                'payloadDigest': hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
                'fencingToken': '1', 'email': uuid.uuid4().hex + '@example.test',
                'displayName': 'B6 synthetic', 'role': role}
        for step in ('CREATE_IDENTITY', 'TENANT_ROLE', 'ORG_MEMBERSHIP', 'VERIFY_MAPPING', 'VERIFY_PROVISIONED'):
            proof, _ = expect(resource + '/operations/' + operation + '/steps/' + step,
                              token, body, status=200)
            if proof['outcome'] != 'SUCCEEDED':
                raise RuntimeError('B6_PROVISION_FAILED')
        password = uuid.uuid4().hex
        if not pending:
            path = adminbase + '/users/' + user
            expect(path, admin, {'emailVerified': True, 'requiredActions': [],
                                'firstName': 'Synthetic', 'lastName': 'B6'}, method='PUT', status=204)
            expect(path + '/reset-password', admin, {'type': 'password', 'value': password,
                                                   'temporary': False}, method='PUT', status=204)
            if with_session:
                offline_role, _ = expect(adminbase + '/roles/offline_access', admin, status=200)
                expect(path + '/role-mappings/realm', admin, [offline_role], status=204)
                online_status, online_login, _ = call(resource.rsplit('/', 1)[0] + '/protocol/openid-connect/token',
                                    form={'grant_type': 'password', 'client_id': login_client,
                                          'username': body['email'], 'password': password})
                if online_status != 200:
                    raise RuntimeError('B6_EXISTING_ONLINE_LOGIN_FAILED_' + str(online_status) + '_' +
                                       str(online_login.get('error', 'UNKNOWN')))
                status, login, _ = call(resource.rsplit('/', 1)[0] + '/protocol/openid-connect/token',
                                    form={'grant_type': 'password', 'client_id': login_client,
                                          'username': body['email'], 'password': password,
                                          'scope': 'offline_access'})
                if status != 200:
                    raise RuntimeError('B6_EXISTING_SESSION_LOGIN_FAILED_' + str(status) + '_' +
                                       str(login.get('error', 'UNKNOWN')) + '_' +
                                       str(login.get('error_description', 'UNKNOWN')))
                if not expect(path + '/sessions', admin, status=200)[0]:
                    raise RuntimeError('B6_EXISTING_SESSION_MISSING')
                if not offline_sessions(user):
                    raise RuntimeError('B6_EXISTING_OFFLINE_SESSION_MISSING')
            expect(path, admin, {'credentials': [{'type': 'otp',
                   'secretData': json.dumps({'value': 'JBSWY3DPEHPK3PXP'}),
                   'credentialData': json.dumps({'subType': 'totp', 'digits': 6, 'counter': 0,
                                                'period': 30, 'algorithm': 'HmacSHA1'})}]},
                   method='PUT', status=204)
        return user

    def command(user, role, candidates=()):
        return {'tenantId': tenant['id'], 'targetUserId': user, 'identityId': user,
                'payloadDigest': hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
                'fencingToken': '1', 'role': role,
                'adminCandidates': ','.join(candidate + ':' + candidate for candidate in sorted(candidates))}

    def read(path, body):
        return expect(path + '?' + urllib.parse.urlencode({key: body[key] for key in
                      ('tenantId', 'targetUserId', 'payloadDigest')}), token, status=200)[0]

    agent = provision('AGENT', with_session=True)
    path = resource + '/disable/' + str(uuid.uuid4())
    body = command(agent, 'AGENT')
    preflight = resource + '/disable/check'
    expect(preflight, None, body, status=401)
    expect(preflight, foreign['token'], body, status=403)
    ready, _ = expect(preflight, token, body, status=200)
    if ready != {'version': 1, 'outcome': 'READY', 'reasonCode': 'READY',
                 'tenantId': tenant['id'], 'userId': agent, 'identityId': agent,
                 'payloadDigest': body['payloadDigest']}:
        raise RuntimeError('B6_PREFLIGHT_PROOF_MISMATCH')
    if not expect(adminbase + '/users/' + agent, admin, status=200)[0]['enabled'] or not offline_sessions(agent):
        raise RuntimeError('B6_PREFLIGHT_CHANGED_ACCOUNT_OR_SESSION')
    expect(path, None, body, status=401)
    expect(path, foreign['token'], body, status=403)
    expect(path, token, {**body, 'extra': 'forbidden'}, status=400)
    if read(path, body) != {'outcome': 'UNKNOWN'}:
        raise RuntimeError('B6_MISSING_RECEIPT_NOT_UNKNOWN')
    proof, _ = expect(path, token, body, status=200)
    if proof['outcome'] != 'SUCCEEDED' or proof['identityId'] != agent:
        raise RuntimeError('B6_DISABLE_FAILED')
    user, _ = expect(adminbase + '/users/' + agent, admin, status=200)
    sessions, _ = expect(adminbase + '/users/' + agent + '/sessions', admin, status=200)
    if user['enabled'] or sessions or offline_sessions(agent):
        raise RuntimeError('B6_DISABLE_READBACK_FAILED')
    if read(path, body) != proof or expect(path, token, body, status=200)[0] != proof:
        raise RuntimeError('B6_RECEIPT_REPLAY_CHANGED')
    expect(path, token, {**body, 'payloadDigest': '0' * 64}, status=409)
    expect(path, token, {**body, 'fencingToken': '2'}, status=200)
    expect(path, token, body, status=409)
    expect(adminbase + '/users/' + agent, admin, {'enabled': True}, method='PUT', status=204)
    if read(path, body) != {'outcome': 'UNKNOWN'}:
        raise RuntimeError('B6_MANUAL_REENABLE_FALSE_SUCCESS')

    first = provision('ADMIN')
    second = provision('ADMIN')
    pending = provision('ADMIN', pending=True)
    drift = command(first, 'ADMIN', (second, pending))
    expect(adminbase + '/users/' + second, admin, {'enabled': False}, method='PUT', status=204)
    rejected, _ = expect(resource + '/disable/' + str(uuid.uuid4()), token, drift, status=200)
    if rejected['outcome'] != 'REJECTED_NO_EFFECT' or rejected['reasonCode'] != 'LAST_USABLE_ADMIN':
        raise RuntimeError('B6_DRIFT_OR_PENDING_ADMIN_BYPASSED_GUARD')
    if not expect(adminbase + '/users/' + first, admin, status=200)[0]['enabled']:
        raise RuntimeError('B6_LAST_ADMIN_CHANGED_ON_REJECTION')
    expect(adminbase + '/users/' + second, admin, {'enabled': True}, method='PUT', status=204)
    attempts = [(resource + '/disable/' + str(uuid.uuid4()), command(user, 'ADMIN', (first, second)))
                for user in (first, second)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda attempt: call(attempt[0], token, attempt[1]), attempts))
    if any(result[0] != 200 for result in results):
        raise RuntimeError('B6_CONCURRENT_DISABLE_HTTP_FAILED')
    if sorted(result[1]['outcome'] for result in results) != ['REJECTED_NO_EFFECT', 'SUCCEEDED']:
        raise RuntimeError('B6_CONCURRENT_LAST_ADMIN_FAILED')
    if sum(expect(adminbase + '/users/' + user, admin, status=200)[0]['enabled']
           for user in (first, second)) != 1:
        raise RuntimeError('B6_NO_USABLE_ADMIN_REMAINS')

    protected = provision('AGENT')
    expect(adminbase + '/users/' + protected, admin,
           {'attributes': {'dc_identity_class': ['PLATFORM_USER']}}, method='PUT', status=204)
    protected_result, _ = expect(resource + '/disable/' + str(uuid.uuid4()), token,
                                 command(protected, 'AGENT'), status=200)
    if protected_result['outcome'] != 'REJECTED_NO_EFFECT' or not expect(
            adminbase + '/users/' + protected, admin, status=200)[0]['enabled']:
        raise RuntimeError('B6_PROTECTED_TARGET_DISABLED')

    survivor = next(user for user in (first, second)
                    if expect(adminbase + '/users/' + user, admin, status=200)[0]['enabled'])
    bootstrap = provision('ADMIN')
    expect(adminbase + '/users/' + bootstrap, admin,
           {'attributes': {'dc_identity_class': []}}, method='PUT', status=204)
    bootstrap_body = command(survivor, 'ADMIN', (bootstrap,))
    unenrolled, _ = expect(resource + '/disable/' + str(uuid.uuid4()), token, bootstrap_body, status=200)
    if unenrolled['outcome'] != 'REJECTED_NO_EFFECT' or unenrolled['reasonCode'] != 'LAST_USABLE_ADMIN':
        raise RuntimeError('B6_UNVERIFIED_BOOTSTRAP_COUNTED')
    client_path = adminbase + '/clients/' + tenant['client']
    client, _ = expect(client_path, admin, status=200)
    expect(client_path, admin, {**client, 'attributes': {**client['attributes'],
           'dc_verified_bootstrap_admins': bootstrap + ':' + bootstrap}}, method='PUT', status=204)
    try:
        enrolled, _ = expect(resource + '/disable/' + str(uuid.uuid4()), token, bootstrap_body, status=200)
        if enrolled['outcome'] != 'SUCCEEDED' or not expect(
                adminbase + '/users/' + bootstrap, admin, status=200)[0]['enabled']:
            raise RuntimeError('B6_VERIFIED_BOOTSTRAP_NOT_COUNTED')
    finally:
        expect(client_path, admin, client, method='PUT', status=204)

    atomic = provision('AGENT', with_session=True)
    atomic_body = command(atomic, 'AGENT')
    atomic_path = resource + '/disable/' + str(uuid.uuid4())
    sql("CREATE FUNCTION dc_tp_b6_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
        "IF NEW.step='DISABLE_ACCOUNT' AND NEW.identity_id='" + atomic + "' THEN "
        "RAISE EXCEPTION 'B6_BOUNDARY_RECEIPT_FAULT'; END IF; RETURN NEW; END $$; "
        "CREATE TRIGGER dc_tp_b6_fault BEFORE INSERT ON dc_tenant_people_receipt "
        "FOR EACH ROW EXECUTE FUNCTION dc_tp_b6_fault();")
    try:
        failed, _, _ = call(atomic_path, token, atomic_body)
        if failed not in (500, 503):
            raise RuntimeError('B6_ATOMIC_FAULT_NOT_TRIGGERED')
        if not expect(adminbase + '/users/' + atomic, admin, status=200)[0]['enabled']:
            raise RuntimeError('B6_IDENTITY_MUTATED_WITHOUT_RECEIPT')
        if not expect(adminbase + '/users/' + atomic + '/sessions', admin, status=200)[0]:
            raise RuntimeError('B6_SESSION_REVOKED_WITHOUT_RECEIPT')
        if not offline_sessions(atomic):
            raise RuntimeError('B6_OFFLINE_SESSION_REVOKED_WITHOUT_RECEIPT')
        if read(atomic_path, atomic_body) != {'outcome': 'UNKNOWN'}:
            raise RuntimeError('B6_ROLLED_BACK_RECEIPT_EXISTS')
    finally:
        sql('DROP TRIGGER dc_tp_b6_fault ON dc_tenant_people_receipt; DROP FUNCTION dc_tp_b6_fault();')
    completed = expect(atomic_path, token, atomic_body, status=200)[0]
    if completed['outcome'] != 'SUCCEEDED':
        raise RuntimeError('B6_ATOMIC_RETRY_FAILED')
    print('B6_KEYCLOAK_DISABLE_LAST_ADMIN_ATOMIC_BOUNDARY_PASS')
    return {'B6_DISABLE_OPERATION_ID': atomic_path.rsplit('/', 1)[-1],
            'B6_DISABLE_USER_ID': atomic, 'B6_DISABLE_PAYLOAD_DIGEST': atomic_body['payloadDigest'],
            'B6_DISABLE_RECEIPT_REF': completed['receiptRef']}
