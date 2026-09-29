import { type Page, type Request } from '@playwright/test';

/**
 * J5.6 (#344) + D1.14/D1.16: mock ของ `/api/v1/journey-authoring/**` แบบมี state และ navigation ของ shell
 * ใช้ร่วมระหว่าง `e2e/journey-authoring.spec.ts` และ `e2e-evidence/d1-visual-evidence.spec.ts`
 * ข้อมูลเป็น synthetic ทั้งหมด ไม่มี PII
 */

export const JOURNEY_ID = '6f1b2c3d-4e5f-4a60-8b7c-9d0e1f2a3b41';
export const NEW_JOURNEY_ID = '7a2b3c4d-5e6f-4a71-9b8c-0d1e2f3a4b52';
export const TEMPLATE_ID = '5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f01';
export const REVIEW_ID = '8b3c4d5e-6f7a-4b82-8c9d-1e2f3a4b5c63';
export const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);

export type Json = Record<string, unknown>;

export function authoringDocument(name = 'ติดตามการชำระ') {
  return {
    schemaVersion: 'J5_AUTHORING_V1',
    registryVersion: 'J5_PALETTE_V1',
    trigger: { nodeId: 'trigger', type: 'EVENT_TRIGGER', config: { eventType: 'invoice.overdue' } },
    nodes: [
      { nodeId: 'send-1', type: 'SEND', config: { channel: 'LINE', contentRef: 'content-a' } },
      { nodeId: 'done', type: 'EXIT', config: { reason: 'COMPLETED' } },
    ],
    edges: [
      {
        edgeId: 'e1',
        source: { nodeId: 'trigger', portId: 'start' },
        target: { nodeId: 'send-1' },
      },
      { edgeId: 'e2', source: { nodeId: 'send-1', portId: 'next' }, target: { nodeId: 'done' } },
    ],
    settings: {
      name,
      purpose: 'SERVICE',
      senderIdentityId: 'sender-synthetic',
      goal: { kind: 'EVENT', eventType: 'invoice.paid' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 14,
    },
    layout: {
      nodes: { trigger: { x: 40, y: 40 }, 'send-1': { x: 40, y: 180 }, done: { x: 40, y: 320 } },
    },
  };
}

export interface JourneyState {
  headVersion: number;
  revision: number;
  document: Json;
  lifecycle: string;
  activeVersion: number | null;
  review: {
    reviewId: string;
    state: string;
    draftRevision: number;
    draftDigest: string;
    compileDigest: string;
    submittedAt: string;
    makerIsCaller: boolean;
  } | null;
  notices: Json[];
}

/** capability ที่ server คืนตาม persona — reviewer ไม่มีสิทธิ์แก้/publish */
export const PERMISSIONS = {
  author: { edit: true, review: true, publish: true },
  reviewer: { edit: false, review: true, publish: false },
};

export class AuthoringMock {
  readonly requests: Request[] = [];
  readonly journeys = new Map<string, JourneyState>();
  /** ครั้งถัดไปที่ PUT draft จะเจอ revision ใหม่จากคนอื่นก่อน */
  concurrentEdit = false;
  publishUnknown = false;
  publishCommitted = false;
  persona: keyof typeof PERMISSIONS = 'author';

  constructor() {
    this.journeys.set(JOURNEY_ID, {
      headVersion: 1,
      revision: 1,
      document: authoringDocument(),
      lifecycle: 'DRAFT_ONLY',
      activeVersion: null,
      review: null,
      notices: [],
    });
  }

  snapshot(journeyId: string) {
    const journey = this.journeys.get(journeyId)!;
    return {
      head: {
        journeyId,
        name: (journey.document.settings as Json).name,
        ownerTeamId: 'team-synthetic',
        lifecycle: journey.lifecycle,
        version: journey.headVersion,
        currentDraftRevision: journey.revision,
        currentDraftDigest: DIGEST(String(journey.revision)),
        activeVersion: journey.activeVersion,
        activeRuntimeHash: null,
      },
      draft: {
        revision: journey.revision,
        digest: DIGEST(String(journey.revision)),
        basePublishedVersion: null,
        document: journey.document,
      },
      review: journey.review,
      permissions: PERMISSIONS[this.persona],
      templateNotices: journey.notices,
    };
  }

  async install(page: Page) {
    // API ที่ไม่ใช่ UAT ไม่มี route profile — Console ต้องไม่แสดง UI ของ UAT (U1.4 #432)
    await page.route('**/api/v1/runtime-profile', (route) =>
      route.fulfill({ status: 404, json: { message: 'Not Found' } }),
    );
    await page.route('**/api/v1/journey-authoring/**', async (route) => {
      const request = route.request();
      this.requests.push(request);
      const path = new URL(request.url()).pathname.replace('/api/v1/journey-authoring', '');
      // ภาพหน้าจอเป็น raw body — parse JSON เฉพาะ request ที่เป็น JSON
      const isJson = (request.headers()['content-type'] ?? '').startsWith('application/json');
      const body = ((isJson ? request.postDataJSON() : null) ?? {}) as Json;
      const reply = (status: number, payload: unknown) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
      const method = request.method();
      const journeyMatch = /^\/journeys\/([^/]+)(\/.*)?$/.exec(path);
      const journeyId = journeyMatch?.[1];
      const journey = journeyId ? this.journeys.get(journeyId) : undefined;
      const tail = journeyMatch?.[2] ?? '';

      if (method === 'GET' && path === '/journeys') {
        return reply(200, {
          items: [...this.journeys.entries()].map(([id, state]) => ({
            journeyId: id,
            name: (state.document.settings as Json).name,
            ownerTeamId: 'team-synthetic',
            lifecycle: state.lifecycle,
            version: state.headVersion,
            currentDraftRevision: state.revision,
            activeVersion: state.activeVersion,
            updatedAt: '2026-09-22T00:00:00.000Z',
            reviewState:
              state.review && ['IN_REVIEW', 'APPROVED'].includes(state.review.state)
                ? state.review.state
                : null,
          })),
          nextCursor: null,
        });
      }
      if (method === 'GET' && path === '/reviews') {
        return reply(200, {
          items: [...this.journeys.entries()]
            .filter(([, state]) => state.review?.state === 'IN_REVIEW')
            .map(([id, state]) => ({
              reviewId: state.review!.reviewId,
              journeyId: id,
              journeyName: (state.document.settings as Json).name,
              ownerTeamId: 'team-synthetic',
              draftRevision: state.review!.draftRevision,
              draftDigest: state.review!.draftDigest,
              compileDigest: state.review!.compileDigest,
              submittedAt: state.review!.submittedAt,
            })),
          nextCursor: null,
        });
      }
      if (method === 'GET' && path === '/templates') {
        return reply(200, {
          items: [
            {
              origin: 'PLATFORM_BUILTIN',
              templateId: TEMPLATE_ID,
              version: 1,
              contentDigest: DIGEST('c'),
              name: 'payment-reminder',
              visibility: 'TENANT',
              ownerTeamId: null,
              lifecycle: 'ACTIVE',
              content: {
                document: authoringDocument('payment-reminder'),
                parameterSchema: [
                  {
                    parameterKey: 'reminderContent',
                    labelKey: 'template.reminderContent',
                    type: 'OPAQUE_RESOURCE_REF',
                    resourceKind: 'CONTENT',
                    required: true,
                    bindTargets: [],
                  },
                ],
              },
              compileDigest: DIGEST('d'),
              nodeMappingDigest: DIGEST('e'),
              publishedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        });
      }
      if (method === 'POST' && path === `/templates/${TEMPLATE_ID}/versions/1/instantiate`) {
        this.journeys.set(NEW_JOURNEY_ID, {
          headVersion: 1,
          revision: 1,
          document: authoringDocument(String(body.name)),
          lifecycle: 'DRAFT_ONLY',
          activeVersion: null,
          review: null,
          notices: [
            {
              kind: 'UPDATE_AVAILABLE',
              journeyId: NEW_JOURNEY_ID,
              source: {
                origin: 'PLATFORM_BUILTIN',
                templateId: TEMPLATE_ID,
                version: 1,
                contentDigest: DIGEST('c'),
              },
              latestVersion: 2,
            },
          ],
        });
        return reply(200, {
          journeyId: NEW_JOURNEY_ID,
          headVersion: 1,
          draftRevision: 1,
          draftDigest: DIGEST('1'),
          diagnostics: [],
        });
      }
      if (method === 'POST' && path === `/reviews/${REVIEW_ID}/decisions`) {
        const state = [...this.journeys.values()].find(
          (entry) => entry.review?.reviewId === REVIEW_ID,
        )!;
        state.review = { ...state.review!, state: 'APPROVED' };
        return reply(200, { reviewId: REVIEW_ID, state: 'APPROVED' });
      }
      if (!journey) return reply(404, { code: 'JOURNEY_NOT_FOUND' });

      if (method === 'GET' && tail === '') return reply(200, this.snapshot(journeyId!));
      if (method === 'GET' && tail === '/audit') {
        return reply(200, {
          items: [
            {
              id: 'audit-2',
              action: journey.review?.state === 'APPROVED' ? 'REVIEW_APPROVED' : 'REVIEW_SUBMITTED',
              actorSubjectId: '0a1b2c3d-0000-4000-8000-000000000002',
              reasonCode: 'REVIEW',
              beforeDigest: null,
              afterDigest: null,
              correlationId: 'corr-synthetic-2',
              occurredAt: '2026-09-22T01:00:00.000Z',
            },
            {
              id: 'audit-1',
              action: 'DRAFT_CREATED',
              actorSubjectId: '0a1b2c3d-0000-4000-8000-000000000001',
              reasonCode: 'CREATE',
              beforeDigest: null,
              afterDigest: DIGEST('1'),
              correlationId: 'corr-synthetic-1',
              occurredAt: '2026-09-22T00:00:00.000Z',
            },
          ],
        });
      }
      if (method === 'PUT' && tail === '/draft') {
        if (this.concurrentEdit) {
          this.concurrentEdit = false;
          journey.revision += 1;
          journey.headVersion += 1;
          journey.document = {
            ...journey.document,
            settings: { ...(journey.document.settings as Json), purpose: 'MARKETING' },
          };
        }
        if (
          body.expectedDraftRevision !== journey.revision ||
          body.expectedHeadVersion !== journey.headVersion
        ) {
          return reply(409, {
            code: 'DRAFT_VERSION_CONFLICT',
            safeParams: { currentDraftRevision: journey.revision },
          });
        }
        journey.revision += 1;
        journey.headVersion += 1;
        journey.document = body.document as Json;
        return reply(200, {
          journeyId,
          headVersion: journey.headVersion,
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          diagnostics: [],
        });
      }
      if (method === 'POST' && tail === '/validate') {
        return reply(200, {
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          stale: false,
          diagnostics: [
            {
              code: 'PORT_CARDINALITY_INVALID',
              severity: 'ERROR',
              stage: 'AUTHORING',
              messageKey: 'journey.authoring.PORT_CARDINALITY_INVALID',
              path: { nodeId: 'send-1', portId: 'next' },
            },
          ],
        });
      }
      if (method === 'POST' && tail === '/compile') {
        return reply(200, {
          artifact: {
            compileDigest: DIGEST('a'),
            runtimeHash: DIGEST('b'),
            referenceDigest: DIGEST('f'),
            capabilityDigest: DIGEST('9'),
            baseHeadVersion: journey.headVersion,
          },
          diagnostics: [],
          stale: false,
          headStale: false,
        });
      }
      if (method === 'POST' && tail === '/simulations') {
        const fixture = body.fixture as { fixtureId: string; startAt: string };
        const start = Date.parse(fixture.startAt);
        return reply(200, {
          compileDigest: body.compileDigest,
          fixtureId: fixture.fixtureId,
          profile: 'SIMULATION_ONLY',
          transitions: [
            { sequence: 1, nodeId: 'trigger', portId: 'start', virtualAt: fixture.startAt },
            {
              sequence: 2,
              nodeId: 'send-1',
              portId: 'next',
              virtualAt: new Date(start + 3_600_000).toISOString(),
            },
          ],
          terminal: 'EXIT',
          diagnostics: [],
        });
      }
      if (method === 'POST' && tail === '/reviews') {
        journey.review = {
          reviewId: REVIEW_ID,
          state: 'IN_REVIEW',
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          compileDigest: DIGEST('a'),
          submittedAt: '2026-09-22T01:00:00.000Z',
          makerIsCaller: false,
        };
        return reply(200, { reviewId: REVIEW_ID, state: 'IN_REVIEW' });
      }
      if (method === 'POST' && tail === '/publish') {
        if (this.publishUnknown) {
          this.publishUnknown = false;
          this.publishCommitted = true;
          journey.activeVersion = 1;
          journey.lifecycle = 'ACTIVE';
          return reply(202, {
            code: 'PUBLISH_OUTCOME_UNKNOWN',
            resolution: { journeyId, originalIdempotencyKey: request.headers()['idempotency-key'] },
          });
        }
        return reply(409, { code: 'APPROVAL_REQUIRED' });
      }
      if (method === 'POST' && tail === '/publish-resolution') {
        return reply(200, {
          outcome: this.publishCommitted ? 'PUBLISHED' : 'NOT_COMMITTED',
          journeyId,
          version: this.publishCommitted ? 1 : null,
          runtimeHash: this.publishCommitted ? DIGEST('b') : null,
          receiptId: 'receipt-1',
        });
      }
      if (method === 'POST' && tail === '/template-upgrade-checks') {
        return reply(200, {
          journeyId,
          fromVersion: 1,
          toVersion: 2,
          baseDraftDigest: DIGEST('1'),
          localDraftDigest: DIGEST('1'),
          proposedDocument: journey.document,
          nodeMapping: {},
          conflicts: [
            {
              conflictId: 'c1',
              kind: 'FIELD_CHANGED_BOTH',
              nodeId: 'send-1',
              field: 'config.contentRef',
            },
          ],
          visualOnly: false,
          proposalDigest: DIGEST('7'),
          conflictDigest: DIGEST('8'),
        });
      }
      if (method === 'POST' && tail === '/template-upgrades') {
        journey.revision += 1;
        journey.headVersion += 1;
        journey.notices = [];
        return reply(200, {
          journeyId,
          headVersion: journey.headVersion,
          draftRevision: journey.revision,
          draftDigest: DIGEST(String(journey.revision)),
          diagnostics: [],
        });
      }
      return reply(400, { code: 'REQUEST_MALFORMED' });
    });
  }

  mutations() {
    return this.requests.filter(
      (request) =>
        request.method() !== 'GET' &&
        !/\/(validate|compile|preview|simulations|template-upgrade-checks|publish-resolution)$/.test(
          new URL(request.url()).pathname,
        ),
    );
  }
}

export function shellNavigation(shellV2: boolean) {
  return {
    groups: [
      { id: 'live', labelKey: 'navigation.groups.live' },
      { id: 'automation', labelKey: 'navigation.groups.automation' },
    ],
    apps: [
      {
        id: 'agent-workspace',
        groupId: 'live',
        labelKey: 'navigation.apps.agentWorkspace',
        hostApp: 'workspace',
        path: '/',
      },
      {
        id: 'journeys',
        groupId: 'automation',
        labelKey: 'navigation.apps.journeys',
        hostApp: 'console',
        path: '/?view=journeys',
      },
    ],
    pins: { appIds: ['agent-workspace', 'journeys'], source: 'SYSTEM', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}

export async function withShell(page: Page, shellV2: boolean) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: shellNavigation(shellV2) }),
  );
}
