import type { QmAutoScoreAnswer, QmScoringProvider } from './qm-transcription-worker.js';

export interface HttpScoringProviderConfiguration {
  id: string;
  endpoint: string;
  modelId: string;
  promptVersion: string;
  apiKey?: string;
  /** How long to wait for the scorer per request; default 2 minutes. */
  timeoutMs?: number;
}

export const DEFAULT_SCORING_TIMEOUT_MS = 120_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class HttpScoringProvider implements QmScoringProvider {
  readonly id: string;
  readonly modelId: string;
  readonly promptVersion: string;
  private readonly endpoint: URL;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(
    configuration: HttpScoringProviderConfiguration,
    private readonly request: Fetch = fetch,
  ) {
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
    // without a bound a hung scorer would hold the job (and its Kafka partition) forever
    this.timeoutMs = configuration.timeoutMs ?? DEFAULT_SCORING_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('scoring provider timeout must be a positive integer');
    }
  }

  async score(
    input: Parameters<QmScoringProvider['score']>[0],
  ): Promise<{ answers: QmAutoScoreAnswer[] }> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
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
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`scoring provider timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    }
    if (!response.ok) throw new Error(`scoring provider returned HTTP ${response.status}`);
    const payload = (await response.json()) as { answers?: unknown };
    if (!Array.isArray(payload.answers))
      throw new Error('scoring provider returned invalid answers');
    return { answers: payload.answers as QmAutoScoreAnswer[] };
  }
}
