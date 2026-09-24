export interface PlatformDevUser {
  username: string;
  password: string;
  totpSecret: string;
  role: 'platform_operator' | 'platform_auditor';
}
export const PLATFORM_REALM: string;
export const PLATFORM_API_CLIENT: string;
export const PLATFORM_CONSOLE_CLIENT: string;
export const PLATFORM_ROLES: readonly string[];
export const PLATFORM_BROWSER_FLOW: string;
export const PLATFORM_CONSOLE_REDIRECT: string;
export const PLATFORM_DEV_USERS: readonly PlatformDevUser[];
export function setupKeycloakPlatform(options?: { withDevUsers?: boolean }): Promise<{
  apiClientUuid: string;
  consoleUuid: string;
  flowId: string;
  users: { username: string; id: string }[];
}>;
