/**
 * Owner: IAM provisioning — real boundary ports ของ step KEYCLOAK_ORGANIZATION / FIRST_ADMIN (A1.4 #409)
 *
 * Authority: #390 (verified adoption: correlation ไม่ตรง = ห้ามยึดหรือลบ), #392 (First Tenant Admin identity),
 * #388 decision "Tenant bootstrap write boundary"
 *
 * - resource ภายนอกทุกชิ้นถูก stamp `tenant_id` + `dc_provisioning_request_id` แล้ว `find` read-back
 *   ตรวจ correlation ก่อนคืน `FOUND` — ชื่อชนแต่ correlation ไม่ตรง = `MISMATCH` (saga ส่ง ACTION_REQUIRED)
 * - `execute` idempotent ทุกขั้นย่อย: สร้างที่ขาด, ข้ามที่มีแล้ว, แล้ว read-back อีกรอบ
 * - แถว `users` ของ first-admin เขียนด้วย role `dcontact_provisioner` เท่านั้น (RLS ยอมเฉพาะ tenant
 *   ที่ยัง PROVISIONING) และ id เป็น deterministic ต่อ request จึง replay ไม่สร้างซ้ำ
 * - D-Contact ไม่ตั้งรหัสผ่าน: ผู้ใช้ได้ required actions ที่ต้องทำเองผ่าน invitation
 */
import type { PrismaClient } from '@d-contact/db';
import { FIRST_ADMIN_REQUIRED_ACTIONS } from '@d-contact/shared';
import type { KeycloakAdminClient } from './keycloak-admin.js';
import { bootstrapRowIds, firstAdminUserId } from './provisioning-ids.js';
import {
  ProvisioningStepError,
  type ProvisioningAdoption,
  type ProvisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';

/** attribute ที่ผูก resource ภายนอกกับ provisioning request — แก้ได้เฉพาะ admin (setup script) */
export const PROVISIONING_REQUEST_ATTRIBUTE = 'dc_provisioning_request_id';
/** แถว users ของ first-admin ไม่มีรหัสผ่านในระบบเรา — bcrypt compare กับค่านี้ไม่มีวันผ่าน */
export const KEYCLOAK_MANAGED_PASSWORD = '!keycloak-managed';

interface KeycloakOrganization {
  id: string;
  name: string;
  alias?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
}

interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  emailVerified?: boolean;
  requiredActions?: string[];
  attributes?: Record<string, string[]>;
}

const first = (attributes: Record<string, string[]> | undefined, name: string) =>
  attributes?.[name]?.[0];

// ── Organization ────────────────────────────────────────────────────────────

export class KeycloakOrganizationPort implements ProvisioningStepPort {
  constructor(private readonly keycloak: KeycloakAdminClient) {}

  /** org ที่ stamp request นี้ไว้ — ใช้ร่วมกับ first-admin port เพื่อหา membership target */
  async correlated(context: ProvisioningStepContext, signal?: AbortSignal) {
    const init = signal ? { signal } : {};
    const { body } = await this.keycloak.admin<KeycloakOrganization[]>(
      'GET',
      `/organizations?${new URLSearchParams({
        q: `${PROVISIONING_REQUEST_ATTRIBUTE}:${context.requestId}`,
      })}`,
      init,
    );
    // list ของ Keycloak 26.0 ไม่คืน attributes — read-back ตัวเต็มทีละ org เพื่อตรวจ correlation
    const organizations: KeycloakOrganization[] = [];
    for (const summary of body ?? []) {
      const full = await this.keycloak.admin<KeycloakOrganization>(
        'GET',
        `/organizations/${encodeURIComponent(summary.id)}`,
        { ...init, accept: [200, 404] },
      );
      if (full.status === 200) organizations.push(full.body);
    }
    return organizations;
  }

  async find(context: ProvisioningStepContext): Promise<ProvisioningAdoption> {
    const correlated = await this.correlated(context);
    if (correlated.length > 1)
      return { status: 'MISMATCH', code: 'KEYCLOAK_ORGANIZATION_DUPLICATE' };
    const [organization] = correlated;
    if (organization) {
      // request id ตรงแต่ tenant/slug ไม่ตรง = มีคนแก้ attribute — ห้าม adopt
      const matches =
        first(organization.attributes, 'tenant_id') === context.tenantId &&
        first(organization.attributes, 'tenant_slug') === context.request.slug &&
        organization.name === context.request.slug;
      return matches
        ? { status: 'FOUND', externalRef: organization.id }
        : { status: 'MISMATCH', code: 'KEYCLOAK_ORGANIZATION_CORRELATION_MISMATCH' };
    }
    // ชื่อ (= slug) ถูกใช้โดย org อื่นที่ไม่ใช่ของ request นี้ — ห้ามยึด
    const { body: named } = await this.keycloak.admin<KeycloakOrganization[]>(
      'GET',
      `/organizations?${new URLSearchParams({ search: context.request.slug, exact: 'true' })}`,
    );
    if ((named ?? []).some((candidate) => candidate.name === context.request.slug)) {
      return { status: 'MISMATCH', code: 'KEYCLOAK_ORGANIZATION_CONFLICT' };
    }
    return { status: 'NOT_FOUND' };
  }

