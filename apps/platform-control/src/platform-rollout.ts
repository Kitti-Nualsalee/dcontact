/**
 * Owner: Platform operations — feature flag `platformProvisioning.enabled` + internal operator
 * allowlist (A1.8 #413, rollout/rollback in #388 checkpoint 2)
 *
 * - off (default) = rollback: the Platform API rejects every mutation (create/edit/preview/recovery/resend)
 *   and the worker takes no new lease/command — list/status/action history stay readable, ledger/receipts/
 *   reservations are untouched; pending work waits until it is turned on again, then reconciles/resumes
 * - on = canary: mutation only for Keycloak subjects (opaque UUID) in the allowlist
 * - the value comes from env at start (J5.5 uses the same env kill switch): rollback = change the value and restart
 *   the API + worker — there is no endpoint for anyone to switch it on/off while running
 */

export type PlatformMutationDecision = 'ALLOWED' | 'DISABLED' | 'NOT_ALLOWLISTED';

export interface PlatformRolloutState {
  enabled: boolean;
  /** Keycloak subject of a Platform Operator in the canary */
  allowlist: readonly string[];
}

const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PlatformRollout {
  /** `read` is called every time — a test can switch the state without creating a new process */
  constructor(private readonly read: () => PlatformRolloutState) {}

  static fixed(state: PlatformRolloutState): PlatformRollout {
    const frozen = { enabled: state.enabled, allowlist: [...state.allowlist] };
    return new PlatformRollout(() => frozen);
  }

  /**
   * only `PLATFORM_PROVISIONING_ENABLED=true` turns it on (any other value/unset = off) and
   * `PLATFORM_OPERATOR_ALLOWLIST` is comma-separated subjects — a non-UUID value makes start fail
   * rather than being silently skipped
   */
  static fromEnv(env: NodeJS.ProcessEnv): PlatformRollout {
    const allowlist = (env.PLATFORM_OPERATOR_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const invalid = allowlist.filter((value) => !SUBJECT.test(value));
    if (invalid.length > 0) {
      throw new Error(
        `PLATFORM_OPERATOR_ALLOWLIST contains ${invalid.length} value(s) that are not a subject UUID`,
      );
    }
    return PlatformRollout.fixed({
      enabled: env.PLATFORM_PROVISIONING_ENABLED === 'true',
      allowlist,
    });
  }

  mutationFor(subject: string): PlatformMutationDecision {
    const state = this.read();
    if (!state.enabled) return 'DISABLED';
    return state.allowlist.includes(subject) ? 'ALLOWED' : 'NOT_ALLOWLISTED';
  }

  /** whether the worker may take a lease of a saga and new operator commands */
  claimsEnabled(): boolean {
    return this.read().enabled;
  }
}
