import {
  InvalidReservationTransitionError,
  RefundNotAllowedError,
  type ReservationSnapshot,
  type ReservationCommand,
} from '@d-contact/cxa-contracts';
export {
  InvalidReservationTransitionError,
  RefundNotAllowedError,
  type ReservationState,
  type RefundReservationCommand,
  type ReservationCommand,
  type ReservationSnapshot,
} from '@d-contact/cxa-contracts';

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
