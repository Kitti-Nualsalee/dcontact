/**
 * Owner: IAM provisioning + Notification delivery — invitation ของ first Tenant Admin (A1.4 #409)
 *
 * Authority: #392 Invitation contract
 * - Keycloak execute-actions (verify email, ตั้ง password, ลงทะเบียน TOTP) อายุ 72 ชั่วโมง
 * - intent ลง `pf_invitations` ก่อนเรียก Keycloak เสมอ (durable outbox) แล้วค่อยบันทึกผล
 * - ผลไม่ชัด (timeout/lost response) = `AMBIGUOUS` → reconcile ด้วย delivery probe เท่านั้น
 *   ห้ามยิงซ้ำเอง; ถ้าพิสูจน์ไม่ได้ saga จะขึ้น ACTION_REQUIRED ให้ operator ตัดสิน
 * - resend = operator action ที่ต้องมี reason/comment, สร้าง generation ใหม่, audit ทุกผล และ
 *   ไม่เกิน 3 ครั้งต่อชั่วโมง (DB trigger บังคับแบบ race-safe)
 * - delivery accepted ≠ user activated: `status()` แยกสองสถานะ
 *
 * ข้อจำกัดที่รู้แล้ว: Keycloak 26.0 ยกเลิก action token ของ generation เก่าไม่ได้ → #436
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  FIRST_ADMIN_REQUIRED_ACTIONS,
  INVITATION_LIMITS,
  PlatformProvisioningError,
} from '@d-contact/shared';
import { appendPlatformAction } from './action-history.js';
import type { KeycloakAdminClient } from './keycloak-admin.js';
import type { FirstAdminPort } from './keycloak-provisioning-ports.js';
import { platformIdentityHash } from './provisioning-input.js';
import type { PlatformActor } from './provisioning-repository.js';
import {
  ProvisioningStepError,
  provisioningStepContext,
  type ProvisioningAdoption,
  type ProvisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';

/**
 * หลักฐานการส่งจากฝั่ง email provider — ใช้ reconcile ผล `AMBIGUOUS` เท่านั้น
 * production ที่ไม่มี lookup ให้คืน `UNKNOWN` เสมอ (operator ตัดสิน)
 */
export interface InvitationDeliveryProbe {
  delivered(input: { recipient: string; since: Date }): Promise<'DELIVERED' | 'UNKNOWN'>;
}

export const NO_DELIVERY_PROBE: InvitationDeliveryProbe = {
  delivered: async () => 'UNKNOWN',
};

/** email sink ของ dev/test (mailpit) — correlation คือผู้รับ (email unique ทั้ง platform) + เวลาหลัง intent */
export function mailpitDeliveryProbe(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): InvitationDeliveryProbe {
  return {
    async delivered({ recipient, since }) {
      const response = await fetcher(
        `${baseUrl}/api/v1/search?${new URLSearchParams({ query: `to:"${recipient}"`, limit: '50' })}`,
      );
      if (!response.ok) return 'UNKNOWN';
      const body = (await response.json()) as { messages?: { Created: string }[] };
      return (body.messages ?? []).some((message) => new Date(message.Created) >= since)
        ? 'DELIVERED'
        : 'UNKNOWN';
    },
  };
}

type InvitationRow = Prisma.PfInvitationGetPayload<object>;

export interface InvitationStatus {
  generation: number | null;
  delivery: 'NOT_STARTED' | 'INTENT' | 'SENT' | 'FAILED' | 'AMBIGUOUS';
  /** เทียบกับนาฬิกาปัจจุบัน — หมดอายุแล้วแต่ยังไม่ activate ต้อง resend */
  expired: boolean;
  activation: 'PENDING_ACTIVATION' | 'ACTIVATED' | 'UNKNOWN';
  expiresAt: Date | null;
  resendsInLastHour: number;
}

export class InvitationOutbox {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly probe: InvitationDeliveryProbe;

