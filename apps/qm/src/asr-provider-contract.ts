/**
 * Contract test for the D-Contact ASR Provider Protocol v1 — ADR-010 point 6: every provider must pass it.
 *
 * Black-box over HTTP, so it runs against the simulator and against a real provider or gateway alike.
 * The caller provides a media URL the provider can really download (a STEREO WAV with speech on both sides).
 */
import {
  ASR_DATA_USE_HEADER,
  ASR_DATA_USE_NO_TRAINING,
  ASR_PROTOCOL_HEADER,
  ASR_PROTOCOL_VERSION,
  parseTranscriptionResult,
  readAsrErrorCode,
  type AsrTranscriptionRequest,
} from './asr-provider-protocol.js';
import type { TranscriptSpeaker } from './qm-transcription-worker.js';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AsrSpeakerWindow {
  speaker: TranscriptSpeaker;
  startMs: number;
  endMs: number;
}

export interface AsrProviderContractInput {
  /** Full URL of the transcriptions POST, e.g. https://asr.example/v1/transcriptions */
  endpoint: string;
  apiKey: string;
  stereoMediaUrl: string;
  /** Duration of the STEREO file: every segment must end within this value + 500 ms. */
  stereoDurationMs: number;
  /** Known speech windows: a segment of that speaker must overlap each window. */
  expectedSpeakers?: AsrSpeakerWindow[];
  languageHint?: string;
  fetch?: Fetch;
  now?: () => Date;
}

export interface AsrContractCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

const DURATION_TOLERANCE_MS = 500;

export async function runAsrProviderContract(
  input: AsrProviderContractInput,
): Promise<AsrContractCheck[]> {
  const request = input.fetch ?? fetch;
  const now = input.now ?? (() => new Date());
  const body = (overrides: Partial<Record<keyof AsrTranscriptionRequest, unknown>> = {}) =>
    JSON.stringify({
      mediaUrl: input.stereoMediaUrl,
      mediaUrlExpiresAt: new Date(now().getTime() + 300_000).toISOString(),
      channelLayout: 'STEREO',
      languageHint: input.languageHint ?? 'th-TH',
      dataUse: 'NO_TRAINING',
      ...overrides,
    });
  const headers = (overrides: Record<string, string | undefined> = {}) => {
    const all: Record<string, string | undefined> = {
      'content-type': 'application/json',
      authorization: `Bearer ${input.apiKey}`,
      [ASR_DATA_USE_HEADER]: ASR_DATA_USE_NO_TRAINING,
      [ASR_PROTOCOL_HEADER]: ASR_PROTOCOL_VERSION,
      ...overrides,
    };
    return Object.fromEntries(
      Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  };
  const post = (requestHeaders: Record<string, string>, requestBody: string) =>
    request(input.endpoint, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody,
      redirect: 'error',
    });

  const checks: AsrContractCheck[] = [];
  const expectRejected = async (
    name: string,
    response: Promise<Response>,
    status: number,
    code: string,
  ) => {
    try {
      const result = await response;
      const actual = readAsrErrorCode(await result.json().catch(() => undefined));
      const ok = result.status === status && actual === code;
      checks.push({
        name,
        ok,
        ...(ok ? {} : { detail: `got HTTP ${result.status} ${actual ?? '-'}` }),
      });
    } catch (error) {
      checks.push({ name, ok: false, detail: (error as Error).message });
    }
  };

  await expectRejected(
    'rejects a request without a bearer token (401 UNAUTHORIZED)',
    post(headers({ authorization: undefined }), body()),
    401,
    'UNAUTHORIZED',
  );
  await expectRejected(
    'rejects a request without the no-training header (400 DATA_USE_REQUIRED)',
    post(headers({ [ASR_DATA_USE_HEADER]: undefined }), body()),
    400,
    'DATA_USE_REQUIRED',
  );
  await expectRejected(
    'rejects a request whose dataUse is not NO_TRAINING (400 DATA_USE_REQUIRED)',
    post(headers(), body({ dataUse: 'TRAINING_ALLOWED' })),
    400,
    'DATA_USE_REQUIRED',
  );
  await expectRejected(
    'rejects an unknown protocol major version (400 PROTOCOL_UNSUPPORTED)',
    post(headers({ [ASR_PROTOCOL_HEADER]: '999' }), body()),
    400,
    'PROTOCOL_UNSUPPORTED',
  );
  await expectRejected(
    'rejects a non-HTTPS media URL (400 MEDIA_URL_NOT_ALLOWED)',
    post(headers(), body({ mediaUrl: input.stereoMediaUrl.replace(/^https:/, 'http:') })),
    400,
    'MEDIA_URL_NOT_ALLOWED',
  );
  const disallowedHost = new URL(input.stereoMediaUrl);
  disallowedHost.hostname = 'asr-contract-disallowed.invalid';
  await expectRejected(
    'rejects a media URL on a host outside its allow-list (400 MEDIA_URL_NOT_ALLOWED)',
    post(headers(), body({ mediaUrl: disallowedHost.toString() })),
    400,
    'MEDIA_URL_NOT_ALLOWED',
  );
  const otherPort = new URL(input.stereoMediaUrl);
  otherPort.port = '8443';
  await expectRejected(
    'rejects a media URL on a non-default port (400 MEDIA_URL_NOT_ALLOWED)',
    post(headers(), body({ mediaUrl: otherPort.toString() })),
    400,
    'MEDIA_URL_NOT_ALLOWED',
  );
  await expectRejected(
    'rejects an expired media URL (400 MEDIA_URL_EXPIRED)',
    post(headers(), body({ mediaUrlExpiresAt: new Date(now().getTime() - 1_000).toISOString() })),
    400,
    'MEDIA_URL_EXPIRED',
  );

  const name = 'transcribes a STEREO recording into a valid v1 response';
  try {
    const response = await post(headers(), body());
    if (!response.ok) {
      const code = readAsrErrorCode(await response.json().catch(() => undefined));
      checks.push({ name, ok: false, detail: `HTTP ${response.status} ${code ?? '-'}` });
      return checks;
    }
    const result = parseTranscriptionResult(await response.json());
    checks.push({ name, ok: true });

    const late = result.segments.find(
      (segment) => segment.endMs > input.stereoDurationMs + DURATION_TOLERANCE_MS,
    );
    checks.push({
      name: 'keeps every segment within the recording duration',
      ok: !late,
      ...(late ? { detail: `segment ends at ${late.endMs} ms` } : {}),
    });

    const ordered = result.segments.every(
      (segment, index, all) => index === 0 || all[index - 1]!.startMs <= segment.startMs,
    );
    checks.push({ name: 'orders segments by startMs', ok: ordered });

    for (const window of input.expectedSpeakers ?? []) {
      const found = result.segments.some(
        (segment) =>
          segment.speaker === window.speaker &&
          segment.startMs < window.endMs &&
          segment.endMs > window.startMs,
      );
      checks.push({
        name: `labels ${window.speaker} speech at ${window.startMs}-${window.endMs} ms from the STEREO channel`,
        ok: found,
      });
    }
  } catch (error) {
    checks.push({ name, ok: false, detail: (error as Error).message });
  }
  return checks;
}
