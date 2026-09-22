/**
 * J5.6 (#344): client ของ `/api/v1/journey-authoring` (Phase Spec #337 §5)
 *
 * - tenant/actor มาจาก bearer token เท่านั้น — ไม่มี field ใดระบุ tenant, role หรือ capability
 * - ทุก mutation ต้องได้ `Idempotency-Key` จาก caller ซึ่งถือ key เดียวตลอด intent: retry หลังผลไม่แน่ชัด
 *   ต้องใช้ key เดิม (publish ที่ไม่รู้ผล resolve ด้วย key เดิมเท่านั้น ห้าม mint ใหม่)
 * - error เป็น code ปิด + safeParams; ข้อความที่แสดงแปลจาก code ฝั่ง Console
 */
import type {
  AuthoringDocumentV1,
  JourneyDiagnosticV1,
  JourneyLifecycle,
  JourneyReviewState,
  JourneyTemplateConflictResolution,
  JourneyTemplateNoticeV1,
  JourneyTemplateParameterValue,
  JourneyTemplateUpgradeProposalV1,
  JourneyTemplateVersionViewV1,
  PlanPreviewV1,
  PublishJourneyResultV1,
  SimulationFixtureV1,
  SimulationResultV1,
} from '@d-contact/cxa-contracts';

const BASE = '/api/v1/journey-authoring';

export class JourneyAuthoringApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly safeParams: Record<string, unknown> = {},
    readonly diagnostics: readonly JourneyDiagnosticV1[] = [],
  ) {
    super(code ?? `Journey authoring API failed with HTTP ${status}`);
    this.name = 'JourneyAuthoringApiError';
  }

  get conflict() {
    return this.status === 409;
  }
}

export interface JourneySummary {
  journeyId: string;
  name: string;
  ownerTeamId: string;
  lifecycle: JourneyLifecycle;
  version: number;
  currentDraftRevision: number;
  activeVersion: number | null;
  updatedAt: string;
}

export interface JourneyHeadView {
  journeyId: string;
  name: string;
  ownerTeamId: string;
  lifecycle: JourneyLifecycle;
  version: number;
  currentDraftRevision: number;
  currentDraftDigest: string;
  activeVersion: number | null;
  activeRuntimeHash: string | null;
}

export interface JourneySnapshot {
  head: JourneyHeadView;
  draft: {
    revision: number;
    digest: string;
    basePublishedVersion: number | null;
    document: AuthoringDocumentV1;
  };
  review: { reviewId: string; state: JourneyReviewState; draftRevision: number } | null;
  templateNotices: JourneyTemplateNoticeV1[];
}

export interface DraftResult {
  journeyId: string;
  headVersion: number;
  draftRevision: number;
  draftDigest: string;
  diagnostics: JourneyDiagnosticV1[];
}

export interface CompileSummary {
  artifact: {
    compileDigest: string;
    runtimeHash: string;
    referenceDigest: string;
    capabilityDigest: string;
    baseHeadVersion: number;
  } | null;
  diagnostics: JourneyDiagnosticV1[];
  stale: boolean;
  headStale: boolean;
}

export interface ReviewBinding {
  draftRevision: number;
  draftDigest: string;
  compileDigest: string;
  referenceDigest: string;
  capabilityDigest: string;
  baseHeadVersion: number;
  baseHeadDigest: string | null;
}

export type PublishOutcome =
  | { kind: 'PUBLISHED'; result: PublishJourneyResultV1 }
  | { kind: 'UNKNOWN'; originalIdempotencyKey: string };

export interface JourneyAuthoringApi {
  listJourneys(query?: { cursor?: string; lifecycle?: JourneyLifecycle }): Promise<{
    items: JourneySummary[];
    nextCursor: string | null;
  }>;
  createJourney(
    input: { ownerTeamId: string; document: AuthoringDocumentV1 },
    key: string,
  ): Promise<DraftResult>;
  journey(journeyId: string): Promise<JourneySnapshot>;
  saveDraft(
    journeyId: string,
    input: {
      expectedHeadVersion: number;
      expectedDraftRevision: number;
      expectedDraftDigest: string;
      document: AuthoringDocumentV1;
    },
    key: string,
  ): Promise<DraftResult>;
  discardDraft(
    journeyId: string,
    input: {
      expectedHeadVersion: number;
      expectedDraftRevision: number;
      expectedDraftDigest: string;
      reasonCode: string;
    },
    key: string,
  ): Promise<DraftResult>;
  validate(
    journeyId: string,
    input: { draftRevision: number; draftDigest: string },
  ): Promise<{ diagnostics: JourneyDiagnosticV1[]; stale: boolean }>;
  compile(
    journeyId: string,
    input: { draftRevision: number; draftDigest: string; expectedHeadVersion: number },
  ): Promise<CompileSummary>;
  preview(journeyId: string, compileDigest: string): Promise<PlanPreviewV1>;
  simulate(
    journeyId: string,
    input: { compileDigest: string; fixture: SimulationFixtureV1 },
  ): Promise<SimulationResultV1>;
  submitReview(
    journeyId: string,
    binding: ReviewBinding,
    key: string,
  ): Promise<{ reviewId: string; state: JourneyReviewState }>;
  decideReview(
    reviewId: string,
    input: {
      decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES';
      reasonCode: string;
      evidenceRef: string;
    },
    key: string,
  ): Promise<{ reviewId: string; state: JourneyReviewState }>;
  publish(
    journeyId: string,
    input: ReviewBinding & { reviewId: string; expectedHeadVersion: number },
    key: string,
  ): Promise<PublishOutcome>;
  resolvePublish(
    journeyId: string,
    originalIdempotencyKey: string,
  ): Promise<PublishJourneyResultV1 & { errorCode?: string }>;
  changeLifecycle(
    journeyId: string,
    action: 'pause' | 'resume' | 'deprecate',
    input: { expectedHeadVersion: number; reasonCode: string },
    key: string,
  ): Promise<{ journeyId: string; headVersion: number; lifecycle: JourneyLifecycle }>;
  templates(): Promise<{ items: JourneyTemplateVersionViewV1[]; nextCursor: string | null }>;
  instantiate(
    templateId: string,
    version: number,
    input: {
      expectedContentDigest: string;
      bindings: Record<string, JourneyTemplateParameterValue>;
      targetOwnerTeamId: string;
      name: string;
    },
    key: string,
  ): Promise<DraftResult>;
  checkUpgrade(
    journeyId: string,
    input: { draftRevision: number; draftDigest: string; targetVersion: number },
  ): Promise<JourneyTemplateUpgradeProposalV1>;
  applyUpgrade(
    journeyId: string,
    input: {
      targetVersion: number;
      expectedHeadVersion: number;
      expectedDraftRevision: number;
      expectedDraftDigest: string;
      proposalDigest: string;
      conflictDigest: string;
      resolutions: Record<string, JourneyTemplateConflictResolution>;
    },
    key: string,
  ): Promise<DraftResult>;
}