  constructor(
    /** Prisma ของ role `dcontact_platform` */
    private readonly platform: PrismaClient,
    private readonly keycloak: KeycloakAdminClient,
    private readonly firstAdmin: FirstAdminPort,
    options: { now?: () => Date; id?: () => string; probe?: InvitationDeliveryProbe } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.probe = options.probe ?? NO_DELIVERY_PROBE;
  }

  /** port ของ step INVITATION สำหรับ saga worker */
  port(): ProvisioningStepPort {
    return {
      find: (context) => this.find(context),
      execute: (context, signal) => this.deliverInitial(context, signal),
    };
  }

  private latest(requestId: string) {
    return this.platform.pfInvitation.findFirst({
      where: { requestId },
      orderBy: { generation: 'desc' },
    });
  }

  async find(context: ProvisioningStepContext): Promise<ProvisioningAdoption> {
    const latest = await this.latest(context.requestId);
    if (latest?.state === 'SENT') return { status: 'FOUND', externalRef: latest.id };
    // INTENT ค้าง/AMBIGUOUS ต้องผ่าน reconciliation ใน execute; FAILED ส่งใหม่ได้
    return { status: 'NOT_FOUND' };
  }

  private async deliverInitial(context: ProvisioningStepContext, signal: AbortSignal) {
    const user = await this.firstAdmin.user(context, signal);
    if (!user) throw new ProvisioningStepError('PERMANENT', 'FIRST_ADMIN_MISSING');
    let latest = await this.latest(context.requestId);

    if (latest?.state === 'SENT') return { externalRef: latest.id };
    if (latest?.state === 'INTENT' || latest?.state === 'AMBIGUOUS') {
      // attempt ก่อนหน้าไม่รู้ผล: หาหลักฐานการส่ง ถ้าไม่มีห้ามยิงซ้ำ
      const reconciled = await this.reconcile(latest, context.request.firstAdminEmail);
      if (reconciled) return { externalRef: reconciled.id };
      throw new ProvisioningStepError('PERMANENT', 'INVITATION_DELIVERY_AMBIGUOUS');
    }
    if (!latest) {
      latest = await this.platform.pfInvitation.create({
        data: {
          id: this.id(),
          requestId: context.requestId,
          tenantId: context.tenantId,
          generation: 1,
          keycloakUserId: user.id,
          recipientHash: platformIdentityHash('email', context.request.firstAdminEmail),
          lifespanSeconds: INVITATION_LIMITS.lifespanSeconds,
          requestedByKind: 'SYSTEM',
          requestedBy: 'provisioning-worker',
          createdAt: this.now(),
        },
      });
    } else {
      // FAILED = พิสูจน์ได้ว่าไม่ได้ส่ง: เปิด intent เดิมอีกครั้ง
      latest = await this.transition(latest, { state: 'INTENT', errorCode: null });
    }
    const sent = await this.send(latest, signal);
    return { externalRef: sent.id };
  }

  /** ส่งหนึ่งครั้งสำหรับ intent ที่บันทึกแล้ว แล้วบันทึกผลตามที่พิสูจน์ได้ */
  private async send(invitation: InvitationRow, signal?: AbortSignal): Promise<InvitationRow> {
    let status: number;
    try {
      ({ status } = await this.keycloak.admin(
        'PUT',
        `/users/${encodeURIComponent(invitation.keycloakUserId)}/execute-actions-email?${new URLSearchParams(
          { lifespan: String(INVITATION_LIMITS.lifespanSeconds) },
        )}`,
        {
          body: [...FIRST_ADMIN_REQUIRED_ACTIONS],
          accept: [204, 400, 500],
          ...(signal ? { signal } : {}),
        },
      ));
    } catch (error) {
      // TRANSIENT/PERMANENT จาก client = ล้มก่อน Keycloak ประมวลผล (ขอ token ไม่ได้, 403, 4xx)
      if (error instanceof ProvisioningStepError && error.kind !== 'AMBIGUOUS') {
        await this.transition(invitation, { state: 'FAILED', errorCode: error.code });
        throw error;
      }
      await this.transition(invitation, {
        state: 'AMBIGUOUS',
        errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
      });
      throw new ProvisioningStepError(
        'AMBIGUOUS',
        error instanceof ProvisioningStepError ? error.code : 'DELIVERY_OUTCOME_UNKNOWN',
      );
    }
    if (status === 204) {
      const sentAt = this.now();
      return this.transition(invitation, {
        state: 'SENT',
        sentAt,
        expiresAt: new Date(sentAt.getTime() + invitation.lifespanSeconds * 1000),
        errorCode: null,
      });
    }
    // Keycloak ตอบกลับชัดเจนว่าส่งไม่สำเร็จ (SMTP ล้ม = 500, input ใช้ไม่ได้ = 400)
    await this.transition(invitation, {
      state: 'FAILED',
      errorCode: status === 500 ? 'EMAIL_SEND_FAILED' : 'EMAIL_REJECTED',
    });
    throw new ProvisioningStepError(
      status === 500 ? 'TRANSIENT' : 'PERMANENT',
      status === 500 ? 'EMAIL_SEND_FAILED' : 'EMAIL_REJECTED',
    );
  }

