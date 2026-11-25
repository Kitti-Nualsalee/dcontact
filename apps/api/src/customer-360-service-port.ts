import type { ServerResponse } from 'node:http';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

/**
 * External customer API (#954): the service principal slot on the same path as the Console
 *
 * this token not provided = the whole machine feature is off (the default) while the human routes are unchanged
 * separated from the implementation so the controller can reference the token without a circular import
 */
export const CUSTOMER_360_SERVICE_API = Symbol('CUSTOMER_360_SERVICE_API');
export const C360_SERVICE_READ_SCOPE = 'customer360.contacts.read';
export const C360_SERVICE_CREATE_SCOPE = 'customer360.contacts.create';

export interface Customer360ServicePort {
  create(req: AuthenticatedGatewayRequest, body: unknown, response: ServerResponse): Promise<void>;
  search(req: AuthenticatedGatewayRequest, body: unknown): Promise<unknown>;
  profile(req: AuthenticatedGatewayRequest, contactId: string): Promise<unknown>;
  command(
    req: AuthenticatedGatewayRequest,
    commandId: string,
    response: ServerResponse,
  ): Promise<void>;
  reconcile(
    req: AuthenticatedGatewayRequest,
    commandId: string,
    body: unknown,
    response: ServerResponse,
  ): Promise<void>;
}
