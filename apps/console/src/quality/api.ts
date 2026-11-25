/** #971: client of `/api/v1/qm` for evaluation forms, team call evaluations and my scores */

export type QuestionType = 'YES_NO' | 'SCALE' | 'TEXT';

export interface FormQuestion {
  id: string;
  type: QuestionType;
  text: string;
  points?: number;
  scale?: [number, number];
  allowNa?: boolean;
  autoFail?: boolean;
}

export interface FormSection {
  id: string;
  name: string;
  weight: number;
  questions: FormQuestion[];
}

export interface FormDefinition {
  scoreMethod: 'WEIGHTED_POINTS';
  requireCommentBelow: number | null;
  sections: FormSection[];
}

export interface FormSummary {
  formId: string;
  name: string;
  updatedAt: string;
  current: {
    versionId: string;
    version: number;
    publishedAt: string;
    questionCount: number;
  } | null;
  draft?: { versionId: string; version: number; revision: number; updatedAt: string } | null;
}

export interface FormDetail {
  formId: string;
  name: string;
  updatedAt: string;
  versions: {
    versionId: string;
    version: number;
    status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
    publishedAt: string | null;
  }[];
  draft: {
    versionId: string;
    version: number;
    revision: number;
    definition: FormDefinition;
    updatedAt: string;
  } | null;
  current: {
    versionId: string;
    version: number;
    definition: FormDefinition;
    publishedAt: string;
  } | null;
}

export interface FormVersion {
  versionId: string;
  formId: string;
  formName: string;
  version: number;
  definition: FormDefinition;
}

export type AnswerInput = { value: boolean | number | string } | { na: true };
export type Answers = Record<string, AnswerInput>;

export interface EvaluationScore {
  preview: boolean;
  rawScore: number;
  finalScore: number;
  autoFailed: boolean;
  sections: { sectionId: string; score: number | null }[];
}

export interface Evaluation {
  evaluationId: string;
  interactionId: string;
  agentId: string;
  evaluatorName: string | null;
  status: 'DRAFT' | 'PUBLISHED';
  revision: number;
  formVersionId: string;
  form: { formId: string; formName: string; version: number; definition: FormDefinition };
  answers: Answers;
  comment: string | null;
  progress: { answered: number; required: number };
  score: EvaluationScore | null;
  publishedAt: string | null;
  updatedAt: string;
}

export interface TeamInteraction {
  interactionId: string;
  agentId: string;
  agentName: string | null;
  queueName: string | null;
  channel: string;
  acceptedAt: string;
  endedAt: string | null;
  hasRecording: boolean;
}

export interface TeamInteractionItem extends TeamInteraction {
  evaluation: {
    evaluationId: string;
    status: 'DRAFT' | 'PUBLISHED';
    finalScore: number | null;
  } | null;
}

export type EvaluationFilter = 'NOT_EVALUATED' | 'DRAFT' | 'PUBLISHED';

export interface MyEvaluationItem {
  evaluationId: string;
  interactionId: string;
  channel: string;
  interactionAt: string;
  formName: string;
  formVersion: number;
  rawScore: number;
  finalScore: number;
  autoFailed: boolean;
  publishedAt: string;
}

export interface FieldError {
  path: string;
  code: string;
}

export class QualityApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly errors: FieldError[] = [],
  ) {
    super(`Quality request failed (${status}${code ? ` ${code}` : ''})`);
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface QualityApi {
  listForms(): Promise<{ items: FormSummary[] }>;
  createForm(input: { commandId: string; name: string }): Promise<FormDetail>;
  getForm(formId: string): Promise<FormDetail>;
  saveDraft(
    formId: string,
    input: { revision: number; name: string; definition: FormDefinition },
  ): Promise<FormDetail>;
  newDraft(formId: string, commandId: string): Promise<FormDetail>;
  publishForm(formId: string, input: { commandId: string; revision: number }): Promise<FormDetail>;
  formVersion(versionId: string): Promise<FormVersion>;
  teamInteractions(input: {
    from: string;
    to: string;
    status?: EvaluationFilter;
    cursor?: string;
  }): Promise<Page<TeamInteractionItem>>;
  evaluation(
    interactionId: string,
  ): Promise<{ interaction: TeamInteraction; evaluation: Evaluation | null }>;
  saveEvaluation(
    interactionId: string,
    input: {
      commandId: string;
      formVersionId: string;
      answers: Answers;
      comment: string;
      revision?: number;
    },
  ): Promise<{ interaction: TeamInteraction; evaluation: Evaluation }>;
  publishEvaluation(
    interactionId: string,
    input: { commandId: string; revision: number },
  ): Promise<{ interaction: TeamInteraction; evaluation: Evaluation }>;
  myEvaluations(cursor?: string): Promise<Page<MyEvaluationItem>>;
  myEvaluation(evaluationId: string): Promise<Evaluation>;
}

export function createQualityApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}): QualityApi {
  const root = `${options.baseUrl.replace(/\/$/, '')}/api/v1/qm`;
  async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const token = options.accessToken();
    if (!token) throw new QualityApiError(401);
    const response = await fetch(`${root}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => undefined)) as
        { code?: unknown; errors?: unknown } | undefined;
      throw new QualityApiError(
        response.status,
        typeof failure?.code === 'string' ? failure.code : undefined,
        Array.isArray(failure?.errors) ? (failure.errors as FieldError[]) : [],
      );
    }
    return (await response.json()) as T;
  }
  const id = (value: string) => encodeURIComponent(value);
  return {
    listForms: () => call('GET', '/forms'),
    createForm: (input) => call('POST', '/forms', input),
    getForm: (formId) => call('GET', `/forms/${id(formId)}`),
    saveDraft: (formId, input) => call('PUT', `/forms/${id(formId)}/draft`, input),
    newDraft: (formId, commandId) => call('POST', `/forms/${id(formId)}/draft`, { commandId }),
    publishForm: (formId, input) => call('POST', `/forms/${id(formId)}/draft/publish`, input),
    formVersion: (versionId) => call('GET', `/form-versions/${id(versionId)}`),
    teamInteractions: ({ from, to, status, cursor }) => {
      const query = new URLSearchParams({
        from,
        to,
        ...(status ? { status } : {}),
        ...(cursor ? { cursor } : {}),
      });
      return call('GET', `/team-interactions?${query.toString()}`);
    },
    evaluation: (interactionId) =>
      call('GET', `/interactions/${id(interactionId)}/human-evaluation`),
    saveEvaluation: (interactionId, input) =>
      call('PUT', `/interactions/${id(interactionId)}/human-evaluation`, input),
    publishEvaluation: (interactionId, input) =>
      call('POST', `/interactions/${id(interactionId)}/human-evaluation/publish`, input),
    myEvaluations: (cursor) =>
      call(
        'GET',
        `/my-evaluations${cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''}`,
      ),
    myEvaluation: (evaluationId) => call('GET', `/my-evaluations/${id(evaluationId)}`),
  };
}
