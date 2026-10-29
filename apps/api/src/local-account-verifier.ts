import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  toVerifiedServiceIdentity,
  toVerifiedWorkspaceIdentity,
  WorkspaceAuthenticationError,
  type OidcAccessTokenVerifier,
} from '@d-contact/workspace-session';

export class LocalAccountAccessTokenVerifier implements OidcAccessTokenVerifier {
  constructor(
    private readonly verifier: OidcAccessTokenVerifier,
    private readonly accountActive: (tenantId: string, userId: string) => Promise<boolean>,
  ) {}

  async verifyAccessToken(accessToken: string) {
    const claims = await this.verifier.verifyAccessToken(accessToken);
    if (claims.dc_user_id === undefined && claims.sid === undefined) {
      toVerifiedServiceIdentity(claims);
      return claims;
    }
    const identity = toVerifiedWorkspaceIdentity(claims);
    try {
      if (!(await this.accountActive(identity.tenantId, identity.userId)))
        throw new WorkspaceAuthenticationError();
    } catch {
      throw new WorkspaceAuthenticationError();
    }
    return claims;
  }
}

export function withLocalAccountAdmission(
  database: PrismaClient,
  verifier: OidcAccessTokenVerifier,
): OidcAccessTokenVerifier {
  return new LocalAccountAccessTokenVerifier(verifier, (tenantId, userId) =>
    withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { tenantId, id: userId, isActive: true },
        select: { id: true },
      });
      return user !== null;
    }),
  );
}
