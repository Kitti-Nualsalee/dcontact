/**
 * Owner: Platform control plane — เหตุการณ์ฝั่ง First admin ใน Action history (A1.8 #413, #391)
 *
 * worker อ่าน Keycloak user events ของ first admin ที่ได้คำเชิญแล้ว แล้วบันทึกลง `pf_action_history`
 * ด้วย actor `FIRST_ADMIN` (subject = Keycloak user id)
 *
 * - เก็บแค่ชนิดเหตุการณ์และเวลา — ไม่อ่าน/เก็บ `details.username` (email), IP หรือ session ของ Keycloak
 * - Keycloak 26 ไม่มี event id: แต่ละชนิดบันทึกครั้งเดียวต่อ (request, identity) ด้วย history id ที่
 *   derive จากค่าเหล่านั้น + `skipDuplicates` จึง replay/worker หลายตัวได้โดยไม่ซ้ำ
 * - `FIRST_ADMIN_ACTIVATED` ใช้นิยามเดียวกับ invitation outbox: emailVerified และไม่มี required action
 *   เหลือ; เวลาคือเหตุการณ์ล่าสุดที่เห็น (event หมดอายุแล้ว = เวลาที่ตรวจพบ)
 * - หยุดตามเมื่อบันทึก ACTIVATED แล้ว หรือคำเชิญเก่ากว่า `trackDays`
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@d-contact/db';
import type { PlatformActionKind } from '@d-contact/shared';
import type { KeycloakAdminClient } from './keycloak-admin.js';
import { setSpanAttributes, withSpan } from './platform-tracing.js';

export type FirstAdminActivityKind = Extract<PlatformActionKind, `FIRST_ADMIN_${string}`>;

interface KeycloakEvent {
  time?: number;
  type?: string;
  details?: Record<string, unknown>;
}

/** ชนิด event ที่ realm ต้องเก็บ — setup ของ Keycloak ใช้รายการเดียวกัน */
export const FIRST_ADMIN_KEYCLOAK_EVENT_TYPES = [
  'VERIFY_EMAIL',
  'CUSTOM_REQUIRED_ACTION',
  'UPDATE_PASSWORD',
  'UPDATE_TOTP',
  'UPDATE_CREDENTIAL',
] as const;

/** แปลง Keycloak event เป็นเหตุการณ์ของ timeline — อ่านเฉพาะ type และ field ที่ไม่ใช่ PII */
export function firstAdminActivityOf(event: KeycloakEvent): FirstAdminActivityKind | null {
  const action = event.details?.custom_required_action;
  const credential = event.details?.credential_type;
  switch (event.type) {
    case 'VERIFY_EMAIL':
      return 'FIRST_ADMIN_EMAIL_VERIFIED';
    case 'CUSTOM_REQUIRED_ACTION':
      return action === 'VERIFY_EMAIL' ? 'FIRST_ADMIN_EMAIL_VERIFIED' : null;
    case 'UPDATE_PASSWORD':
      return 'FIRST_ADMIN_PASSWORD_SET';
    case 'UPDATE_TOTP':
      return 'FIRST_ADMIN_TOTP_ENROLLED';
    case 'UPDATE_CREDENTIAL':
      return credential === 'password'
        ? 'FIRST_ADMIN_PASSWORD_SET'
        : credential === 'otp'
          ? 'FIRST_ADMIN_TOTP_ENROLLED'
          : null;
    default:
      return null;
  }
}

