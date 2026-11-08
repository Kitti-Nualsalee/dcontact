import { randomUUID } from 'node:crypto';
import { Prisma, lockTeamReferences } from '@d-contact/db';
import {
  C360ContactPointError,
  normalizeC360Email,
  normalizeC360Phone,
} from '@d-contact/contact-points';
import { type C360VerifiedActor } from './profile-authorization.js';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  type C360CommandActor,
  type C360PreparedProfileCommand,
  type C360ProfileEffect,
} from './profile-command.js';
import {
  lockIamScopeVersionsShared,
  tryC360IdentityFences,
  tryIamContactProjectionFences,
} from './profile-fences.js';
import { C360ReadError, c360FilterDigest, type C360CursorCodec } from './profile-read.js';
import { normalizeC360ProfilePatch, type C360ProfilePatch } from './profile-write.js';

/** #795: work routes มี predicate ของ Agent เอง ไม่เปิด generic directory ให้ Agent */
export class C360WorkError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export interface C360WorkContext {
  interactionId: string;
  contactId: string | null;
  linkageRevision: string;
  state: string;
  scopeVersion: string;
  leaseId: string | null;
}
const denied = () => new C360WorkError(404, 'RESOURCE_NOT_FOUND');

/** Team → scope → User → lease/auth → Interaction; identity/projection ตามมาภายหลัง */
export async function fenceC360Work(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  interactionId: string,
  leaseId: string | null,
  write: boolean,
): Promise<C360WorkContext> {
  if (actor.role !== 'AGENT' || !actor.teamId) throw denied();
  await lockTeamReferences(tx, actor.tenantId, [actor.teamId]);
  await lockIamScopeVersionsShared(tx, actor.tenantId, [actor.teamId]);
  const users = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM users WHERE tenant_id=${actor.tenantId}::uuid AND id=${actor.userId}::uuid AND is_active AND role::text='AGENT' AND team_id=${actor.teamId}::uuid FOR NO KEY UPDATE NOWAIT`;
  if (!users.length) throw denied();
  if (leaseId) {
    const leases = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM agent_work_session_leases WHERE tenant_id=${actor.tenantId}::uuid AND user_id=${actor.userId}::uuid AND id=${leaseId}::uuid AND released_at IS NULL FOR NO KEY UPDATE NOWAIT`;
    if (!leases.length) throw new C360WorkError(409, 'WORK_SESSION_CHANGED');
    await tx.$queryRaw`SELECT lease_id FROM c360_work_mutation_auth WHERE tenant_id=${actor.tenantId}::uuid AND user_id=${actor.userId}::uuid AND lease_id=${leaseId}::uuid FOR NO KEY UPDATE NOWAIT`;
  }
  const [work] = await tx.$queryRaw<
    { id: string; state: string; contact_id: string | null; customer_link_revision: bigint }[]
  >`SELECT id,state::text,contact_id,customer_link_revision FROM interactions WHERE tenant_id=${actor.tenantId}::uuid AND id=${interactionId}::uuid AND agent_id=${actor.userId}::uuid AND channel::text='VOICE' FOR NO KEY UPDATE NOWAIT`;
  if (!work) throw denied();
  const active = ['ACTIVE', 'WRAPUP'].includes(work.state);
  if ((write && !active) || (!active && work.state !== 'COMPLETED'))
    throw new C360WorkError(409, 'WORK_STATE_CHANGED');
  if (active && !leaseId) throw new C360WorkError(401, 'REAUTH_REQUIRED');
  const version = await tx.iamTeamScopeVersion.findUnique({
    where: { tenantId_teamId: { tenantId: actor.tenantId, teamId: actor.teamId } },
  });
  return {
    interactionId,
    contactId: work.contact_id,
    state: work.state,
    linkageRevision: work.customer_link_revision.toString(),
    scopeVersion: String(version?.scopeVersion ?? 0),
    leaseId,
  };
}

