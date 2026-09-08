export type ReservationState = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'REFUNDED';
export interface RefundReservationCommand {
  type: 'REFUND';
  outcome: 'DELIVERY_FAILED' | 'DELIVERED';
}

export type ReservationCommand = 'CONFIRM' | 'RELEASE' | RefundReservationCommand;

export interface ReservationSnapshot {
  id: string;
  state: ReservationState;
}

export class InvalidReservationTransitionError extends Error {
  readonly code = 'INVALID_RESERVATION_TRANSITION';

  constructor(state: ReservationState, command: ReservationCommand) {
    super(
      `ไม่รองรับ reservation transition: ${state} -> ${typeof command === 'string' ? command : command.type}`,
    );
    this.name = 'InvalidReservationTransitionError';
  }
}

export class RefundNotAllowedError extends Error {
  readonly code = 'REFUND_NOT_ALLOWED';

  constructor(readonly outcome: RefundReservationCommand['outcome']) {
    super(`ไม่อนุญาตให้ refund reservation สำหรับ outcome ${outcome}`);
    this.name = 'RefundNotAllowedError';
  }
}

export function transitionReservation(
  reservation: ReservationSnapshot,
  command: ReservationCommand,
): ReservationSnapshot {
  if (typeof command !== 'string' && command.outcome !== 'DELIVERY_FAILED') {
    throw new RefundNotAllowedError(command.outcome);
  }
  const commandType = typeof command === 'string' ? command : command.type;

  if (commandType === 'CONFIRM' && reservation.state === 'RESERVED') {
    return { ...reservation, state: 'CONFIRMED' };
  }

  if (commandType === 'CONFIRM' && reservation.state === 'CONFIRMED') {
    return reservation;
  }

  if (commandType === 'RELEASE' && reservation.state === 'RESERVED') {
    return { ...reservation, state: 'RELEASED' };
  }

  if (commandType === 'RELEASE' && reservation.state === 'RELEASED') {
    return reservation;
  }

  if (commandType === 'REFUND' && reservation.state === 'CONFIRMED') {
    return { ...reservation, state: 'REFUNDED' };
  }

  if (commandType === 'REFUND' && reservation.state === 'REFUNDED') {
    return reservation;
  }

  throw new InvalidReservationTransitionError(reservation.state, command);
}
