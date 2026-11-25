/**
 * ASR simulator implementing the D-Contact ASR Provider Protocol v1 (docs/qm-asr-provider-protocol.md).
 *
 * Stands in for a real ASR model until one exists: it downloads the real recording through the signed URL,
 * finds the regions with sound on each channel and returns segments with real speakers and timings,
 * but the text is a canned Thai phrase that always starts with the simulated prefix from
 * locales/asr-simulator.th.json.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ASR_DATA_USE_HEADER,
  ASR_DATA_USE_NO_TRAINING,
  ASR_HEALTH_PATH,
  ASR_PROTOCOL_HEADER,
  ASR_PROTOCOL_VERSION,
  ASR_TRANSCRIPTIONS_PATH,
  type AsrErrorCode,
  type AsrTranscriptionRequest,
} from './asr-provider-protocol.js';
import type {
  TranscriptionProviderResult,
  TranscriptionSegmentResult,
  TranscriptSpeaker,
} from './qm-transcription-worker.js';
import phrases from './locales/asr-simulator.th.json';
import { detectSpeechRegions, parsePcmWav, WavFormatError } from './wav-speech-regions.js';

export const ASR_SIMULATOR_MODEL_ID = 'dcontact-asr-simulator-v1';
/** Fixed and low so that nobody mistakes the output for a real model's result. */
export const ASR_SIMULATOR_CONFIDENCE = 0.5;
/** Prefix of every simulated transcript line. */
export const ASR_SIMULATOR_TEXT_PREFIX = phrases.prefix;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SEGMENTS = 2_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AsrSimulatorConfiguration {
  apiKey: string;
  /** Hostnames media may be downloaded from (SSRF guard). */
  mediaHosts: readonly string[];
  maxMediaBytes?: number;
  mediaTimeoutMs?: number;
  fetch?: Fetch;
  now?: () => Date;
}

export interface AsrSimulatorRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** True when the body exceeded the limit and was dropped while reading. */
  oversized?: boolean;
}

export interface AsrSimulatorResponse {
  status: number;
  body: unknown;
}

export interface AsrSimulatorLog {
  channelLayout?: string;
  durationMs?: number;
  segments?: number;
  status: number;
  code?: string;
}

function simulatedText(speaker: TranscriptSpeaker, turn: number): string {
  const lines = speaker === 'AGENT' ? phrases.agent : phrases.contact;
  return `${phrases.prefix} ${lines[turn % lines.length]}`;
}

class SimulatorError extends Error {
  constructor(
    readonly status: number,
    readonly code: AsrErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export class AsrSimulator {
  private readonly apiKeyDigest: Buffer;
  private readonly mediaHosts: ReadonlySet<string>;
  private readonly maxMediaBytes: number;
  private readonly mediaTimeoutMs: number;
  private readonly fetch: Fetch;
  private readonly now: () => Date;

  constructor(configuration: AsrSimulatorConfiguration) {
    if (!configuration.apiKey.trim()) throw new Error('ASR simulator API key is required');
    const hosts = configuration.mediaHosts.map((host) => host.trim().toLowerCase()).filter(Boolean);
    if (hosts.length === 0) throw new Error('ASR simulator media hosts are required');
    this.apiKeyDigest = digest(configuration.apiKey);
    this.mediaHosts = new Set(hosts);
    this.maxMediaBytes = configuration.maxMediaBytes ?? 128 * 1024 * 1024;
    this.mediaTimeoutMs = configuration.mediaTimeoutMs ?? 60_000;
    this.fetch = configuration.fetch ?? fetch;
    this.now = configuration.now ?? (() => new Date());
  }

  async handle(
    request: AsrSimulatorRequest,
  ): Promise<AsrSimulatorResponse & { log: AsrSimulatorLog }> {
    try {
      if (request.path === ASR_HEALTH_PATH) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          throw new SimulatorError(405, 'METHOD_NOT_ALLOWED', 'use GET');
        }
        return {
          status: 200,
          body: {
            status: 'ok',
            protocolVersion: ASR_PROTOCOL_VERSION,
            modelId: ASR_SIMULATOR_MODEL_ID,
            simulated: true,
          },
          log: { status: 200 },
        };
      }
      if (request.path !== ASR_TRANSCRIPTIONS_PATH) {
        throw new SimulatorError(404, 'NOT_FOUND', 'unknown path');
      }
      if (request.method !== 'POST')
        throw new SimulatorError(405, 'METHOD_NOT_ALLOWED', 'use POST');
      this.authorize(request.headers.authorization);
      const protocol = request.headers[ASR_PROTOCOL_HEADER];
      if (protocol !== undefined && protocol !== ASR_PROTOCOL_VERSION) {
        throw new SimulatorError(
          400,
          'PROTOCOL_UNSUPPORTED',
          `protocol ${ASR_PROTOCOL_VERSION} only`,
        );
      }
      const input = this.parseRequest(request);
      const { result, durationMs } = await this.transcribe(input);
      return {
        status: 200,
        body: { ...result, simulated: true },
        log: {
          status: 200,
          channelLayout: input.channelLayout,
          durationMs,
          segments: result.segments.length,
        },
      };
    } catch (error) {
      const problem =
        error instanceof SimulatorError
          ? error
          : new SimulatorError(500, 'INTERNAL', 'simulator failed');
      return {
        status: problem.status,
        body: { error: { code: problem.code, message: problem.message } },
        log: { status: problem.status, code: problem.code },
      };
    }
  }

