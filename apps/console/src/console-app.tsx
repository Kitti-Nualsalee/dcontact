import { useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import type { ConsoleApi, QmContext } from './console-api.js';

export function ConsoleApp({ api, contextId }: { api: ConsoleApi; contextId: string }) {
  const [context, setContext] = useState<QmContext>();
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [pending, setPending] = useState(false);
  const { t } = useTranslation('quality');
  const [error, setError] = useState<'loadFailed' | 'publishFailed'>();

  const refresh = async () => setContext(await api.context(contextId));
  useEffect(() => {
    void refresh().catch(() => setError('loadFailed'));
  }, [api, contextId]);

  const publish = async () => {
    const evaluation = context?.evaluation;
    if (!evaluation) return;
    setConfirmPublish(false);
    setPending(true);
    try {
      await api.publish(evaluation.id, crypto.randomUUID());
      await refresh();
    } catch {
      setError('publishFailed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="console-shell">
      <header>
        <strong>{t('interactionReview.brand')}</strong>
        <span>{t('interactionReview.product')}</span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">{t('interactionReview.eyebrow')}</p>
            <h1>
              {t('interactionReview.heading', {
                id: context?.interaction.id ?? t('interactionReview.loading'),
              })}
            </h1>
          </div>
          <span className="tenant-chip">
            {context?.interaction.queueName ?? t('interactionReview.loading')}
          </span>
        </div>
        {error ? (
          <p role="alert" className="warning">
            {t(`interactionReview.errors.${error}`)}
          </p>
        ) : null}
        <section className="review-grid">
          <article className="panel media-panel">
            <h2>{t('interactionReview.recording.title')}</h2>
            {context?.recording?.status === 'DELETED' ? (
              <p className="warning">{t('interactionReview.recording.deleted')}</p>
            ) : context?.recording ? (
              <>
                <button
                  className="primary"
                  onClick={() =>
                    void api.playback(context.recording!.id).then((p) => setPlaybackUrl(p.url))
                  }
                >
                  {t('interactionReview.recording.requestPlayback')}
                </button>
                {playbackUrl ? <audio controls src={playbackUrl} /> : null}
                {context.recording.pauseIntervals.map((gap) => (
                  <div className="pci-gap" key={`${gap.startMs}-${gap.endMs}`}>
                    {t('interactionReview.recording.pciGap', {
                      start: formatTime(gap.startMs),
                      end: formatTime(gap.endMs),
                    })}
                  </div>
                ))}
              </>
            ) : (
              <p>{t('interactionReview.recording.missing')}</p>
            )}
          </article>
          <article className="panel transcript-panel">
            <h2>{t('interactionReview.transcript')}</h2>
            {(context?.transcript?.segments ?? []).map((segment) => (
              <div className="segment" key={segment.id}>
                <span>
                  {formatTime(segment.startMs)} · {segment.speaker}
                </span>
                <p>{segment.text}</p>
              </div>
            ))}
          </article>
          <article className="panel evaluation-panel">
            <div className="panel-title">
              <h2>{t('interactionReview.evaluation.title')}</h2>
              <strong>{context?.evaluation?.status ?? '—'}</strong>
            </div>
            <p className="score">{context?.evaluation?.answers.score ?? '—'}</p>
            {context?.evaluation?.status === 'DRAFT' ? (
              <p className="draft-note">{t('interactionReview.evaluation.draftNote')}</p>
            ) : null}
            {context?.evaluation?.status === 'DRAFT' ? (
              <button
                className="primary"
                disabled={pending}
                onClick={() => setConfirmPublish(true)}
              >
                {t('interactionReview.evaluation.publish')}
              </button>
            ) : null}
            {pending ? <p aria-live="polite">{t('interactionReview.evaluation.pending')}</p> : null}
          </article>
        </section>
      </main>
      {confirmPublish ? (
        <section role="dialog" aria-modal="true" className="modal">
          <div>
            <h2>{t('interactionReview.confirm.title')}</h2>
            <p>{t('interactionReview.confirm.detail')}</p>
            <button onClick={() => setConfirmPublish(false)}>
              {t('interactionReview.confirm.cancel')}
            </button>
            <button className="primary" onClick={() => void publish()}>
              {t('interactionReview.confirm.action')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
