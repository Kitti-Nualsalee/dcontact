/**
 * J5.6 (#344): compile → preview/simulation → ส่งตรวจ → ตัดสิน (maker-checker)
 *
 * ปุ่มทุกปุ่มส่งคำสั่งไป server ซึ่งตรวจสิทธิ์และความสดของ digest เอง — Console ไม่ซ่อนแล้วถือว่า
 * authorized; ถ้า server ปฏิเสธจะแสดง code ที่ได้กลับมาตรง ๆ
 */
import { useId, useRef, useState } from 'react';
import type { PlanPreviewV1, SimulationResultV1 } from '@d-contact/cxa-contracts';
import {
  JourneyAuthoringApiError,
  type CompileSummary,
  type JourneyAuthoringApi,
  type JourneySnapshot,
} from './api.js';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { errorMessage } from './model.js';
import { Dialog, reasonField } from './publish.js';

type Decision = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';
const DECISIONS: readonly Decision[] = ['APPROVE', 'REQUEST_CHANGES', 'REJECT'];

export function ReviewPanel({
  api,
  snapshot,
  compile,
  dirty,
  readOnly,
  onCompile,
  onChanged,
}: {
  api: JourneyAuthoringApi;
  snapshot: JourneySnapshot;
  compile: CompileSummary | null;
  dirty: boolean;
  readOnly: boolean;
  onCompile: () => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation('journeys');
  const decisionLabel = (decision: Decision) => t(`review.decision.${decision}`);
  const contextId = useId();
  const [busy, setBusy] = useState(false);
  // เก็บ code แล้วแปลตอน render — สลับภาษาแล้วข้อความ error เปลี่ยนตาม
  const [error, setError] = useState<{ code?: string } | null>(null);
  const [preview, setPreview] = useState<PlanPreviewV1 | null>(null);
  const [simulation, setSimulation] = useState<SimulationResultV1 | null>(null);
  const [contextJson, setContextJson] = useState('{}');
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const submitIntent = useRef<{ binding: string; key: string } | null>(null);
  const { head, review } = snapshot;
  const artifact = compile?.artifact ?? null;
  const pendingReview =
    review && review.draftRevision === head.currentDraftRevision ? review : null;
  const { permissions } = snapshot;
  // ตัดสินได้เมื่อ server บอกว่าถือ journey.review และไม่ใช่ผู้ส่งตรวจ — ไม่ขึ้นกับสิทธิ์แก้ไข
  const inReview = pendingReview?.state === 'IN_REVIEW';
  const canDecide = inReview && permissions.review && !pendingReview.makerIsCaller;
  const decisionBlockedReason = !inReview
    ? null
    : pendingReview.makerIsCaller
      ? t('review.blockedMaker')
      : !permissions.review
        ? t('review.blockedPermission')
        : null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError({ code: failure instanceof JourneyAuthoringApiError ? failure.code : undefined });
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      if (!artifact) return;
      const binding = {
        draftRevision: head.currentDraftRevision,
        draftDigest: head.currentDraftDigest,
        compileDigest: artifact.compileDigest,
        referenceDigest: artifact.referenceDigest,
        capabilityDigest: artifact.capabilityDigest,
        baseHeadVersion: head.version,
        baseHeadDigest: null,
      };
      const serialized = JSON.stringify(binding);
      if (submitIntent.current?.binding !== serialized)
        submitIntent.current = { binding: serialized, key: `review-${crypto.randomUUID()}` };
      await api.submitReview(head.journeyId, binding, submitIntent.current.key);
      submitIntent.current = null;
      await onChanged();
    });

  const decide = (decision: Decision, values: Record<string, string>) =>
    run(async () => {
      if (!pendingReview) return;
      setDeciding(null);
      await api.decideReview(
        pendingReview.reviewId,
        { decision, reasonCode: values.reasonCode!, evidenceRef: values.evidenceRef! },
        `decision-${crypto.randomUUID()}`,
      );
      await onChanged();
    });

  const simulate = () =>
    run(async () => {
      if (!artifact) return;
      let context: Record<string, string | number | boolean | null>;
      try {
        context = JSON.parse(contextJson) as typeof context;
      } catch {
        setError({ code: 'SIMULATION_CONTEXT_INVALID' });
        return;
      }
      setSimulation(
        await api.simulate(head.journeyId, {
          compileDigest: artifact.compileDigest,
          fixture: {
            fixtureId: 'console-synthetic',
            startAt: new Date().toISOString(),
            seed: 'console',
            context,
          },
        }),
      );
    });

  return (
    <div className="j5-review">
      <div className="j5-button-row">
        <Button isDisabled={dirty || busy} onPress={() => void run(onCompile)}>
          {t('review.compile')}
        </Button>
        <Button
          isDisabled={!artifact || busy}
          onPress={() =>
            void run(async () =>
              setPreview(await api.preview(head.journeyId, artifact!.compileDigest)),
            )
          }
        >
          {t('review.preview')}
        </Button>
      </div>
      {dirty ? <p className="j5-help">{t('review.saveBeforeCompile')}</p> : null}
      {artifact ? (
        <p className="j5-help">
          {t('review.compiled', { digest: artifact.compileDigest.slice(0, 12) })}
          {compile?.stale ? t('review.compiledStale') : ''}
        </p>
      ) : null}
      {preview ? (
        <ol className="j5-preview" aria-label={t('review.previewLabel')}>
          {preview.steps.map((step) => (
            <li key={step.nodeId}>
              {step.type} ({step.nodeId})
              {step.capability !== 'AVAILABLE' ? t('review.runtimeUnsupported') : ''}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="j5-field">
        <label htmlFor={contextId}>{t('review.contextLabel')}</label>
        <textarea
          id={contextId}
          rows={3}
          value={contextJson}
          onChange={(event) => setContextJson(event.target.value)}
        />
        <small className="j5-help">{t('review.contextHint')}</small>
      </div>
      <Button isDisabled={!artifact || busy} onPress={() => void simulate()}>
        {t('review.simulate')}
      </Button>
      {simulation ? (
        <div className="j5-simulation" role="status">
          <p>
            {t('review.simulationResult', {
              terminal: simulation.terminal,
              steps: simulation.transitions.length,
            })}
          </p>
          <ol>
            {simulation.transitions.map((transition) => (
              <li key={transition.sequence}>
                {transition.nodeId}
                {transition.portId ? ` → ${transition.portId}` : ''}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <h3>{t('review.heading')}</h3>
      <p role="status" aria-live="polite">
        {pendingReview
          ? t('review.state', { state: pendingReview.state })
          : t('review.notSubmitted')}
      </p>
      {pendingReview ? (
        <dl className="j5-candidate" aria-label={t('review.candidateLabel')}>
          <dt>{t('review.draft')}</dt>
          <dd>{t('common.revision', { revision: pendingReview.draftRevision })}</dd>
          <dt>{t('review.draftDigest')}</dt>
          <dd>
            <code>{pendingReview.draftDigest.slice(0, 12)}</code>
          </dd>
          <dt>{t('review.compileDigest')}</dt>
          <dd>
            <code>{pendingReview.compileDigest.slice(0, 12)}</code>
          </dd>
        </dl>
      ) : null}
      {decisionBlockedReason ? <p role="note">{decisionBlockedReason}</p> : null}
      <div className="j5-button-row">
        {readOnly || !permissions.edit ? null : (
          <Button
            variant="primary"
            isDisabled={
              !artifact ||
              compile?.stale === true ||
              dirty ||
              busy ||
              pendingReview?.state === 'IN_REVIEW'
            }
            onPress={() => void submit()}
          >
            {t('review.submit')}
          </Button>
        )}
        {canDecide
          ? DECISIONS.map((decision) => (
              <Button
                key={decision}
                variant={decision === 'APPROVE' ? 'primary' : 'secondary'}
                isDisabled={busy}
                onPress={() => setDeciding(decision)}
              >
                {decisionLabel(decision)}
              </Button>
            ))
          : null}
      </div>
      {error ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(error.code)}
        </p>
      ) : null}
      {deciding ? (
        <Dialog
          title={t('review.confirmTitle', { decision: decisionLabel(deciding) })}
          body={<p>{t('review.confirmBody')}</p>}
          fields={[
            reasonField(),
            {
              name: 'evidenceRef',
              label: t('review.evidenceLabel'),
              hint: t('review.evidenceHint'),
              pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
            },
          ]}
          confirmLabel={decisionLabel(deciding)}
          danger={deciding === 'REJECT'}
          onCancel={() => setDeciding(null)}
          onConfirm={(values) => void decide(deciding, values)}
        />
      ) : null}
    </div>
  );
}
