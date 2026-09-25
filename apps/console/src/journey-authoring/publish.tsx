/**
 * J5.6 (#344): publish และ lifecycle — สถานะทั้งหมดมาจาก server
 *
 * - key ของ publish ถูกถือไว้ตลอด intent เดียว (ผูกกับ review/draft/compile ที่ยืนยัน): retry และ
 *   resolve ใช้ key เดิมเสมอ ไม่ mint ใหม่ จึงไม่มีทาง publish ซ้ำจากการกดซ้ำหรือเน็ตหลุด
 * - `202 PUBLISH_OUTCOME_UNKNOWN` หรือเน็ตหลุดระหว่างรอ ไม่ถูกแสดงว่าสำเร็จ — ต้อง resolve จนรู้ผล
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  JourneyAuthoringApiError,
  type CompileSummary,
  type JourneyAuthoringApi,
  type JourneySnapshot,
} from './api.js';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { errorMessage, journeyText } from './model.js';

export interface DialogField {
  name: string;
  label: string;
  hint?: string;
  initial?: string;
  pattern?: RegExp;
  patternHint?: string;
}

/** dialog แบบ modal: focus เข้าตัวแรก, Tab วนในกล่อง, Esc ปิด และคืน focus ให้ปุ่มที่เปิด */
export function Dialog({
  title,
  body,
  fields = [],
  confirmLabel,
  danger,
  alert,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  fields?: DialogField[];
  confirmLabel: string;
  danger?: boolean;
  alert?: boolean;
  onCancel: () => void;
  onConfirm: (values: Record<string, string>) => void;
}) {
  const { t } = useTranslation('journeys');
  const titleId = useId();
  const bodyId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.name, field.initial ?? ''])),
  );
  useEffect(() => {
    returnFocus.current = window.document.activeElement;
    boxRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      const target = returnFocus.current as HTMLElement | null;
      if (target?.isConnected) target.focus();
    };
  }, []);
  const invalid = fields.some((field) => {
    const value = values[field.name]?.trim() ?? '';
    return value.length === 0 || (field.pattern ? !field.pattern.test(value) : false);
  });
  return (
    <div className="j5-modal" role="presentation">
      <div
        ref={boxRef}
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="j5-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const focusable = [
              ...(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ??
                []),
            ];
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && window.document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && window.document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="j5-dialog-body">
          {body}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid)
              onConfirm(
                Object.fromEntries(
                  Object.entries(values).map(([key, value]) => [key, value.trim()]),
                ),
              );
          }}
        >
          {fields.map((field) => (
            <label key={field.name}>
              {field.label}
              <input
                type="text"
                value={values[field.name] ?? ''}
                required
                onChange={(event) =>
                  setValues((current) => ({ ...current, [field.name]: event.target.value }))
                }
              />
              {field.hint ? <small>{field.hint}</small> : null}
            </label>
          ))}
          <div className="j5-dialog-actions">
            <Button onPress={onCancel}>{t('common.cancel')}</Button>
            <Button type="submit" variant={danger ? 'danger' : 'primary'} isDisabled={invalid}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** ช่อง reason code ร่วม — label/hint อ่านจาก catalog ตอนเปิด dialog (ภาษาปัจจุบัน) */
export function reasonField(): DialogField {
  return {
    name: 'reasonCode',
    label: journeyText('dialog.reasonLabel'),
    hint: journeyText('dialog.reasonHint'),
    pattern: /^[A-Z][A-Z0-9_]{2,63}$/,
  };
}

type PublishState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'unknown' }
  | { phase: 'not-committed' }
  | { phase: 'published'; version: number }
  | { phase: 'failed'; code?: string };

