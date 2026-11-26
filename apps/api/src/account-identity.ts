/**
 * Owner: IAM — the part of account self-service that talks to the identity system (AC4 #597, #589, ADR-033)
 *
 * - `KeycloakAccountIdentity`: the user Admin REST + the `dc-account` extension through the service account
 *   `dcontact-account-service` — Keycloak errors are mapped to D-Contact codes and the raw message is not passed on
 * - `AccountSecretBox`: encrypts the not-yet-confirmed TOTP secret with AES-256-GCM (the key from the API's env)
 * - TOTP secret: random the same way as Keycloak (20 letters/digits, stored as characters) and the QR uses the Base32 of the bytes
 */
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { AccountPolicyError } from './account-policy.js';
import type { KeycloakAccountServiceClient } from './keycloak-account-service.js';

export type AccountErrorCode =
  | 'VALIDATION_FAILED'
  | 'PASSWORD_POLICY_VIOLATION'
  | 'EMAIL_IN_USE'
  | 'EMAIL_CHANGE_NOT_ALLOWED'
  | 'EMAIL_CHANGE_EXPIRED'
  | 'INVALID_OTP_CODE'
  | 'ENROLMENT_EXPIRED'
  | 'MFA_REQUIRED_LAST_DEVICE'
  | 'DEVICE_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'IDENTITY_UNAVAILABLE';

export type PasswordRule =
  | 'MIN_LENGTH'
  | 'MAX_LENGTH'
  | 'DIGITS'
  | 'LOWER_CASE'
  | 'UPPER_CASE'
  | 'SPECIAL_CHARS'
  | 'NOT_USERNAME'
  | 'NOT_EMAIL'
  | 'PATTERN'
  | 'HISTORY'
  | 'BLACKLISTED'
  | 'OTHER';

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'AccountError';
  }
}

export interface IdentityUser {
  firstName: string;
  lastName: string;
  email: string;
  /** the locale the user chose (`th`/`en`) — used to choose the email language */
  locale: 'th' | 'en';
}

export interface OtpDevice {
  id: string;
  label: string;
  createdAt: string | null;
}

export interface AccountIdentityPort {
  getUser(identityId: string): Promise<IdentityUser>;
  updateUser(
    identityId: string,
    patch: { firstName?: string; lastName?: string; email?: string; emailVerified?: boolean },
  ): Promise<void>;
  resetPassword(identityId: string, password: string): Promise<void>;
  emailInUse(email: string, exceptIdentityId: string): Promise<boolean>;
  otpDevices(identityId: string): Promise<OtpDevice[]>;
  deleteCredential(identityId: string, credentialId: string): Promise<void>;
  createTotp(input: {
    identityId: string;
    tenantId: string;
    secret: string;
    code: string;
    label: string;
  }): Promise<{ credentialId: string } | 'INVALID_CODE' | 'LABEL_IN_USE'>;
}

const unavailable = () => new AccountError('IDENTITY_UNAVAILABLE');

/** the password policy error key in Keycloak → a rule the web page can translate (no raw message passed on) */
const PASSWORD_RULES: Record<string, PasswordRule> = {
  invalidPasswordMinLengthMessage: 'MIN_LENGTH',
  invalidPasswordMaxLengthMessage: 'MAX_LENGTH',
  invalidPasswordMinDigitsMessage: 'DIGITS',
  invalidPasswordMinLowerCaseCharsMessage: 'LOWER_CASE',
  invalidPasswordMinUpperCaseCharsMessage: 'UPPER_CASE',
  invalidPasswordMinSpecialCharsMessage: 'SPECIAL_CHARS',
  invalidPasswordNotUsernameMessage: 'NOT_USERNAME',
  invalidPasswordNotContainsUsernameMessage: 'NOT_USERNAME',
  invalidPasswordNotEmailMessage: 'NOT_EMAIL',
  invalidPasswordRegexPatternMessage: 'PATTERN',
  invalidPasswordHistoryMessage: 'HISTORY',
  invalidPasswordBlacklistedMessage: 'BLACKLISTED',
};

