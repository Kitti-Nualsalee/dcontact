/**
 * Owner: IAM — email บัญชีของ D-Contact: outbox + ตัวส่ง SMTP (AC3 #596, #589, ADR-033)
 *
 * - ผู้เรียก (AC4) เรียก `enqueueAccountEmail` ใน transaction ของ tenant เดียวกับการเปลี่ยนบัญชี
 *   — `dedupeKey` ซ้ำไม่เพิ่มแถว (เรียกซ้ำได้ ไม่ซ้ำผล)
 * - `AccountEmailDispatcher` จองทีละแถวด้วย lease (`SENDING`) แล้วส่งนอก transaction
 *   - ล้มชั่วคราว (เครือข่าย, 4xx) = retry แบบ exponential backoff สูงสุด `maxAttempts` ครั้ง
 *   - ล้มถาวร (5xx เช่นผู้รับนอกองค์กรบน M365 direct send, template ผิด) = `DEAD` ทันที
 *   - process ตายระหว่างส่ง = lease หมดแล้วแถวถูกจองใหม่ (at-least-once) — `Message-ID` คงที่ต่อแถว
 *     ให้ปลายทางตัดฉบับซ้ำได้
 * - จบแล้ว (`SENT`/`DEAD`) ล้างผู้รับและตัวแปร (token ยืนยัน) ออกจากแถว
 * - log มีแค่ id/template/สถานะ/รหัส error — ไม่มีอีเมล, token หรือข้อความจาก SMTP server
 */
import { randomUUID } from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  ACCOUNT_EMAIL_LOCALES,
  ACCOUNT_EMAIL_TEMPLATES,
  AccountEmailTemplateError,
  assertAccountEmailVariables,
  renderAccountEmail,
  type AccountEmailLocale,
  type AccountEmailTemplate,
  type AccountEmailVariables,
  type RenderedEmail,
} from './account-email-templates.js';

export const ACCOUNT_EMAIL_SENDER_NAME = 'D-Contact';

// ── SMTP ──

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS ตั้งแต่ต้น (465); false = plain แล้ว STARTTLS ถ้า server รองรับ */
  secure: boolean;
  user?: string;
  password?: string;
  /** ที่อยู่ผู้ส่ง — ชื่อที่แสดงเป็น "D-Contact" เสมอ (#589 Q2) */
  fromAddress: string;
  /** ชื่อ host ที่ประกาศใน EHLO/HELO (M365 direct send ใช้ domain ขององค์กร) */
  helo?: string;
}

export class AccountEmailConfigError extends Error {
  constructor(readonly variable: string) {
    super(`ค่า ${variable} ไม่ถูกต้อง`);
    this.name = 'AccountEmailConfigError';
  }
}

/** `"D-Contact" <no-reply@x>` หรือ `no-reply@x` → `no-reply@x` */
export function fromAddressOf(value: string): string {
  const address = (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(address)) throw new AccountEmailConfigError('SMTP_FROM');
  return address;
}

/** `undefined` = ไม่ได้ตั้ง SMTP (ไม่เปิดตัวส่ง) */
export function smtpConfigFromEnvironment(
  environment: Record<string, string | undefined>,
): SmtpConfig | undefined {
  const host = environment.SMTP_HOST?.trim();
  if (!host) return undefined;
  const port = Number(environment.SMTP_PORT ?? '25');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AccountEmailConfigError('SMTP_PORT');
  }
  const secure = (environment.SMTP_SECURE ?? 'false').trim().toLowerCase();
  if (secure !== 'true' && secure !== 'false') throw new AccountEmailConfigError('SMTP_SECURE');
  const user = environment.SMTP_USER?.trim() || undefined;
  const password = environment.SMTP_PASSWORD || undefined;
  if (Boolean(user) !== Boolean(password)) throw new AccountEmailConfigError('SMTP_PASSWORD');
  return {
    host,
    port,
    secure: secure === 'true',
    ...(user ? { user, password } : {}),
    fromAddress: fromAddressOf(environment.SMTP_FROM ?? ''),
    ...(environment.SMTP_HELO?.trim() ? { helo: environment.SMTP_HELO.trim() } : {}),
  };
}

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  messageId: string;
}

/** ล้มส่ง — `permanent` = ส่งซ้ำไม่มีประโยชน์ (SMTP 5xx) */
export class EmailSendError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
    this.name = 'EmailSendError';
  }
}

