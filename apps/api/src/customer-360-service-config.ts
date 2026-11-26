/**
 * External customer API (#954): the machine feature switch per deployment
 *
 * off by default: service tokens are rejected on every customer route, while the human routes are unchanged
 * once on, read/search work at once while create needs a confidential client for introspection
 * (`KEYCLOAK_C360_CLIENT_ID/SECRET`, the same set as Cus360 work); none = create answers 503, never fail open
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
  // a misspelled value must not be silently interpreted as on or off
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
