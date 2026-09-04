import type { QmAutoScoreAnswer, QmScoringProvider } from './qm-transcription-worker.js';

export interface HttpScoringProviderConfiguration {
  id: string;
  endpoint: string;
  modelId: string;
  promptVersion: string;
  apiKey?: string;
}

export class HttpScoringProvider implements QmScoringProvider {
  readonly id: string;
  readonly modelId: string;
  readonly promptVersion: string;
  private readonly endpoint: URL;
  private readonly apiKey?: string;

  constructor(configuration: HttpScoringProviderConfiguration) {
    this.id = configuration.id.trim();
    this.modelId = configuration.modelId.trim();
    this.promptVersion = configuration.promptVersion.trim();
    this.endpoint = new URL(configuration.endpoint);
    this.apiKey = configuration.apiKey;
    if (!this.id || !this.modelId || !this.promptVersion) {
      throw new Error('scoring provider id, model and prompt version are required');
    }
    if (this.endpoint.protocol !== 'https:') {
      throw new Error('scoring provider endpoint must use HTTPS');
    }
  }

  async score(
    input: Parameters<QmScoringProvider['score']>[0],
  ): Promise<{ answers: QmAutoScoreAnswer[] }> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dcontact-data-use': 'no-training',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        modelId: this.modelId,
        promptVersion: this.promptVersion,
        dataUse: 'NO_TRAINING',
        ...input,
      }),
    });
    if (!response.ok) throw new Error(`scoring provider returned HTTP ${response.status}`);
    const payload = (await response.json()) as { answers?: unknown };
    if (!Array.isArray(payload.answers))
      throw new Error('scoring provider returned invalid answers');
    return { answers: payload.answers as QmAutoScoreAnswer[] };
  }
}