/** Keycloak's `{ error, error_description }` → `rules[]`; not a policy error = `undefined` */
export function passwordRulesOf(
  body: unknown,
): Array<{ rule: PasswordRule; value?: number }> | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error !== 'string' || !error.startsWith('invalidPassword')) return undefined;
  const description = (body as { error_description?: unknown }).error_description;
  const value =
    typeof description === 'string' ? Number(/(\d+)/.exec(description)?.[1] ?? NaN) : NaN;
  const rule = PASSWORD_RULES[error] ?? 'OTHER';
  return [Number.isInteger(value) && rule !== 'OTHER' ? { rule, value } : { rule }];
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export class KeycloakAccountIdentity implements AccountIdentityPort {
  constructor(private readonly client: KeycloakAccountServiceClient) {}

  private async admin(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    try {
      return await this.client.admin(method, path, body);
    } catch (error) {
      if (error instanceof AccountPolicyError) throw unavailable();
      throw error;
    }
  }

  async getUser(identityId: string): Promise<IdentityUser> {
    const { status, body } = await this.admin('GET', `users/${encodeURIComponent(identityId)}`);
    if (status !== 200) throw unavailable();
    const user = body as {
      firstName?: unknown;
      lastName?: unknown;
      email?: unknown;
      attributes?: Record<string, unknown>;
    };
    const locale = (user.attributes?.locale as unknown[] | undefined)?.[0];
    return {
      firstName: text(user.firstName),
      lastName: text(user.lastName),
      email: text(user.email),
      locale: locale === 'en' ? 'en' : 'th',
    };
  }

  async updateUser(
    identityId: string,
    patch: { firstName?: string; lastName?: string; email?: string; emailVerified?: boolean },
  ): Promise<void> {
    // a partial-field PUT: Keycloak keeps the other attributes (tenant_id, dc_user_id)
    const { status } = await this.admin('PUT', `users/${encodeURIComponent(identityId)}`, patch);
    if (status === 409) throw new AccountError('EMAIL_IN_USE');
    if (status !== 204) throw unavailable();
  }

  async resetPassword(identityId: string, password: string): Promise<void> {
    const { status, body } = await this.admin(
      'PUT',
      `users/${encodeURIComponent(identityId)}/reset-password`,
      { type: 'password', value: password, temporary: false },
    );
    if (status === 204) return;
    const rules = status === 400 ? passwordRulesOf(body) : undefined;
    if (rules) throw new AccountError('PASSWORD_POLICY_VIOLATION', { rules });
    throw unavailable();
  }

  async emailInUse(email: string, exceptIdentityId: string): Promise<boolean> {
    const { status, body } = await this.admin(
      'GET',
      `users?${new URLSearchParams({ email, exact: 'true', briefRepresentation: 'true' })}`,
    );
    if (status !== 200 || !Array.isArray(body)) throw unavailable();
    return body.some(
      (user: { id?: unknown; email?: unknown }) =>
        user.id !== exceptIdentityId && text(user.email).toLowerCase() === email.toLowerCase(),
    );
  }

  async otpDevices(identityId: string): Promise<OtpDevice[]> {
    const { status, body } = await this.admin(
      'GET',
      `users/${encodeURIComponent(identityId)}/credentials`,
    );
    if (status !== 200 || !Array.isArray(body)) throw unavailable();
    return body
      .filter((credential: { type?: unknown }) => credential.type === 'otp')
      .map((credential: { id?: unknown; userLabel?: unknown; createdDate?: unknown }) => ({
        id: text(credential.id),
        label: text(credential.userLabel),
        createdAt:
          typeof credential.createdDate === 'number'
            ? new Date(credential.createdDate).toISOString()
            : null,
      }));
  }

  async deleteCredential(identityId: string, credentialId: string): Promise<void> {
    const { status } = await this.admin(
      'DELETE',
      `users/${encodeURIComponent(identityId)}/credentials/${encodeURIComponent(credentialId)}`,
    );
    if (status === 404) throw new AccountError('DEVICE_NOT_FOUND');
    if (status !== 204) throw unavailable();
  }

  async createTotp(input: {
    identityId: string;
    tenantId: string;
    secret: string;
    code: string;
    label: string;
  }): Promise<{ credentialId: string } | 'INVALID_CODE' | 'LABEL_IN_USE'> {
    let result: { status: number; body: unknown };
    try {
      result = await this.client.extension(
        'POST',
        `users/${encodeURIComponent(input.identityId)}/totp/verify-and-create`,
        { tenantId: input.tenantId, secret: input.secret, code: input.code, label: input.label },
      );
    } catch (error) {
      if (error instanceof AccountPolicyError) throw unavailable();
      throw error;
    }
    const code = (result.body as { code?: unknown; credentialId?: unknown } | undefined) ?? {};
    if (result.status === 201 && typeof code.credentialId === 'string') {
      return { credentialId: code.credentialId };
    }
    if (result.status === 400 && code.code === 'INVALID_OTP_CODE') return 'INVALID_CODE';
    if (result.status === 409 && code.code === 'LABEL_IN_USE') return 'LABEL_IN_USE';
    throw unavailable();
  }
}

// ── TOTP secret ──

const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** the raw secret the way Keycloak generates it itself (`HmacOTP.generateSecret(20)`) — Keycloak stores it as characters like this */
export function generateTotpSecret(length = 20): string {
  return Array.from({ length }, () => SECRET_ALPHABET[randomInt(SECRET_ALPHABET.length)]).join('');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 with no padding — the format authenticator apps accept */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/**
 * must match the realm's OTP policy (`totp`, HmacSHA1, 6 digits, 30 seconds — the Keycloak default for both dev/UAT)
 * the extension checks the code with the realm's policy every time; if the values do not match the user cannot confirm (no wrong credential is created)
 */
export function otpauthUri(secret: string, account: string): string {
  const label = `${encodeURIComponent('D-Contact')}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32(Buffer.from(secret, 'utf8')),
    issuer: 'D-Contact',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params}`;
}

/** AES-256-GCM: `v1.<iv>.<tag>.<ciphertext>` (base64url) — a 32-byte key from `ACCOUNT_SECRET_KEY` (base64) */
export class AccountSecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32)
      throw new TypeError('ACCOUNT_SECRET_KEY must be the base64 of 32 bytes');
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // bind the ciphertext to the owner (tenant/user/enrolment) — moved to another row it cannot be decrypted
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  open(sealed: string, context: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw unavailable();
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw unavailable();
    }
  }
}
