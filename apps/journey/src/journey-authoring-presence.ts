import {
  JOURNEY_PRESENCE_HEARTBEAT_SECONDS,
  JOURNEY_PRESENCE_TTL_SECONDS,
} from '@d-contact/cxa-contracts';

/**
 * J5.3 (#341): advisory soft-lease presence (#331 §7, Phase Spec §6)
 *
 * Can only say "who is probably viewing this resource" — it grants no permission, takes no lock, does not block save/publish and
 * is not canonical data: losing all of it when the process restarts is correct. Edit correctness lives in the CAS
 * of the draft; never use presence to decide authorization or conflicts
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

  /** Used for both join and heartbeat — the client should call it every JOURNEY_PRESENCE_HEARTBEAT_SECONDS */
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

  /** Only sessions with a heartbeat within the TTL; other tenants cannot see them because the key is bound to the tenant */
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
