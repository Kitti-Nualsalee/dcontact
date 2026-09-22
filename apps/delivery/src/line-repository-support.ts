/**
 * Owner: Delivery/Channels — error และ helper ร่วมของ LINE persistence primitives (S2.1 #365)
 *
 * ทุก primitive ทำงานใน `withTenantDatabaseTransaction` เพื่อให้ RLS engage จริงกับ application
 * role; binding ข้าม tenant จึงล้มที่ composite FK/RLS แล้วถูกแปลงเป็น error เดียวแบบ generic
 * ที่ไม่บอกว่า ID ของ tenant อื่นมีอยู่หรือไม่
 */
import { Prisma } from '@d-contact/db';

/** binding ไม่ผ่าน (FK/RLS) — ข้อความไม่อ้าง ID ใด ๆ เพื่อไม่เผยการมีอยู่ของข้อมูล tenant อื่น */
export class LineBindingRejectedError extends Error {
  readonly code = 'LINE_BINDING_REJECTED';

  constructor() {
    super('binding ของ LINE persistence ไม่ผ่าน');
    this.name = 'LineBindingRejectedError';
  }
}

/** key เดิมแต่ canonical input ต่าง — ห้ามเขียนทับของเดิม */
export class LineIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly subject: string) {
    super(`${subject} ใช้ idempotency key เดิมกับ input ที่ต่างกัน`);
    this.name = 'LineIdempotencyConflictError';
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/** แปลง FK violation เป็น generic binding error; error อื่น (CHECK/trigger) ส่งต่อตามเดิม */
export async function rejectingForeignBinding<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new LineBindingRejectedError();
    throw error;
  }
}
