/**
 * #901: deployment context ของ tenant Console ที่ binding ของ first admin ผูกไว้
 *
 * issuer/client เป็น operator config ของ worker ไม่มาจาก request หรือ token และต้องตรง `iss`/`azp`
 * ที่ API ตรวจจาก Console session จริง (`tenantConfigurationCaller`)
 */
export interface TenantConsoleContext {
  issuer: string;
  clientId: string;
}

/** client ที่เป็นของ platform/Keycloak เอง — ห้ามใช้เป็น tenant Console (ตรงกับ guard ฝั่ง API และ DB) */
const PROTECTED_CLIENTS = new Set([
  'platform-console',
  'dcontact-platform-api',
  'realm-management',
  'admin-cli',
]);

const ISSUER = /^https?:\/\/[^\s/]+(\/\S*)?\/realms\/[A-Za-z0-9._-]+$/;
const CLIENT = /^[A-Za-z0-9._-]{1,255}$/;

export function tenantConsoleContext(issuer: string, clientId: string): TenantConsoleContext {
  if (!ISSUER.test(issuer)) {
    throw new Error('PLATFORM_TENANT_CONSOLE_ISSUER ต้องเป็น issuer ของ realm (…/realms/<realm>)');
  }
  if (!CLIENT.test(clientId) || PROTECTED_CLIENTS.has(clientId)) {
    throw new Error('PLATFORM_TENANT_CONSOLE_CLIENT_ID ต้องเป็น client ของ tenant Console');
  }
  return { issuer, clientId };
}

export function tenantConsoleContextFromEnv(
  env: Record<string, string | undefined>,
): TenantConsoleContext {
  return tenantConsoleContext(
    env.PLATFORM_TENANT_CONSOLE_ISSUER ?? '',
    env.PLATFORM_TENANT_CONSOLE_CLIENT_ID ?? '',
  );
}
