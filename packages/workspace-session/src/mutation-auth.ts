import type { WorkspaceSession } from './workspace-session.js';

/** Binding internal to the server only; must not be included in WorkspaceSession or a socket payload sent to the browser */
export interface WorkspaceMutationAuthBinding {
  tenantId: string;
  userId: string;
  leaseId: string;
  authEpoch: string;
  issuer: string;
  subject: string;
  sid: string;
  tokenFingerprint: string;
  tokenExpiresAt: Date;
}

export interface WorkspaceMutationAuthAuthority {
  reauthenticate(input: {
    accessToken: string;
    leaseId: string;
    identity?: Pick<WorkspaceSession, 'tenantId' | 'userId'>;
    expected?: WorkspaceMutationAuthBinding;
  }): Promise<WorkspaceMutationAuthBinding>;
  invalidateCaptured(binding: WorkspaceMutationAuthBinding, reason: string): Promise<boolean>;
}
