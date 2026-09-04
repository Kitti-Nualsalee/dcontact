import type {
  TranscriptionProvider,
  TranscriptionProviderResult,
} from './qm-transcription-worker.js';

export interface HttpTranscriptionProviderConfiguration {
  id: string;
  endpoint: string;
  apiKey?: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Provider-neutral HTTPS adapter; deployment gateway maps this contract to cloud or on-prem ASR. */
export class HttpTranscriptionProvider implements TranscriptionProvider {
  readonly id: string;
  private readonly endpoint: URL;

  constructor(
    configuration: HttpTranscriptionProviderConfiguration,
    private readonly request: Fetch = fetch,
  ) {
    this.id = configuration.id.trim();
    this.endpoint = new URL(configuration.endpoint);
    if (!this.id) throw new Error('transcription provider id is required');
    if (this.endpoint.protocol !== 'https:') {
      throw new Error('transcription provider endpoint must use HTTPS');
    }
    this.apiKey = configuration.apiKey;
  }

  private readonly apiKey?: string;

  async transcribe(
    input: Parameters<TranscriptionProvider['transcribe']>[0],
  ): Promise<TranscriptionProviderResult> {
    if (input.dataUse !== 'NO_TRAINING') {
      throw new Error('transcription provider requires NO_TRAINING');
    }
    if (new URL(input.mediaUrl).protocol !== 'https:') {
      throw new Error('transcription media URL must use HTTPS');
    }
    const response = await this.request(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dcontact-data-use': 'no-training',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      throw new Error(`transcription provider returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray((payload as { segments?: unknown }).segments)
    ) {
      throw new Error('transcription provider returned an invalid response');
    }
    return payload as TranscriptionProviderResult;
  }
}
