import { Fragment, type ReactNode } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { StatusChip } from '@d-contact/ui-react';
import type { CaseStatus } from './api.js';
import { statusTone } from './model.js';

export function useDateFormat(): (value: string | null | undefined) => string {
  const { locale } = useLocale();
  return (value) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        )
      : '';
}

export function CaseStatusChip({ status }: { status: CaseStatus }) {
  const { t } = useTranslation('cases');
  return <StatusChip status={statusTone(status)}>{t(`status.${status}`)}</StatusChip>;
}

/**
 * แทน `[[name]]` ในข้อความแปลด้วย node (ตัวหนา, chip) โดยไม่ต่อสตริง HTML
 * ลำดับคำเป็นของ catalog ของแต่ละภาษา
 */
export function renderTemplate(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\[\[\w+\]\])/).map((piece, index) => {
    const key = /^\[\[(\w+)\]\]$/.exec(piece)?.[1];
    return <Fragment key={index}>{key && key in parts ? parts[key] : piece}</Fragment>;
  });
}

export const marker = (name: string) => `[[${name}]]`;
