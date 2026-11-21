/**
 * External customer API (#954): สวิตช์ของ machine feature ต่อ deployment
 *
 * ค่าเริ่มต้นปิด: service token ถูกปฏิเสธทุก route ของลูกค้า โดย route ของ human ไม่เปลี่ยน
 * เปิดแล้วอ่าน/ค้นได้ทันที ส่วน create ต้องมี confidential client สำหรับ introspection
 * (`KEYCLOAK_C360_CLIENT_ID/SECRET` ชุดเดียวกับ Cus360 work) ไม่มี = create ตอบ 503 ไม่ fail open
 */
export type C360ServiceApiReadiness =
  | { readonly event: 'customer_360.service_api.readiness'; readonly status: 'DISABLED' }
  | {
      readonly event: 'customer_360.service_api.readiness';
      readonly status: 'ENABLED';
      readonly create: 'ENABLED' | 'DISABLED_NO_INTROSPECTION_CLIENT';
    };

export function resolveC360ServiceApiEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.C360_SERVICE_API;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // ค่าที่สะกดผิดต้องไม่ถูกตีความเป็นเปิดหรือปิดเงียบ ๆ
  throw new Error('C360_SERVICE_API must be "on" or "off"');
}

export function c360ServiceApiReadiness(
  enabled: boolean,
  introspectionConfigured: boolean,
): C360ServiceApiReadiness {
  if (!enabled) return { event: 'customer_360.service_api.readiness', status: 'DISABLED' };
  return {
    event: 'customer_360.service_api.readiness',
    status: 'ENABLED',
    create: introspectionConfigured ? 'ENABLED' : 'DISABLED_NO_INTROSPECTION_CLIENT',
  };
}
