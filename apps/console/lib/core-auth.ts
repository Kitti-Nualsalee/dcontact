import { jwtVerify } from 'jose';
import { CoreIdentity } from '@d-contact/api/src/tenant-core-command.js';

const JWT_SECRET = new TextEncoder().encode(process.env.CORE_JWT_SECRET || '');

export async function getCoreIdentity(request: Request): Promise<CoreIdentity | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;

  try {
    const { payload } = await jwtVerify(auth.slice(7), JWT_SECRET, {
      issuer: process.env.KEYCLOAK_REALM_URL,
      audience: 'account',
    });

    if (!payload.sub || !payload.tenant || !payload.roles || !Array.isArray(payload.roles)) return null;

    return {
      userId: payload.sub,
      tenantId: String(payload.tenant),
      roles: payload.roles as string[],
      subject: payload.sub,
    };
  } catch {
    return null;
  }
}
