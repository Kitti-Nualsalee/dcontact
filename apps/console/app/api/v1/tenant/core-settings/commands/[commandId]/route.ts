import { NextResponse } from 'next/server.js';
import { getCoreIdentity } from '../../../../../../lib/core-auth.js';
import { db } from '@d-contact/db';
import { getCoreCommand, reconcileCoreCommand } from '@d-contact/api/src/tenant-core-command.js';

type Props = { params: { commandId: string } };

export async function GET(request: Request, { params }: Props) {
  const identity = await getCoreIdentity(request);
  if (!identity) return NextResponse.json({ code: 'CORE_ACCESS_DENIED' }, { status: 403 });

  const command = await getCoreCommand(db, identity, params.commandId);
  return NextResponse.json(command);
}

export async function POST(request: Request, { params }: Props) {
  const identity = await getCoreIdentity(request);
  if (!identity) return NextResponse.json({ code: 'CORE_ACCESS_DENIED' }, { status: 403 });

  const result = await reconcileCoreCommand(db, identity, params.commandId);
  return NextResponse.json(result);
}