export interface EmailSender {
  send(email: OutgoingEmail): Promise<void>;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.helo ? { name: config.helo } : {}),
      ...(config.user ? { auth: { user: config.user, pass: config.password } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      logger: false,
      debug: false,
    });
  }

  async send(email: OutgoingEmail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: { name: ACCOUNT_EMAIL_SENDER_NAME, address: this.config.fromAddress },
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        messageId: email.messageId,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (error) {
      // ไม่ส่งต่อข้อความของ server/nodemailer — อาจมีอีเมลผู้รับ
      const responseCode = (error as { responseCode?: unknown }).responseCode;
      if (typeof responseCode === 'number') {
        throw new EmailSendError(
          responseCode >= 500 ? 'SMTP_REJECTED' : 'SMTP_DEFERRED',
          responseCode >= 500,
        );
      }
      throw new EmailSendError('SMTP_UNAVAILABLE', false);
    }
  }
}

// ── outbox ──

export interface EnqueueAccountEmail<T extends AccountEmailTemplate = AccountEmailTemplate> {
  tenantId: string;
  userId?: string;
  template: T;
  locale: AccountEmailLocale;
  recipient: string;
  variables: AccountEmailVariables[T];
  /** เรียกซ้ำด้วยค่าเดิม = แถวเดิม (เช่น `email-change:{changeId}:verify`) */
  dedupeKey: string;
}

