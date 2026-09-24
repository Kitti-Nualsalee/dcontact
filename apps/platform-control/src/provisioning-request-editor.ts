/**
 * Owner: Platform provisioning — แก้ field ที่ไม่ใช่ identity หลัง submit (A1.5 #410)
 *
 * Authority: #392 Correcting non-identity input
 * - แก้ได้เฉพาะ `displayName/locale/timezone` ก่อน PLAN_BOOTSTRAP สำเร็จ และ `firstAdminDisplayName`
 *   ก่อน FIRST_ADMIN สำเร็จ — identity (slug, domain, plan/template pin) แก้ไม่ได้
 * - A1.5b (#441): `firstAdminEmail` แก้ได้แยกเดี่ยว เมื่อ FIRST_ADMIN ยังไม่เคยเริ่ม หรือหยุดเพราะอีเมลชน
 *   (ยังไม่มี identity ภายนอก) — reserve อีเมลใหม่ + tombstone อันเดิมใน transaction เดียว
 * - compare-and-swap บน `expectedRevision`; ทุกการแก้สร้าง payload revision + digest ใหม่แบบ append-only
 *   ภายใต้ request เดิม (ไม่ใช่ replay create ด้วย idempotency key เดิม)
 * - ทุกผลรวมที่ถูกปฏิเสธลง Action history พร้อม actor/reason
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@d-contact/db';
import {
  EDITABLE_REQUEST_FIELDS,
  IDENTITY_TOMBSTONE_DAYS,
  PlatformProvisioningError,
  type EditableRequestField,
  type PlatformPlanCode,
} from '@d-contact/shared';
import { appendPlatformAction } from './action-history.js';
import {
  canonicalizeProvisioningRequest,
  platformIdentityHash,
  provisioningPayloadDigest,
} from './provisioning-input.js';
import { reserveIdentity, type PlatformActor } from './provisioning-repository.js';

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

export interface EditProvisioningRequestCommand {
  requestId: string;
  expectedRevision: number;
  /** ส่ง field อื่นที่ไม่อยู่ใน `EDITABLE_REQUEST_FIELDS` มา = FIELD_LOCKED */
  changes: Partial<Record<EditableRequestField, string>> & Record<string, unknown>;
  reasonCode: string;
  comment: string;
  actor: PlatformActor;
  correlationId: string;
}

export class ProvisioningRequestEditor {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    /** Prisma ของ `dcontact_platform` */
    private readonly database: PrismaClient,
    options: { now?: () => Date; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async edit(command: EditProvisioningRequestCommand) {
    if (command.actor.kind !== 'PLATFORM_OPERATOR') {
      throw new PlatformProvisioningError('RECOVERY_PRECONDITION_FAILED');
    }
    const fields = Object.keys(command.changes);
    if (
      fields.length === 0 ||
      !REASON.test(command.reasonCode) ||
      !command.comment.trim() ||
      command.comment.length > 500
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', {
        ...(fields.length === 0 ? { changes: 'EMPTY' } : {}),
        ...(REASON.test(command.reasonCode) ? {} : { reasonCode: 'INVALID' }),
        ...(command.comment.trim() && command.comment.length <= 500 ? {} : { comment: 'INVALID' }),
      });
    }
    const request = /^[0-9a-f-]{36}$/i.test(command.requestId)
      ? await this.database.pfProvisioningRequest.findUnique({
          where: { id: command.requestId },
          include: { steps: true },
        })
      : null;
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');

    const reject = async (
      code:
        | 'FIELD_LOCKED'
        | 'REVISION_CONFLICT'
        | 'INVALID_STATE_TRANSITION'
        | 'FIRST_ADMIN_EMAIL_CONFLICT',
    ) => {
      await appendPlatformAction(this.database, this.id(), {
        tenantId: request.tenantId,
        requestId: request.id,
        action: 'REQUEST_EDITED',
        actor: command.actor,
        correlationId: command.correlationId,
        outcome: 'REJECTED',
        reasonCode: command.reasonCode,
        comment: command.comment,
        errorCode: code,
        at: this.now(),
      });
      return new PlatformProvisioningError(code);
    };

