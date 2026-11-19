/**
 * #916: config ของ confidential client ที่ API ใช้ introspect access token ของ Workspace (Cus360 work)
 *
 * ไม่ตั้งทั้งคู่ = ปิดเฉพาะ Cus360 work (Workspace ไม่ประกาศ `workCustomerV1`) และต้องเห็นสาเหตุใน log
 * ตั้งไม่ครบ = config ผิด หยุด API ตั้งแต่เริ่ม; diagnostic ไม่พิมพ์ secret
 */
export const C360_WORK_CLIENT_ENV = Object.freeze([
  'KEYCLOAK_C360_CLIENT_ID',
  'KEYCLOAK_C360_CLIENT_SECRET',
] as const);

export type C360WorkConfig =
  | { readonly configured: true; readonly clientId: string; readonly clientSecret: string }
  | { readonly configured: false };

export function resolveC360WorkConfig(env: NodeJS.ProcessEnv): C360WorkConfig {
  const clientId = env.KEYCLOAK_C360_CLIENT_ID || undefined;
  const clientSecret = env.KEYCLOAK_C360_CLIENT_SECRET || undefined;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    const missing = clientId ? 'KEYCLOAK_C360_CLIENT_SECRET' : 'KEYCLOAK_C360_CLIENT_ID';
    throw new Error(`Cus360 confidential client configuration is incomplete: missing ${missing}`);
  }
  return clientId && clientSecret
    ? { configured: true, clientId, clientSecret }
    : { configured: false };
}

export type C360WorkUnavailableReason =
  'KEYCLOAK_C360_CLIENT_NOT_CONFIGURED' | 'C360_WRITE_RUNTIME_NOT_READY';

export type C360WorkReadinessDiagnostic =
  | {
      readonly event: 'customer_360.work.readiness';
      readonly status: 'ENABLED';
      readonly clientId: string;
    }
  | {
      readonly event: 'customer_360.work.readiness';
      readonly status: 'DISABLED';
      readonly reasons: readonly C360WorkUnavailableReason[];
      readonly missingEnv: readonly string[];
      readonly impact: string;
      readonly remediation: string;
    };

/** สถานะเดียวกับที่ใช้ตัดสิน `AGENT_WORKSPACE_CUSTOMER_AVAILABLE` — มีแค่ client id ไม่มี secret */
export function c360WorkReadiness(
  config: C360WorkConfig,
  writeRuntimeReady: boolean,
): C360WorkReadinessDiagnostic {
  if (config.configured && writeRuntimeReady)
    return { event: 'customer_360.work.readiness', status: 'ENABLED', clientId: config.clientId };
  const reasons: C360WorkUnavailableReason[] = [];
  if (!config.configured) reasons.push('KEYCLOAK_C360_CLIENT_NOT_CONFIGURED');
  if (!writeRuntimeReady) reasons.push('C360_WRITE_RUNTIME_NOT_READY');
  return {
    event: 'customer_360.work.readiness',
    status: 'DISABLED',
    reasons,
    missingEnv: config.configured ? [] : [...C360_WORK_CLIENT_ENV],
    impact: 'Workspace ไม่แสดงแผงข้อมูลลูกค้าของงาน (ไม่ประกาศ workCustomerV1)',
    remediation: config.configured
      ? 'ตรวจ contact-points runtime (dev) หรือ C360_WRITE_RELEASE_MANIFEST/C360_IMAGE_DIGEST ของ release (production)'
      : 'ตั้ง KEYCLOAK_C360_CLIENT_ID/SECRET เป็น confidential client ที่อยู่ใน aud ของ token Workspace — ดู docs/agent-usecase-dev.md',
  };
}