  async execute(context: ProvisioningStepContext, signal: AbortSignal) {
    // name ใช้ slug เพราะ Keycloak บังคับ name unique — ชื่อลูกค้าซ้ำกันได้จึงเก็บใน attribute แทน
    const created = await this.keycloak.admin('POST', '/organizations', {
      signal,
      accept: [201, 409],
      body: {
        name: context.request.slug,
        alias: context.request.slug,
        enabled: true,
        description: context.request.displayName,
        domains: [{ name: context.request.primaryDomain, verified: false }],
        attributes: {
          tenant_id: [context.tenantId],
          tenant_slug: [context.request.slug],
          [PROVISIONING_REQUEST_ATTRIBUTE]: [context.requestId],
          display_name: [context.request.displayName],
        },
      },
    });
    const adoption = await this.find(context);
    if (adoption.status === 'FOUND') return { externalRef: adoption.externalRef };
    if (created.status === 409 || adoption.status === 'MISMATCH') {
      throw new ProvisioningStepError(
        'PERMANENT',
        adoption.status === 'MISMATCH' ? adoption.code : 'KEYCLOAK_ORGANIZATION_CONFLICT',
      );
    }
    // 201 แต่ read-back ไม่เห็น — ไม่รู้สถานะจริง
    throw new ProvisioningStepError('AMBIGUOUS', 'KEYCLOAK_READ_BACK_FAILED');
  }

  /** ลบได้เฉพาะ org ที่ correlation ตรงและยังไม่มีสมาชิก — ไม่มีวันลบ org ของ tenant อื่น */
  async compensate(context: ProvisioningStepContext, externalRef: string) {
    const adoption = await this.find(context);
    if (adoption.status !== 'FOUND' || adoption.externalRef !== externalRef) {
      throw new ProvisioningStepError('PERMANENT', 'NOT_OWNED');
    }
    const { body: members } = await this.keycloak.admin<unknown[]>(
      'GET',
      `/organizations/${encodeURIComponent(externalRef)}/members?max=1`,
    );
    if ((members ?? []).length > 0) {
      throw new ProvisioningStepError('PERMANENT', 'KEYCLOAK_ORGANIZATION_HAS_MEMBERS');
    }
    await this.keycloak.admin('DELETE', `/organizations/${encodeURIComponent(externalRef)}`, {
      accept: [204, 404],
    });
  }
}

// ── First Tenant Admin ──────────────────────────────────────────────────────

export class FirstAdminPort implements ProvisioningStepPort {
  constructor(
    private readonly keycloak: KeycloakAdminClient,
    /** Prisma ที่ต่อด้วย role `dcontact_provisioner` */
    private readonly provisioner: PrismaClient,
    private readonly organizations: KeycloakOrganizationPort,
  ) {}

  /** ผู้ใช้ Keycloak ที่ email ตรง (username = email) — มีได้อย่างมากหนึ่งคนเพราะ email unique ใน realm */
  async user(context: ProvisioningStepContext, signal?: AbortSignal) {
    const { body } = await this.keycloak.admin<KeycloakUser[]>(
      'GET',
      `/users?${new URLSearchParams({
        username: context.request.firstAdminEmail,
        exact: 'true',
        briefRepresentation: 'false',
      })}`,
      signal ? { signal } : {},
    );
    return (body ?? [])[0];
  }

  private correlated(user: KeycloakUser, context: ProvisioningStepContext) {
    return (
      first(user.attributes, PROVISIONING_REQUEST_ATTRIBUTE) === context.requestId &&
      first(user.attributes, 'tenant_id') === context.tenantId &&
      first(user.attributes, 'tenant_slug') === context.request.slug &&
      first(user.attributes, 'dc_user_id') === firstAdminUserId(context.requestId)
    );
  }

  async find(context: ProvisioningStepContext): Promise<ProvisioningAdoption> {
    const user = await this.user(context);
    if (!user) return { status: 'NOT_FOUND' };
    // email เดียวกันเป็นของ identity อื่น — code คงที่และไม่บอกว่าเป็นของ tenant ไหน (#409)
    if (!this.correlated(user, context)) {
      return { status: 'MISMATCH', code: 'FIRST_ADMIN_EMAIL_CONFLICT' };
    }
    return (await this.converged(user, context))
      ? { status: 'FOUND', externalRef: user.id }
      : // ของเราแต่ยังทำไม่ครบ (crash กลางทาง) — execute เติมส่วนที่ขาดแบบ idempotent
        { status: 'NOT_FOUND' };
  }

