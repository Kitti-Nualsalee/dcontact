import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Badge } from '@d-contact/ui-react';
import type { EvaluationScore } from './api.js';
import { formatScore } from './model.js';

/** คะแนนสุดท้ายพร้อมคะแนนก่อน auto-fail; `stale` = มีการแก้ที่ยังไม่บันทึก คะแนนตัวอย่างอาจไม่ตรง */
export function ScoreSummary({ score, stale }: { score: EvaluationScore | null; stale?: boolean }) {
  const { t } = useTranslation('quality');
  const { locale } = useLocale();
  if (!score) return <p className="qm-muted qm-score-empty">{t('score.none')}</p>;
  return (
    <div className="qm-score" data-stale={(score.preview && stale) || undefined}>
      <p className="qm-score-label">{score.preview ? t('score.preview') : t('score.final')}</p>
      <p className="qm-score-value">
        {t('score.value', { score: formatScore(score.finalScore, locale) })}
      </p>
      {score.autoFailed ? (
        <p>
          <Badge tone="critical">{t('score.autoFailed')}</Badge>{' '}
          <span className="qm-muted">
            {t('score.raw', { score: formatScore(score.rawScore, locale) })}
          </span>
        </p>
      ) : null}
      {score.preview && stale ? <p className="qm-muted">{t('score.stale')}</p> : null}
    </div>
  );
}
