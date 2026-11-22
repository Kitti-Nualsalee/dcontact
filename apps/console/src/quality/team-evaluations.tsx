import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Dialog,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
  TextField,
  toastQueue,
} from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import { dateRange, defaultDates } from '../team-recordings/model.js';
import {
  QualityApiError,
  type Answers,
  type Evaluation,
  type EvaluationFilter,
  type FormDefinition,
  type FormSummary,
  type QualityApi,
  type TeamInteraction,
  type TeamInteractionItem,
} from './api.js';
import { EvaluationForm } from './evaluation-form.js';
import { cleanAnswers, errorMap, formatScore, scoredQuestions, unanswered } from './model.js';
import { ScoreSummary } from './score-summary.js';
import { EditorSkeleton, ListSkeleton } from './skeleton.js';
import './quality.css';

interface Props {
  api: QualityApi;
  identityKey: string;
  onSignIn?: () => void;
}

const TOAST_MS = 5000;
const FILTERS: (EvaluationFilter | 'ALL')[] = ['ALL', 'NOT_EVALUATED', 'DRAFT', 'PUBLISHED'];

const statusOf = (failure: unknown) => (failure instanceof QualityApiError ? failure.status : 500);

/** เปลี่ยนผู้ใช้แล้วทิ้ง state ของคนก่อนทั้งหมด */
export function TeamEvaluations(props: Props) {
  return <TeamEvaluationsSession key={props.identityKey} {...props} />;
}