export function PublishPanel({
  api,
  snapshot,
  compile,
  dirty,
  readOnly,
  onChanged,
}: {
  api: JourneyAuthoringApi;
  snapshot: JourneySnapshot;
  compile: CompileSummary | null;
  dirty: boolean;
  readOnly: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation('journeys');
  const [state, setState] = useState<PublishState>({ phase: 'idle' });
  const [confirming, setConfirming] = useState(false);
  const [lifecycle, setLifecycle] = useState<'pause' | 'resume' | 'deprecate' | null>(null);
  const [lifecycleError, setLifecycleError] = useState<{ code?: string } | null>(null);
  const intent = useRef<{ binding: string; key: string } | null>(null);
  const { head, review } = snapshot;
  const artifact = compile?.artifact;
  const approved =
    review?.state === 'APPROVED' && review.draftRevision === head.currentDraftRevision;
  const ready = !readOnly && !dirty && approved && artifact && !compile?.stale;
  const blocker = readOnly
    ? t('publish.blockerReadOnly')
    : dirty
      ? t('publish.blockerDirty')
      : !approved
        ? t('publish.blockerApproval')
        : !artifact || compile?.stale
          ? t('publish.blockerCompile')
          : null;

  const send = async () => {
    if (!artifact || !review) return;
    const body = {
      reviewId: review.reviewId,
      draftRevision: head.currentDraftRevision,
      draftDigest: head.currentDraftDigest,
      compileDigest: artifact.compileDigest,
      referenceDigest: artifact.referenceDigest,
      capabilityDigest: artifact.capabilityDigest,
      baseHeadVersion: head.version,
      baseHeadDigest: null,
      expectedHeadVersion: head.version,
    };
    const binding = JSON.stringify(body);
    if (intent.current?.binding !== binding) {
      intent.current = { binding, key: `publish-${crypto.randomUUID()}` };
    }
    setState({ phase: 'sending' });
    try {
      const outcome = await api.publish(head.journeyId, body, intent.current.key);
      if (outcome.kind === 'UNKNOWN') {
        setState({ phase: 'unknown' });
        return;
      }
      intent.current = null;
      setState({ phase: 'published', version: outcome.result.version ?? 0 });
      await onChanged();
    } catch (error) {
      if (error instanceof JourneyAuthoringApiError) {
        setState({ phase: 'failed', code: error.code });
      } else {
        // เน็ตหลุดระหว่างรอ: ไม่รู้ว่า server commit หรือยัง
        setState({ phase: 'unknown' });
      }
    }
  };

  const resolve = async () => {
    if (!intent.current) return;
    setState({ phase: 'sending' });
    try {
      const result = await api.resolvePublish(head.journeyId, intent.current.key);
      if (result.outcome === 'PUBLISHED') {
        intent.current = null;
        setState({ phase: 'published', version: result.version ?? 0 });
        await onChanged();
      } else if (result.outcome === 'NOT_COMMITTED') {
        setState({ phase: 'not-committed' });
      } else {
        setState({ phase: 'failed', code: result.errorCode });
      }
    } catch (error) {
      setState(
        error instanceof JourneyAuthoringApiError
          ? { phase: 'failed', code: error.code }
          : { phase: 'unknown' },
      );
    }
  };

  const changeLifecycle = async (action: 'pause' | 'resume' | 'deprecate', reasonCode: string) => {
    setLifecycle(null);
    setLifecycleError(null);
    try {
      await api.changeLifecycle(
        head.journeyId,
        action,
        { expectedHeadVersion: head.version, reasonCode },
        `lifecycle-${crypto.randomUUID()}`,
      );
      await onChanged();
    } catch (error) {
      setLifecycleError({
        code: error instanceof JourneyAuthoringApiError ? error.code : undefined,
      });
    }
  };

  const status =
    state.phase === 'sending'
      ? t('publish.sending')
      : state.phase === 'published'
        ? t('publish.published', { version: state.version })
        : state.phase === 'unknown'
          ? t('publish.unknown')
          : state.phase === 'not-committed'
            ? t('publish.notCommitted')
            : '';

  return (
    <div className="j5-publish">
      <dl className="j5-facts">
        <div>
          <dt>{t('publish.factStatus')}</dt>
          <dd>{head.lifecycle}</dd>
        </div>
        <div>
          <dt>{t('publish.factActiveVersion')}</dt>
          <dd>{head.activeVersion ?? t('publish.neverPublished')}</dd>
        </div>
        <div>
          <dt>{t('publish.factDraft')}</dt>
          <dd>{t('common.revision', { revision: head.currentDraftRevision })}</dd>
        </div>
      </dl>
      <p className="j5-live" role="status" aria-live="polite">
        {status}
      </p>
      {state.phase === 'failed' ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(state.code)}
        </p>
      ) : null}
      {blocker ? <p className="j5-help">{blocker}</p> : null}
      <div className="j5-button-row">
        {state.phase === 'unknown' ? (
          <Button variant="primary" onPress={() => void resolve()}>
            {t('publish.resolve')}
          </Button>
        ) : state.phase === 'not-committed' ? (
          <Button variant="primary" onPress={() => void send()}>
            {t('publish.resend')}
          </Button>
        ) : (
          <Button
            variant="primary"
            isDisabled={!ready || state.phase === 'sending'}
            onPress={() => setConfirming(true)}
          >
            {t('publish.publish')}
          </Button>
        )}
        {readOnly ? null : (
          <>
            {head.lifecycle === 'ACTIVE' ? (
              <Button onPress={() => setLifecycle('pause')}>{t('publish.pause')}</Button>
            ) : null}
            {head.lifecycle === 'PAUSED' ? (
              <Button onPress={() => setLifecycle('resume')}>{t('publish.resume')}</Button>
            ) : null}
            {head.lifecycle === 'ACTIVE' || head.lifecycle === 'PAUSED' ? (
              <Button variant="danger" onPress={() => setLifecycle('deprecate')}>
                {t('publish.deprecate')}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {lifecycleError ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(lifecycleError.code)}
        </p>
      ) : null}
      {confirming && artifact ? (
        <Dialog
          alert
          title={t('publish.confirmTitle', { version: (head.activeVersion ?? 0) + 1 })}
          body={<p>{t('publish.confirmBody', { hash: artifact.runtimeHash.slice(0, 12) })}</p>}
          confirmLabel={t('publish.confirmLabel')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void send();
          }}
        />
      ) : null}
      {lifecycle ? (
        <Dialog
          title={
            lifecycle === 'pause'
              ? t('publish.pauseTitle')
              : lifecycle === 'resume'
                ? t('publish.resumeTitle')
                : t('publish.deprecateTitle')
          }
          body={<p>{t('publish.lifecycleBody')}</p>}
          fields={[reasonField()]}
          confirmLabel={t('common.confirm')}
          danger={lifecycle === 'deprecate'}
          onCancel={() => setLifecycle(null)}
          onConfirm={(values) => void changeLifecycle(lifecycle, values.reasonCode!)}
        />
      ) : null}
    </div>
  );
}
