/**
 * Owner: IAM provisioning — real boundary ports of the KEYCLOAK_ORGANIZATION / FIRST_ADMIN steps (A1.4 #409)
 *
 * Authority: #390 (verified adoption: correlation mismatch = never adopt or delete), #392 (First Tenant Admin identity),
 * #388 decision "Tenant bootstrap write boundary"
 *
 * - every external resource is stamped with `tenant_id` + `dc_provisioning_request_id`, then `find` reads back
 *   and checks the correlation before returning `FOUND` — a name clash with a different correlation = `MISMATCH` (the saga raises ACTION_REQUIRED)
 * - `execute` is idempotent at every sub-step: create what is missing, skip what exists, then read back again
 * - the first-admin `users` row is written only with role `dcontact_provisioner` (RLS allows only tenants
 *   still PROVISIONING) and the id is deterministic per request so a replay does not create a duplicate
 * - D-Contact sets no password: the user gets required actions to complete themselves through the invitation
 */
import type { PrismaClient } from '@d-contact/db';
import { FIRST_ADMIN_REQUIRED_ACTIONS } from '@d-contact/shared';
import type { KeycloakAdminClient } from './keycloak-admin.js';
import type { TenantConsoleRedirects } from './tenant-console-redirects.js';
import { bootstrapRowIds, firstAdminUserId } from './provisioning-ids.js';
import {
  ProvisioningStepError,
  type ProvisioningAdoption,
  type ProvisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';

/** attribute binding an external resource to a provisioning request — only an admin (setup script) can change it */
export const PROVISIONING_REQUEST_ATTRIBUTE = 'dc_provisioning_request_id';
/** the first-admin `users` row has no password in our system — a bcrypt compare against this value never passes */
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

  /** the org that stamps this request — used with the first-admin port to find the membership target */
  async correlated(context: ProvisioningStepContext, signal?: AbortSignal) {
    const init = signal ? { signal } : {};
    const { body } = await this.keycloak.admin<KeycloakOrganization[]>(
      'GET',
      `/organizations?${new URLSearchParams({
        q: `${PROVISIONING_REQUEST_ATTRIBUTE}:${context.requestId}`,
      })}`,
      init,
    );
    // the Keycloak 26.0 list does not return attributes — read back each org in full to check the correlation
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
      // the request id matches but tenant/slug do not = someone edited the attribute — never adopt
      const matches =
        first(organization.attributes, 'tenant_id') === context.tenantId &&
        first(organization.attributes, 'tenant_slug') === context.request.slug &&
        organization.name === context.request.slug;
      return matches
        ? { status: 'FOUND', externalRef: organization.id }
        : { status: 'MISMATCH', code: 'KEYCLOAK_ORGANIZATION_CORRELATION_MISMATCH' };
    }
    // the name (= slug) is used by another org that does not belong to this request — never adopt
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
    // name uses the slug because Keycloak enforces unique names — customer names can repeat so they are kept in an attribute instead
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
    // 201 but the read-back does not see it — the real state is unknown
    throw new ProvisioningStepError('AMBIGUOUS', 'KEYCLOAK_READ_BACK_FAILED');
  }

  /** may delete only an org whose correlation matches and has no members — never deletes another tenant's org */
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
    /** Prisma connected with role `dcontact_provisioner` */
    private readonly provisioner: PrismaClient,
    private readonly organizations: KeycloakOrganizationPort,
    /** #907: redirect of the tenant Console — the real worker always sets it; tests without a Console client may omit it */
    private readonly redirects?: TenantConsoleRedirects,
  ) {}

  /** the Keycloak user whose email matches (username = email) — at most one because email is unique in the realm */
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
    // the same email belongs to another identity — stable code and does not say which tenant owns it (#409)
    if (!this.correlated(user, context)) {
      return { status: 'MISMATCH', code: 'FIRST_ADMIN_EMAIL_CONFLICT' };
    }
    return (await this.converged(user, context))
      ? { status: 'FOUND', externalRef: user.id }
      : // ours but incomplete (crashed midway) — execute fills in what is missing idempotently
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
    if (membership.status !== 200) return false;
    // #907: the first admin must be able to log in to the tenant Console before the invitation is sent
    return this.redirects ? this.redirects.registered(context.request.slug) : true;
  }

  async execute(context: ProvisioningStepContext, signal: AbortSignal) {
    const dcUserId = firstAdminUserId(context.requestId);
    const [organization] = await this.organizations.correlated(context, signal);
    if (!organization)
      throw new ProvisioningStepError('PERMANENT', 'KEYCLOAK_ORGANIZATION_MISSING');

    // 1) the tenant's users row (the provisioner's RLS allows only tenants still PROVISIONING)
    await this.provisioner.user.createMany({
      data: [
        {
          id: dcUserId,
          tenantId: context.tenantId,
          email: context.request.firstAdminEmail,
          passwordHash: KEYCLOAK_MANAGED_PASSWORD,
          displayName: context.request.firstAdminDisplayName,
          role: 'ADMIN',
          // the Admin Team is seeded by PLAN_BOOTSTRAP which always comes before FIRST_ADMIN (#392 Bootstrap scope)
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

    // 2) Keycloak identity with correlation and required actions — no credential
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

    // 3) tenant role + Organization membership (both idempotent)
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
      // Keycloak takes the user id raw (not a JSON string with quotation marks)
      { signal, rawBody: user.id, accept: [201, 204, 409] },
    );

    // 4) identity mapping: users.keycloak_id points only to a verified Keycloak user
    const mapped = await this.provisioner.user.updateMany({
      where: { id: dcUserId, OR: [{ keycloakId: null }, { keycloakId: user.id }] },
      data: { keycloakId: user.id },
    });
    if (mapped.count !== 1)
      throw new ProvisioningStepError('PERMANENT', 'FIRST_ADMIN_ROW_CONFLICT');

    // 5) #907 exact redirect of the tenant for the Console client (idempotent, read back to verify)
    await this.redirects?.register(context.request.slug, signal);

    const adoption = await this.find(context);
    if (adoption.status !== 'FOUND') {
      throw new ProvisioningStepError('AMBIGUOUS', 'KEYCLOAK_READ_BACK_FAILED');
    }
    return { externalRef: adoption.externalRef };
  }
}
