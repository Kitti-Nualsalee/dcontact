/**
 * Owner: Platform API — read model ของ control plane (A1.6 #411)
 *
 * Authority: #387 (platform เห็นเฉพาะ control-plane metadata), #388 checkpoint 1 (cursor, generic 404)
 *
 * - ใช้ role `dcontact_platform` เท่านั้น จึงอ่าน business data ของ tenant ไม่ได้โดยโครงสร้าง
 * - ค้นหาด้วย name/slug/domain/request ID หรือ first-admin email; email เทียบด้วย hash เท่านั้น
 *   และ response แสดง email แบบ mask — ไม่คืน raw email, token หรือ payload ดิบ
 * - cursor เป็น opaque (createdAt, id) เรียงแบบ total order จึงเสถียรแม้มี tenant ใหม่ระหว่างเปิดหน้า
 */
import type { Prisma, PrismaClient } from '@d-contact/db';
import {
  PlatformProvisioningError,
  PROVISIONING_REQUEST_STATUSES,
  type ProvisioningRequestStatus,
} from '@d-contact/shared';
import { commandView } from './operator-commands.js';
import { normalizeFirstAdminEmail, platformIdentityHash } from './provisioning-input.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Cursor {
  at: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (!UUID.test(parsed.id) || Number.isNaN(Date.parse(parsed.at))) throw new Error('cursor');
    return parsed;
  } catch {
    throw new PlatformProvisioningError('VALIDATION_FAILED', { cursor: 'INVALID' });
  }
}

/** a***@example.com — operator เห็นพอยืนยันผู้รับ แต่ไม่ได้ email เต็ม */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

export interface TenantSummary {
  tenantId: string;
  name: string;
  slug: string;
  primaryDomain: string | null;
  lifecycleStatus: 'PROVISIONING' | 'ACTIVE';
  /** tenant เดิมก่อน A1 ไม่มี provisioning history (#388 rollout: legacy read-only) */
  legacy: boolean;
  request: {
    requestId: string;
    status: ProvisioningRequestStatus;
    revision: number;
    updatedAt: string;
  } | null;
  createdAt: string;
}

export class PlatformQueries {
  /** `database` = Prisma ของ role `dcontact_platform` */
  constructor(private readonly database: PrismaClient) {}

