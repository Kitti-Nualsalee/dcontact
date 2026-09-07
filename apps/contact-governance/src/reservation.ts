export type ReservationState = 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'REFUNDED';
export type ReservationCommand = 'CONFIRM' | 'RELEASE' | 'REFUND';

export interface ReservationSnapshot {
  id: string;
  state: ReservationState;
}

export class InvalidReservationTransitionError extends Error {
  readonly code = 'INVALID_RESERVATION_TRANSITION';

  constructor(state: ReservationState, command: ReservationCommand) {
    super(`unsupported reservation transition: ${state} -> ${command}`);
    this.name = 'InvalidReservationTransitionError';
  }
}

export function transitionReservation(
  reservation: ReservationSnapshot,
  command: ReservationCommand,
): ReservationSnapshot {
  if (command === 'CONFIRM' && reservation.state === 'RESERVED') {
    return { ...reservation, state: 'CONFIRMED' };
  }

  if (command === 'CONFIRM' && reservation.state === 'CONFIRMED') {
    return reservation;
  }

  if (command === 'RELEASE' && reservation.state === 'RESERVED') {
    return { ...reservation, state: 'RELEASED' };
  }

  if (command === 'RELEASE' && reservation.state === 'RELEASED') {
    return reservation;
  }

  if (command === 'REFUND' && reservation.state === 'CONFIRMED') {
    return { ...reservation, state: 'REFUNDED' };
  }

  if (command === 'REFUND' && reservation.state === 'REFUNDED') {
    return reservation;
  }

  throw new InvalidReservationTransitionError(reservation.state, command);
}
