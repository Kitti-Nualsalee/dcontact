export interface PeopleTelephonyNode {
  telephonyNodeId: string;
  releaseDigest: string;
  dialplanDigest: string;
  extensions: readonly string[];
}
export interface PeopleExtensionPermit {
  ref: string;
  telephonyNodeId: string;
  releaseDigest: string;
  dialplanDigest: string;
  policyRevision: number;
}

export function extensionPermit(
  pool: unknown,
  policyRevision: number,
  ref: string,
  nodes: readonly PeopleTelephonyNode[],
): PeopleExtensionPermit | null {
  if (
    !Array.isArray(pool) ||
    !Number.isInteger(policyRevision) ||
    policyRevision < 1 ||
    !/^[0-9]{4,6}$/.test(ref)
  )
    return null;
  const matches = pool.filter(
    (value) =>
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'ref' in value &&
      value.ref === ref,
  );
  if (matches.length !== 1) return null;
  const entry: Record<string, unknown> = Object.fromEntries(Object.entries(matches[0]));
  if (
    Object.keys(entry).sort().join(',') !== 'dialplanDigest,ref,releaseDigest,telephonyNodeId' ||
    typeof entry.telephonyNodeId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(entry.telephonyNodeId) ||
    typeof entry.releaseDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.releaseDigest) ||
    typeof entry.dialplanDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.dialplanDigest)
  )
    return null;
  const configured = nodes.filter((node) => node.telephonyNodeId === entry.telephonyNodeId);
  if (
    configured.length !== 1 ||
    configured[0]!.releaseDigest !== entry.releaseDigest ||
    configured[0]!.dialplanDigest !== entry.dialplanDigest ||
    !configured[0]!.extensions.includes(ref)
  )
    return null;
  return {
    ref,
    telephonyNodeId: entry.telephonyNodeId,
    releaseDigest: entry.releaseDigest,
    dialplanDigest: entry.dialplanDigest,
    policyRevision,
  };
}

export function acceptedExtensionMatches(
  raw: unknown,
  nodes: readonly PeopleTelephonyNode[],
): boolean {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !('policyRevision' in raw) ||
    typeof raw.policyRevision !== 'number' ||
    !('ref' in raw) ||
    typeof raw.ref !== 'string'
  )
    return false;
  const { policyRevision, ...entry } = Object.fromEntries(Object.entries(raw));
  return extensionPermit([entry], raw.policyRevision, raw.ref, nodes) !== null;
}