/** IAM IN ต้องตรงกับ owner head ปัจจุบัน ไม่เชื่อ projection ที่ยังตามไม่ทัน */
function scopeRows(
  actor: C360VerifiedActor,
  permission: 'VIEW' | 'WORK',
  condition: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM iam_team_segment_scope_active_grants g
    JOIN teams t ON t.tenant_id=g.tenant_id AND t.id=g.team_id AND t.is_active
    LEFT JOIN iam_contact_segment_scope_projection p ON p.tenant_id=g.tenant_id AND p.segment_id=g.segment_id AND p.contact_id=c.id
    LEFT JOIN c360_segment_membership_heads h ON h.tenant_id=g.tenant_id AND h.segment_id=g.segment_id AND h.contact_id=c.id
    WHERE g.tenant_id=c.tenant_id AND g.team_id=${actor.teamId}::uuid AND g.permission::text=${permission} AND (${condition}))`;
}
const fresh = Prisma.sql`p.state='IN' AND h.state='IN' AND p.membership_revision=h.membership_revision`;
const stale = Prisma.sql`p.state='INVALIDATED' OR h.state='INVALIDATED' OR p.membership_revision IS DISTINCT FROM h.membership_revision`;

export async function authorizeC360WorkContact(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
  permission: 'WORK' | 'VIEW',
) {
  const [row] = await tx.$queryRaw<{ allowed: boolean; deferred: boolean }[]>(
    Prisma.sql`SELECT ${scopeRows(actor, permission, fresh)} AS allowed, ${scopeRows(actor, permission, stale)} AS deferred FROM contacts c WHERE c.tenant_id=${actor.tenantId}::uuid AND c.id=${contactId}::uuid`,
  );
  if (row?.allowed) return;
  if (row?.deferred) throw new C360WorkError(503, 'SCOPE_UNAVAILABLE', true);
  throw denied();
}

export async function fenceC360WorkContacts(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  ids: string[],
) {
  await tryC360IdentityFences(tx, actor.tenantId, ids);
  await tryIamContactProjectionFences(tx, actor.tenantId, ids);
}

export function normalizeC360WorkSearch(body: Record<string, unknown>) {
  if (Object.keys(body).some((k) => !['type', 'query', 'explicitCountry', 'cursor'].includes(k)))
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  if (body.type !== 'PHONE' && body.type !== 'EMAIL')
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  if (body.type === 'EMAIL' && body.explicitCountry !== undefined)
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  let point;
  try {
    point =
      body.type === 'PHONE'
        ? normalizeC360Phone(body.query, body.explicitCountry)
        : normalizeC360Email(body.query);
  } catch (error) {
    if (error instanceof C360ContactPointError)
      throw new C360ReadError(400, 'VALIDATION_FAILED', false, [
        { field: 'query', code: error.code },
      ]);
    throw error;
  }
  if (body.cursor !== undefined && typeof body.cursor !== 'string')
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  return {
    kind: body.type,
    value: point.normalizedValue,
    version: point.normalizationVersion,
    cursor: body.cursor as string | undefined,
  };
}
function referenceContext(actor: C360VerifiedActor, work: C360WorkContext) {
  return {
    tenantId: actor.tenantId,
    userId: actor.userId,
    scope: c360FilterDigest([
      actor.teamId ?? '',
      work.scopeVersion,
      work.leaseId ?? '',
      work.linkageRevision,
    ]),
  };
}
export async function searchC360WorkCandidates(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  work: C360WorkContext,
  search: ReturnType<typeof normalizeC360WorkSearch>,
  codec: C360CursorCodec,
  now = Date.now(),
) {
  const context = referenceContext(actor, work);
  const filter = c360FilterDigest([work.interactionId, search.kind, search.value, search.version]);
  const cursorContext = { ...context, kind: 'work-candidate-page', filter };
  const position = search.cursor
    ? codec.open(search.cursor, cursorContext, { distinguishScopeChange: true })
    : null;
  if (
    position &&
    (position.length !== 2 || !/^\d{4}-/.test(position[0]!) || !/^[\da-f-]{36}$/.test(position[1]!))
  )
    throw new C360ReadError(400, 'CURSOR_INVALID');
  const matching = Prisma.sql`EXISTS (SELECT 1 FROM c360_contact_points cp WHERE cp.tenant_id=c.tenant_id AND cp.contact_id=c.id AND cp.state='ACTIVE' AND cp.kind=${search.kind} AND cp.normalization_version=${search.version} AND cp.normalized_value=${search.value})`;
  const [pending] = await tx.$queryRaw<{ exists: boolean }[]>(
    Prisma.sql`SELECT EXISTS(SELECT 1 FROM contacts c WHERE c.tenant_id=${actor.tenantId}::uuid AND ${matching} AND NOT ${scopeRows(actor, 'WORK', fresh)} AND ${scopeRows(actor, 'WORK', stale)}) AS exists`,
  );
  if (pending?.exists) throw new C360WorkError(503, 'SCOPE_UNAVAILABLE', true);
  const rows = await tx.$queryRaw<
    {
      id: string;
      display_name: string | null;
      company: string | null;
      created_key: string;
      lineage_revision: number;
    }[]
  >(Prisma.sql`SELECT c.id,c.display_name,c.company,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key,ih.lineage_revision FROM contacts c JOIN c360_identity_heads ih ON ih.tenant_id=c.tenant_id AND ih.contact_id=c.id AND ih.state='ACTIVE'
    WHERE c.tenant_id=${actor.tenantId}::uuid AND ${matching} AND ${scopeRows(actor, 'WORK', fresh)}
    ${position ? Prisma.sql`AND (c.created_at,c.id) < (${position[0]}::timestamptz,${position[1]}::uuid)` : Prisma.empty}
    ORDER BY c.created_at DESC,c.id DESC LIMIT 11`);
  const visible = rows.slice(0, 10);
  const last = visible.at(-1);
  return {
    items: visible.map((c) => ({
      candidateRef: codec.seal({
        ...context,
        kind: 'work-candidate-ref',
        filter: c360FilterDigest([work.interactionId]),
        position: [c.id, String(c.lineage_revision), filter, String(now + 300_000)],
      }),
      displayName: c.display_name,
      company: c.company,
      matchingChannel: search.kind === 'PHONE' ? `•••${search.value.slice(-2)}` : '•••@•••',
    })),
    nextCursor:
      rows.length > 10 && last
        ? codec.seal({ ...cursorContext, position: [last.created_key, last.id] })
        : null,
    verified: false,
  };
}
export function openC360WorkCandidate(
  actor: C360VerifiedActor,
  work: C360WorkContext,
  ref: string,
  codec: C360CursorCodec,
  now = Date.now(),
) {
  const parts = codec.open(
    ref,
    {
      ...referenceContext(actor, work),
      kind: 'work-candidate-ref',
      filter: c360FilterDigest([work.interactionId]),
    },
    { distinguishScopeChange: true },
  );
  if (
    parts.length !== 4 ||
    !/^[\da-f-]{36}$/.test(parts[0]!) ||
    !/^\d+$/.test(parts[1]!) ||
    !/^\d+$/.test(parts[3]!)
  )
    throw new C360ReadError(400, 'CURSOR_INVALID');
  if (Number(parts[3]) <= now) throw new C360WorkError(410, 'CANDIDATE_EXPIRED');
  return { contactId: parts[0]!, lineageRevision: parts[1]! };
}

export async function readC360WorkCustomer(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  work: C360WorkContext,
) {
  if (!work.contactId)
    return {
      interactionId: work.interactionId,
      state: 'UNLINKED' as const,
      linkageRevision: work.linkageRevision,
      canLink: work.state !== 'COMPLETED',
    };
  await fenceC360WorkContacts(tx, actor, [work.contactId]);
  await authorizeC360WorkContact(
    tx,
    actor,
    work.contactId,
    work.state === 'COMPLETED' ? 'VIEW' : 'WORK',
  );
  const contact = await tx.contact.findFirstOrThrow({
    where: { tenantId: actor.tenantId, id: work.contactId },
    select: {
      id: true,
      displayName: true,
      company: true,
      profileRevision: true,
      tagRevision: true,
    },
  });
  const head = await tx.c360IdentityHead.findUnique({
    where: { tenantId_contactId: { tenantId: actor.tenantId, contactId: work.contactId } },
  });
  return {
    interactionId: work.interactionId,
    state: 'LINKED' as const,
    linkageRevision: work.linkageRevision,
    contact: { id: contact.id, displayName: contact.displayName, company: contact.company },
    revisions: {
      profile: String(contact.profileRevision),
      tag: String(contact.tagRevision),
      lineage: head?.lineageRevision === undefined ? null : String(head.lineageRevision),
    },
    identity: head?.state ?? 'LEGACY_MISSING_HEAD',
    canLink: work.state !== 'COMPLETED',
    canEdit: work.state !== 'COMPLETED' && head?.state === 'ACTIVE',
  };
}

export function normalizeC360WorkPatch(body: Record<string, unknown>): C360ProfilePatch {
  if (
    Object.keys(body).some(
      (k) =>
        ![
          'commandId',
          'expectedProfileRevision',
          'expectedLineageRevision',
          'expectedLinkageRevision',
          'displayName',
          'company',
        ].includes(k),
    )
  )
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const { expectedLinkageRevision: _, ...patch } = body;
  return normalizeC360ProfilePatch(patch);
}
export async function updateC360WorkProfile(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  work: C360WorkContext,
  expectedProfile: string,
  expectedLineage: string,
  patch: C360ProfilePatch,
): Promise<C360ProfileEffect> {
  if (!work.contactId) throw denied();
  await fenceC360WorkContacts(tx, actor, [work.contactId]);
  await authorizeC360WorkContact(tx, actor, work.contactId, 'WORK');
  const head = await tx.c360IdentityHead.findUnique({
    where: { tenantId_contactId: { tenantId: actor.tenantId, contactId: work.contactId } },
  });
  if (head?.state !== 'ACTIVE') throw new C360ProfileCommandRejection('IDENTITY_CHANGED', 409);
  const [row] = await tx.$queryRaw<
    { display_name: string | null; company: string | null; profile_revision: bigint }[]
  >`SELECT display_name,company,profile_revision FROM contacts WHERE tenant_id=${actor.tenantId}::uuid AND id=${work.contactId}::uuid FOR NO KEY UPDATE NOWAIT`;
  if (!row) throw denied();
  if (
    String(row.profile_revision) !== expectedProfile ||
    String(head.lineageRevision) !== expectedLineage
  )
    throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  const changed = (['displayName', 'company'] as const).filter(
    (k) =>
      patch[k] !== undefined && patch[k] !== (k === 'displayName' ? row.display_name : row.company),
  );
  const before = String(row.profile_revision);
  const refs = [
    { type: 'CONTACT', id: work.contactId },
    { type: 'INTERACTION', id: work.interactionId },
  ];
  if (!changed.length)
    return {
      outcome: 'NO_OP',
      committedRevisions: { profile: before, linkage: work.linkageRevision },
      resourceRefs: refs,
    };
  const after = String(row.profile_revision + 1n);
  await tx.contact.update({
    where: { id: work.contactId },
    data: {
      displayName: patch.displayName,
      company: patch.company,
      profileRevision: BigInt(after),
    },
  });
  return {
    outcome: 'APPLIED',
    httpStatus: 200,
    committedRevisions: { profile: after, linkage: work.linkageRevision },
    resourceRefs: refs,
    audits: [
      {
        operation: 'CONTACT_UPDATE',
        resourceType: 'CONTACT',
        resourceId: work.contactId,
        changedFields: changed,
        beforeRevisions: { profile: before },
        afterRevisions: { profile: after },
      },
    ],
  };
}

export async function changeC360WorkLink(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  work: C360WorkContext,
  commandActor: C360CommandActor,
  command: C360PreparedProfileCommand,
  target: { contactId: string; lineageRevision: string } | null,
  reason: string | null,
): Promise<C360ProfileEffect> {
  const ids = [work.contactId, target?.contactId].filter((id): id is string => !!id);
  await fenceC360WorkContacts(tx, actor, ids);
  for (const id of new Set(ids)) await authorizeC360WorkContact(tx, actor, id, 'WORK');
  if (target) {
    const head = await tx.c360IdentityHead.findUnique({
      where: { tenantId_contactId: { tenantId: actor.tenantId, contactId: target.contactId } },
    });
    if (head?.state !== 'ACTIVE' || String(head.lineageRevision) !== target.lineageRevision)
      throw new C360ProfileCommandRejection('IDENTITY_CHANGED', 409);
  }
  const selected = target?.contactId ?? null;
  const refs = [
    { type: 'INTERACTION', id: work.interactionId },
    ...(selected ? [{ type: 'CONTACT', id: selected }] : []),
  ];
  if (selected === work.contactId)
    return {
      outcome: 'NO_OP',
      committedRevisions: { linkage: work.linkageRevision },
      resourceRefs: refs,
    };
  const action = selected === null ? 'DETACH' : work.contactId ? 'RELINK' : 'LINK';
  if ((action === 'LINK' && reason !== null) || (action !== 'LINK' && !reason))
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const after = BigInt(work.linkageRevision) + 1n;
  await tx.interaction.update({
    where: { id: work.interactionId },
    data: { contactId: selected, customerLinkRevision: after },
  });
  await tx.c360InteractionCustomerChange.create({
    data: {
      id: randomUUID(),
      tenantId: actor.tenantId,
      interactionId: work.interactionId,
      action,
      beforeContactId: work.contactId,
      afterContactId: selected,
      beforeLinkRevision: BigInt(work.linkageRevision),
      afterLinkRevision: after,
      actorUserId: actor.userId,
      leaseId: work.leaseId!,
      actorIdentityKey: commandActor.actorIdentityKey,
      commandId: command.commandId,
      reason,
    },
  });
  return {
    outcome: 'APPLIED',
    httpStatus: 200,
    committedRevisions: { linkage: String(after) },
    resourceRefs: refs,
    audits: [
      {
        operation: `CUSTOMER_${action}`,
        resourceType: 'INTERACTION',
        resourceId: work.interactionId,
        changedFields: ['contactId'],
        beforeRevisions: { linkage: work.linkageRevision },
        afterRevisions: { linkage: String(after) },
      },
    ],
  };
}