  private authorize(header: string | undefined): void {
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token || !timingSafeEqual(digest(token), this.apiKeyDigest)) {
      throw new SimulatorError(401, 'UNAUTHORIZED', 'bearer token is missing or invalid');
    }
  }

  private parseRequest(request: AsrSimulatorRequest): AsrTranscriptionRequest {
    if (request.oversized || Buffer.byteLength(request.body) > MAX_REQUEST_BYTES) {
      throw new SimulatorError(413, 'REQUEST_TOO_LARGE', 'request body exceeds 64 KiB');
    }
    if (request.headers[ASR_DATA_USE_HEADER] !== ASR_DATA_USE_NO_TRAINING) {
      throw new SimulatorError(
        400,
        'DATA_USE_REQUIRED',
        `${ASR_DATA_USE_HEADER} must be no-training`,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(request.body) as Record<string, unknown>;
    } catch {
      throw new SimulatorError(400, 'INVALID_REQUEST', 'body must be JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new SimulatorError(400, 'INVALID_REQUEST', 'body must be a JSON object');
    }
    if (body.dataUse !== 'NO_TRAINING') {
      throw new SimulatorError(400, 'DATA_USE_REQUIRED', 'dataUse must be NO_TRAINING');
    }
    const { mediaUrl, mediaUrlExpiresAt, channelLayout, languageHint } = body;
    if (channelLayout !== 'STEREO' && channelLayout !== 'PER_LEG') {
      throw new SimulatorError(400, 'INVALID_REQUEST', 'channelLayout must be STEREO or PER_LEG');
    }
    if (typeof languageHint !== 'string' || !languageHint.trim()) {
      throw new SimulatorError(400, 'INVALID_REQUEST', 'languageHint is required');
    }
    if (typeof mediaUrl !== 'string') {
      throw new SimulatorError(400, 'INVALID_REQUEST', 'mediaUrl is required');
    }
    let url: URL;
    try {
      url = new URL(mediaUrl);
    } catch {
      throw new SimulatorError(400, 'INVALID_REQUEST', 'mediaUrl is not a URL');
    }
    // Port 443 only: the same host may run other services on other ports.
    if (
      url.protocol !== 'https:' ||
      url.port !== '' ||
      !this.mediaHosts.has(url.hostname.toLowerCase())
    ) {
      throw new SimulatorError(
        400,
        'MEDIA_URL_NOT_ALLOWED',
        'mediaUrl must be HTTPS on an allowed host',
      );
    }
    const expiresAt = typeof mediaUrlExpiresAt === 'string' ? Date.parse(mediaUrlExpiresAt) : NaN;
    if (Number.isNaN(expiresAt)) {
      throw new SimulatorError(
        400,
        'INVALID_REQUEST',
        'mediaUrlExpiresAt must be an ISO timestamp',
      );
    }
    if (expiresAt <= this.now().getTime()) {
      throw new SimulatorError(400, 'MEDIA_URL_EXPIRED', 'mediaUrl has expired');
    }
    return {
      mediaUrl,
      mediaUrlExpiresAt: mediaUrlExpiresAt as string,
      channelLayout,
      languageHint,
      dataUse: 'NO_TRAINING',
    };
  }

  private async download(mediaUrl: string): Promise<Buffer> {
    let response: Response;
    try {
      response = await this.fetch(mediaUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(this.mediaTimeoutMs),
      });
    } catch {
      throw new SimulatorError(502, 'MEDIA_FETCH_FAILED', 'media download failed');
    }
    if (!response.ok || !response.body) {
      throw new SimulatorError(502, 'MEDIA_FETCH_FAILED', `media returned HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (declared > this.maxMediaBytes) {
      await response.body.cancel();
      throw new SimulatorError(422, 'MEDIA_TOO_LARGE', 'media exceeds the simulator limit');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > this.maxMediaBytes) {
          throw new SimulatorError(422, 'MEDIA_TOO_LARGE', 'media exceeds the simulator limit');
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof SimulatorError) throw error;
      throw new SimulatorError(502, 'MEDIA_FETCH_FAILED', 'media download was interrupted');
    }
    return Buffer.concat(chunks, total);
  }

  private async transcribe(
    input: AsrTranscriptionRequest,
  ): Promise<{ result: TranscriptionProviderResult; durationMs: number }> {
    const media = await this.download(input.mediaUrl);
    let wav;
    try {
      wav = parsePcmWav(media);
    } catch (error) {
      if (error instanceof WavFormatError) {
        throw new SimulatorError(422, 'MEDIA_UNSUPPORTED', error.message);
      }
      throw error;
    }
    if (wav.durationMs === 0)
      throw new SimulatorError(422, 'MEDIA_UNSUPPORTED', 'media has no audio');

    const tracks: Array<{ speaker?: TranscriptSpeaker; channel: number }> =
      input.channelLayout === 'STEREO' && wav.channels === 2
        ? // FreeSWITCH RECORD_STEREO: left = caller (CONTACT on inbound calls), right = what the caller hears (AGENT)
          [
            { speaker: 'CONTACT', channel: 0 },
            { speaker: 'AGENT', channel: 1 },
          ]
        : // Mono/mixed audio: simulate diarization by alternating AGENT and CONTACT per region
          [{ channel: 0 }];

    const timed = tracks.flatMap(({ speaker, channel }) =>
      detectSpeechRegions(wav, channel).map((region) => ({ ...region, speaker })),
    );
    timed.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

    const turns = new Map<TranscriptSpeaker, number>();
    const segments: TranscriptionSegmentResult[] = timed
      .slice(0, MAX_SEGMENTS)
      .map((region, index) => {
        const speaker: TranscriptSpeaker =
          region.speaker ?? (index % 2 === 0 ? 'AGENT' : 'CONTACT');
        const turn = turns.get(speaker) ?? 0;
        turns.set(speaker, turn + 1);
        return {
          speaker,
          startMs: region.startMs,
          endMs: region.endMs,
          text: simulatedText(speaker, turn),
          confidence: ASR_SIMULATOR_CONFIDENCE,
        };
      });

    if (segments.length === 0) {
      // Protocol v1 requires at least one segment: a silent call returns one SYSTEM segment covering it all
      segments.push({
        speaker: 'SYSTEM',
        startMs: 0,
        endMs: wav.durationMs,
        text: `${phrases.prefix} ${phrases.noSpeech}`,
        confidence: ASR_SIMULATOR_CONFIDENCE,
      });
    }

    return {
      result: {
        modelId: ASR_SIMULATOR_MODEL_ID,
        language: input.languageHint,
        confidenceAvg: ASR_SIMULATOR_CONFIDENCE,
        segments,
      },
      durationMs: wav.durationMs,
    };
  }
}

/** Converts a node http request into an AsrSimulatorRequest, keeping at most the body limit. */
export async function readSimulatorRequest(request: IncomingMessage): Promise<AsrSimulatorRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    // Drain the whole body so a 413 can be answered, but keep only what fits the limit.
    if (total <= MAX_REQUEST_BYTES) chunks.push(buffer);
  }
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    method: request.method ?? 'GET',
    path: new URL(request.url ?? '/', 'http://simulator.local').pathname,
    headers,
    body: total > MAX_REQUEST_BYTES ? '' : Buffer.concat(chunks).toString('utf8'),
    oversized: total > MAX_REQUEST_BYTES,
  };
}

export function writeSimulatorResponse(
  response: ServerResponse,
  result: AsrSimulatorResponse,
  method: string,
): void {
  const body = JSON.stringify(result.body);
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    [ASR_PROTOCOL_HEADER]: ASR_PROTOCOL_VERSION,
  });
  response.end(method === 'HEAD' ? undefined : body);
}
