import type {
  VoiceRolloutAuthority,
  VoiceRolloutScope,
  VoiceRolloutEvaluationInput,
  VoiceRolloutAuthorizationInput,
  VoiceRolloutAuthorization,
} from './voice-rollout-control.js';

export class E1SandboxVoiceRollout implements VoiceRolloutAuthority {
  constructor(
    private readonly authority: VoiceRolloutAuthority,
    private readonly scope: VoiceRolloutScope,
  ) {}

  async evaluate(input: VoiceRolloutEvaluationInput): Promise<VoiceRolloutAuthorization> {
    if (
      input.tenantId !== this.scope.tenantId ||
      input.telephonyNodeId !== this.scope.telephonyNodeId
    )
      return { status: 'DENIED', reasonCode: 'E1_SANDBOX_SCOPE_REQUIRED' };
    const result = await this.authority.evaluate(input);
    return result.status === 'ALLOWED' && result.state !== 'SANDBOX'
      ? { status: 'DENIED', reasonCode: 'E1_SANDBOX_SCOPE_REQUIRED' }
      : result;
  }

  async authorize(input: VoiceRolloutAuthorizationInput): Promise<VoiceRolloutAuthorization> {
    const evaluated = await this.evaluate(input);
    if (evaluated.status === 'DENIED') return evaluated;
    const result = await this.authority.authorize(input);
    return result.status === 'ALLOWED' && result.state !== 'SANDBOX'
      ? { status: 'DENIED', reasonCode: 'E1_SANDBOX_SCOPE_REQUIRED' }
      : result;
  }
}
