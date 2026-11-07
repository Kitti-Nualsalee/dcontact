import { NextResponse } from 'next/server.js';
import { getCoreIdentity } from '../../../../../lib/core-auth.js';

export async function GET(request: Request) {
  const identity = await getCoreIdentity(request);
  if (!identity) return NextResponse.json({ code: 'CORE_ACCESS_DENIED' }, { status: 403 });

  return NextResponse.json({
    organization: {
      read: true,
      write: identity.roles.includes('CORE_ADMIN'),
    },
    teams: {
      read: identity.roles.some(r => ['CORE_ADMIN', 'SUPERVISOR'].includes(r)),
      write: identity.roles.includes('CORE_ADMIN'),
    },
  });
}
