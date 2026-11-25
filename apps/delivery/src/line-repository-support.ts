/**
 * Owner: Delivery/Channels — shared errors and helpers of the LINE persistence primitives (S2.1 #365)
 *
 * Every primitive runs inside `withTenantDatabaseTransaction` so RLS really engages with the application
 * role; a cross-tenant binding therefore fails at the composite FK/RLS and is converted into a single generic error
 * that does not reveal whether another tenant's ID exists
 */
import { Prisma } from '@d-contact/db';

/** The binding failed (FK/RLS) — the message cites no ID so it does not reveal the existence of another tenant's data */
export class LineBindingRejectedError extends Error {
  readonly code = 'LINE_BINDING_REJECTED';

  constructor() {
    super('LINE persistence binding failed');
    this.name = 'LineBindingRejectedError';
  }
}

/** The same key but a different canonical input — must not overwrite the original */
export class LineIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly subject: string) {
    super(`${subject} used the same idempotency key with a different input`);
    this.name = 'LineIdempotencyConflictError';
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/** Convert an FK violation into the generic binding error; other errors (CHECK/trigger) pass through unchanged */
export async function rejectingForeignBinding<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new LineBindingRejectedError();
    throw error;
  }
}