/** เขียนงานส่ง email ใน transaction ของ tenant — คืน id ของแถว (ใหม่หรือเดิม) */
export async function enqueueAccountEmail<T extends AccountEmailTemplate>(
  tx: Prisma.TransactionClient,
  input: EnqueueAccountEmail<T>,
): Promise<{ id: string; created: boolean }> {
  if (!(ACCOUNT_EMAIL_TEMPLATES as readonly string[]).includes(input.template)) {
    throw new AccountEmailTemplateError('INVALID_TEMPLATE');
  }
  if (!(ACCOUNT_EMAIL_LOCALES as readonly string[]).includes(input.locale)) {
    throw new AccountEmailTemplateError('INVALID_LOCALE');
  }
  assertAccountEmailVariables(input.template, input.variables);
  if (!/^[^\s@]+@[^\s@]+$/.test(input.recipient) || input.recipient.length > 320) {
    throw new AccountEmailTemplateError('INVALID_VARIABLES');
  }
  if (input.dedupeKey.length < 1 || input.dedupeKey.length > 200) {
    throw new AccountEmailTemplateError('INVALID_VARIABLES');
  }
  const id = randomUUID();
  const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO account_email_outbox
      (id, tenant_id, user_id, template, locale, recipient, variables, dedupe_key)
    VALUES (${id}::uuid, ${input.tenantId}::uuid, ${input.userId ?? null}::uuid, ${input.template},
            ${input.locale}, ${input.recipient}, ${JSON.stringify(input.variables)}::jsonb,
            ${input.dedupeKey})
    ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
    RETURNING id
  `);
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await tx.accountEmailOutbox.findUniqueOrThrow({
    where: { tenantId_dedupeKey: { tenantId: input.tenantId, dedupeKey: input.dedupeKey } },
    select: { id: true },
  });
  return { id: existing.id, created: false };
}

// ── dispatcher ──

export interface AccountEmailDispatcherOptions {
  consoleUrl: string;
  timeZone?: string;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (event: Record<string, unknown>) => void;
}

export type DispatchOutcome = 'SENT' | 'RETRY' | 'DEAD';

type ClaimedRow = {
  id: string;
  template: string;
  locale: string;
  recipient: string;
  variables: unknown;
  attempts: number;
};

export function messageIdFor(outboxId: string) {
  return `<${outboxId}@account.dcontact>`;
}

export class AccountEmailDispatcher {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly log: (event: Record<string, unknown>) => void;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly sender: EmailSender,
    private readonly options: AccountEmailDispatcherOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 3_600_000;
    this.log = options.log ?? ((event) => console.log(JSON.stringify(event)));
  }

  /** backoff ก่อนลองครั้งถัดไปหลังล้มครั้งที่ `attempts` */
  backoffMs(attempts: number) {
    return Math.min(this.baseBackoffMs * 2 ** Math.max(attempts - 1, 0), this.maxBackoffMs);
  }

  /** ส่งงานที่ถึงเวลาของ tenant หนึ่งทีละแถว — คืนผลของแต่ละแถวที่จับได้ */
  async drainTenant(tenantId: string, limit = 50): Promise<DispatchOutcome[]> {
    const outcomes: DispatchOutcome[] = [];
    for (let handled = 0; handled < limit; handled += 1) {
      const outcome = await this.dispatchNext(tenantId);
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async drainAll(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const tenants = await this.database.tenant.findMany({ select: { id: true } });
      for (const tenant of tenants) await this.drainTenant(tenant.id);
    } catch (error) {
      this.log({
        type: 'account.email.drain_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      this.draining = false;
    }
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.drainAll(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async dispatchNext(tenantId: string): Promise<DispatchOutcome | undefined> {
    const row = await this.claim(tenantId);
    if (!row) return undefined;

    let rendered: RenderedEmail;
    try {
      rendered = renderAccountEmail(row.template, row.locale, row.variables, {
        consoleUrl: this.options.consoleUrl,
        ...(this.options.timeZone ? { timeZone: this.options.timeZone } : {}),
      });
    } catch (error) {
      const code = error instanceof AccountEmailTemplateError ? error.reason : 'TEMPLATE_FAILED';
      return this.finishFailed(tenantId, row, code, true);
    }
    try {
      await this.sender.send({ ...rendered, to: row.recipient, messageId: messageIdFor(row.id) });
    } catch (error) {
      const failure =
        error instanceof EmailSendError ? error : new EmailSendError('SEND_FAILED', false);
      return this.finishFailed(tenantId, row, failure.code, failure.permanent);
    }
    await this.finish(tenantId, row, {
      status: 'SENT',
      sentAt: this.now(),
      lastErrorCode: null,
    });
    this.log({
      type: 'account.email.sent',
      tenantId,
      outboxId: row.id,
      template: row.template,
      attempts: row.attempts,
    });
    return 'SENT';
  }

  private async claim(tenantId: string): Promise<ClaimedRow | undefined> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const now = this.now();
      const [candidate] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM account_email_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND ((status = 'PENDING' AND available_at <= ${now})
            OR (status = 'SENDING' AND lease_expires_at <= ${now}))
        ORDER BY available_at, created_at, id
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
      if (!candidate) return undefined;
      const row = await tx.accountEmailOutbox.update({
        where: { id: candidate.id },
        data: {
          status: 'SENDING',
          attempts: { increment: 1 },
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        },
      });
      return {
        id: row.id,
        template: row.template,
        locale: row.locale,
        recipient: row.recipient!,
        variables: row.variables,
        attempts: row.attempts,
      };
    });
  }

  private async finishFailed(
    tenantId: string,
    row: ClaimedRow,
    code: string,
    permanent: boolean,
  ): Promise<DispatchOutcome> {
    const dead = permanent || row.attempts >= this.maxAttempts;
    if (dead) {
      await this.finish(tenantId, row, { status: 'DEAD', lastErrorCode: code });
    } else {
      const availableAt = new Date(this.now().getTime() + this.backoffMs(row.attempts));
      await this.finish(tenantId, row, {
        status: 'PENDING',
        availableAt,
        lastErrorCode: code,
      });
    }
    this.log({
      type: dead ? 'account.email.dead' : 'account.email.retry',
      tenantId,
      outboxId: row.id,
      template: row.template,
      attempts: row.attempts,
      errorCode: code,
    });
    return dead ? 'DEAD' : 'RETRY';
  }

  /** ปิดงานเฉพาะเมื่อ lease ยังเป็นของรอบนี้ (attempts ตรง) — lease หมดแล้วมีคนจองใหม่ = ไม่ทับ */
  private async finish(
    tenantId: string,
    row: ClaimedRow,
    data: {
      status: 'SENT' | 'PENDING' | 'DEAD';
      sentAt?: Date;
      availableAt?: Date;
      lastErrorCode: string | null;
    },
  ) {
    const terminal = data.status !== 'PENDING';
    await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.accountEmailOutbox.updateMany({
        where: { id: row.id, status: 'SENDING', attempts: row.attempts },
        data: {
          ...data,
          leaseExpiresAt: null,
          ...(terminal ? { recipient: null, variables: Prisma.DbNull } : {}),
        },
      }),
    );
  }
}
