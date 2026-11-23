import {
  ASR_DATA_USE_HEADER,
  ASR_DATA_USE_NO_TRAINING,
  ASR_PROTOCOL_HEADER,
  ASR_PROTOCOL_VERSION,
  parseTranscriptionResult,
  readAsrErrorCode,
} from './asr-provider-protocol.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderResult,
} from './qm-transcription-worker.js';

export interface HttpTranscriptionProviderConfiguration {
  id: string;
  endpoint: string;
  apiKey?: string;
  /** เวลารอ provider ต่อคำขอ ค่าเริ่มต้น 5 นาที (protocol v1 เป็น synchronous) */
  timeoutMs?: number;
}

export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 300_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Client ของ D-Contact ASR Provider Protocol v1 (docs/qm-asr-provider-protocol.md)
 * provider จริงหรือ gateway ของ deployment แปลงสัญญานี้ไปเป็น ASR แบบ cloud หรือ on-prem
 */
export class HttpTranscriptionProvider implements TranscriptionProvider {
  readonly id: string;
  private readonly endpoint: URL;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

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
    this.timeoutMs = configuration.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('transcription provider timeout must be a positive integer');
    }
  }

  async transcribe(
    input: Parameters<TranscriptionProvider['transcribe']>[0],
  ): Promise<TranscriptionProviderResult> {
    if (input.dataUse !== 'NO_TRAINING') {
      throw new Error('transcription provider requires NO_TRAINING');
    }
    if (new URL(input.mediaUrl).protocol !== 'https:') {
      throw new Error('transcription media URL must use HTTPS');
    }
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ASR_DATA_USE_HEADER]: ASR_DATA_USE_NO_TRAINING,
          [ASR_PROTOCOL_HEADER]: ASR_PROTOCOL_VERSION,
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`transcription provider timed out after ${this.timeoutMs} ms`);
      }
      throw error;
    }
    if (!response.ok) {
      const code = readAsrErrorCode(await response.json().catch(() => undefined));
      throw new Error(
        `transcription provider returned HTTP ${response.status}${code ? ` ${code}` : ''}`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('transcription provider returned an invalid response: body is not JSON');
    }
    try {
      return parseTranscriptionResult(payload);
    } catch (error) {
      throw new Error(
        `transcription provider returned an invalid response: ${(error as Error).message}`,
      );
    }
  }
}
