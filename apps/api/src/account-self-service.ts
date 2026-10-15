/**
 * Owner: IAM — self-service บัญชีของผู้ใช้ทุก role (AC4 #597, Phase Contract #589, ADR-033)
 *
 * - เป้าหมายมาจาก token เท่านั้น: `dc_user_id` + tenant → แถว `users` (RLS) → `keycloak_id`
 *   ไม่รับ user id จาก body/path
 * - ทุกการเปลี่ยนทำใน transaction ของ tenant พร้อม advisory lock ต่อผู้ใช้ และเรียกระบบ identity เป็นขั้นสุดท้าย
 *   ก่อน commit: identity ล้ม = transaction ถูกยกเลิก (ไม่มี audit/email/แถวค้าง) ซึ่งเป็น compensation ของ
 *   saga ตาม iam-architecture §7; identity สำเร็จแต่ commit ล้ม (หายาก) = identity นำหน้า DB จนกว่าจะทำซ้ำ
 * - `users.display_name` เป็นแหล่งจริงของชื่อ แล้ว push ไป Keycloak; email ถูก sync ทั้ง `users.email` และ Keycloak
 * - email แจ้งเตือน/ยืนยันเข้า outbox ของ AC3 ใน transaction เดียวกัน; audit ไม่มีรหัสผ่าน/secret/token/email
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { enqueueAccountEmail } from './account-email.js';
import {
  AccountError,
  AccountSecretBox,
  generateTotpSecret,
  otpauthUri,
  type AccountIdentityPort,
  type OtpDevice,
} from './account-identity.js';
import { readAccountPolicy } from './account-policy.js';
import { TenantClientRateLimiter } from './tenant-client-rate-limiter.js';

type Tx = Prisma.TransactionClient;

export interface AccountActor {
  tenantId: string;
  userId: string;
}

export interface AccountView {
  firstName: string;
  lastName: string;
  email: string;
  pendingEmail: string | null;
  mfa: { enrolled: boolean; required: boolean; devices: OtpDevice[] };
  policy: { emailChange: 'VERIFY' | 'IMMEDIATE' | 'ADMIN_ONLY' };
}

export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
export const TOTP_ENROLMENT_TTL_MS = 10 * 60 * 1000;
export const TOTP_MAX_ATTEMPTS = 5;
const HOUR = 60 * 60 * 1000;
export const RATE_LIMITS = {
  password: { limit: 5, windowMs: HOUR },
  emailChange: { limit: 3, windowMs: HOUR },
} as const;

type AuditAction =
  | 'password.changed'
  | 'email.change.requested'
  | 'email.change.confirmed'
  | 'email.change.cancelled'
  | 'profile.updated'
  | 'mfa.enrolled'
  | 'mfa.removed';

export interface AccountSelfServiceOptions {
  now?: () => Date;
  limiter?: TenantClientRateLimiter;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const NAME_MAX = 100;
const PASSWORD_MAX = 256;
const LABEL_MAX = 64;

const invalid = (field: string, reason: 'REQUIRED' | 'INVALID' | 'SAME' | 'DUPLICATE') =>
  new AccountError('VALIDATION_FAILED', { field, reason });

function requiredText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null || value === '') throw invalid(field, 'REQUIRED');
  if (typeof value !== 'string') throw invalid(field, 'INVALID');
  const trimmed = value.trim();
  if (trimmed.length < 1) throw invalid(field, 'REQUIRED');
  if (trimmed.length > max || /[\u0000-\u001f\u007f]/.test(trimmed))
    throw invalid(field, 'INVALID');
  return trimmed;
}

function emailOf(value: unknown): string {
  const email = requiredText(value, 'newEmail', 320).toLowerCase();
  if (!EMAIL.test(email)) throw invalid('newEmail', 'INVALID');
  return email;
}

export const tokenHash = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export class AccountSelfService {
  private readonly now: () => Date;
  private readonly limiter: TenantClientRateLimiter;

  constructor(
    private readonly database: PrismaClient,
    private readonly identity: AccountIdentityPort,
    private readonly secrets: AccountSecretBox,
    options: AccountSelfServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new TenantClientRateLimiter(this.now);
  }

  // ── อ่าน ──

  async get(actor: AccountActor): Promise<AccountView> {
    const { identityId, policy, pending } = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (tx) => {
        const identityId = await this.identityIdOf(tx, actor);
        const pending = await tx.accountEmailChange.findFirst({
          where: {
            tenantId: actor.tenantId,
            userId: actor.userId,
            status: 'PENDING',
            expiresAt: { gt: this.now() },
          },
          select: { newEmail: true },
        });
        return { identityId, policy: await readAccountPolicy(tx, actor.tenantId), pending };
      },
    );
    const [user, devices] = await Promise.all([
      this.identity.getUser(identityId),
      this.identity.otpDevices(identityId),
    ]);
    return {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      pendingEmail: pending?.newEmail ?? null,
      mfa: { enrolled: devices.length > 0, required: policy.mfaRequired, devices },
      policy: { emailChange: policy.emailChange },
    };
  }

  // ── ชื่อ ──

  async updateProfile(
    actor: AccountActor,
    input: { firstName?: unknown; lastName?: unknown },
    correlationId: string,
  ): Promise<{ firstName: string; lastName: string }> {
    const firstName = requiredText(input.firstName, 'firstName', NAME_MAX);
    const lastName = requiredText(input.lastName, 'lastName', NAME_MAX);
    await this.mutate(actor, async (tx, identityId) => {
      await tx.user.update({
        where: { id: actor.userId },
        data: { displayName: `${firstName} ${lastName}` },
      });
      await this.audit(tx, actor, 'profile.updated', correlationId);
      await this.identity.updateUser(identityId, { firstName, lastName });
    });
    return { firstName, lastName };
  }

  // ── รหัสผ่าน (D4: ไม่ถามรหัสเดิม + email แจ้ง) ──

  async changePassword(
    actor: AccountActor,
    input: { newPassword?: unknown },
    correlationId: string,
  ): Promise<void> {
    const password = input.newPassword;
    if (password === undefined || password === null || password === '') {
      throw invalid('newPassword', 'REQUIRED');
    }
    if (typeof password !== 'string' || password.length > PASSWORD_MAX) {
      throw invalid('newPassword', 'INVALID');
    }
    this.rateLimit(actor, 'password');
    await this.mutate(actor, async (tx, identityId) => {
      const user = await this.identity.getUser(identityId);
      await this.audit(tx, actor, 'password.changed', correlationId);
      if (user.email) {
        await enqueueAccountEmail(tx, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          template: 'password-changed-notice',
          locale: user.locale,
          recipient: user.email,
          variables: { changedAt: this.now().toISOString() },
          dedupeKey: `password-changed:${actor.userId}:${randomUUID()}`,
        });
      }
      await this.identity.resetPassword(identityId, password);
    });
  }

  // ── email ──

  async requestEmailChange(
    actor: AccountActor,
    input: { newEmail?: unknown },
    correlationId: string,
  ): Promise<
    | { status: 'PENDING'; pendingEmail: string; expiresAt: string }
    | { status: 'CHANGED'; email: string }
  > {
    const newEmail = emailOf(input.newEmail);
    this.rateLimit(actor, 'emailChange');
    return this.mutate(actor, async (tx, identityId) => {
      const policy = await readAccountPolicy(tx, actor.tenantId);
      if (policy.emailChange === 'ADMIN_ONLY') throw new AccountError('EMAIL_CHANGE_NOT_ALLOWED');
      const user = await this.identity.getUser(identityId);
      if (user.email.toLowerCase() === newEmail) throw invalid('newEmail', 'SAME');
      await this.assertEmailFree(tx, actor, identityId, newEmail);
      const now = this.now();
      await tx.accountEmailChange.updateMany({
        where: { tenantId: actor.tenantId, userId: actor.userId, status: 'PENDING' },
        data: { status: 'CANCELLED', completedAt: now },
      });

      if (policy.emailChange === 'IMMEDIATE') {
        await this.applyEmail(tx, actor, identityId, user, newEmail, correlationId, 'IMMEDIATE');
        return { status: 'CHANGED' as const, email: newEmail };
      }

      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_TTL_MS);
      await tx.accountEmailChange.create({
        data: {
          id,
          tenantId: actor.tenantId,
          userId: actor.userId,
          newEmail,
          tokenHash: tokenHash(token),
          status: 'PENDING',
          requestedAt: now,
          expiresAt,
        },
      });
      await this.audit(tx, actor, 'email.change.requested', correlationId, { changeId: id });
      await enqueueAccountEmail(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        template: 'verify-new-email',
        locale: user.locale,
        recipient: newEmail,
        variables: { token, expiresInMinutes: EMAIL_CHANGE_TTL_MS / 60_000 },
        dedupeKey: `email-change:${id}:verify`,
      });
      return {
        status: 'PENDING' as const,
        pendingEmail: newEmail,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  async confirmEmailChange(
    actor: AccountActor,
    input: { token?: unknown },
    correlationId: string,
  ): Promise<{ email: string }> {
    if (typeof input.token !== 'string' || input.token.length < 1 || input.token.length > 512) {
      throw invalid('token', input.token ? 'INVALID' : 'REQUIRED');
    }
    const hash = tokenHash(input.token);
    const result = await this.mutate(actor, async (tx, identityId) => {
      const change = await tx.accountEmailChange.findFirst({
        where: {
          tenantId: actor.tenantId,
          userId: actor.userId,
          tokenHash: hash,
          status: 'PENDING',
        },
      });
      // ไม่บอกว่า token ไม่มี, ใช้แล้ว หรือหมดอายุ — ตอบแบบเดียวกันหมด
      if (!change) return 'EXPIRED' as const;
      const now = this.now();
      if (change.expiresAt <= now) {
        await tx.accountEmailChange.update({
          where: { id: change.id },
          data: { status: 'EXPIRED', completedAt: now },
        });
        return 'EXPIRED' as const;
      }
      const policy = await readAccountPolicy(tx, actor.tenantId);
      if (policy.emailChange === 'ADMIN_ONLY') throw new AccountError('EMAIL_CHANGE_NOT_ALLOWED');
      const user = await this.identity.getUser(identityId);
      await this.assertEmailFree(tx, actor, identityId, change.newEmail);
      await tx.accountEmailChange.update({
        where: { id: change.id },
        data: { status: 'CONFIRMED', completedAt: now },
      });
      await this.applyEmail(
        tx,
        actor,
        identityId,
        user,
        change.newEmail,
        correlationId,
        'VERIFIED',
        {
          changeId: change.id,
        },
      );
      return { email: change.newEmail };
    });
    if (result === 'EXPIRED') throw new AccountError('EMAIL_CHANGE_EXPIRED');
    return result;
  }

  async cancelEmailChange(actor: AccountActor, correlationId: string): Promise<void> {
    await withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      await this.identityIdOf(tx, actor);
      await this.lock(tx, actor);
      const cancelled = await tx.accountEmailChange.updateMany({
        where: { tenantId: actor.tenantId, userId: actor.userId, status: 'PENDING' },
        data: { status: 'CANCELLED', completedAt: this.now() },
      });
      if (cancelled.count > 0) {
        await this.audit(tx, actor, 'email.change.cancelled', correlationId);
      }
    });
  }

  // ── TOTP ──

  async startTotpEnrolment(
    actor: AccountActor,
  ): Promise<{ enrolmentId: string; otpauthUri: string; secret: string; expiresAt: string }> {
    const secret = generateTotpSecret();
    const id = randomUUID();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + TOTP_ENROLMENT_TTL_MS);
    const identityId = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (tx) => {
        const identityId = await this.identityIdOf(tx, actor);
        await this.lock(tx, actor);
        // ลงทะเบียนค้างได้ทีละรายการ — เริ่มใหม่ = ทิ้งของเดิม
        await tx.accountTotpEnrolment.deleteMany({
          where: { tenantId: actor.tenantId, userId: actor.userId },
        });
        await tx.accountTotpEnrolment.create({
          data: {
            id,
            tenantId: actor.tenantId,
            userId: actor.userId,
            secretCiphertext: this.secrets.seal(secret, this.secretContext(actor, id)),
            createdAt: now,
            expiresAt,
          },
        });
        return identityId;
      },
    );
    const user = await this.identity.getUser(identityId);
    const uri = otpauthUri(secret, user.email || 'D-Contact');
    return {
      enrolmentId: id,
      otpauthUri: uri,
      secret: new URL(uri).searchParams.get('secret')!,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async confirmTotpEnrolment(
    actor: AccountActor,
    enrolmentId: string,
    input: { code?: unknown; label?: unknown },
    correlationId: string,
  ): Promise<{ credentialId: string }> {
    if (typeof input.code !== 'string' || !/^\d{6,8}$/.test(input.code)) {
      throw invalid('code', input.code ? 'INVALID' : 'REQUIRED');
    }
    const code = input.code;
    const label = requiredText(input.label, 'label', LABEL_MAX);
    // นับครั้งที่ลองแล้ว commit ก่อนเรียก identity — code ผิดก็ยังถูกนับ
    const claim = await withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      const identityId = await this.identityIdOf(tx, actor);
      await this.lock(tx, actor);
      const enrolment = await tx.accountTotpEnrolment.findFirst({
        where: { id: enrolmentId, tenantId: actor.tenantId, userId: actor.userId },
      });
      if (!enrolment) return 'EXPIRED' as const;
      if (enrolment.expiresAt <= this.now()) {
        await tx.accountTotpEnrolment.delete({ where: { id: enrolment.id } });
        return 'EXPIRED' as const;
      }
      if (enrolment.attempts >= TOTP_MAX_ATTEMPTS) return 'LIMITED' as const;
      await tx.accountTotpEnrolment.update({
        where: { id: enrolment.id },
        data: { attempts: { increment: 1 } },
      });
      return {
        identityId,
        secret: this.secrets.open(
          enrolment.secretCiphertext,
          this.secretContext(actor, enrolment.id),
        ),
      };
    });
    if (claim === 'EXPIRED') throw new AccountError('ENROLMENT_EXPIRED');
    if (claim === 'LIMITED') throw new AccountError('RATE_LIMITED');

    const created = await this.identity.createTotp({
      identityId: claim.identityId,
      tenantId: actor.tenantId,
      secret: claim.secret,
      code,
      label,
    });
    if (created === 'INVALID_CODE') throw new AccountError('INVALID_OTP_CODE');
    if (created === 'LABEL_IN_USE') throw invalid('label', 'DUPLICATE');
    await withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      await tx.accountTotpEnrolment.deleteMany({
        where: { id: enrolmentId, tenantId: actor.tenantId, userId: actor.userId },
      });
      await this.audit(tx, actor, 'mfa.enrolled', correlationId, {
        credentialId: created.credentialId,
      });
    });
    return created;
  }

  async removeTotpDevice(
    actor: AccountActor,
    credentialId: string,
    correlationId: string,
  ): Promise<void> {
    await this.mutate(actor, async (tx, identityId) => {
      const devices = await this.identity.otpDevices(identityId);
      if (!devices.some((device) => device.id === credentialId)) {
        throw new AccountError('DEVICE_NOT_FOUND');
      }
      const policy = await readAccountPolicy(tx, actor.tenantId);
      if (policy.mfaRequired && devices.length <= 1) {
        throw new AccountError('MFA_REQUIRED_LAST_DEVICE');
      }
      await this.audit(tx, actor, 'mfa.removed', correlationId, { credentialId });
      await this.identity.deleteCredential(identityId, credentialId);
    });
  }

  // ── ภายใน ──

  /** transaction ของ tenant + lock ต่อผู้ใช้; งานใน `work` เรียก identity เป็นขั้นสุดท้าย */
  private mutate<T>(actor: AccountActor, work: (tx: Tx, identityId: string) => Promise<T>) {
    return withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (tx) => {
        const identityId = await this.identityIdOf(tx, actor);
        await this.lock(tx, actor);
        return work(tx, identityId);
      },
      { timeout: 15_000 },
    );
  }

  private async lock(tx: Tx, actor: AccountActor) {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`account:${actor.tenantId}:${actor.userId}`}))`,
    );
  }

  /** ผู้ใช้ของ token ใน tenant ของ token (RLS) — ไม่มีหรือยังไม่ผูกกับระบบ identity = ใช้งานไม่ได้ */
  private async identityIdOf(tx: Tx, actor: AccountActor): Promise<string> {
    const user = await tx.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, isActive: true },
      select: { keycloakId: true },
    });
    if (!user?.keycloakId) throw new AccountError('IDENTITY_UNAVAILABLE');
    return user.keycloakId;
  }

  private async assertEmailFree(tx: Tx, actor: AccountActor, identityId: string, email: string) {
    const local = await tx.user.findFirst({
      where: {
        tenantId: actor.tenantId,
        email: { equals: email, mode: 'insensitive' },
        NOT: { id: actor.userId },
      },
      select: { id: true },
    });
    if (local || (await this.identity.emailInUse(email, identityId))) {
      throw new AccountError('EMAIL_IN_USE');
    }
  }

  /** เปลี่ยน email จริง: `users.email` → audit → แจ้ง email เดิม → identity (ขั้นสุดท้าย) */
  private async applyEmail(
    tx: Tx,
    actor: AccountActor,
    identityId: string,
    user: { email: string; locale: 'th' | 'en' },
    newEmail: string,
    correlationId: string,
    mode: 'IMMEDIATE' | 'VERIFIED',
    metadata: Record<string, string> = {},
  ) {
    try {
      await tx.user.update({ where: { id: actor.userId }, data: { email: newEmail } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AccountError('EMAIL_IN_USE');
      }
      throw error;
    }
    await this.audit(tx, actor, 'email.change.confirmed', correlationId, { mode, ...metadata });
    if (user.email) {
      await enqueueAccountEmail(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        template: 'email-changed-notice',
        locale: user.locale,
        recipient: user.email,
        variables: { newEmail, changedAt: this.now().toISOString() },
        dedupeKey: `email-changed:${actor.userId}:${randomUUID()}`,
      });
    }
    await this.identity.updateUser(identityId, { email: newEmail, emailVerified: true });
  }

  private async audit(
    tx: Tx,
    actor: AccountActor,
    action: AuditAction,
    correlationId: string,
    metadata?: Record<string, string>,
  ) {
    await tx.accountAuditEvent.create({
      data: {
        id: randomUUID(),
        tenantId: actor.tenantId,
        userId: actor.userId,
        action,
        ...(metadata ? { metadata } : {}),
        correlationId,
        occurredAt: this.now(),
      },
    });
  }

  private rateLimit(actor: AccountActor, kind: keyof typeof RATE_LIMITS) {
    const { limit, windowMs } = RATE_LIMITS[kind];
    const limited = this.limiter.consume({
      tenantId: actor.tenantId,
      clientId: `account:${actor.userId}:${kind}`,
      limitPerMinute: limit,
      windowMs,
    });
    if (limited)
      throw new AccountError('RATE_LIMITED', { retryAfterSeconds: limited.retryAfterSeconds });
  }

  private secretContext(actor: AccountActor, enrolmentId: string) {
    return `totp:${actor.tenantId}:${actor.userId}:${enrolmentId}`;
  }
}
