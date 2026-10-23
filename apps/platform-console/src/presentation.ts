import type { TFunction } from 'i18next';
import { stepPresentation, statusPresentation, type ActionHistoryItem } from './model.js';

/** แปลเฉพาะ labels; codes และข้อมูลที่ผู้ปฏิบัติงานกรอกยังเป็นค่าจาก API เดิม */
export function describeHistory(item: ActionHistoryItem, t: TFunction): string {
  const parts: string[] = [];
  if (item.stepKey) parts.push(t(stepPresentation(item.stepKey).title));
  if (item.beforeState || item.afterState)
    parts.push(
      t('history.transition', {
        before: item.beforeState ? t(statusPresentation(item.beforeState).label) : '—',
        after: item.afterState ? t(statusPresentation(item.afterState).label) : '—',
      }),
    );
  if (item.attempt) parts.push(t('history.attempt', { count: item.attempt }));
  if (item.errorCode) parts.push(item.errorCode);
  if (item.reasonCode) parts.push(t('history.reason', { code: item.reasonCode }));
  return parts.join(' · ');
}