/** uuid ที่คงที่ต่อ (request, identity, action) — insert ซ้ำชน primary key แล้วถูกข้าม */
function historyId(requestId: string, userId: string, action: FirstAdminActivityKind): string {
  const hex = createHash('sha256')
    .update(`first-admin-activity\0${requestId}\0${userId}\0${action}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type FirstAdminActivityResult =
  | { kind: 'IDLE' }
  | {
      kind: 'FIRST_ADMIN_SYNCED';
      requestId: string;
      tenantId: string;
      recorded: number;
      code: string;
    };

interface Candidate {
  request_id: string;
  tenant_id: string;
  keycloak_user_id: string;
  correlation_id: string;
  trace_parent: string | null;
}

export class FirstAdminActivityReconciler {
  private readonly nextCheck = new Map<string, number>();

  constructor(
    private readonly platform: PrismaClient,
    private readonly keycloak: Pick<KeycloakAdminClient, 'admin'>,
    private readonly options: {
      /** ระยะห่างขั้นต่ำระหว่างการตรวจ request เดิม */
      intervalMs?: number;
      trackDays?: number;
      now?: () => Date;
      /** จำกัด tenant (ใช้ในเทสต์) */
      scope?: () => string[] | undefined;
    } = {},
  ) {}

  private now() {
    return (this.options.now ?? (() => new Date()))();
  }

  async runOnce(): Promise<FirstAdminActivityResult> {
    const now = this.now();
    const scope = this.options.scope?.() ?? null;
    const candidates = await this.platform.$queryRawUnsafe<Candidate[]>(
      `SELECT i.request_id, i.tenant_id, i.keycloak_user_id::text AS keycloak_user_id, r.correlation_id, r.trace_parent
       FROM pf_invitations i
       JOIN pf_provisioning_requests r ON r.id = i.request_id AND r.tenant_id = i.tenant_id
       WHERE i.state = 'SENT' AND i.superseded_at IS NULL
         AND i.sent_at > $1::timestamptz
         AND ($2::uuid[] IS NULL OR i.tenant_id = ANY($2::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM pf_action_history h
           WHERE h.request_id = i.request_id AND h.action = 'FIRST_ADMIN_ACTIVATED')
       ORDER BY i.sent_at
       LIMIT 200`,
      new Date(now.getTime() - (this.options.trackDays ?? 30) * 86_400_000),
      scope,
    );
    const due = candidates.find(
      (candidate) => (this.nextCheck.get(candidate.request_id) ?? 0) <= now.getTime(),
    );
    if (!due) return { kind: 'IDLE' };
    this.nextCheck.set(due.request_id, now.getTime() + (this.options.intervalMs ?? 60_000));
    return withSpan(
      'provisioning.first_admin_activity',
      {
        parent: due.trace_parent,
        attributes: {
          'dcontact.request_id': due.request_id,
          'dcontact.tenant_id': due.tenant_id,
          'dcontact.correlation_id': due.correlation_id,
        },
      },
      async (span) => {
        const result = await this.sync(due, now);
        if (result.kind !== 'IDLE') setSpanAttributes(span, { 'dcontact.code': result.code });
        return result;
      },
    );
  }

  private async sync(candidate: Candidate, now: Date): Promise<FirstAdminActivityResult> {
    const userPath = `/users/${encodeURIComponent(candidate.keycloak_user_id)}`;
    const user = await this.keycloak.admin<{ emailVerified?: boolean; requiredActions?: string[] }>(
      'GET',
      userPath,
      { accept: [200, 404] },
    );
    const types = FIRST_ADMIN_KEYCLOAK_EVENT_TYPES.map((type) => `type=${type}`).join('&');
    const events = await this.keycloak.admin<KeycloakEvent[]>(
      'GET',
      `/events?user=${encodeURIComponent(candidate.keycloak_user_id)}&${types}&max=200`,
    );
    const firstSeen = new Map<FirstAdminActivityKind, Date>();
    for (const event of events.body ?? []) {
      const kind = firstAdminActivityOf(event);
      if (!kind || typeof event.time !== 'number') continue;
      const at = new Date(event.time);
      if (!firstSeen.has(kind) || at < firstSeen.get(kind)!) firstSeen.set(kind, at);
    }
    const activated =
      user.status === 200 &&
      user.body?.emailVerified === true &&
      (user.body.requiredActions ?? []).length === 0;
    if (activated) {
      const latest = Math.max(0, ...[...firstSeen.values()].map((at) => at.getTime()));
      firstSeen.set('FIRST_ADMIN_ACTIVATED', latest > 0 ? new Date(latest) : now);
    }
    const rows = [...firstSeen].map(([action, at]) => ({
      id: historyId(candidate.request_id, candidate.keycloak_user_id, action),
      tenantId: candidate.tenant_id,
      requestId: candidate.request_id,
      action,
      actorKind: 'FIRST_ADMIN' as const,
      actorSubject: candidate.keycloak_user_id,
      correlationId: candidate.correlation_id,
      outcome: 'SUCCEEDED',
      occurredAt: at,
    }));
    const { count } = await this.platform.pfActionHistory.createMany({
      data: rows,
      skipDuplicates: true,
    });
    if (activated) this.nextCheck.delete(candidate.request_id);
    return {
      kind: 'FIRST_ADMIN_SYNCED',
      requestId: candidate.request_id,
      tenantId: candidate.tenant_id,
      recorded: count,
      code:
        user.status === 404
          ? 'FIRST_ADMIN_MISSING'
          : activated
            ? 'ACTIVATED'
            : 'PENDING_ACTIVATION',
    };
  }
}