  private async converged(user: KeycloakUser, context: ProvisioningStepContext) {
    const row = await this.provisioner.user.findUnique({
      where: { id: firstAdminUserId(context.requestId) },
      select: { tenantId: true, keycloakId: true, role: true, teamId: true },
    });
    if (
      row?.tenantId !== context.tenantId ||
      row.keycloakId !== user.id ||
      row.role !== 'ADMIN' ||
      row.teamId !== bootstrapRowIds(context.requestId).adminTeamId
    ) {
      return false;
    }
    const { body: roles } = await this.keycloak.admin<{ name: string }[]>(
      'GET',
      `/users/${encodeURIComponent(user.id)}/role-mappings/realm`,
    );
    if (!(roles ?? []).some((role) => role.name === 'admin')) return false;
    const [organization] = await this.organizations.correlated(context);
    if (!organization) return false;
    const membership = await this.keycloak.admin(
      'GET',
      `/organizations/${encodeURIComponent(organization.id)}/members/${encodeURIComponent(user.id)}`,
      { accept: [200, 404] },
    );
    return membership.status === 200;
  }

  async execute(context: ProvisioningStepContext, signal: AbortSignal) {
    const dcUserId = firstAdminUserId(context.requestId);
    const [organization] = await this.organizations.correlated(context, signal);
    if (!organization)
      throw new ProvisioningStepError('PERMANENT', 'KEYCLOAK_ORGANIZATION_MISSING');

    // 1) แถว users ของ tenant (RLS ของ provisioner ยอมเฉพาะ tenant ที่ยัง PROVISIONING)
    await this.provisioner.user.createMany({
      data: [
        {
          id: dcUserId,
          tenantId: context.tenantId,
          email: context.request.firstAdminEmail,
          passwordHash: KEYCLOAK_MANAGED_PASSWORD,
          displayName: context.request.firstAdminDisplayName,
          role: 'ADMIN',
          // Admin Team ถูก seed โดย PLAN_BOOTSTRAP ซึ่งมาก่อน FIRST_ADMIN เสมอ (#392 Bootstrap scope)
          teamId: bootstrapRowIds(context.requestId).adminTeamId,
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.provisioner.user.findUnique({
      where: { id: dcUserId },
      select: { tenantId: true },
    });
    if (row?.tenantId !== context.tenantId) {
      throw new ProvisioningStepError('PERMANENT', 'FIRST_ADMIN_ROW_CONFLICT');
    }

    // 2) Keycloak identity พร้อม correlation และ required actions — ไม่มี credential
    let user = await this.user(context, signal);
    if (!user) {
      const created = await this.keycloak.admin('POST', '/users', {
        signal,
        accept: [201, 409],
        body: {
          username: context.request.firstAdminEmail,
          email: context.request.firstAdminEmail,
          emailVerified: false,
          enabled: true,
          firstName: context.request.firstAdminDisplayName,
          lastName: context.request.displayName,
          requiredActions: [...FIRST_ADMIN_REQUIRED_ACTIONS],
          attributes: {
            tenant_id: [context.tenantId],
            tenant_slug: [context.request.slug],
            dc_user_id: [dcUserId],
            [PROVISIONING_REQUEST_ATTRIBUTE]: [context.requestId],
          },
        },
      });
      user = await this.user(context, signal);
      if (!user) {
        throw new ProvisioningStepError(
          created.status === 409 ? 'PERMANENT' : 'AMBIGUOUS',
          created.status === 409 ? 'FIRST_ADMIN_EMAIL_CONFLICT' : 'KEYCLOAK_READ_BACK_FAILED',
        );
      }
    }
    if (!this.correlated(user, context)) {
      throw new ProvisioningStepError('PERMANENT', 'FIRST_ADMIN_EMAIL_CONFLICT');
    }

    // 3) tenant role + Organization membership (ทั้งคู่ idempotent)
    const { body: adminRole } = await this.keycloak.admin<{ id: string; name: string }>(
      'GET',
      '/roles/admin',
      { signal },
    );
    await this.keycloak.admin('POST', `/users/${encodeURIComponent(user.id)}/role-mappings/realm`, {
      signal,
      body: [adminRole],
    });
    await this.keycloak.admin(
      'POST',
      `/organizations/${encodeURIComponent(organization.id)}/members`,
      // Keycloak รับ user id แบบ raw (ไม่ใช่ JSON string ที่มีเครื่องหมายคำพูด)
      { signal, rawBody: user.id, accept: [201, 204, 409] },
    );

    // 4) identity mapping: users.keycloak_id ชี้ Keycloak user ที่ verify แล้วเท่านั้น
    const mapped = await this.provisioner.user.updateMany({
      where: { id: dcUserId, OR: [{ keycloakId: null }, { keycloakId: user.id }] },
      data: { keycloakId: user.id },
    });
    if (mapped.count !== 1)
      throw new ProvisioningStepError('PERMANENT', 'FIRST_ADMIN_ROW_CONFLICT');

    const adoption = await this.find(context);
    if (adoption.status !== 'FOUND') {
      throw new ProvisioningStepError('AMBIGUOUS', 'KEYCLOAK_READ_BACK_FAILED');
    }
    return { externalRef: adoption.externalRef };
  }
}