  private async reconcile(invitation: InvitationRow, recipient: string) {
    const evidence = await this.probe.delivered({ recipient, since: invitation.createdAt });
    if (evidence !== 'DELIVERED') {
      if (invitation.state === 'INTENT') {
        await this.transition(invitation, {
          state: 'AMBIGUOUS',
          errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
        });
      }
      return null;
    }
    const sentAt = this.now();
    return this.transition(invitation, {
      state: 'SENT',
      sentAt,
      expiresAt: new Date(sentAt.getTime() + invitation.lifespanSeconds * 1000),
      errorCode: null,
    });
  }

  /** CAS บน revision — ใครขยับก่อน = REVISION_CONFLICT */
  private async transition(
    invitation: InvitationRow,
    data: Prisma.PfInvitationUpdateManyMutationInput,
    client: Prisma.TransactionClient | PrismaClient = this.platform,
  ): Promise<InvitationRow> {
    const updated = await client.pfInvitation.updateMany({
      where: { id: invitation.id, revision: invitation.revision },
      data: { ...data, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
    return client.pfInvitation.findUniqueOrThrow({ where: { id: invitation.id } });
  }

  // ── Operator actions ──────────────────────────────────────────────────────

  /**
   * Resend invitation (#392): supersede generation ล่าสุดแล้วสร้างใหม่ใน transaction เดียว
   * cap 3 ครั้ง/ชั่วโมงบังคับที่ trigger (advisory lock ต่อ request) — ถูกปฏิเสธก็ลง audit
   */
  async resend(command: {
    requestId: string;
    reasonCode: string;
    comment: string;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<InvitationStatus> {
    if (command.actor.kind !== 'PLATFORM_OPERATOR') {
      throw new PlatformProvisioningError('RECOVERY_PRECONDITION_FAILED');
    }
    if (
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(command.reasonCode) ||
      !command.comment.trim() ||
      command.comment.length > 500
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', {
        ...(/^[A-Z][A-Z0-9_]{2,63}$/.test(command.reasonCode) ? {} : { reasonCode: 'INVALID' }),
        ...(command.comment.trim() && command.comment.length <= 500 ? {} : { comment: 'INVALID' }),
      });
    }
    const request = /^[0-9a-f-]{36}$/i.test(command.requestId)
      ? await this.platform.pfProvisioningRequest.findUnique({
          where: { id: command.requestId },
          include: { steps: true },
        })
      : null;
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    const audit = (
      client: Prisma.TransactionClient | PrismaClient,
      entry: { outcome: 'SUCCEEDED' | 'REJECTED'; errorCode?: string; attempt?: number },
    ) =>
      appendPlatformAction(client, this.id(), {
        tenantId: request.tenantId,
        requestId: request.id,
        action: 'RESEND_INVITATION',
        actor: command.actor,
        correlationId: command.correlationId,
        reasonCode: command.reasonCode,
        comment: command.comment,
        stepKey: 'INVITATION',
        at: this.now(),
        ...entry,
      });

    const latest = await this.latest(request.id);
    const context = provisioningStepContext(request, 'INVITATION', 0);
    const user = latest ? await this.firstAdmin.user(context) : undefined;
    const precondition = !latest
      ? 'INVITATION_NOT_STARTED'
      : !user || user.id !== latest.keycloakUserId
        ? 'FIRST_ADMIN_MISSING'
        : activated(user)
          ? 'ALREADY_ACTIVATED'
          : null;
    if (precondition) {
      await audit(this.platform, { outcome: 'REJECTED', errorCode: precondition });
      throw new PlatformProvisioningError('RECOVERY_PRECONDITION_FAILED');
    }

    let created: InvitationRow;
    try {
      created = await this.platform.$transaction(async (transaction) => {
        await this.transition(latest!, { supersededAt: this.now() }, transaction);
        return transaction.pfInvitation.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            generation: latest!.generation + 1,
            keycloakUserId: latest!.keycloakUserId,
            recipientHash: latest!.recipientHash,
            lifespanSeconds: INVITATION_LIMITS.lifespanSeconds,
            requestedByKind: 'PLATFORM_OPERATOR',
            requestedBy: command.actor.subject,
            reasonCode: command.reasonCode,
            createdAt: this.now(),
          },
        });
      });
    } catch (error) {
      if (String(error).includes('PF_INVITATION_RESEND_LIMIT')) {
        await audit(this.platform, { outcome: 'REJECTED', errorCode: 'INVITATION_RESEND_LIMITED' });
        throw new PlatformProvisioningError('INVITATION_RESEND_LIMITED');
      }
      if (
        error instanceof PlatformProvisioningError ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      ) {
        // operator อีกคน resend ก่อนเรา (generation ชนหรือ revision เปลี่ยน)
        await audit(this.platform, { outcome: 'REJECTED', errorCode: 'REVISION_CONFLICT' });
        throw new PlatformProvisioningError('REVISION_CONFLICT');
      }
      throw error;
    }

    try {
      await this.send(created);
      await audit(this.platform, { outcome: 'SUCCEEDED', attempt: created.generation });
    } catch (error) {
      await audit(this.platform, {
        outcome: 'REJECTED',
        attempt: created.generation,
        errorCode: error instanceof ProvisioningStepError ? error.code : 'DELIVERY_OUTCOME_UNKNOWN',
      });
      throw error;
    }
    return this.status(request.id);
  }