  async searchTenants(input: {
    query?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: TenantSummary[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const query = input.query?.trim() ?? '';
    if (query.length > 254)
      throw new PlatformProvisioningError('VALIDATION_FAILED', { query: 'INVALID' });
    if (
      input.status &&
      !(PROVISIONING_REQUEST_STATUSES as readonly string[]).includes(input.status)
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { status: 'INVALID' });
    }
    const cursor = decodeCursor(input.cursor);

    const matches: Prisma.TenantWhereInput[] = [];
    if (query) {
      const contains = { contains: query, mode: 'insensitive' as const };
      matches.push(
        { name: contains },
        { slug: contains },
        { primaryDomain: contains },
        { pfProvisioningRequests: { some: { slug: contains } } },
        { pfProvisioningRequests: { some: { primaryDomain: contains } } },
      );
      if (UUID.test(query)) {
        matches.push({ id: query }, { pfProvisioningRequests: { some: { id: query } } });
      }
      const email = normalizeFirstAdminEmail(query);
      if (email) {
        // ค้นด้วย hash — ไม่ทำ substring match บน email
        const emailHash = platformIdentityHash('first-admin-email', email);
        matches.push({ pfProvisioningRequests: { some: { firstAdminEmailHash: emailHash } } });
      }
    }
    const where: Prisma.TenantWhereInput = {
      AND: [
        matches.length > 0 ? { OR: matches } : {},
        input.status
          ? {
              pfProvisioningRequests: {
                some: { status: input.status as ProvisioningRequestStatus },
              },
            }
          : {},
        cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.at) } },
                { createdAt: new Date(cursor.at), id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.database.tenant.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        name: true,
        slug: true,
        primaryDomain: true,
        lifecycleStatus: true,
        createdAt: true,
        pfProvisioningRequests: {
          select: {
            id: true,
            status: true,
            revision: true,
            updatedAt: true,
            slug: true,
            primaryDomain: true,
          },
        },
      },
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => {
        const request = row.pfProvisioningRequests[0];
        return {
          tenantId: row.id,
          name: row.name,
          // tenant ที่ยัง PROVISIONING ถือ placeholder — แสดง slug/domain ที่ขอไว้แทน
          slug: row.lifecycleStatus === 'PROVISIONING' && request ? request.slug : row.slug,
          primaryDomain:
            row.lifecycleStatus === 'PROVISIONING' && request
              ? request.primaryDomain
              : row.primaryDomain,
          lifecycleStatus: row.lifecycleStatus,
          legacy: !request,
          request: request
            ? {
                requestId: request.id,
                status: request.status,
                revision: request.revision,
                updatedAt: request.updatedAt.toISOString(),
              }
            : null,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  }

  /** representation ปัจจุบันของ request — ใช้ตอบ GET และ 202/replay */
  async requestView(requestId: string) {
    const request = UUID.test(requestId)
      ? await this.database.pfProvisioningRequest.findUnique({
          where: { id: requestId },
          include: {
            steps: { orderBy: { ordinal: 'asc' } },
            invitations: { orderBy: { generation: 'desc' }, take: 1 },
            operatorCommands: { orderBy: { createdAt: 'desc' }, take: 10 },
          },
        })
      : null;
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    const now = Date.now();
    const resendsInLastHour = await this.database.pfInvitation.count({
      where: {
        requestId,
        generation: { gt: 1 },
        createdAt: { gt: new Date(now - 3600_000) },
      },
    });
    const invitation = request.invitations[0];
    return {
      requestId: request.id,
      tenantId: request.tenantId,
      status: request.status,
      revision: request.revision,
      failureCode: request.failureCode,
      displayName: request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      locale: request.locale,
      timezone: request.timezone,
      plan: { code: request.planCode, version: request.planVersion },
      bootstrapTemplateVersion: request.bootstrapTemplateVersion,
      firstAdmin: {
        emailMasked: maskEmail(request.firstAdminEmail),
        displayName: request.firstAdminDisplayName,
      },
      acceptedAt: request.acceptedAt.toISOString(),
      deadlineAt: request.deadlineAt.toISOString(),
      terminalAt: request.terminalAt?.toISOString() ?? null,
      steps: request.steps.map((step) => ({
        stepKey: step.stepKey,
        state: step.state,
        attempt: step.attempt,
        errorCode: step.errorCode,
        nextAttemptAt: step.nextAttemptAt?.toISOString() ?? null,
        finishedAt: step.finishedAt?.toISOString() ?? null,
      })),
      // delivery ≠ activation (#392) — activation ต้องถาม Keycloak จึงอยู่ฝั่ง worker ไม่ใช่ API
      invitation: invitation
        ? {
            generation: invitation.generation,
            delivery: invitation.state,
            sentAt: invitation.sentAt?.toISOString() ?? null,
            expiresAt: invitation.expiresAt?.toISOString() ?? null,
            expired: Boolean(invitation.expiresAt && invitation.expiresAt.getTime() <= now),
            resendsInLastHour,
          }
        : null,
      commands: request.operatorCommands.map(commandView),
    };
  }

  async actionHistory(input: { tenantId: string; cursor?: string; limit?: number }) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const tenant = UUID.test(input.tenantId)
      ? await this.database.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true },
        })
      : null;
    if (!tenant) throw new PlatformProvisioningError('NOT_FOUND');
    const cursor = decodeCursor(input.cursor);
    const rows = await this.database.pfActionHistory.findMany({
      where: {
        tenantId: tenant.id,
        ...(cursor
          ? {
              OR: [
                { occurredAt: { gt: new Date(cursor.at) } },
                { occurredAt: new Date(cursor.at), id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      // timeline เก่า → ใหม่ แบบ total order
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        action: row.action,
        outcome: row.outcome,
        actor: { kind: row.actorKind, subject: row.actorSubject, role: row.actorRole },
        stepKey: row.stepKey,
        attempt: row.attempt,
        beforeState: row.beforeState,
        afterState: row.afterState,
        reasonCode: row.reasonCode,
        comment: row.comment,
        errorCode: row.errorCode,
        correlationId: row.correlationId,
        occurredAt: row.occurredAt.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ at: last.occurredAt.toISOString(), id: last.id })
          : null,
    };
  }
}
