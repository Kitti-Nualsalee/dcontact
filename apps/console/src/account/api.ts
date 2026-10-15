/**
 * AC5 (#598): Console client ของ `/api/v1/me/account/*` (ทุก role) และ `/api/v1/tenant/account-policy` (admin)
 *
 * ผู้ใช้และ tenant มาจาก bearer token ที่ gateway ตรวจแล้ว — ไม่มี user id ใน path/body
 */

export type EmailChangePolicy = 'VERIFY' | 'IMMEDIATE' | 'ADMIN_ONLY';

export interface OtpDevice {
  id: string;
  label: string;
  createdAt: string | null;
}

export interface AccountView {
  firstName: string;
  lastName: string;
  email: string;
  pendingEmail: string | null;
  mfa: { enrolled: boolean; required: boolean; devices: OtpDevice[] };
  policy: { emailChange: EmailChangePolicy };
}

export interface PasswordRule {
  rule: string;
  value?: number;
}

export interface TotpEnrolment {
  enrolmentId: string;
  otpauthUri: string;
  secret: string;
  expiresAt: string;
}

export interface AccountPolicy {
  emailChange: EmailChangePolicy;
  mfaRequired: boolean;
  revision: number;
  updatedAt: string | null;
}

export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly details: {
      field?: string;
      reason?: string;
      rules?: PasswordRule[];
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(code ?? `account API failed with HTTP ${status}`);
    this.name = 'AccountApiError';
  }
}

export interface AccountApi {
  get(): Promise<AccountView>;
  updateProfile(input: { firstName: string; lastName: string }): Promise<void>;
  changePassword(newPassword: string): Promise<void>;
  requestEmailChange(
    newEmail: string,
  ): Promise<
    | { status: 'PENDING'; pendingEmail: string; expiresAt: string }
    | { status: 'CHANGED'; email: string }
  >;
  confirmEmailChange(token: string): Promise<{ email: string }>;
  cancelEmailChange(): Promise<void>;
  startTotp(): Promise<TotpEnrolment>;
  confirmTotp(enrolmentId: string, input: { code: string; label: string }): Promise<void>;
  removeTotp(credentialId: string): Promise<void>;
}

export interface AccountPolicyApi {
  get(): Promise<AccountPolicy>;
  update(input: {
    emailChange: EmailChangePolicy;
    mfaRequired: boolean;
    reason: string;
    expectedRevision: number;
  }): Promise<AccountPolicy>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function client(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}) {
  const request = input.fetch ?? globalThis.fetch;
  return async <T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> => {
    const token = input.accessToken();
    if (!token) throw new AccountApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await request(`${input.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AccountApiError(0, 'NETWORK');
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        { code?: string; field?: string; reason?: string; rules?: PasswordRule[] } | undefined;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new AccountApiError(response.status, payload?.code, {
        ...(payload?.field ? { field: payload.field } : {}),
        ...(payload?.reason ? { reason: payload.reason } : {}),
        ...(Array.isArray(payload?.rules) ? { rules: payload.rules } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      });
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
}

const ACCOUNT = '/api/v1/me/account';

export function createAccountApi(input: Parameters<typeof client>[0]): AccountApi {
  const call = client(input);
  return {
    get: () => call<AccountView>(ACCOUNT),
    updateProfile: (body) => call<void>(`${ACCOUNT}/profile`, 'PATCH', body),
    changePassword: (newPassword) => call<void>(`${ACCOUNT}/password`, 'POST', { newPassword }),
    requestEmailChange: (newEmail) => call(`${ACCOUNT}/email-change`, 'POST', { newEmail }),
    confirmEmailChange: (token) => call(`${ACCOUNT}/email-change/confirm`, 'POST', { token }),
    cancelEmailChange: () => call<void>(`${ACCOUNT}/email-change`, 'DELETE'),
    startTotp: () => call<TotpEnrolment>(`${ACCOUNT}/mfa/totp/enrolments`, 'POST'),
    confirmTotp: (enrolmentId, body) =>
      call<void>(
        `${ACCOUNT}/mfa/totp/enrolments/${encodeURIComponent(enrolmentId)}/confirm`,
        'POST',
        body,
      ),
    removeTotp: (credentialId) =>
      call<void>(`${ACCOUNT}/mfa/totp/${encodeURIComponent(credentialId)}`, 'DELETE'),
  };
}

export function createAccountPolicyApi(input: Parameters<typeof client>[0]): AccountPolicyApi {
  const call = client(input);
  return {
    get: () => call<AccountPolicy>('/api/v1/tenant/account-policy'),
    update: (body) => call<AccountPolicy>('/api/v1/tenant/account-policy', 'PUT', body),
  };
}
