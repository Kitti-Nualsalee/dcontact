import { useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import { QualityApiError, type Evaluation, type MyEvaluationItem, type QualityApi } from './api.js';
import { EvaluationForm } from './evaluation-form.js';
import { formatScore } from './model.js';
import { ScoreSummary } from './score-summary.js';
import './quality.css';

interface Props {
  api: QualityApi;
  identityKey: string;
  onSignIn?: () => void;
}

const statusOf = (failure: unknown) => (failure instanceof QualityApiError ? failure.status : 500);

/** Agent เห็นผลประเมินที่ publish แล้วของตัวเองทุกใบ (ไม่มีโหมดประเมินลับ) */
export function MyQuality(props: Props) {
  return <MyQualitySession key={props.identityKey} {...props} />;
}

function MyQualitySession({ api, onSignIn }: Props) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const openId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [items, setItems] = useState<MyEvaluationItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageCursor, setPageCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string>();
  const format = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void api
      .myEvaluations(pageCursor)
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
  }, [api, pageCursor, reload]);

  if (!ready) return null;
  if (selected) {
    return (
      <MyEvaluationDetail
        api={api}
        evaluationId={selected}
        onBack={() => {
          const opener = selected;
          setSelected(undefined);
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
          {t('mine.title')}
        </h1>
        <p className="qm-muted">{t('mine.scope')}</p>
      </header>
      {loading && items.length === 0 ? (
        <div className="qm-skeleton" role="status" aria-label={t('loading')}>
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="qm-skeleton-row" />
          ))}
        </div>
      ) : null}
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
        <p className="qm-empty">{t('mine.empty')}</p>
      ) : null}
      {items.length > 0 ? (
        <>
          <div className="qm-scroll" aria-busy={loading} data-stale={loading || undefined}>
            <Table aria-label={t('mine.list')}>
              <TableHeader>
                <Column isRowHeader>{t('mine.publishedAt')}</Column>
                <Column>{t('mine.interactionAt')}</Column>
                <Column>{t('mine.form')}</Column>
                <Column>{t('mine.score')}</Column>
                <Column>{t('mine.action')}</Column>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <Row key={item.evaluationId} id={item.evaluationId}>
                    <Cell>
                      <time className="qm-nowrap" dateTime={item.publishedAt}>
                        {format(item.publishedAt)}
                      </time>
                    </Cell>
                    <Cell>
                      <time className="qm-nowrap" dateTime={item.interactionAt}>
                        {format(item.interactionAt)}
                      </time>
                    </Cell>
                    <Cell>
                      {t('editor.formName', { name: item.formName, version: item.formVersion })}
                    </Cell>
                    <Cell>
                      <span className="qm-nowrap">
                        {t('score.value', { score: formatScore(item.finalScore, locale) })}
                      </span>
                      {item.autoFailed ? (
                        <>
                          {' '}
                          <Badge tone="critical">{t('score.autoFailed')}</Badge>
                        </>
                      ) : null}
                    </Cell>
                    <Cell>
                      <Button
                        id={`${openId}-${item.evaluationId}`}
                        size="sm"
                        aria-label={t('mine.openItem', { time: format(item.interactionAt) })}
                        onPress={() => setSelected(item.evaluationId)}
                      >
                        {t('mine.open')}
                      </Button>
                    </Cell>
                  </Row>
                ))}
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

function MyEvaluationDetail({
  api,
  evaluationId,
  onBack,
}: {
  api: QualityApi;
  evaluationId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  const heading = useRef<HTMLHeadingElement>(null);
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [error, setError] = useState<number>();
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void api
      .myEvaluation(evaluationId)
      .then((loaded) => {
        if (!active) return;
        setEvaluation(loaded);
        requestAnimationFrame(() => heading.current?.focus());
      })
      .catch((failure: unknown) => {
        if (active) setError(statusOf(failure));
      });
    return () => {
      active = false;
    };
  }, [api, evaluationId, reload]);

  return (
    <main className="qm-root">
      <Button variant="ghost" onPress={onBack}>
        {t('mine.back')}
      </Button>
      {error ? (
        <section role="alert" className="qm-alert">
          <p>{t(error === 404 ? 'mine.notFound' : 'failed')}</p>
          {error >= 500 ? (
            <Button onPress={() => setReload((current) => current + 1)}>{t('retry')}</Button>
          ) : null}
        </section>
      ) : !evaluation ? (
        <div className="qm-skeleton" role="status" aria-label={t('loading')}>
          <span className="qm-skeleton-row" />
          <span className="qm-skeleton-row" />
        </div>
      ) : (
        <>
          <header className="qm-head">
            <h1 ref={heading} tabIndex={-1}>
              {t('editor.formName', {
                name: evaluation.form.formName,
                version: evaluation.form.version,
              })}
            </h1>
            <p className="qm-muted">
              {t('mine.publishedBy', {
                name: evaluation.evaluatorName ?? t('unknownAgent'),
                time: new Intl.DateTimeFormat(locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(evaluation.publishedAt!)),
              })}
            </p>
          </header>
          <div className="qm-layout">
            <div className="qm-main">
              <EvaluationForm
                definition={evaluation.form.definition}
                answers={evaluation.answers}
                sectionScores={evaluation.score?.sections}
              />
              <section className="qm-card">
                <h2>{t('editor.comment')}</h2>
                <p className="qm-answer-text">{evaluation.comment || t('evaluation.noText')}</p>
              </section>
            </div>
            <aside className="qm-aside" aria-label={t('editor.summary')}>
              <section className="qm-card">
                <h2>{t('editor.summary')}</h2>
                <ScoreSummary score={evaluation.score} />
              </section>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
