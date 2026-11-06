import { NextResponse } from 'next/server.js';
import { getCoreIdentity } from '../../../../../lib/core-auth.js';
import { db } from '@d-contact/db';
import { coreOrganizationSnapshot } from '@d-contact/api/src/tenant-core-organization.js';

export async function GET(request: Request) {
  const identity = await getCoreIdentity(request);
  if (!identity) return NextResponse.json({ code: 'CORE_ACCESS_DENIED' }, { status: 403 });

  const tx = await db.$transaction(async (tx) => {
    return coreOrganizationSnapshot(tx, identity.tenantId);
  }, { isolationLevel: 'READ COMMITTED' });

  return NextResponse.json({ organization: tx });
}

export async function PATCH(request: Request) {
  const identity = await getCoreIdentity(request);
  if (!identity) return NextResponse.json({ code: 'CORE_ACCESS_DENIED' }, { status: 403 });

  const body = await request.json();
  const result = await import('@d-contact/api/src/tenant-core-organization.js').then(m =>
    m.updateCoreOrganization(db, identity, body)
  );

  return NextResponse.json(result);
}
