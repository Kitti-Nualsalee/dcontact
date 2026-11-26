#!/usr/bin/env python3
"""#537: assemble uat.env on VM2 from the VM3 credential bundle without showing secrets."""

from __future__ import annotations

import os
import secrets
import stat
import sys
import uuid
from pathlib import Path

ROOT = Path(os.environ.get('UAT_ROOT', '/opt/dcontact-uat'))
TARGET = ROOT / 'uat.env'
EXPECTED = {
    'UAT_POSTGRES_USER',
    'UAT_POSTGRES_PASSWORD',
    'UAT_APP_DB_PASSWORD',
    'UAT_KEYCLOAK_DB_PASSWORD',
}
ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'


def fail(message: str) -> None:
    raise SystemExit(message)


def random_value(length: int) -> str:
    return ''.join(secrets.choice(ALPHABET) for _ in range(length))


def main() -> None:
    if len(sys.argv) != 2:
        fail('usage: python3 vm2-create-uat-env.py /path/to/dcontact-uat-db-credentials.env')
    bundle = Path(sys.argv[1])
    if not bundle.is_file() or stat.S_IMODE(bundle.stat().st_mode) != 0o600:
        fail('credential bundle is missing or its mode is not 600')
    if TARGET.exists():
        fail('uat.env already exists; stopping so the secret is not overwritten')
    if ROOT.stat().st_uid != os.getuid() or stat.S_IMODE(ROOT.stat().st_mode) != 0o700:
        fail('UAT_ROOT must be owned by this user with mode 700')

    values: dict[str, str] = {}
    for line in bundle.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        if '=' not in line:
            fail('credential bundle has an invalid format')
        key, value = line.split('=', 1)
        if key in values or key not in EXPECTED or not value:
            fail('credential bundle has an invalid key/value')
        values[key] = value
    if set(values) != EXPECTED or values['UAT_POSTGRES_USER'] != 'dcontact_uat_owner':
        fail('credential bundle is incomplete or the owner identity does not match')
    for key in EXPECTED - {'UAT_POSTGRES_USER'}:
        if len(values[key]) != 48 or not values[key].isalnum() or not values[key].isascii():
            fail(f'{key} is not the random 48-character password from VM3')

    output = {
        'UAT_HOST': 'dcontact-uat.osd.co.th',
        'UAT_ALLOWED_CIDRS': '"192.168.102.0/24 127.0.0.1/32"',
        # Compose interpolates the base file before the overlay removes the TLS secret; /dev/null holds no private key on VM2
        'UAT_TLS_CERT_FILE': '/dev/null',
        'UAT_TLS_KEY_FILE': '/dev/null',
        'UAT_TENANT_ID': str(uuid.uuid4()),
        'UAT_TENANT_SLUG': 'dcontact-uat',
        'UAT_TENANT_NAME': '"D-Contact UAT"',
        'UAT_ORGANIZATION_DOMAIN': 'dcontact-uat.osd.co.th',
        **values,
        'UAT_KEYCLOAK_ADMIN_USERNAME': 'admin',
        'UAT_KEYCLOAK_ADMIN_PASSWORD': random_value(48),
        'UAT_S3_ROOT_ACCESS_KEY': random_value(32),
        'UAT_S3_ROOT_SECRET_KEY': random_value(48),
        'UAT_S3_API_ACCESS_KEY': random_value(32),
        'UAT_S3_API_SECRET_KEY': random_value(48),
    }
    if output['UAT_S3_ROOT_ACCESS_KEY'] == output['UAT_S3_API_ACCESS_KEY']:
        fail('S3 access keys are duplicated')

    fd = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as file:
            for key, value in output.items():
                file.write(f'{key}={value}\n')
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        TARGET.unlink(missing_ok=True)
        raise
    print(f'created {TARGET} successfully (mode 600; secrets not shown)')
    bundle.unlink()
    print('removed the temporary credential bundle from VM2')


if __name__ == '__main__':
    main()
