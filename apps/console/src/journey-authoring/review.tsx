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
import { errorMessage } from './model.js';
import { Dialog, REASON_FIELD } from './publish.js';

type Decision = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT';
const DECISION_LABELS: Record<Decision, string> = {
  APPROVE: 'อนุมัติ',
  REQUEST_CHANGES: 'ขอให้แก้ไข',
  REJECT: 'ไม่อนุมัติ',
};

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
  const contextId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      ? 'คุณเป็นผู้ส่งตรวจ candidate นี้ ต้องให้ reviewer คนอื่นเป็นผู้ตัดสิน'
      : !permissions.review
        ? 'คุณไม่มีสิทธิ์ตรวจ Journey นี้ (journey.review)'
        : null;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(
        errorMessage(failure instanceof JourneyAuthoringApiError ? failure.code : undefined),
      );
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
        setError('context ของ simulation ต้องเป็น JSON object ของค่าสังเคราะห์');
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
        <button
          type="button"
          className="gov-secondary"
          disabled={dirty || busy}
          onClick={() => void run(onCompile)}
        >
          Compile ฉบับร่าง
        </button>
        <button
          type="button"
          className="gov-secondary"
          disabled={!artifact || busy}
          onClick={() =>
            void run(async () =>
              setPreview(await api.preview(head.journeyId, artifact!.compileDigest)),
            )
          }
        >
          ดูลำดับการทำงาน
        </button>
      </div>
      {dirty ? <p className="j5-help">บันทึกฉบับร่างก่อน compile</p> : null}
      {artifact ? (
        <p className="j5-help">
          compile แล้ว · digest {artifact.compileDigest.slice(0, 12)}
          {compile?.stale ? ' · ผลนี้เก่ากว่าฉบับร่างล่าสุด' : ''}
        </p>
      ) : null}
      {preview ? (
        <ol className="j5-preview" aria-label="ลำดับการทำงานจาก compile">
          {preview.steps.map((step) => (
            <li key={step.nodeId}>
              {step.type} ({step.nodeId})
              {step.capability !== 'AVAILABLE' ? ' · runtime ยังไม่รองรับ' : ''}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="j5-field">
        <label htmlFor={contextId}>Context สังเคราะห์สำหรับ simulation (JSON)</label>
        <textarea
          id={contextId}
          rows={3}
          value={contextJson}
          onChange={(event) => setContextJson(event.target.value)}
        />
        <small className="j5-help">ใช้ค่าสมมติเท่านั้น ห้ามใส่ข้อมูลลูกค้าจริง</small>
      </div>
      <button
        type="button"
        className="gov-secondary"
        disabled={!artifact || busy}
        onClick={() => void simulate()}
      >
        จำลองการทำงาน
      </button>
      {simulation ? (
        <div className="j5-simulation" role="status">
          <p>
            จบที่ {simulation.terminal} หลัง {simulation.transitions.length} ขั้นตอน (จำลองเท่านั้น)
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

      <h3>การตรวจ (maker-checker)</h3>
      <p role="status" aria-live="polite">
        {pendingReview ? `สถานะการตรวจ: ${pendingReview.state}` : 'ฉบับร่างนี้ยังไม่ได้ส่งตรวจ'}
      </p>
      {pendingReview ? (
        <dl className="j5-candidate" aria-label="Candidate ที่ส่งตรวจ">
          <dt>ฉบับร่าง</dt>
          <dd>revision {pendingReview.draftRevision}</dd>
          <dt>Draft digest</dt>
          <dd>
            <code>{pendingReview.draftDigest.slice(0, 12)}</code>
          </dd>
          <dt>Compile digest</dt>
          <dd>
            <code>{pendingReview.compileDigest.slice(0, 12)}</code>
          </dd>
        </dl>
      ) : null}
      {decisionBlockedReason ? <p role="note">{decisionBlockedReason}</p> : null}
      <div className="j5-button-row">
        {readOnly || !permissions.edit ? null : (
          <button
            type="button"
            className="gov-primary"
            disabled={
              !artifact || compile?.stale || dirty || busy || pendingReview?.state === 'IN_REVIEW'
            }
            onClick={() => void submit()}
          >
            ส่งตรวจ
          </button>
        )}
        {canDecide
          ? (Object.keys(DECISION_LABELS) as Decision[]).map((decision) => (
              <button
                key={decision}
                type="button"
                className={decision === 'APPROVE' ? 'gov-primary' : 'gov-secondary'}
                disabled={busy}
                onClick={() => setDeciding(decision)}
              >
                {DECISION_LABELS[decision]}
              </button>
            ))
          : null}
      </div>
      {error ? (
        <p className="j5-status-error" role="alert">
          {error}
        </p>
      ) : null}
      {deciding ? (
        <Dialog
          title={`ยืนยัน${DECISION_LABELS[deciding]}`}
          body={<p>ผู้ส่งตรวจตัดสินงานของตัวเองไม่ได้ server จะตรวจสิทธิ์ของคุณอีกครั้ง</p>}
          fields={[
            REASON_FIELD,
            {
              name: 'evidenceRef',
              label: 'Evidence reference',
              hint: 'เช่นเลข ticket',
              pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
            },
          ]}
          confirmLabel={DECISION_LABELS[deciding]}
          danger={deciding === 'REJECT'}
          onCancel={() => setDeciding(null)}
          onConfirm={(values) => void decide(deciding, values)}
        />
      ) : null}
    </div>
  );
}
