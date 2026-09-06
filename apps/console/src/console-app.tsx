import { useEffect, useState } from 'react';
import type { ConsoleApi, QmContext } from './console-api.js';

export function ConsoleApp({ api, contextId }: { api: ConsoleApi; contextId: string }) {
  const [context, setContext] = useState<QmContext>();
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async () => setContext(await api.context(contextId));
  useEffect(() => {
    void refresh().catch(() => setError('เปิด Interaction context ไม่สำเร็จ'));
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
      setError('Publish ไม่สำเร็จ ผลประเมินยังเป็น DRAFT');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="console-shell">
      <header>
        <strong>D-CONTACT</strong>
        <span>Quality Console</span>
      </header>
      <main>
        <div className="heading">
          <div>
            <p className="eyebrow">RECORDING · TRANSCRIPT · QM</p>
            <h1>Interaction {context?.interaction.id ?? 'กำลังโหลด'}</h1>
          </div>
          <span className="tenant-chip">{context?.interaction.queueName ?? 'กำลังโหลด'}</span>
        </div>
        {error ? (
          <p role="alert" className="warning">
            {error}
          </p>
        ) : null}
        <section className="review-grid">
          <article className="panel media-panel">
            <h2>Recording evidence</h2>
            {context?.recording?.status === 'DELETED' ? (
              <p className="warning">ไฟล์เสียงถูกลบตาม retention แล้ว</p>
            ) : context?.recording ? (
              <>
                <button
                  className="primary"
                  onClick={() =>
                    void api.playback(context.recording!.id).then((p) => setPlaybackUrl(p.url))
                  }
                >
                  ขอสิทธิ์ฟัง recording
                </button>
                {playbackUrl ? <audio controls src={playbackUrl} /> : null}
                {context.recording.pauseIntervals.map((gap) => (
                  <div className="pci-gap" key={`${gap.startMs}-${gap.endMs}`}>
                    ช่วง PCI ไม่มีหลักฐานเสียง · {formatTime(gap.startMs)}–{formatTime(gap.endMs)}
                  </div>
                ))}
              </>
            ) : (
              <p>ไม่พบ recording</p>
            )}
          </article>
          <article className="panel transcript-panel">
            <h2>Transcript</h2>
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
              <h2>Evaluation</h2>
              <strong>{context?.evaluation?.status ?? '—'}</strong>
            </div>
            <p className="score">{context?.evaluation?.answers.score ?? '—'}</p>
            {context?.evaluation?.status === 'DRAFT' ? (
              <p className="draft-note">AUTO_DRAFT — Agent ยังมองไม่เห็น</p>
            ) : null}
            {context?.evaluation?.status === 'DRAFT' ? (
              <button
                className="primary"
                disabled={pending}
                onClick={() => setConfirmPublish(true)}
              >
                Publish evaluation
              </button>
            ) : null}
            {pending ? <p aria-live="polite">กำลังรอ server ยืนยัน</p> : null}
          </article>
        </section>
      </main>
      {confirmPublish ? (
        <section role="dialog" aria-modal="true" className="modal">
          <div>
            <h2>ยืนยัน Publish evaluation</h2>
            <p>Agent จะเห็นผลประเมินนี้ และการเผยแพร่จะถูกบันทึกใน audit log</p>
            <button onClick={() => setConfirmPublish(false)}>ยกเลิก</button>
            <button className="primary" onClick={() => void publish()}>
              ยืนยัน Publish
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
