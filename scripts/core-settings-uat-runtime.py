"""อ่าน runtime/identity config บน VM2 เท่านั้น ไม่เขียน realm หรือแสดง credential."""
import hashlib
import ipaddress
import json
import pathlib
import subprocess
import urllib.parse
import urllib.request


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def ordered(rows):
    return sorted(rows, key=lambda row: json.dumps(row, sort_keys=True, separators=(',', ':')))


def identity_configuration(get):
    base = '/admin/realms/dcontact'

    def pages(path):
        rows = []
        for first in range(0, 10000, 100):
            batch = get(path + '?first=' + str(first) + '&max=100')
            if not isinstance(batch, list):
                raise ValueError('IDENTITY_RESPONSE_INVALID')
            rows.extend(batch)
            if len(batch) < 100:
                return ordered(rows)
        raise ValueError('IDENTITY_RESPONSE_LIMIT')

    realm = get(base)
    if realm.get('realm') != 'dcontact':
        raise ValueError('IDENTITY_REALM_MISMATCH')
    if 'supportedLocales' in realm:
        realm['supportedLocales'] = sorted(realm['supportedLocales'])
    flows = ordered(get(base + '/authentication/flows'))
    executions, configs = {}, {}
    for flow in flows:
        alias = urllib.parse.quote(flow['alias'], safe='')
        rows = get(base + '/authentication/flows/' + alias + '/executions')
        executions[flow['id']] = rows
        for row in rows:
            key = row.get('authenticationConfig')
            if key and key not in configs:
                configs[key] = get(base + '/authentication/config/' + urllib.parse.quote(key, safe=''))
    clients, roles, composites, client_mappers = [], {}, {}, {}
    roles['realm'] = pages(base + '/roles')
    for summary in pages(base + '/clients'):
        key = summary['id']
        path = base + '/clients/' + urllib.parse.quote(key, safe='')
        client = get(path)
        for field in ['defaultClientScopes', 'optionalClientScopes']:
            if field in client:
                client[field] = sorted(client[field])
        if 'protocolMappers' in client:
            client['protocolMappers'] = ordered(client['protocolMappers'])
        clients.append(client)
        roles[key] = pages(path + '/roles')
        client_mappers[key] = ordered(get(path + '/protocol-mappers/models'))
    for rows in roles.values():
        for role in rows:
            if role.get('composite'):
                key = role['id']
                composites[key] = ordered(get(base + '/roles-by-id/' + urllib.parse.quote(key, safe='') + '/composites'))
    scopes = ordered([get(base + '/client-scopes/' + urllib.parse.quote(scope['id'], safe='')) for scope in get(base + '/client-scopes')])
    scope_mappers = {scope['id']: ordered(get(base + '/client-scopes/' + urllib.parse.quote(scope['id'], safe='') + '/protocol-mappers/models')) for scope in scopes}
    for scope in scopes:
        if 'protocolMappers' in scope:
            scope['protocolMappers'] = ordered(scope['protocolMappers'])
    organizations = ordered([get(base + '/organizations/' + urllib.parse.quote(org['id'], safe='')) for org in pages(base + '/organizations')])
    for organization in organizations:
        if 'domains' in organization:
            organization['domains'] = ordered(organization['domains'])
    keys = get(base + '/keys')
    if 'keys' in keys:
        keys['keys'] = ordered(keys['keys'])
    org_brokers = {org['id']: ordered(get(base + '/organizations/' + urllib.parse.quote(org['id'], safe='') + '/identity-providers')) for org in organizations}
    return {
        'realm': realm, 'flows': flows, 'executions': executions, 'authenticatorConfigs': configs,
        'requiredActions': ordered(get(base + '/authentication/required-actions')),
        'clients': ordered(clients), 'roles': roles, 'composites': composites,
        'clientMappers': client_mappers, 'clientScopes': scopes, 'scopeMappers': scope_mappers,
        'organizations': organizations, 'organizationBrokers': org_brokers,
        'brokers': ordered(get(base + '/identity-provider/instances')),
        'userProfile': get(base + '/users/profile'), 'keys': keys,
        'components': ordered(get(base + '/components')),
    }


class RejectIdentityRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def keycloak_reader(container):
    environment = dict(item.split('=', 1) for item in container['Config']['Env'] if '=' in item)
    addresses = [network['IPAddress'] for _, network in sorted(container['NetworkSettings']['Networks'].items()) if network.get('IPAddress')]
    if not addresses or not ipaddress.ip_address(addresses[0]).is_private:
        raise ValueError('IDENTITY_NETWORK_INVALID')
    prefix = environment.get('KC_HTTP_RELATIVE_PATH', '').rstrip('/')
    base = 'http://' + addresses[0] + ':8080' + prefix
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), RejectIdentityRedirect())
    form = urllib.parse.urlencode({
        'grant_type': 'password', 'client_id': 'admin-cli',
        'username': environment['KC_BOOTSTRAP_ADMIN_USERNAME'],
        'password': environment['KC_BOOTSTRAP_ADMIN_PASSWORD'],
    }).encode()
    request = urllib.request.Request(base + '/realms/master/protocol/openid-connect/token', data=form, headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    with opener.open(request, timeout=5) as response:
        token = json.load(response)['access_token']

    def get(path):
        request = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + token}, method='GET')
        with opener.open(request, timeout=5) as response:
            return json.load(response)
    return get


def collect():
    record = json.loads(pathlib.Path('/opt/dcontact-uat/deployments/current.json').read_bytes())
    services = {'api': 'api', 'console': 'proxy', 'keycloak': 'keycloak', 'e1': 'e1-sandbox', 'freeswitch': 'freeswitch'}
    containers, configs, images, sources = {}, {}, {}, {}
    for key, service in services.items():
        value = json.loads(subprocess.check_output(['docker', 'inspect', 'dcontact-uat-' + service + '-1']))[0]
        if not value['State']['Running']:
            raise ValueError('SERVICE_NOT_RUNNING')
        containers[key] = value
        images[key] = value['Config']['Image'].split('@')[-1]
        sources[key] = value['Config'].get('Labels', {}).get('org.opencontainers.image.revision')
        configs[key] = {field: value[field] for field in ['Config', 'HostConfig', 'Mounts']}
    images['ops'] = record['images']['ops'].split('@')[-1]
    if any(record['images'][key].split('@')[-1] != images[key] for key in ['api', 'console', 'keycloak']):
        raise ValueError('IMAGE_RECORD_MISMATCH')
    sha = record['sourceSha']
    if any(sources[key] != sha for key in ['api', 'console', 'e1']):
        raise ValueError('SOURCE_RECORD_MISMATCH')
    mounts = {}
    for config in configs.values():
        for mount in config['Mounts']:
            if mount.get('Type') == 'bind':
                path = pathlib.Path(mount['Source'])
                if path.is_file():
                    mounts[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
                elif mount['Destination'] == '/e1-freeswitch' and path.is_dir():
                    for file in sorted(path.rglob('*')):
                        if file.is_file():
                            mounts[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
    # อ่านสองรอบเพื่อตรวจการเปลี่ยนระหว่างเก็บ graph; ไม่เชื่อ deployment record แทน live config
    get = keycloak_reader(containers['keycloak'])
    identity_digest = digest(identity_configuration(get))
    if digest(identity_configuration(get)) != identity_digest:
        raise ValueError('IDENTITY_CONFIG_CHANGED_DURING_SNAPSHOT')
    return {
        'kind': 'CORE_SETTINGS_RUNTIME_SNAPSHOT', 'sourceSha': sha, 'images': images,
        'configDigestVersion': 2, 'identityConfigDigest': identity_digest,
        'configDigest': digest({'version': 2, 'containers': configs, 'mountedFiles': mounts, 'identityConfigDigest': identity_digest}),
    }


if __name__ == '__main__':
    print(json.dumps(collect(), sort_keys=True))
