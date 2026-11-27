import { useEffect, useId, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { QualityApiError, type QualityApi, type TranscriptView } from './api.js';
import { formatOffset } from './model.js';
import { ListSkeleton } from './skeleton.js';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; status: number }
  | { kind: 'loaded'; view: TranscriptView; checking: boolean };

/**
 * The call transcript beside the evaluation form (Supervisor). It loads on its own: if it fails
 * the form still works (Partial state), and a reload keeps the current text on screen.
 */
export function TranscriptCard({ api, interactionId }: { api: QualityApi; interactionId: string }) {
  const { t } = useTranslation('quality');
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoad((current) =>
      current.kind === 'loaded' ? { ...current, checking: true } : { kind: 'loading' },
    );
    void api
      .transcript(interactionId)
      .then((view) => {
        if (active) setLoad({ kind: 'loaded', view, checking: false });
      })
      .catch((error: unknown) => {
        if (active)
          setLoad({
            kind: 'failed',
            status: error instanceof QualityApiError ? error.status : 0,
          });
      });
    return () => {
      active = false;
    };
  }, [api, interactionId, reload]);

  const again = () => setReload((current) => current + 1);
  const view = load.kind === 'loaded' ? load.view : undefined;
  const transcript = view?.status === 'READY' ? view.transcript : null;

  return (
    <section className="qm-card" aria-labelledby={headingId}>
      <div className="qm-card-head">
        <h2 id={headingId}>{t('transcript.title')}</h2>
        {transcript ? (
          <span className="qm-muted">{t('transcript.source', { model: transcript.modelId })}</span>
        ) : null}
      </div>
      {load.kind === 'loading' ? (
        <div className="qm-transcript-loading">
          <ListSkeleton label={t('transcript.loading')} rows={4} />
        </div>
      ) : null}
      {load.kind === 'failed' ? (
        <div role="alert" className="qm-alert">
          <p>{t(load.status === 401 ? 'unauthorized' : 'transcript.loadFailed')}</p>
          {load.status !== 401 ? <Button onPress={again}>{t('retry')}</Button> : null}
        </div>
      ) : null}
      {view && view.status !== 'READY' ? (
        <div
          className="qm-transcript-status"
          role="status"
          data-tone={view.status === 'FAILED' ? 'critical' : undefined}
        >
          <p>
            {view.status === 'FAILED'
              ? t(`transcript.failed.${view.failureCode ?? 'TRANSCRIPTION_ERROR'}`, {
                  defaultValue: t('transcript.failed.TRANSCRIPTION_ERROR'),
                })
              : t(`transcript.status.${view.status}`)}
          </p>
          {view.status === 'PROCESSING' ? (
            <Button isDisabled={load.kind === 'loaded' && load.checking} onPress={again}>
              {load.kind === 'loaded' && load.checking
                ? t('transcript.checking')
                : t('transcript.checkAgain')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {transcript ? (
        <>
          <p className="qm-muted">{t('transcript.machineNote')}</p>
          {transcript.segments.length === 0 ? (
            <p className="qm-empty">{t('transcript.noSpeech')}</p>
          ) : (
            <div
              className="qm-transcript"
              role="region"
              aria-label={t('transcript.lines', { count: transcript.segments.length })}
              // a scroll area must be reachable by keyboard so it can scroll without a mouse
              tabIndex={0}
            >
              <ol>
                {transcript.segments.map((segment) => (
                  <li key={segment.segmentId} data-speaker={segment.speaker}>
                    <span className="qm-transcript-meta">
                      <time dateTime={`PT${Math.floor(segment.startMs / 1000)}S`}>
                        {formatOffset(segment.startMs)}
                      </time>
                      <span>{t(`transcript.speaker.${segment.speaker}`)}</span>
                    </span>
                    <p className="qm-wrap">{segment.text}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
