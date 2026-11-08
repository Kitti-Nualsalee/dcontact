import type { WorkspaceSession } from './workspace-session.js';

/** Binding ภายใน server เท่านั้น ห้ามรวมใน WorkspaceSession หรือ socket payload ที่ส่ง browser */
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
