export interface JourneyActionIdentity {
  enrollmentId: string;
  journeyVersion: number;
  stepId: string;
}

export function createJourneyActionKey(identity: JourneyActionIdentity): string {
  return `${identity.enrollmentId}:${identity.journeyVersion}:${identity.stepId}`;
}
