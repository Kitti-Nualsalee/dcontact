/**
 * Owner: Platform control plane — canonical input of a provisioning request (A1.1 #406)
 *
 * Authority: #389 (slug/domain canonical form), #390 (canonical payload digest), #392 (first admin),
 * decision on #406 (sipDomain derives from slug)
 *
 * the server is the sole authority of the canonical form: the digest idempotency compares is the digest of this form,
 * not the raw JSON from the browser — so field order/whitespace/domain case do not make a different request
 */
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import {
  PLATFORM_PLAN_CODES,
  PlatformProvisioningError,
  type CanonicalProvisioningRequest,
  type ProvisioningRequestInput,
} from '@d-contact/shared';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/** slug is a lowercase DNS label, used as a subdomain and to derive sipDomain, so it must be canonical before reserving */
export function normalizeTenantSlug(value: string): string | null {
  const slug = value.trim().toLowerCase();
  return SLUG_PATTERN.test(slug) && !slug.includes('--') ? slug : null;
}

/** primary domain → lowercase IDNA (punycode) with no trailing dot; needs at least two labels */
export function normalizePrimaryDomain(value: string): string | null {
  const ascii = toAsciiHostname(value.trim().replace(/\.$/, ''));
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label)) ? ascii : null;
}

/** IDNA (UTS #46) via Node — a value with a path/port/userinfo is not a hostname */
function toAsciiHostname(value: string): string | null {
  if (!value || /[/:@?#\s]/.test(value)) return null;
  return domainToASCII(value) || null;
}

/** the first admin's email: the local part is unchanged (may be case-sensitive) but the domain is canonical */
export function normalizeFirstAdminEmail(value: string): string | null {
  const email = value.trim();
  if (!EMAIL_PATTERN.test(email)) return null;
  const at = email.lastIndexOf('@');
  const domain = normalizePrimaryDomain(email.slice(at + 1));
  return domain ? `${email.slice(0, at)}@${domain}` : null;
}

/** the sipDomain of a new tenant derives from slug (decision on #406) — immutable along with slug */
export function deriveTenantSipDomain(slug: string, platformSipBaseDomain: string): string {
  const base = normalizePrimaryDomain(platformSipBaseDomain);
  if (!base) throw new PlatformProvisioningError('VALIDATION_FAILED');
  return `${slug}.${base}`;
}

/**
 * converts operational input into canonical form or throws `VALIDATION_FAILED` with field errors
 * — the digest of this form is what idempotency compares, not the raw JSON from the browser
 */
export function canonicalizeProvisioningRequest(
  input: ProvisioningRequestInput,
): CanonicalProvisioningRequest {
  const errors: Record<string, string> = {};
  const displayName = input.displayName.trim().replace(/\s+/g, ' ');
  if (displayName.length < 2 || displayName.length > 120) errors.displayName = 'INVALID';
  const slug = normalizeTenantSlug(input.slug);
  if (!slug) errors.slug = 'INVALID';
  const primaryDomain = normalizePrimaryDomain(input.primaryDomain);
  if (!primaryDomain) errors.primaryDomain = 'INVALID';
  const locale = input.locale.trim();
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) errors.locale = 'INVALID';
  const timezone = input.timezone.trim();
  if (!isIanaTimezone(timezone)) errors.timezone = 'INVALID';
  if (!PLATFORM_PLAN_CODES.includes(input.planCode)) errors.planCode = 'INVALID';
  const bootstrapTemplateVersion = input.bootstrapTemplateVersion.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(bootstrapTemplateVersion)) {
    errors.bootstrapTemplateVersion = 'INVALID';
  }
  const firstAdminEmail = normalizeFirstAdminEmail(input.firstAdmin.email);
  if (!firstAdminEmail) errors['firstAdmin.email'] = 'INVALID';
  const firstAdminDisplayName = input.firstAdmin.displayName.trim().replace(/\s+/g, ' ');
  if (firstAdminDisplayName.length < 1 || firstAdminDisplayName.length > 120) {
    errors['firstAdmin.displayName'] = 'INVALID';
  }
  if (Object.keys(errors).length > 0) {
    throw new PlatformProvisioningError('VALIDATION_FAILED', errors);
  }
  return {
    displayName,
    slug: slug!,
    primaryDomain: primaryDomain!,
    locale,
    timezone,
    planCode: input.planCode,
    bootstrapTemplateVersion,
    firstAdminEmail: firstAdminEmail!,
    firstAdminDisplayName,
  };
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * hash stored in place of the raw value in reservations/audit (email, idempotency key, external ref) — has a domain
 * separator so values of different kinds do not collide, and keeps raw values out of logs/evidence
 */
export function platformIdentityHash(kind: string, value: string): string {
  return sha256(`dcontact-platform|${kind}|${value}`);
}

/** digest of the canonical payload — keys are sorted deterministically so it does not depend on the field order the client sent */
export function provisioningPayloadDigest(request: CanonicalProvisioningRequest): string {
  const ordered = Object.fromEntries(
    Object.entries(request).sort(([left], [right]) => left.localeCompare(right)),
  );
  return sha256(JSON.stringify(ordered));
}
