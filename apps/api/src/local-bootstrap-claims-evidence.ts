import { createHash, randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import {
  toVerifiedWorkspaceIdentity,
  type OidcAccessTokenVerifier,
  type VerifiedOidcClaims,
} from '@d-contact/workspace-session';
import { tenantConfigurationCaller } from './tenant-config-identity.js';

const localIssuer = 'https://console.dcontact.test/auth/realms/dcontact';
const consoleClient = 'dcontact-uat-console';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const manifestFields = [
  'tenantId',
  'userId',
  'subject',
  'tenantSlug',
  'organizationId',
  'clientId',
];

interface ExpectedManifest {
  tenantId: string;
  userId: string;
  subject: string;
  tenantSlug: string;
  organizationId: string;
  clientId: string;
}

export interface LocalBootstrapClaimsEvidence {
  event: 'local.bootstrap.verified_claims';
  version: 1;
  evidenceId: string;
  observedAt: string;
  actualClaimTupleDigest: string;
  expectedManifestDigest: string;
  organizationIdSource: 'OPERATOR_MANIFEST_ONLY';
  issuerMatch: boolean;
  clientMatch: boolean;
  tenantMatch: boolean;
  userMatch: boolean;
  subjectMatch: boolean;
  organizationContextMatch: boolean;
  classificationPresent: boolean;
  classificationAllowed: boolean;
  workspaceIdentityValid: boolean;
  callerMatch: boolean;
  matched: boolean;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseManifest(environment: NodeJS.ProcessEnv): ExpectedManifest {
  try {
    if (
      environment.DCONTACT_API_PROFILE !== 'uat-workspace' ||
      environment.KEYCLOAK_ISSUER !== localIssuer ||
      (environment.UAT_HOST !== undefined && environment.UAT_HOST !== 'console.dcontact.test')
    )
      throw new Error();
    const raw = environment.LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON!;
    if (raw.length > 4096) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const fields = Object.fromEntries(Object.entries(value));
    if (
      Object.keys(fields).length !== manifestFields.length ||
      Object.keys(fields).some((name) => !manifestFields.includes(name)) ||
      !manifestFields.every((name) => typeof fields[name] === 'string') ||
      !['tenantId', 'userId', 'subject', 'organizationId'].every((name) =>
        uuid.test(fields[name]),
      ) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(fields.tenantSlug) ||
      fields.clientId !== consoleClient
    )
      throw new Error();
    return {
      tenantId: fields.tenantId,
      userId: fields.userId,
      subject: fields.subject,
      tenantSlug: fields.tenantSlug,
      organizationId: fields.organizationId,
      clientId: fields.clientId,
    };
  } catch {
    throw new Error('LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_CONFIGURATION_INVALID');
  }
}

function summarize(claims: VerifiedOidcClaims, expected: ExpectedManifest) {
  const fields: Record<string, unknown> = { ...claims };
  const text = (name: string) => (typeof fields[name] === 'string' ? fields[name] : null);
  const organization = fields.organization;
  const organizations =
    organization && typeof organization === 'object' && !Array.isArray(organization)
      ? Object.entries(organization)
          .map(([alias, context]) => {
            const ids: unknown =
              context && typeof context === 'object' && 'tenant_id' in context
                ? context.tenant_id
                : undefined;
            return [
              alias,
              Array.isArray(ids) ? ids.map((id) => (typeof id === 'string' ? id : null)) : null,
            ];
          })
          .sort(([left], [right]) => String(left).localeCompare(String(right)))
      : null;
  let workspaceIdentityValid = false;
  let callerMatch = false;
  try {
    const identity = toVerifiedWorkspaceIdentity(claims);
    workspaceIdentityValid = true;
    const request = Object.assign(new IncomingMessage(new Socket()), {
      gatewayIdentity: identity,
      gatewayVerifiedClaims: claims,
    });
    const caller = tenantConfigurationCaller(request);
    callerMatch =
      !!caller &&
      caller.issuer === localIssuer &&
      caller.subject === expected.subject &&
      caller.clientId === expected.clientId &&
      caller.tenantSlug === expected.tenantSlug;
  } catch {}
  const checks = {
    issuerMatch: fields.iss === localIssuer,
    clientMatch: fields.azp === expected.clientId,
    tenantMatch:
      fields.tenant_id === expected.tenantId && fields.tenant_slug === expected.tenantSlug,
    userMatch: fields.dc_user_id === expected.userId,
    subjectMatch: fields.sub === expected.subject,
    organizationContextMatch:
      JSON.stringify(organizations) ===
      JSON.stringify([[expected.tenantSlug, [expected.tenantId]]]),
    classificationPresent: fields.dc_identity_class !== undefined,
    classificationAllowed:
      fields.dc_identity_class === undefined || fields.dc_identity_class === 'TENANT_USER',
    workspaceIdentityValid,
    callerMatch,
  };
  return {
    actualClaimTupleDigest: digest([
      text('iss'),
      text('sub'),
      text('azp'),
      text('tenant_id'),
      text('tenant_slug'),
      text('dc_user_id'),
      organizations,
      text('dc_identity_class'),
      checks.classificationPresent,
      Array.isArray(claims.realm_access?.roles)
        ? claims.realm_access.roles.filter((role) => typeof role === 'string').sort()
        : null,
      fields.serviceAccountClientId !== undefined,
      typeof fields.preferred_username === 'string' &&
        fields.preferred_username.startsWith('service-account-'),
      Object.keys(
        fields.resource_access && typeof fields.resource_access === 'object'
          ? fields.resource_access
          : {},
      )
        .filter((name) =>
          ['dcontact-platform-api', 'realm-management', 'master-realm', 'admin-cli'].includes(name),
        )
        .sort(),
    ]),
    ...checks,
    matched:
      checks.issuerMatch &&
      checks.clientMatch &&
      checks.tenantMatch &&
      checks.userMatch &&
      checks.subjectMatch &&
      checks.organizationContextMatch &&
      checks.classificationAllowed &&
      checks.workspaceIdentityValid &&
      checks.callerMatch,
  };
}

export function withLocalBootstrapClaimsEvidence(
  verifier: OidcAccessTokenVerifier,
  environment: NodeJS.ProcessEnv,
  emit: (evidence: LocalBootstrapClaimsEvidence) => void | Promise<void>,
): OidcAccessTokenVerifier {
  if (environment.LOCAL_BOOTSTRAP_CLAIMS_EVIDENCE_JSON === undefined) return verifier;
  const expected = parseManifest(environment);
  const expectedManifestDigest = digest(
    manifestFields.map((name) => expected[name as keyof ExpectedManifest]),
  );
  const emitted = new Set<string>();
  return {
    async verifyAccessToken(accessToken) {
      const claims = await verifier.verifyAccessToken(accessToken);
      try {
        const summary = summarize(claims, expected);
        const key = digest(summary);
        if (!emitted.has(key) && emitted.size < 32) {
          emitted.add(key);
          const evidence: LocalBootstrapClaimsEvidence = {
            event: 'local.bootstrap.verified_claims',
            version: 1,
            evidenceId: randomUUID(),
            observedAt: new Date().toISOString(),
            expectedManifestDigest,
            organizationIdSource: 'OPERATOR_MANIFEST_ONLY',
            ...summary,
          };
          void Promise.resolve(emit(evidence)).catch(() => undefined);
        }
      } catch {}
      return claims;
    },
  };
}