  /** delivery กับ activation แยกกัน (#392) — ไม่คืน email หรือ token */
  async status(requestId: string): Promise<InvitationStatus> {
    const now = this.now();
    const request = await this.platform.pfProvisioningRequest.findUnique({
      where: { id: requestId },
      include: { steps: true },
    });
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    const latest = await this.latest(requestId);
    const resendsInLastHour = await this.platform.pfInvitation.count({
      where: {
        requestId,
        generation: { gt: 1 },
        createdAt: { gt: new Date(now.getTime() - 3600_000) },
      },
    });
    let activation: InvitationStatus['activation'] = 'UNKNOWN';
    if (latest) {
      const user = await this.firstAdmin
        .user(provisioningStepContext(request, 'INVITATION', 0))
        .catch(() => undefined);
      if (user?.id === latest.keycloakUserId) {
        activation = activated(user) ? 'ACTIVATED' : 'PENDING_ACTIVATION';
      }
    }
    return {
      generation: latest?.generation ?? null,
      delivery: latest?.state ?? 'NOT_STARTED',
      expired: Boolean(latest?.expiresAt && latest.expiresAt <= now && activation !== 'ACTIVATED'),
      activation,
      expiresAt: latest?.expiresAt ?? null,
      resendsInLastHour,
    };
  }
}

function activated(user: { emailVerified?: boolean; requiredActions?: string[] }) {
  return user.emailVerified === true && (user.requiredActions ?? []).length === 0;
}
