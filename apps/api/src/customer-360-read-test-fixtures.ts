import { randomUUID } from 'node:crypto';
import type { Fixture } from './customer-360-test-fixtures.js';

/**
 * Cus360 C2 (#792): helper ข้อมูลสังเคราะห์ของ read tests และ browser sandbox
 * เขียนผ่าน owner connection ใต้ command สังเคราะห์ (C3 ยังไม่มี writer ของ point) — ใช้ใน DB ทดสอบเท่านั้น
 */

let tick = 0;

export async function contact(
  f: Fixture,
  data: { displayName?: string; company?: string; tenantId?: string; vip?: boolean } = {},
) {
  const id = randomUUID();
  tick += 1;
  await f.owner.contact.create({
    data: {
      id,
      tenantId: data.tenantId ?? f.tenantId,
      displayName: data.displayName ?? `ลูกค้า ${tick}`,
      company: data.company,
      vip: data.vip ?? false,
      // เวลาเรียงตามลำดับสร้างและไม่ซ้ำ เพื่อให้ cursor มี tie-breaker ที่คาดเดาได้
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, 0, 0) + tick * 1000),
    },
  });
  return id;
}

export async function grant(
  f: Fixture,
  token: string,
  contactId: string,
  permission: 'READ' | 'MANAGE',
) {
  const commandId = randomUUID();
  const actorIdentityKey = 'operator-fixture';
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey,
      commandId,
      action: 'CUSTODIAN_GRANT',
      resourceType: 'CONTACT',
      resourceId: contactId,
      payloadDigest: 'f'.repeat(64),
      normalizationContractVersion: 'cus360-v1',
    },
  });
  return f.owner.c360ContactCustodianGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId,
      granteeUserId: f.actors.get(token)!.id,
      permission,
      origin: 'OPERATOR',
      evidenceRef: 'fixture-evidence',
      actorIdentityKey,
      commandId,
    },
  });
}

export async function point(
  f: Fixture,
  contactId: string,
  kind: 'PHONE' | 'EMAIL',
  normalized: string,
  state: 'ACTIVE' | 'RETIRED' | 'REVIEW_REQUIRED' = 'ACTIVE',
  raw = normalized,
) {
  const key = `synthetic-fixture-writer:${randomUUID()}`;
  const commandId = randomUUID();
  const retired = state === 'RETIRED';
  const review = state === 'REVIEW_REQUIRED';
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey: key,
      commandId,
      action: 'FIXTURE_POINTS',
      resourceType: 'CONTACT',
      payloadDigest: '0'.repeat(64),
      normalizationContractVersion: 'fixture',
    },
  });
  await f.owner.$executeRaw`INSERT INTO c360_contact_points
    (id, tenant_id, contact_id, kind, raw_value, normalized_value, normalization_version, state,
     source_kind, created_actor_identity_key, created_command_id,
     retired_at, retired_actor_identity_key, retired_command_id)
    VALUES (${randomUUID()}::uuid, ${f.tenantId}::uuid, ${contactId}::uuid, ${kind}, ${raw},
      ${review ? null : normalized}, ${review ? null : 'fixture'}, ${state}, 'PROFILE_COMMAND',
      ${key}, ${commandId}::uuid,
      ${retired ? new Date() : null}, ${retired ? key : null}, ${retired ? commandId : null}::uuid)`;
}

export async function head(f: Fixture, contactId: string, state: 'ACTIVE' | 'AMBIGUOUS') {
  await f.owner.c360IdentityHead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      canonicalContactId: contactId,
      state,
      stateDigest: 'e'.repeat(64),
    },
  });
}

export async function interaction(
  f: Fixture,
  contactId: string,
  agentToken: string | null,
  channel: 'VOICE' | 'WEBCHAT' = 'VOICE',
  state: 'COMPLETED' | 'ACTIVE' = 'COMPLETED',
) {
  tick += 1;
  const queuedAt = new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 0) + tick * 60_000);
  await f.owner.interaction.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      channel,
      direction: 'INBOUND',
      state,
      contactId,
      agentId: agentToken ? f.actors.get(agentToken)!.id : null,
      queuedAt,
      endedAt: state === 'COMPLETED' ? new Date(queuedAt.getTime() + 60_000) : null,
      wrapUpCode: 'SECRET-WRAP-CODE',
      metadata: { note: 'SECRET-NOTE' },
    },
  });
}

export async function tag(f: Fixture, contactId: string, name: string) {
  const tagId = randomUUID();
  const commandId = randomUUID();
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey: 'operator-fixture',
      commandId,
      action: 'TAG_SEED',
      resourceType: 'TAG',
      payloadDigest: '1'.repeat(64),
      normalizationContractVersion: 'fixture',
    },
  });
  await f.owner.c360Tag.create({
    data: {
      id: tagId,
      tenantId: f.tenantId,
      name,
      nameKey: name.toLowerCase(),
      actorIdentityKey: 'operator-fixture',
      commandId,
    },
  });
  await f.owner.c360ContactTag.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      tagId,
      actorIdentityKey: 'operator-fixture',
      commandId,
    },
  });
  return tagId;
}
