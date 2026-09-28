/**
 * U1.4 (#432): client ของ UAT run API (`/api/v1/uat-runs`) และรายงาน runtime profile
 * (`/api/v1/runtime-profile`) — sibling ของ `api.ts` ที่ใช้ token/error contract เดียวกัน
 *
 * - tenant/actor มาจาก bearer token เท่านั้น; browser ส่งได้แค่ opaque id, revision และค่าที่ผู้ทดสอบกรอก
 * - ทุก mutation ต้องได้ `Idempotency-Key` จาก caller ซึ่งถือ key เดียวตลอด intent (retry ใช้ key เดิม)
 * - สถานะ run/ผลทุกอย่างเป็นของ server — Console ไม่อนุมาน PASSED/PUBLISHED เอง
 * - runtime profile เป็น route public: API ที่ไม่ใช่ UAT ไม่มี route นี้ (404) = ไม่แสดง UI ของ UAT เลย
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

/** รายงาน profile ของ API — มีแต่สถานะ guard/flag ไม่มี secret หรือ tenant */
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

export interface StartUatRunInput {
  environment: string;
  packVersion: string;
  /** revision ของ run ที่ ACTIVE อยู่ หรือ 0 เมื่อยังไม่มี */
  expectedRevision: number;
}

export interface RecordUatStepResultInput {
  stepId: string;
  outcome: UatOutcome;
  actual: string;
  /** ต้องมีเมื่อ FAIL เท่านั้น — server ตรวจซ้ำ */
  severity?: UatSeverity;
  correlationId?: string;
}

export interface UatApi {
  /** `null` = API นี้ไม่ใช่ UAT (ไม่มี route) */
  runtimeProfile(): Promise<RuntimeProfile | null>;
  /** `null` = ยังไม่มี run ที่ ACTIVE (หรือผู้เรียกไม่ใช่ผู้ทดสอบของ pack) */
  current(): Promise<UatRunView | null>;
  /** fixture ที่ server ตรึงไว้ของ run ปัจจุบัน; `null` = ยังไม่มี run */
  simulationFixture(): Promise<{ runId: string; fixture: SimulationFixtureV1 } | null>;
  /** `เริ่มรอบใหม่` */
  start(input: StartUatRunInput, key: string): Promise<UatRunView>;
  recordStepResult(
    runId: string,
    input: RecordUatStepResultInput,
    key: string,
  ): Promise<UatStepResultView>;
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
    init: { body?: unknown; key?: string } = {},
  ): Promise<T> => {
    const token = input.accessToken();
    if (!token) throw new JourneyAuthoringApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.key) headers['idempotency-key'] = init.key;
    const response = await request(url(`${RUNS}${path}`), {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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

  /** 404 `UAT_RUN_NOT_FOUND` = ยังไม่มี run — เป็นสถานะปกติ ไม่ใช่ error */
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
      // route public (readiness อ่านได้ก่อนมีบัญชี) — ไม่ส่ง token ไปโดยไม่จำเป็น
      const response = await request(url(PROFILE), { method: 'GET' });
      if (response.status === 404) return null;
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok) throw new JourneyAuthoringApiError(response.status, undefined);
      // ตอบไม่ใช่ JSON ของ profile (เช่น SPA fallback ของ static host) = ไม่ใช่ UAT API
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
  };
}
