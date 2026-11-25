/**
 * Owner: Delivery/Channels — deterministic id minting of the LINE simulation (S1.6)
 *
 * Every id is derived from (tenantId, actionKey, kind, salt) via sha256, with no `randomUUID`
 * or process-bound counter — a restart on a shared store must mint the same id again
 * for the same input (see `line-delivery-port.ts` §restart/replay)
 */
import { createHash } from 'node:crypto';

export type LineIdKind = 'delivery' | 'provider-request' | 'outcome' | 'event';

const PREFIX: Record<LineIdKind, string> = {
  delivery: 'line-dlv',
  'provider-request': 'line-prq',
  outcome: 'line-ocr',
  event: 'line-evt',
};

export function mintLineId(
  kind: LineIdKind,
  tenantId: string,
  actionKey: string,
  salt: string,
): string {
  const digest = createHash('sha256')
    .update([kind, tenantId, actionKey, salt].join('|'))
    .digest('hex');
  return `${PREFIX[kind]}_${digest.slice(0, 32)}`;
}
