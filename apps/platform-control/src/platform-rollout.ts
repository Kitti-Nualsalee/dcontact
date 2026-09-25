/**
 * Owner: Platform operations — feature flag `platformProvisioning.enabled` + internal operator
 * allowlist (A1.8 #413, rollout/rollback ใน #388 checkpoint 2)
 *
 * - ปิด (default) = rollback: Platform API ปฏิเสธทุก mutation (create/edit/preview/recovery/resend)
 *   และ worker ไม่รับ lease/command ใหม่ — list/status/action history ยังอ่านได้, ledger/receipts/
 *   reservations ไม่ถูกแตะ งานค้างรอจนเปิดอีกครั้งแล้ว reconcile/resume ต่อ
 * - เปิด = canary: mutation ได้เฉพาะ Keycloak subject (opaque UUID) ที่อยู่ใน allowlist
 * - ค่ามาจาก env ตอน start (J5.5 ใช้ env kill switch แบบเดียวกัน): rollback = ตั้งค่าแล้ว restart
 *   API + worker — ไม่มี endpoint ให้ใครเปิด/ปิดเองระหว่างทำงาน
 */

export type PlatformMutationDecision = 'ALLOWED' | 'DISABLED' | 'NOT_ALLOWLISTED';

export interface PlatformRolloutState {
  enabled: boolean;
  /** Keycloak subject ของ Platform Operator ที่อยู่ใน canary */
  allowlist: readonly string[];
}

const SUBJECT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PlatformRollout {
  /** `read` ถูกเรียกทุกครั้ง — test สลับสถานะได้โดยไม่ต้องสร้าง process ใหม่ */
  constructor(private readonly read: () => PlatformRolloutState) {}

  static fixed(state: PlatformRolloutState): PlatformRollout {
    const frozen = { enabled: state.enabled, allowlist: [...state.allowlist] };
    return new PlatformRollout(() => frozen);
  }

  /**
   * `PLATFORM_PROVISIONING_ENABLED=true` เท่านั้นที่เปิด (ค่าอื่น/ไม่ตั้ง = ปิด) และ
   * `PLATFORM_OPERATOR_ALLOWLIST` เป็น subject คั่นด้วย comma — ค่าที่ไม่ใช่ UUID ทำให้ start ไม่ขึ้น
   * แทนที่จะถูกข้ามเงียบๆ
   */
  static fromEnv(env: NodeJS.ProcessEnv): PlatformRollout {
    const allowlist = (env.PLATFORM_OPERATOR_ALLOWLIST ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const invalid = allowlist.filter((value) => !SUBJECT.test(value));
    if (invalid.length > 0) {
      throw new Error(
        `PLATFORM_OPERATOR_ALLOWLIST มีค่าที่ไม่ใช่ subject UUID ${invalid.length} ค่า`,
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

  /** worker รับ lease ของ saga และ operator command ใหม่ได้หรือไม่ */
  claimsEnabled(): boolean {
    return this.read().enabled;
  }
}
