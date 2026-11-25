/**
 * #907: registers the tenant's exact redirect on the deployment's Console client during the FIRST_ADMIN step
 *
 * - same format as the Console (`createConsoleOidcSettings`): `<origin>/?tenant=<slug>` for both login and post-logout
 * - the provisioner gets `view`/`manage` through fine-grained admin permission v2 on this client only (see
 *   `scripts/keycloak-provisioning-setup.mjs`), with no realm-wide `manage-clients`
 * - Keycloak takes the whole client on PUT, so a lost update among several workers is prevented with a Postgres advisory lock
 *   and a read-back verifies every time; it does not touch another tenant's redirect or the client's other values
 */
import type { PrismaClient } from '@d-contact/db';
import type { KeycloakAdminClient } from './keycloak-admin.js';
import { ProvisioningStepError } from './provisioning-saga.js';
import type { TenantConsoleContext } from './tenant-console-context.js';

const POST_LOGOUT = 'post.logout.redirect.uris';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

interface KeycloakClient {
  id: string;
  clientId: string;
  publicClient?: boolean;
  redirectUris?: string[];
  attributes?: Record<string, string>;
  [key: string]: unknown;
}

/** the same URL the Console builds as `redirect_uri` and `post_logout_redirect_uri` */
export function tenantConsoleRedirect(origin: string, slug: string): string {
  if (!SLUG.test(slug) || slug.includes('--')) {
    throw new ProvisioningStepError('PERMANENT', 'TENANT_CONSOLE_SLUG_INVALID');
  }
  const url = new URL('/', origin);
  url.searchParams.set('tenant', slug);
  return url.toString();
}

function postLogout(client: KeycloakClient): string[] {
  const value = client.attributes?.[POST_LOGOUT] ?? '';
  return value ? value.split('##').filter(Boolean) : [];
}

export function redirectRegistered(client: KeycloakClient, redirect: string): boolean {
  return (client.redirectUris ?? []).includes(redirect) && postLogout(client).includes(redirect);
}

/** the client obtained must be a public + PKCE tenant Console only — keeps a redirect from being added to another client */
function assertConsoleClient(client: KeycloakClient | undefined, clientId: string): KeycloakClient {
  if (
    !client ||
    client.clientId !== clientId ||
    client.publicClient !== true ||
    client.attributes?.['pkce.code.challenge.method'] !== 'S256'
  ) {
    throw new ProvisioningStepError('PERMANENT', 'TENANT_CONSOLE_CLIENT_UNEXPECTED');
  }
  return client;
}

export class TenantConsoleRedirects {
  constructor(
    private readonly keycloak: Pick<KeycloakAdminClient, 'admin'>,
    /** only the advisory lock is used — any role connected to the same DB as the other workers */
    private readonly lock: Pick<PrismaClient, '$transaction'>,
    private readonly context: TenantConsoleContext,
  ) {}

  redirect(slug: string) {
    return tenantConsoleRedirect(this.context.origin, slug);
  }

  private async client(signal?: AbortSignal): Promise<KeycloakClient> {
    const { body } = await this.keycloak.admin<KeycloakClient[]>(
      'GET',
      `/clients?${new URLSearchParams({ clientId: this.context.clientId })}`,
      signal ? { signal } : {},
    );
    const matches = (body ?? []).filter((client) => client.clientId === this.context.clientId);
    if (matches.length !== 1) {
      throw new ProvisioningStepError('PERMANENT', 'TENANT_CONSOLE_CLIENT_MISSING');
    }
    const { body: full } = await this.keycloak.admin<KeycloakClient>(
      'GET',
      `/clients/${encodeURIComponent(matches[0]!.id)}`,
      signal ? { signal } : {},
    );
    return assertConsoleClient(full, this.context.clientId);
  }

  async registered(slug: string, signal?: AbortSignal): Promise<boolean> {
    return redirectRegistered(await this.client(signal), this.redirect(slug));
  }

  async register(slug: string, signal?: AbortSignal): Promise<void> {
    const redirect = this.redirect(slug);
    await this.lock.$transaction(
      async (transaction) => {
        // every worker writes the same client: serialize GET → PUT → read-back for the whole set
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:tenant-console-redirects:${this.context.clientId}`}, 0))`;
        const current = await this.client(signal);
        if (redirectRegistered(current, redirect)) return;
        const redirects = current.redirectUris ?? [];
        const logout = postLogout(current);
        await this.keycloak.admin('PUT', `/clients/${encodeURIComponent(current.id)}`, {
          ...(signal ? { signal } : {}),
          body: {
            ...current,
            redirectUris: redirects.includes(redirect) ? redirects : [...redirects, redirect],
            attributes: {
              ...current.attributes,
              [POST_LOGOUT]: (logout.includes(redirect) ? logout : [...logout, redirect]).join(
                '##',
              ),
            },
          },
        });
        const readBack = await this.client(signal);
        const before = new Set([...(current.redirectUris ?? []), redirect]);
        if (
          !redirectRegistered(readBack, redirect) ||
          (readBack.redirectUris ?? []).length !== before.size ||
          ![...before].every((uri) => (readBack.redirectUris ?? []).includes(uri))
        ) {
          throw new ProvisioningStepError('AMBIGUOUS', 'TENANT_CONSOLE_REDIRECT_READ_BACK_FAILED');
        }
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
  }
}
