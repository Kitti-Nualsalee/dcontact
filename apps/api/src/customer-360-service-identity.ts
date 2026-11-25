import type { Prisma } from '@d-contact/db';
import { lockC360ServicePrincipal } from '@d-contact/customer-360';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
import { Customer360HttpError } from './customer-360-api.js';

/** used only after the global OIDC service guard; the caller body is not an authority */
export function currentC360ServicePrincipal(
  tx: Prisma.TransactionClient,
  request: AuthenticatedGatewayRequest,
  expectedEpoch?: string,
) {
  const service = request.gatewayServiceIdentity,
    claims = request.gatewayVerifiedClaims as { iss?: unknown } | undefined;
  if (!service || typeof claims?.iss !== 'string' || service.expiresAt.getTime() <= Date.now())
    throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
  return lockC360ServicePrincipal(
    tx,
    {
      tenantId: service.tenantId,
      issuer: claims.iss,
      subject: service.subject,
      clientId: service.clientId,
    },
    expectedEpoch,
  );
}