function TeamEvaluationsSession({ api, onSignIn }: Props) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const fromId = useId();
  const toId = useId();
  const openId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [dates, setDates] = useState(() => defaultDates(new Date()));
  const [filter, setFilter] = useState<EvaluationFilter | 'ALL'>('ALL');
  const [applied, setApplied] = useState({ ...dates, filter });
  const [items, setItems] = useState<TeamInteractionItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const range = dateRange(dates.from, dates.to);
  const rangeError = 'error' in range ? range.error : undefined;
  const format = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );

  useEffect(() => {
    const window = dateRange(applied.from, applied.to);
    if ('error' in window) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    void api
      .teamInteractions({
        ...window,
        ...(applied.filter === 'ALL' ? {} : { status: applied.filter }),
        ...(pageCursor ? { cursor: pageCursor } : {}),
      })
      .then((page) => {
        if (!active) return;
        setItems((current) => (pageCursor ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
      })
      .catch((failure: unknown) => {
        if (active) setError(statusOf(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, applied, pageCursor, reload]);

  if (!ready) return null;

  if (selected) {
    return (
      <EvaluationEditor
        api={api}
        interactionId={selected}
        onSignIn={onSignIn}
        onBack={(changed) => {
          const opener = selected;
          setSelected(undefined);
          if (changed) {
            setPageCursor(undefined);
            setReload((current) => current + 1);
          }
          // คืน focus ให้ปุ่มของแถวเดิม ถ้าไม่อยู่แล้วไปที่หัวข้อหน้า
          requestAnimationFrame(() =>
            (document.getElementById(`${openId}-${opener}`) ?? heading.current)?.focus(),
          );
        }}
      />
    );
  }

  const errorKey =
    error === 401 ? 'unauthorized' : error === 403 ? 'forbidden' : error ? 'failed' : undefined;
  return (
    <main className="qm-root">
      <header className="qm-head">
        <h1 ref={heading} tabIndex={-1}>
          {t('team.title')}
        </h1>
        <p className="qm-muted">{t('team.scope')}</p>
      </header>
      <form
        className="qm-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (rangeError) return;
          setPageCursor(undefined);
          setApplied({ ...dates, filter });
          setReload((current) => current + 1);
        }}
      >
        <div className="qm-field">
          <label htmlFor={fromId}>{t('team.from')}</label>
          <input
            id={fromId}
            type="date"
            value={dates.from}
            max={dates.to}
            aria-invalid={rangeError ? true : undefined}
            aria-describedby={rangeError ? `${fromId}-error` : undefined}
            onChange={(event) => setDates({ ...dates, from: event.target.value })}
          />
        </div>
        <div className="qm-field">
          <label htmlFor={toId}>{t('team.to')}</label>
          <input
            id={toId}
            type="date"
            value={dates.to}
            min={dates.from}
            aria-invalid={rangeError ? true : undefined}
            aria-describedby={rangeError ? `${fromId}-error` : undefined}
            onChange={(event) => setDates({ ...dates, to: event.target.value })}
          />
        </div>
        <Select
          className="qm-filter-select"
          label={t('team.status')}
          selectedKey={filter}
          onSelectionChange={(key) => setFilter(key as EvaluationFilter | 'ALL')}
          options={FILTERS.map((id) => ({ id, label: t(`team.filter.${id}`) }))}
        />
        <Button type="submit" variant="primary" isDisabled={loading || !!rangeError}>
          {t('team.show')}
        </Button>
        {rangeError ? (
          <p id={`${fromId}-error`} className="qm-field-error qm-filters-error" role="alert">
            {t(`range.${rangeError}`)}
          </p>
        ) : null}
      </form>
      {loading && items.length === 0 ? <ListSkeleton label={t('loading')} /> : null}
      {errorKey ? (
        <section role="alert" className="qm-alert">
          <p>{t(errorKey)}</p>
          {error === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          {error !== 403 ? (
            <Button onPress={() => setReload((current) => current + 1)}>{t('retry')}</Button>
          ) : null}
        </section>
      ) : null}
      {!loading && !error && items.length === 0 ? (
        <p className="qm-empty">{t('team.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <>
          <p className="qm-muted" aria-live="polite">
            {t('team.count', { count: items.length })}
          </p>
          <div className="qm-scroll" aria-busy={loading} data-stale={loading || undefined}>
            <Table aria-label={t('team.list')}>
              <TableHeader>
                <Column isRowHeader>{t('team.acceptedAt')}</Column>
                <Column>{t('team.agent')}</Column>
                <Column>{t('team.queue')}</Column>
                <Column>{t('team.evaluation')}</Column>
                <Column>{t('team.score')}</Column>
                <Column>{t('team.action')}</Column>
              </TableHeader>
              <TableBody>
                {items.map((item) => {
                  const agent = item.agentName ?? t('unknownAgent');
                  const state = item.evaluation?.status ?? 'NOT_EVALUATED';
                  return (
                    <Row key={item.interactionId} id={item.interactionId}>
                      <Cell>
                        <time className="qm-nowrap" dateTime={item.acceptedAt}>
                          {format(item.acceptedAt)}
                        </time>
                      </Cell>
                      <Cell>{agent}</Cell>
                      <Cell>{item.queueName ?? t('unknownQueue')}</Cell>
                      <Cell>
                        <Badge
                          tone={
                            state === 'PUBLISHED'
                              ? 'success'
                              : state === 'DRAFT'
                                ? 'attention'
                                : 'neutral'
                          }
                        >
                          {t(`team.filter.${state}`)}
                        </Badge>
                      </Cell>
                      <Cell>
                        <span className="qm-nowrap">
                          {item.evaluation?.status === 'PUBLISHED'
                            ? formatScore(item.evaluation.finalScore, locale)
                            : '—'}
                        </span>
                      </Cell>
                      <Cell>
                        <Button
                          id={`${openId}-${item.interactionId}`}
                          size="sm"
                          variant={state === 'NOT_EVALUATED' ? 'primary' : 'secondary'}
                          aria-label={t(`team.open.${state}Item`, {
                            agent,
                            time: format(item.acceptedAt),
                          })}
                          onPress={() => setSelected(item.interactionId)}
                        >
                          {t(`team.open.${state}`)}
                        </Button>
                      </Cell>
                    </Row>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {nextCursor ? (
            <div className="qm-more">
              <Button isDisabled={loading} onPress={() => setPageCursor(nextCursor)}>
                {t('more')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

type EditorError = { kind: 'load'; status: number } | { kind: 'save'; code: string } | undefined;

function EvaluationEditor({
  api,
  interactionId,
  onBack,
  onSignIn,
}: {
  api: QualityApi;
  interactionId: string;
  onBack: (changed: boolean) => void;
  onSignIn?: () => void;
}) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const commentId = useId();
  const [interaction, setInteraction] = useState<TeamInteraction>();
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [formVersionId, setFormVersionId] = useState<string>();
  const [definition, setDefinition] = useState<FormDefinition>();
  const [answers, setAnswers] = useState<Answers>({});
  const [comment, setComment] = useState('');
  const [dirty, setDirty] = useState(false);
  const [changed, setChanged] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<EditorError>();
  const [busy, setBusy] = useState<'save' | 'publish' | 'form'>();
  const [dialog, setDialog] = useState<'publish' | 'leave' | 'switch'>();
  const [pendingForm, setPendingForm] = useState<string>();
  const [focusHeading, setFocusHeading] = useState(false);
  const [reload, setReload] = useState(0);

  // ย้าย focus ไปที่หัวข้อหลัง Dialog ปิดแล้วจริง (ปุ่มที่เปิด Dialog อาจหายไปหลัง publish)
  useEffect(() => {
    if (!focusHeading || dialog) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        heading.current?.focus();
        setFocusHeading(false);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusHeading, dialog]);

  const apply = (next: Evaluation | null) => {
    setEvaluation(next);
    if (next) {
      setFormVersionId(next.formVersionId);
      setDefinition(next.form.definition);
      setAnswers(next.answers);
      setComment(next.comment ?? '');
    }
    setDirty(false);
  };

  useEffect(() => {
    let active = true;
    setFailure(undefined);
    void Promise.all([api.evaluation(interactionId), api.listForms()])
      .then(([loaded, list]) => {
        if (!active) return;
        setInteraction(loaded.interaction);
        setForms(list.items.filter((form) => form.current));
        apply(loaded.evaluation);
        setFocusHeading(true);
      })
      .catch((error: unknown) => {
        if (active) setFailure({ kind: 'load', status: statusOf(error) });
      });
    return () => {
      active = false;
    };
  }, [api, interactionId, reload]);

  /** เปลี่ยนฟอร์มล้างคำตอบที่ตอบไว้ จึงถามก่อนเมื่อมีคำตอบแล้ว */
  const requestForm = (versionId: string) => {
    if (Object.keys(answers).length > 0 && versionId !== formVersionId) {
      setPendingForm(versionId);
      setDialog('switch');
    } else chooseForm(versionId);
  };

  const chooseForm = (versionId: string) => {
    setFormVersionId(versionId);
    setBusy('form');
    setErrors({});
    void api
      .formVersion(versionId)
      .then((version) => {
        setDefinition(version.definition);
        setAnswers({});
        setDirty(true);
      })
      .catch((error: unknown) => setFailure({ kind: 'load', status: statusOf(error) }))
      .finally(() => setBusy(undefined));
  };

  /** บันทึกร่างแล้วคืนผลล่าสุด; ล้มแล้วแสดงเหตุโดยไม่ทิ้งคำตอบที่กรอกไว้ */
  const save = async (): Promise<Evaluation | undefined> => {
    if (!formVersionId || !definition) return undefined;
    setErrors({});
    setFailure(undefined);
    try {
      const result = await api.saveEvaluation(interactionId, {
        commandId: crypto.randomUUID(),
        formVersionId,
        answers: cleanAnswers(definition, answers),
        comment,
        ...(evaluation ? { revision: evaluation.revision } : {}),
      });
      apply(result.evaluation);
      setChanged(true);
      return result.evaluation;
    } catch (error) {
      handle(error);
      return undefined;
    }
  };

  const handle = (error: unknown) => {
    if (error instanceof QualityApiError && error.errors.length > 0) {
      setErrors(errorMap(error.errors));
      setFailure({ kind: 'save', code: 'VALIDATION_FAILED' });
    } else if (error instanceof QualityApiError && error.status === 401) {
      setFailure({ kind: 'load', status: 401 });
    } else {
      setFailure({
        kind: 'save',
        code: error instanceof QualityApiError && error.code ? error.code : 'FAILED',
      });
    }
  };

  const publish = async () => {
    setBusy('publish');
    try {
      const saved = dirty || !evaluation ? await save() : evaluation;
      if (!saved) return;
      const result = await api.publishEvaluation(interactionId, {
        commandId: crypto.randomUUID(),
        revision: saved.revision,
      });
      apply(result.evaluation);
      setChanged(true);
      setDialog(undefined);
      toastQueue.add(
        { title: t('editor.toast.published'), tone: 'success' },
        { timeout: TOAST_MS },
      );
      setFocusHeading(true);
    } catch (error) {
      setDialog(undefined);
      handle(error);
    } finally {
      setBusy(undefined);
    }
  };

  const back = () => (dirty ? setDialog('leave') : onBack(changed));

  if (failure?.kind === 'load') {
    const key =
      failure.status === 401
        ? 'unauthorized'
        : failure.status === 404
          ? 'editor.notFound'
          : failure.status === 403
            ? 'editor.forbidden'
            : 'failed';
    return (
      <main className="qm-root">
        <Button variant="ghost" onPress={() => onBack(changed)}>
          {t('editor.back')}
        </Button>
        <section role="alert" className="qm-alert">
          <p>{t(key)}</p>
          {failure.status === 401 && onSignIn ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
          {failure.status >= 500 ? (
            <Button onPress={() => setReload((current) => current + 1)}>{t('retry')}</Button>
          ) : null}
        </section>
      </main>
    );
  }
  if (!interaction)
    return (
      <EditorSkeleton
        label={t('loading')}
        backLabel={t('editor.back')}
        onBack={() => onBack(changed)}
      />
    );

  const agent = interaction.agentName ?? t('unknownAgent');
  const published = evaluation?.status === 'PUBLISHED';
  const missing = definition ? unanswered(definition, answers) : [];
  const required = definition ? scoredQuestions(definition).length : 0;
  const saving = busy === 'save' || busy === 'publish';
  const formLabel = evaluation
    ? t('editor.formName', { name: evaluation.form.formName, version: evaluation.form.version })
    : undefined;

  return (
    <main className="qm-root">
      <Button variant="ghost" onPress={back}>
        {t('editor.back')}
      </Button>
      <header className="qm-head">
        <h1 ref={heading} tabIndex={-1}>
          {t('editor.title', { agent })}
        </h1>
        <p className="qm-muted">
          {[
            new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(interaction.acceptedAt),
            ),
            interaction.queueName ?? t('unknownQueue'),
            interaction.hasRecording ? t('editor.hasRecording') : t('editor.noRecording'),
          ].join(' · ')}
        </p>
      </header>
      <div className="qm-layout">
        <div className="qm-main">
          {!evaluation ? (
            forms.length === 0 ? (
              <p className="qm-empty">{t('editor.noForms')}</p>
            ) : (
              <section className="qm-card">
                <Select
                  label={t('editor.chooseForm')}
                  description={t('editor.chooseFormHint')}
                  placeholder={t('editor.chooseFormPlaceholder')}
                  selectedKey={formVersionId ?? null}
                  isDisabled={busy === 'form' || saving}
                  onSelectionChange={(key) => key && requestForm(String(key))}
                  options={forms.map((form) => ({
                    id: form.current!.versionId,
                    label: t('editor.formName', {
                      name: form.name,
                      version: form.current!.version,
                    }),
                  }))}
                />
              </section>
            )
          ) : null}
          {definition ? (
            <>
              <EvaluationForm
                definition={definition}
                answers={answers}
                errors={errors}
                disabled={saving || published}
                sectionScores={published ? evaluation?.score?.sections : undefined}
                {...(published
                  ? {}
                  : {
                      onChange: (next: Answers) => {
                        setAnswers(next);
                        setDirty(true);
                      },
                    })}
              />
              <section className="qm-card">
                {published ? (
                  <>
                    <h2>{t('editor.comment')}</h2>
                    <p className="qm-answer-text">
                      {evaluation?.comment || t('evaluation.noText')}
                    </p>
                  </>
                ) : (
                  <TextField
                    id={commentId}
                    label={t('editor.comment')}
                    description={
                      definition.requireCommentBelow !== null
                        ? t('editor.commentRule', { score: definition.requireCommentBelow })
                        : undefined
                    }
                    multiline
                    maxLength={4000}
                    value={comment}
                    isDisabled={saving}
                    isInvalid={!!errors.comment}
                    errorMessage={
                      errors.comment
                        ? t(`errors.${errors.comment}`, { defaultValue: t('errors.INVALID') })
                        : undefined
                    }
                    onChange={(next) => {
                      setComment(next);
                      setDirty(true);
                    }}
                  />
                )}
              </section>
            </>
          ) : null}
        </div>
        <aside className="qm-aside" aria-label={t('editor.summary')}>
          <section className="qm-card">
            <h2>{t('editor.summary')}</h2>
            <dl className="qm-facts">
              <dt>{t('editor.status')}</dt>
              <dd>
                <Badge tone={published ? 'success' : evaluation ? 'attention' : 'neutral'}>
                  {t(`team.filter.${evaluation?.status ?? 'NOT_EVALUATED'}`)}
                </Badge>
              </dd>
              {formLabel ? (
                <>
                  <dt>{t('editor.form')}</dt>
                  <dd>{formLabel}</dd>
                </>
              ) : null}
              {definition && !published ? (
                <>
                  <dt>{t('editor.progress')}</dt>
                  <dd>
                    {t('editor.progressValue', {
                      answered: required - missing.length,
                      required,
                    })}
                  </dd>
                </>
              ) : null}
              {evaluation?.evaluatorName ? (
                <>
                  <dt>{published ? t('editor.publishedBy') : t('editor.lastSavedBy')}</dt>
                  <dd>{evaluation.evaluatorName}</dd>
                </>
              ) : null}
            </dl>
            <ScoreSummary score={evaluation?.score ?? null} stale={dirty} />
            {failure?.kind === 'save' ? (
              <section role="alert" className="qm-alert qm-alert-aside">
                <p>
                  {t(`editor.failure.${failure.code}`, {
                    defaultValue: t('editor.failure.FAILED'),
                  })}
                </p>
                {failure.code === 'STALE_REVISION' ? (
                  <Button onPress={() => setReload((current) => current + 1)}>
                    {t('editor.reload')}
                  </Button>
                ) : null}
              </section>
            ) : null}
            {!published && definition ? (
              <div className="qm-actions">
                <Button
                  variant="primary"
                  isDisabled={saving || !formVersionId}
                  onPress={() => {
                    setBusy('save');
                    void save()
                      .then((result) => {
                        if (result)
                          toastQueue.add(
                            { title: t('editor.toast.saved'), tone: 'success' },
                            { timeout: TOAST_MS },
                          );
                      })
                      .finally(() => setBusy(undefined));
                  }}
                >
                  {busy === 'save' ? t('editor.saving') : t('editor.save')}
                </Button>
                <Button
                  isDisabled={saving || missing.length > 0}
                  onPress={() => setDialog('publish')}
                >
                  {t('editor.publish')}
                </Button>
                {missing.length > 0 ? (
                  <p className="qm-muted">
                    {t('editor.publishNeedsAll', { count: missing.length })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>
        </aside>
      </div>
      <Dialog
        role="alertdialog"
        isDismissable={false}
        isOpen={dialog === 'publish'}
        onOpenChange={(open) => !open && !busy && setDialog(undefined)}
        title={t('editor.publishDialog.title', { agent })}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" isDisabled={busy === 'publish'} onPress={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={busy === 'publish'}
              onPress={() => void publish()}
            >
              {busy === 'publish' ? t('editor.publishing') : t('editor.publishDialog.confirm')}
            </Button>
          </>
        )}
      >
        <p>{t('editor.publishDialog.body', { agent })}</p>
      </Dialog>
      <Dialog
        role="alertdialog"
        isOpen={dialog === 'switch'}
        onOpenChange={(open) => !open && setDialog(undefined)}
        title={t('editor.switchDialog.title')}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" onPress={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              onPress={() => {
                setDialog(undefined);
                if (pendingForm) chooseForm(pendingForm);
              }}
            >
              {t('editor.switchDialog.confirm')}
            </Button>
          </>
        )}
      >
        <p>{t('editor.switchDialog.body')}</p>
      </Dialog>
      <Dialog
        role="alertdialog"
        isOpen={dialog === 'leave'}
        onOpenChange={(open) => !open && setDialog(undefined)}
        title={t('editor.leaveDialog.title')}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" onPress={close}>
              {t('editor.leaveDialog.stay')}
            </Button>
            <Button variant="danger" onPress={() => onBack(changed)}>
              {t('editor.leaveDialog.leave')}
            </Button>
          </>
        )}
      >
        <p>{t('editor.leaveDialog.body')}</p>
      </Dialog>
    </main>
  );
}
