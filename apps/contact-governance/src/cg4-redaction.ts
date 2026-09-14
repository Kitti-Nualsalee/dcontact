import { createHash } from 'node:crypto';

/**
 * CG4.7 (#190): role-scoped evidence redaction for every CG4 read path.
 *
 * #179 §2/§7 is explicit: a response may carry opaque ids, versions, reason codes,
 * digests and timings, but never a raw evidence body, ticket reference, actor name or
 * contact identity. Redaction is applied at the query layer rather than per controller,
 * so a new route cannot forget it — a caller has to ask for the unredacted view and prove
 * the access level to get one.
 */

/**
 * What a viewer may see. `SUMMARY` is the default for anyone who can read the resource at
 * all; `EVIDENCE` additionally reveals the reference strings, and is only ever granted
 * from a capability check, never from a request field.
 */
export type Cg4EvidenceAccessLevel = 'SUMMARY' | 'EVIDENCE';

/** A reference replaced by its digest: still correlatable, no longer readable. */
export interface Cg4RedactedRef {
  redacted: true;
  /** First 16 hex chars of the SHA-256 — enough to match two records, not to reverse. */
  digest: string;
}

export type Cg4MaybeRedacted<T extends string | undefined> = T | Cg4RedactedRef;

export function cg4RefDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function redactCg4Ref(
  value: string | null | undefined,
  level: Cg4EvidenceAccessLevel,
): string | Cg4RedactedRef | undefined {
  if (value === null || value === undefined) return undefined;
  if (level === 'EVIDENCE') return value;
  return { redacted: true, digest: cg4RefDigest(value) };
}

export function isCg4RedactedRef(value: unknown): value is Cg4RedactedRef {
  return typeof value === 'object' && value !== null && (value as Cg4RedactedRef).redacted === true;
}

/**
 * An actor reference is a stable subject id, not a name — but it still identifies a
 * person, so a summary viewer sees only its digest. That keeps "who approved what" a
 * comparable value for audit UIs without handing out the directory key.
 */
export function redactCg4Actor(
  value: string,
  level: Cg4EvidenceAccessLevel,
): string | Cg4RedactedRef {
  return level === 'EVIDENCE' ? value : { redacted: true, digest: cg4RefDigest(value) };
}

/** One evidence-ref read, recorded so evidence access itself stays auditable (#190). */
export interface Cg4EvidenceAccessRecord {
  tenantId: string;
  viewerSubjectId: string;
  resourceKind: 'EXCEPTION' | 'POLICY_VERSION' | 'DECISION' | 'KILL_SWITCH';
  resourceId: string;
  level: Cg4EvidenceAccessLevel;
  occurredAt: string;
}

export interface Cg4EvidenceAccessSink {
  record(access: Cg4EvidenceAccessRecord): void | Promise<void>;
}

/**
 * Resolves the access level from capabilities the domain owner already verified. It takes
 * the resolved capability list, never a role name or a request flag, so there is no path
 * by which a caller can talk itself into `EVIDENCE`.
 */
export function resolveCg4EvidenceAccess(input: {
  capabilities: readonly { capability: string }[];
}): Cg4EvidenceAccessLevel {
  const held = new Set(input.capabilities.map((grant) => grant.capability));
  // Reading raw evidence is a compliance action: only the capabilities that already carry
  // approval or revocation authority imply it.
  const evidenceCapabilities = [
    'cg.exception.approve.standard',
    'cg.exception.approve.high',
    'cg.exception.revoke',
    'cg.policy.publish',
    'cg.policy.publish.relaxation',
    'cg.policy.rollback',
  ];
  return evidenceCapabilities.some((capability) => held.has(capability)) ? 'EVIDENCE' : 'SUMMARY';
}