    if (['SUCCEEDED', 'FAILED_FINAL', 'CANCELLED'].includes(request.status)) {
      throw await reject('INVALID_STATE_TRANSITION');
    }
    if (request.revision !== command.expectedRevision) throw await reject('REVISION_CONFLICT');
    if (fields.includes('firstAdminEmail')) {
      if (fields.length !== 1) {
        throw new PlatformProvisioningError('VALIDATION_FAILED', { changes: 'EMAIL_CHANGE_ALONE' });
      }
      return this.changeFirstAdminEmail(request, command, reject);
    }
    const stepState = new Map(request.steps.map((step) => [step.stepKey, step.state]));
    const locked = fields.some((field) => {
      const owner = EDITABLE_REQUEST_FIELDS[field as EditableRequestField];
      // identity field หรือ field ที่ step เจ้าของสำเร็จแล้ว
      return owner === undefined || stepState.get(owner) === 'SUCCEEDED';
    });
    if (locked) throw await reject('FIELD_LOCKED');

    // validate ด้วย canonicalization เดียวกับตอน accept แล้วได้ digest ของ payload ใหม่
    const changes = command.changes as Partial<Record<EditableRequestField, string>>;
    const canonical = canonicalizeProvisioningRequest({
      displayName: changes.displayName ?? request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      locale: changes.locale ?? request.locale,
      timezone: changes.timezone ?? request.timezone,
      planCode: request.planCode as PlatformPlanCode,
      bootstrapTemplateVersion: request.bootstrapTemplateVersion,
      firstAdmin: {
        email: request.firstAdminEmail,
        displayName: changes.firstAdminDisplayName ?? request.firstAdminDisplayName,
      },
    });
    const payloadDigest = provisioningPayloadDigest(canonical);
    const revision = request.revision + 1;

