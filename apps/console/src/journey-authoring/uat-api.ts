/**
 * U1.4 (#432): client of the UAT run API (`/api/v1/uat-runs`) and the runtime profile report
 * (`/api/v1/runtime-profile`) — a sibling of `api.ts` using the same token/error contract
 *
 * - tenant/actor come from the bearer token only; the browser can send only opaque ids, revisions and values the tester typed
 * - every mutation needs an `Idempotency-Key` from the caller, which holds one key for the whole intent (retries reuse the key)
 * - run/result state belongs to the server — Console never infers PASSED/PUBLISHED itself
 * - the runtime profile is a public route: a non-UAT API has no such route (404) = no UAT UI at all
 * - U1.5 (#433): screenshots are always sent as a raw body (PNG/JPEG) with a bearer header; the bundle is fetched via fetch
 *   and the caller builds the Blob itself — no token or storage URL appears in any URL
 */
import type { SimulationFixtureV1 } from '@d-contact/cxa-contracts';
import { JourneyAuthoringApiError } from './api.js';

const RUNS = '/api/v1/uat-runs';
const PROFILE = '/api/v1/runtime-profile';

export type UatStateLabel = 'REAL_STATE' | 'SIMULATION_ONLY';
export type UatOutcome = 'PASS' | 'FAIL' | 'BLOCKED';
export type UatSeverity = 'S1' | 'S2' | 'S3' | 'S4';
export const UAT_OUTCOMES: readonly UatOutcome[] = ['PASS', 'FAIL', 'BLOCKED'];
export const UAT_SEVERITIES: readonly UatSeverity[] = ['S1', 'S2', 'S3', 'S4'];

/** API profile report — only guard/flag status, no secrets or tenant */
export interface RuntimeProfile {
  profile: string;
  kafka?: string;
  lineWebhook?: string;
  providerEgress?: string;
  journeyRuntime?: string;
  unilateralPublish?: string;
  blockedRequests?: number;
  journeyAuthoring?: { canvasWrite: boolean; publishUi: boolean };
}

export interface UatScenarioStep {
  stepId: string;
  title: string;
  expected: string;
  stateLabel: UatStateLabel;
}

export interface UatStepResultView {
  stepId: string;
  outcome: UatOutcome;
  expected: string;
  actual: string;
  severity: UatSeverity | null;
  correlationId: string | null;
  stateLabel: UatStateLabel;
  recordedByRef: string;
  recordedAt: string;
}

export interface UatRunView {
  runId: string;
  sequence: number;
  lifecycle: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  revision: number;
  journeyId: string | null;
  fixturePack: { environment: string; packVersion: string; digest: string; buildSha: string };
  steps: readonly UatScenarioStep[];
  openedAt: string;
  closedAt: string | null;
  stepResults: UatStepResultView[];
}

/** metadata of an evidence screenshot — bytes are read through the API only */
export interface UatEvidenceView {
  evidenceId: string;
  stepId: string;
  sha256: string;
  sizeBytes: number;
  contentType: 'image/png' | 'image/jpeg';
  recordedByRef: string;
  recordedAt: string;
}

/** file types the server accepts as evidence — used for the file input's `accept` (the server re-checks magic bytes) */
export const UAT_EVIDENCE_ACCEPT = 'image/png,image/jpeg';

/** evidence bundle (JSON) as built by the server — Console does not edit the content (the digest covers the whole thing) */
export interface UatEvidenceBundle {
  schema: string;
  manifest: { runId: string; sequence: number } & Record<string, unknown>;
  verdict: 'PASS' | 'FAIL' | 'INCOMPLETE';
  scan: { status: 'PASSED' | 'FAILED'; findings: unknown[] } & Record<string, unknown>;
  digest: string;
  [key: string]: unknown;
}

export interface StartUatRunInput {
  environment: string;
  packVersion: string;
  /** revision of the currently ACTIVE run, or 0 when there is none yet */
  expectedRevision: number;
}

export interface RecordUatStepResultInput {
  stepId: string;
  outcome: UatOutcome;
  actual: string;
  /** required only on FAIL — the server re-checks */
  severity?: UatSeverity;
  correlationId?: string;
}

