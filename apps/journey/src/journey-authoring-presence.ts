import {
  JOURNEY_PRESENCE_HEARTBEAT_SECONDS,
  JOURNEY_PRESENCE_TTL_SECONDS,
} from '@d-contact/cxa-contracts';

/**
 * J5.3 (#341): presence แบบ advisory soft lease (#331 §7, Phase Spec §6)
 *
 * บอกได้แค่ว่า "ใครน่าจะกำลังเปิด resource นี้อยู่" — ไม่ให้สิทธิ์, ไม่ lock, ไม่กัน save/publish และ
 * ไม่ใช่ข้อมูล canonical: หายทั้งหมดเมื่อ process เริ่มใหม่ก็ถูกต้อง ความถูกต้องของการแก้ไขอยู่ที่ CAS
 * ของ draft เสมอ ห้ามนำ presence ไปตัดสิน authorization หรือ conflict
 */
export interface JourneyPresenceEntry {
  readonly subjectId: string;
  readonly sessionId: string;
  readonly baseRevision: number;
  readonly lastSeenAt: string;
}

export class JourneyPresenceRegistry {
  private readonly entries = new Map<string, Map<string, JourneyPresenceEntry>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** ใช้ทั้ง join และ heartbeat — client ควรเรียกทุก JOURNEY_PRESENCE_HEARTBEAT_SECONDS */
  heartbeat(
    tenantId: string,
    resourceId: string,
    entry: Omit<JourneyPresenceEntry, 'lastSeenAt'>,
  ): void {
    const key = `${tenantId}:${resourceId}`;
    const sessions = this.entries.get(key) ?? new Map<string, JourneyPresenceEntry>();
    sessions.set(entry.sessionId, { ...entry, lastSeenAt: this.now().toISOString() });
    this.entries.set(key, sessions);
  }

  leave(tenantId: string, resourceId: string, sessionId: string): void {
    this.entries.get(`${tenantId}:${resourceId}`)?.delete(sessionId);
  }

  /** เฉพาะ session ที่ heartbeat ภายใน TTL; tenant อื่นมองไม่เห็นเพราะ key ผูก tenant */
  list(tenantId: string, resourceId: string): JourneyPresenceEntry[] {
    const key = `${tenantId}:${resourceId}`;
    const sessions = this.entries.get(key);
    if (!sessions) return [];
    const cutoff = this.now().getTime() - JOURNEY_PRESENCE_TTL_SECONDS * 1_000;
    for (const [sessionId, entry] of sessions) {
      if (new Date(entry.lastSeenAt).getTime() < cutoff) sessions.delete(sessionId);
    }
    return [...sessions.values()].sort((left, right) =>
      left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0,
    );
  }

  static readonly heartbeatSeconds = JOURNEY_PRESENCE_HEARTBEAT_SECONDS;
  static readonly ttlSeconds = JOURNEY_PRESENCE_TTL_SECONDS;
}
