import type { ServerResponse } from 'node:http';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

/**
 * External customer API (#954): ช่องของ service principal บน path เดียวกับ Console
 *
 * ไม่ได้ provide token นี้ = ปิด machine feature ทั้งชุด (ค่าเริ่มต้น) โดย route ของ human ไม่เปลี่ยน
 * แยกไฟล์จาก implementation เพื่อให้ controller อ้าง token ได้โดยไม่เกิด import วน
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
