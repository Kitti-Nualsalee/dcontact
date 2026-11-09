#!/usr/bin/env python3
"""ตรวจความต่างระหว่าง deployment record และ runtime โดยไม่แก้ระบบ."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path('/opt/dcontact-uat')
SERVICES = ('api', 'e1-sandbox', 'proxy', 'keycloak')


def read_records(root, allow_missing=False):
    records = {}
    for name in ('current', 'previous'):
        path = root / 'deployments' / (name + '.json')
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            if allow_missing:
                records[name] = None
                continue
            raise
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 8388608:
                raise RuntimeError('RECORD_FILE_INVALID')
            raw = stream.read(8388609)
            if len(raw) > 8388608:
                raise RuntimeError('RECORD_FILE_INVALID')
        record = json.loads(raw)
        if not isinstance(record, dict) or not re.fullmatch('[0-9a-f]{40}', str(record.get('sourceSha', ''))):
            raise RuntimeError('RECORD_SOURCE_REQUIRED')
        records[name] = {'sha256': hashlib.sha256(raw).hexdigest(),
                         'schema': record.get('schema'), 'action': record.get('action'),
                         'sourceSha': record.get('sourceSha'),
                         'rollbackEligible': record.get('rollbackEligible'),
                         'images': record.get('images')}
        if 'components' in record or 'legacyAnchor' in record:
            saved = record.get('components')
            anchor = record.get('legacyAnchor')
            if (not isinstance(saved, dict) or set(saved) != set(SERVICES)
                    or any(not isinstance(item, dict) for item in saved.values()) or not isinstance(anchor, dict)):
                raise RuntimeError('RECORD_COMPONENT_REFERENCE_INVALID')
            fields = ('containerId', 'imageId', 'imageReference', 'sourceSha', 'running',
                      'startedAt', 'configSha256', 'repositoryDigests')
            records[name]['components'] = {service: {key: saved[service].get(key) for key in fields} for service in SERVICES}
            records[name]['legacyAnchor'] = {key: anchor.get(key) for key in ('kind', 'sourceSha')}
    return records


def inspect(root=ROOT, execute=subprocess.run, allow_missing=False, fallback_current=None):
    records = read_records(root, allow_missing)
    reference = records['current'] if records['current'] is not None else fallback_current
    if not isinstance(reference, dict) or not re.fullmatch('[0-9a-f]{40}', str(reference.get('sourceSha', ''))):
        raise RuntimeError('RECORD_SOURCE_REQUIRED')
    names = ['dcontact-uat-' + service + '-1' for service in SERVICES]
    def observe():
        result = execute(['docker', 'inspect', *names], check=True, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=20)
        containers = json.loads(result.stdout)
        if len(containers) != len(names) or {c['Name'].lstrip('/') for c in containers} != set(names):
            raise RuntimeError('RUNTIME_INVENTORY_CHANGED')
        components = {}
        for container in containers:
            name = container['Name'].lstrip('/')
            service = name[len('dcontact-uat-'):-2]
            labels = container['Config'].get('Labels') or {}
            if labels.get('com.docker.compose.project') != 'dcontact-uat':
                raise RuntimeError('RUNTIME_PROJECT_MISMATCH')
            if not re.fullmatch('[0-9a-f]{40}', str(labels.get('org.opencontainers.image.revision', ''))):
                raise RuntimeError('RUNTIME_SOURCE_REQUIRED')
            if not re.fullmatch('sha256:[0-9a-f]{64}', str(container.get('Image', ''))):
                raise RuntimeError('RUNTIME_IMAGE_ID_REQUIRED')
            config = {key: container[key] for key in ('Config', 'HostConfig', 'Mounts')}
            config_bytes = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
            components[service] = {'containerId': container['Id'], 'imageId': container['Image'],
                                   'imageReference': container['Config']['Image'],
                                   'sourceSha': labels.get('org.opencontainers.image.revision'),
                                   'running': container['State']['Running'],
                                   'startedAt': container['State'].get('StartedAt'),
                                   'configSha256': hashlib.sha256(config_bytes).hexdigest()}
        if not all(c['running'] for c in components.values()):
            raise RuntimeError('RUNTIME_NOT_RUNNING')
        image_ids = sorted({item['imageId'] for item in components.values()})
        result = execute(['docker', 'image', 'inspect', *image_ids], check=True,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        images = json.loads(result.stdout)
        if len(images) != len(image_ids) or {image['Id'] for image in images} != set(image_ids):
            raise RuntimeError('IMAGE_INVENTORY_CHANGED')
        digests = {}
        revisions = {}
        for image in images:
            refs = image.get('RepoDigests') or []
            if not refs or any(not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', ref) for ref in refs):
                raise RuntimeError('IMAGE_REPOSITORY_DIGEST_REQUIRED')
            digests[image['Id']] = sorted(set(refs))
            revisions[image['Id']] = (image.get('Config', {}).get('Labels') or {}).get(
                'org.opencontainers.image.revision')
        for component in components.values():
            if revisions[component['imageId']] != component['sourceSha']:
                raise RuntimeError('IMAGE_SOURCE_LABEL_MISMATCH')
            component['repositoryDigests'] = digests[component['imageId']]
        return components

    components = observe()
    if observe() != components:
        raise RuntimeError('RUNTIME_CHANGED_DURING_INSPECTION')
    if read_records(root, allow_missing) != records:
        raise RuntimeError('RECORD_CHANGED_DURING_INSPECTION')
    per_component = reference.get('components')
    if per_component is not None or reference.get('legacyAnchor') is not None:
        anchor = reference.get('legacyAnchor')
        if (reference.get('schema') != 'UatDeploymentReconciliationV1' or reference.get('action') != 'reconciliation'
                or reference.get('rollbackEligible') is not False or not isinstance(anchor, dict)
                or anchor.get('kind') != 'HISTORICAL_RELEASE_LAYOUT_NOT_CURRENT_RUNTIME'
                or anchor.get('sourceSha') != reference['sourceSha']
                or not isinstance(per_component, dict) or set(per_component) != set(SERVICES)):
            raise RuntimeError('RECORD_COMPONENT_REFERENCE_INVALID')
        for item in per_component.values():
            if (not isinstance(item, dict)
                    or not re.fullmatch('[0-9a-f]{40}', str(item.get('sourceSha', '')))
                    or not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', str(item.get('imageReference', '')))
                    or not re.fullmatch('sha256:[0-9a-f]{64}', str(item.get('imageId', '')))
                    or not re.fullmatch('[0-9a-f]{64}', str(item.get('configSha256', '')))
                    or not re.fullmatch('[0-9a-f]{64}', str(item.get('containerId', '')))
                    or item.get('running') is not True
                    or item.get('startedAt') is not None and not re.fullmatch(
                        r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z', str(item['startedAt']))
                    or not isinstance(item.get('repositoryDigests'), list)
                    or item['imageReference'] not in item['repositoryDigests']
                    or any(not isinstance(ref, str) or not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', ref)
                           for ref in item['repositoryDigests'])):
                raise RuntimeError('RECORD_COMPONENT_REFERENCE_INVALID')
    mismatch = sorted(name for name, component in components.items()
                      if component['sourceSha'] != (per_component[name]['sourceSha'] if per_component else reference['sourceSha']))
    recorded_images = reference.get('images')
    if not isinstance(recorded_images, dict):
        raise RuntimeError('RECORD_IMAGES_REQUIRED')
    keys = {'api': 'api', 'e1-sandbox': 'api', 'proxy': 'console', 'keycloak': 'keycloak'}
    digest_mismatch = []
    for service, key in keys.items():
        image_reference = per_component[service]['imageReference'] if per_component else recorded_images.get(key)
        if not isinstance(image_reference, str) or not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', image_reference):
            raise RuntimeError('RECORD_IMMUTABLE_IMAGE_REQUIRED')
        if (image_reference not in components[service]['repositoryDigests']
                or per_component and per_component[service]['imageId'] != components[service]['imageId']):
            digest_mismatch.append(service)
    result = {'schema': 'UatReleaseInspectionV1', 'records': records,
            'components': components, 'sourceMismatch': mismatch,
            'imageDigestMismatch': sorted(digest_mismatch),
            'rollbackCertified': False, 'runtimeConsistency': 'TWO_MATCHING_OBSERVATIONS'}
    if per_component:
        result['componentConfigMismatch'] = sorted(name for name in SERVICES
            if components[name]['configSha256'] != per_component[name]['configSha256'])
        result['componentIdentityMismatch'] = sorted(name for name in SERVICES
            if components[name]['containerId'] != per_component[name]['containerId']
            or components[name].get('startedAt') != per_component[name].get('startedAt'))
        result['referenceKind'] = 'PER_COMPONENT_OBSERVATION'
    return result


if __name__ == '__main__':
    print(json.dumps(inspect(), sort_keys=True))
