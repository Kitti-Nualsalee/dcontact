/**
 * D-Contact ASR Provider Protocol v1 — the HTTP contract between QM and every ASR provider.
 * Full specification: docs/qm-asr-provider-protocol.md. This file holds the types and the validator
 * shared by the QM client and the contract test.
 */
import type {
  TranscriptionProviderResult,
  TranscriptionSegmentResult,
  TranscriptSpeaker,
} from './qm-transcription-worker.js';

export const ASR_PROTOCOL_VERSION = '1';
export const ASR_PROTOCOL_HEADER = 'x-dcontact-asr-protocol';
export const ASR_DATA_USE_HEADER = 'x-dcontact-data-use';
export const ASR_DATA_USE_NO_TRAINING = 'no-training';
export const ASR_TRANSCRIPTIONS_PATH = '/v1/transcriptions';
export const ASR_HEALTH_PATH = '/v1/health';

export const TRANSCRIPT_SPEAKERS: readonly TranscriptSpeaker[] = [
  'AGENT',
  'CONTACT',
  'SYSTEM',
  'IVR',
];

export type AsrChannelLayout = 'PER_LEG' | 'STEREO';

export interface AsrTranscriptionRequest {
  mediaUrl: string;
  mediaUrlExpiresAt: string;
  channelLayout: AsrChannelLayout;
  languageHint: string;
  dataUse: 'NO_TRAINING';
}

export type AsrErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'DATA_USE_REQUIRED'
  | 'PROTOCOL_UNSUPPORTED'
  | 'MEDIA_URL_NOT_ALLOWED'
  | 'MEDIA_URL_EXPIRED'
  | 'MEDIA_FETCH_FAILED'
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_UNSUPPORTED'
  | 'REQUEST_TOO_LARGE'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface AsrErrorBody {
  error: { code: AsrErrorCode | string; message: string };
}

export class AsrProtocolError extends Error {
  override readonly name = 'AsrProtocolError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validates a v1 response body and returns only the fields QM uses (other provider fields are dropped). */
export function parseTranscriptionResult(payload: unknown): TranscriptionProviderResult {
  if (!isRecord(payload)) throw new AsrProtocolError('response must be a JSON object');
  const { modelId, language, confidenceAvg, segments } = payload;
  if (typeof modelId !== 'string' || !modelId.trim()) {
    throw new AsrProtocolError('response.modelId is required');
  }
  if (typeof language !== 'string' || !language.trim()) {
    throw new AsrProtocolError('response.language is required');
  }
  if (!isUnitInterval(confidenceAvg)) {
    throw new AsrProtocolError('response.confidenceAvg must be between 0 and 1');
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new AsrProtocolError('response.segments must contain at least one segment');
  }
  const parsed = segments.map((segment, index): TranscriptionSegmentResult => {
    const at = `response.segments[${index}]`;
    if (!isRecord(segment)) throw new AsrProtocolError(`${at} must be an object`);
    const { speaker, startMs, endMs, text, confidence } = segment;
    if (!TRANSCRIPT_SPEAKERS.includes(speaker as TranscriptSpeaker)) {
      throw new AsrProtocolError(`${at}.speaker must be one of ${TRANSCRIPT_SPEAKERS.join(', ')}`);
    }
    if (!isNonNegativeInteger(startMs) || !isNonNegativeInteger(endMs) || endMs <= startMs) {
      throw new AsrProtocolError(`${at} requires integer startMs < endMs`);
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new AsrProtocolError(`${at}.text is required`);
    }
    if (confidence !== undefined && !isUnitInterval(confidence)) {
      throw new AsrProtocolError(`${at}.confidence must be between 0 and 1`);
    }
    return {
      speaker: speaker as TranscriptSpeaker,
      startMs,
      endMs,
      text,
      ...(confidence === undefined ? {} : { confidence }),
    };
  });
  return { modelId, language, confidenceAvg, segments: parsed };
}

/** Reads error.code from a non-2xx response body; undefined when the provider did not follow the format. */
export function readAsrErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  const code = payload.error.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}
