/**
 * #916: the config of the confidential client the API uses to introspect the Workspace access token (Cus360 work)
 *
 * neither set = disables only Cus360 work (the Workspace does not announce `workCustomerV1`) and the cause must be visible in the log
 * incompletely set = a wrong config, the API stops at start; the diagnostic never prints a secret
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

/** the same status used to decide `AGENT_WORKSPACE_CUSTOMER_AVAILABLE` — only the client id, no secret */
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
    impact: 'The Workspace does not show the work customer panel (workCustomerV1 is not announced)',
    remediation: config.configured
      ? 'Check the contact-points runtime (dev) or C360_WRITE_RELEASE_MANIFEST/C360_IMAGE_DIGEST of the release (production)'
      : 'Set KEYCLOAK_C360_CLIENT_ID/SECRET to a confidential client that is in the aud of the Workspace token — see docs/agent-usecase-dev.md',
  };
}