export interface UatApi {
  /** `null` = this API is not UAT (no route) */
  runtimeProfile(): Promise<RuntimeProfile | null>;
  /** `null` = no ACTIVE run yet (or the caller is not a tester of the pack) */
  current(): Promise<UatRunView | null>;
  /** fixture pinned by the server for the current run; `null` = no run yet */
  simulationFixture(): Promise<{ runId: string; fixture: SimulationFixtureV1 } | null>;
  /** `Start new round` */
  start(input: StartUatRunInput, key: string): Promise<UatRunView>;
  recordStepResult(
    runId: string,
    input: RecordUatStepResultInput,
    key: string,
  ): Promise<UatStepResultView>;
  /** upload a screenshot (PNG/JPEG) for one step — one `Idempotency-Key` for the whole intent */
  uploadEvidence(runId: string, stepId: string, file: Blob, key: string): Promise<UatEvidenceView>;
  listEvidence(runId: string): Promise<{ runId: string; items: UatEvidenceView[] }>;
  /** bundle of the run — the server scans it to be current before answering */
  exportBundle(runId: string): Promise<UatEvidenceBundle>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createUatApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): UatApi {
  const request = input.fetch ?? globalThis.fetch;
  const url = (path: string) => `${input.baseUrl.replace(/\/$/, '')}${path}`;

  const call = async <T>(
    method: 'GET' | 'POST',
    path: string,
    init: { body?: unknown; key?: string; raw?: { blob: Blob; stepId: string } } = {},
  ): Promise<T> => {
    const token = input.accessToken();
    if (!token) throw new JourneyAuthoringApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.raw) {
      // the server decides the type from magic bytes; send the type the browser guessed so the server can reject with the exact reason
      headers['content-type'] = init.raw.blob.type || 'application/octet-stream';
      headers['x-uat-step-id'] = init.raw.stepId;
    }
    if (init.key) headers['idempotency-key'] = init.key;
    const response = await request(url(`${RUNS}${path}`), {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.raw ? { body: init.raw.blob } : {}),
    });
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      const error = isRecord(payload) ? payload : {};
      throw new JourneyAuthoringApiError(
        response.status,
        typeof error.code === 'string' ? error.code : undefined,
        isRecord(error.safeParams) ? error.safeParams : {},
      );
    }
    return payload as T;
  };

  /** 404 `UAT_RUN_NOT_FOUND` = no run yet — a normal state, not an error */
  const orNone = async <T>(work: Promise<T>): Promise<T | null> => {
    try {
      return await work;
    } catch (error) {
      if (error instanceof JourneyAuthoringApiError && error.status === 404) return null;
      throw error;
    }
  };

  return {
    runtimeProfile: async () => {
      // public route (readiness readable before an account exists) — do not send the token unnecessarily
      const response = await request(url(PROFILE), { method: 'GET' });
      if (response.status === 404) return null;
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok) throw new JourneyAuthoringApiError(response.status, undefined);
      // response is not the profile JSON (e.g. SPA fallback of a static host) = not a UAT API
      if (!isRecord(payload) || typeof payload.profile !== 'string') return null;
      return payload as unknown as RuntimeProfile;
    },
    current: () => orNone(call<UatRunView>('GET', '/current')),
    simulationFixture: () =>
      orNone(
        call<{ runId: string; fixture: SimulationFixtureV1 }>('GET', '/current/simulation-fixture'),
      ),
    start: (body, key) => call('POST', '/start', { body, key }),
    recordStepResult: (runId, body, key) =>
      call('POST', `/${encodeURIComponent(runId)}/step-results`, { body, key }),
    uploadEvidence: (runId, stepId, blob, key) =>
      call('POST', `/${encodeURIComponent(runId)}/evidence`, { key, raw: { blob, stepId } }),
    listEvidence: (runId) => call('GET', `/${encodeURIComponent(runId)}/evidence`),
    exportBundle: (runId) => call('GET', `/${encodeURIComponent(runId)}/bundle`),
  };
}