export function createJourneyAuthoringApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): JourneyAuthoringApi {
  const request = input.fetch ?? globalThis.fetch;

  const send = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    init: { body?: unknown; key?: string } = {},
  ) => {
    const token = input.accessToken();
    if (!token) throw new JourneyAuthoringApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.key) headers['idempotency-key'] = init.key;
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${BASE}${path}`, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const payload = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;
    if (!response.ok) {
      throw new JourneyAuthoringApiError(
        response.status,
        typeof payload?.code === 'string' ? payload.code : undefined,
        (payload?.safeParams as Record<string, unknown> | undefined) ?? {},
        (payload?.diagnostics as JourneyDiagnosticV1[] | undefined) ?? [],
      );
    }
    return { status: response.status, payload };
  };
  const call = async <T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    init: { body?: unknown; key?: string } = {},
  ): Promise<T> => (await send(method, path, init)).payload as T;
  const id = encodeURIComponent;

  return {
    listJourneys: (query = {}) => {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.lifecycle) params.set('lifecycle', query.lifecycle);
      const suffix = params.size > 0 ? `?${params}` : '';
      return call('GET', `/journeys${suffix}`);
    },
    createJourney: (body, key) => call('POST', '/journeys', { body, key }),
    journey: (journeyId) => call('GET', `/journeys/${id(journeyId)}`),
    saveDraft: (journeyId, body, key) =>
      call('PUT', `/journeys/${id(journeyId)}/draft`, { body, key }),
    discardDraft: (journeyId, body, key) =>
      call('POST', `/journeys/${id(journeyId)}/draft/discard`, { body, key }),
    validate: (journeyId, body) => call('POST', `/journeys/${id(journeyId)}/validate`, { body }),
    compile: (journeyId, body) => call('POST', `/journeys/${id(journeyId)}/compile`, { body }),
    preview: (journeyId, compileDigest) =>
      call('POST', `/journeys/${id(journeyId)}/preview`, { body: { compileDigest } }),
    simulate: (journeyId, body) => call('POST', `/journeys/${id(journeyId)}/simulations`, { body }),
    submitReview: (journeyId, body, key) =>
      call('POST', `/journeys/${id(journeyId)}/reviews`, { body, key }),
    decideReview: (reviewId, body, key) =>
      call('POST', `/reviews/${id(reviewId)}/decisions`, {
        body: { expectedReviewState: 'IN_REVIEW', ...body },
        key,
      }),
    publish: async (journeyId, body, key) => {
      const { status, payload } = await send('POST', `/journeys/${id(journeyId)}/publish`, {
        body,
        key,
      });
      // 202 = commit อาจเกิดหรือไม่เกิด: ไม่ถือว่าสำเร็จ และให้ resolve ด้วย key เดิม
      if (status === 202) return { kind: 'UNKNOWN', originalIdempotencyKey: key };
      return { kind: 'PUBLISHED', result: payload as unknown as PublishJourneyResultV1 };
    },
    resolvePublish: (journeyId, originalIdempotencyKey) =>
      call('POST', `/journeys/${id(journeyId)}/publish-resolution`, {
        body: { originalIdempotencyKey },
      }),
    changeLifecycle: (journeyId, action, body, key) =>
      call('POST', `/journeys/${id(journeyId)}/${action}`, { body, key }),
    templates: () => call('GET', '/templates'),
    instantiate: (templateId, version, body, key) =>
      call('POST', `/templates/${id(templateId)}/versions/${version}/instantiate`, { body, key }),
    checkUpgrade: (journeyId, body) =>
      call('POST', `/journeys/${id(journeyId)}/template-upgrade-checks`, { body }),
    applyUpgrade: (journeyId, body, key) =>
      call('POST', `/journeys/${id(journeyId)}/template-upgrades`, { body, key }),
  };
}