    await this.database
      .$transaction(async (transaction: Prisma.TransactionClient) => {
        const updated = await transaction.pfProvisioningRequest.updateMany({
          where: { id: request.id, revision: request.revision, status: request.status },
          data: {
            displayName: canonical.displayName,
            locale: canonical.locale,
            timezone: canonical.timezone,
            firstAdminDisplayName: canonical.firstAdminDisplayName,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
        if (changes.displayName !== undefined) {
          // tenant ยัง PROVISIONING: ชื่อตามคำขอล่าสุด (trigger ห้ามแตะ slug/domain เท่านั้น)
          await transaction.tenant.update({
            where: { id: request.tenantId },
            data: { name: canonical.displayName },
          });
        }
        await transaction.pfRequestPayloadRevision.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            requestRevision: revision,
            payloadDigest,
            changedFields: fields.sort(),
            actorKind: 'PLATFORM_OPERATOR',
            actorSubject: command.actor.subject,
            reasonCode: command.reasonCode,
            createdAt: this.now(),
          },
        });
        await appendPlatformAction(transaction, this.id(), {
          tenantId: request.tenantId,
          requestId: request.id,
          action: 'REQUEST_EDITED',
          actor: command.actor,
          correlationId: command.correlationId,
          outcome: 'SUCCEEDED',
          reasonCode: command.reasonCode,
          comment: command.comment,
          inputDigest: payloadDigest,
          at: this.now(),
        });
      })
      .catch(async (error: unknown) => {
        if (error instanceof PlatformProvisioningError) throw await reject('REVISION_CONFLICT');
        throw error;
      });
    return { requestId: request.id, revision, payloadDigest, changedFields: fields.sort() };
  }

  /** อีเมลใหม่ต้อง reserve ได้ (unique ทั้ง platform) และอันเดิม tombstone — guard ใน DB ตรวจซ้ำ */
  private async changeFirstAdminEmail(
    request: Prisma.PfProvisioningRequestGetPayload<{ include: { steps: true } }>,
    command: EditProvisioningRequestCommand,
    reject: (
      code: 'FIELD_LOCKED' | 'REVISION_CONFLICT' | 'FIRST_ADMIN_EMAIL_CONFLICT',
    ) => Promise<PlatformProvisioningError>,
  ) {
    const identity = request.steps.find((step) => step.stepKey === 'FIRST_ADMIN');
    const editable =
      (identity?.state === 'PENDING' && identity.attempt === 0) ||
      (identity?.state === 'ACTION_REQUIRED' &&
        identity.errorCode === 'FIRST_ADMIN_EMAIL_CONFLICT');
    if (!editable) throw await reject('FIELD_LOCKED');

    const canonical = canonicalizeProvisioningRequest({
      displayName: request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      locale: request.locale,
      timezone: request.timezone,
      planCode: request.planCode as PlatformPlanCode,
      bootstrapTemplateVersion: request.bootstrapTemplateVersion,
      firstAdmin: {
        email: String(command.changes.firstAdminEmail ?? ''),
        displayName: request.firstAdminDisplayName,
      },
    });
    const emailHash = platformIdentityHash('first-admin-email', canonical.firstAdminEmail);
    if (emailHash === request.firstAdminEmailHash) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { firstAdminEmail: 'UNCHANGED' });
    }
    const payloadDigest = provisioningPayloadDigest(canonical);
    const revision = request.revision + 1;
    const now = this.now();
    let conflict = false;
    await this.database
      .$transaction(async (transaction: Prisma.TransactionClient) => {
        const reserved = await reserveIdentity(transaction, {
          kind: 'FIRST_ADMIN_EMAIL',
          valueKey: emailHash,
          tenantId: request.tenantId,
          requestId: request.id,
        });
        if (reserved === 'CONFLICT') {
          conflict = true;
          throw new PlatformProvisioningError('FIRST_ADMIN_EMAIL_CONFLICT');
        }
        await transaction.pfIdentityReservation.updateMany({
          where: {
            kind: 'FIRST_ADMIN_EMAIL',
            valueKey: request.firstAdminEmailHash,
            requestId: request.id,
            state: 'HELD',
          },
          data: {
            state: 'TOMBSTONED',
            tombstonedUntil: new Date(now.getTime() + IDENTITY_TOMBSTONE_DAYS * 86_400_000),
            revision: { increment: 1 },
          },
        });
        const updated = await transaction.pfProvisioningRequest.updateMany({
          where: { id: request.id, revision: request.revision, status: request.status },
          data: {
            firstAdminEmail: canonical.firstAdminEmail,
            firstAdminEmailHash: emailHash,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
        await transaction.pfFirstAdminEmailRevision.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            requestRevision: revision,
            previousEmailHash: request.firstAdminEmailHash,
            emailHash,
            payloadDigest,
            actorKind: 'PLATFORM_OPERATOR',
            actorSubject: command.actor.subject,
            reasonCode: command.reasonCode,
            createdAt: now,
          },
        });
        for (const action of ['REQUEST_EDITED', 'RESERVATION_TOMBSTONED'] as const) {
          await appendPlatformAction(transaction, this.id(), {
            tenantId: request.tenantId,
            requestId: request.id,
            action,
            actor: command.actor,
            correlationId: command.correlationId,
            outcome: 'SUCCEEDED',
            reasonCode: command.reasonCode,
            ...(action === 'REQUEST_EDITED'
              ? { comment: command.comment, inputDigest: payloadDigest }
              : {}),
            stepKey: 'FIRST_ADMIN',
            at: now,
          });
        }
      })
      .catch(async (error: unknown) => {
        if (error instanceof PlatformProvisioningError) {
          throw await reject(conflict ? 'FIRST_ADMIN_EMAIL_CONFLICT' : 'REVISION_CONFLICT');
        }
        throw error;
      });
    return { requestId: request.id, revision, payloadDigest, changedFields: ['firstAdminEmail'] };
  }
}
