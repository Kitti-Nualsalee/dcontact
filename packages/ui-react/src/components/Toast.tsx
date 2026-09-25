/**
 * Toast ใช้ `UNSTABLE_Toast*` ของ React Aria (1.21) หุ้มไว้ในไฟล์นี้ไฟล์เดียว — ถ้า API ของ React Aria
 * เปลี่ยน แก้ที่นี่ที่เดียว ส่วนแอปเรียก `toastQueue.add()` และวาง `<ToastRegion>` หนึ่งครั้งที่ root
 */
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Text,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastContent as AriaToastContent,
  UNSTABLE_ToastQueue as AriaToastQueue,
  UNSTABLE_ToastRegion as AriaToastRegion,
} from 'react-aria-components';
import { useUiText } from '../i18n.js';
import styles from './Toast.module.css';

export interface ToastContent {
  title: ReactNode;
  description?: ReactNode;
  tone?: 'success' | 'attention' | 'critical' | 'info';
}

export type ToastQueue = AriaToastQueue<ToastContent>;

/** สร้าง queue ต่อแอป (หรือใช้ `toastQueue` ร่วม) — toast สำคัญ (critical) ไม่ควรหายเอง */
export function createToastQueue(): ToastQueue {
  return new AriaToastQueue<ToastContent>({ maxVisibleToasts: 3 });
}

export const toastQueue = createToastQueue();

export function ToastRegion({ queue = toastQueue }: { queue?: ToastQueue }) {
  const t = useUiText();
  return (
    <AriaToastRegion queue={queue} className={styles.region} aria-label={t('toast.region')}>
      {({ toast }) => (
        <AriaToast
          toast={toast}
          className={`${styles.toast} ${styles[toast.content.tone ?? 'info']}`}
        >
          <AriaToastContent className={styles.content}>
            <Text slot="title" className={styles.title}>
              {toast.content.title}
            </Text>
            {toast.content.description ? (
              <Text slot="description" className={styles.description}>
                {toast.content.description}
              </Text>
            ) : null}
          </AriaToastContent>
          <AriaButton slot="close" className={styles.close} aria-label={t('toast.dismiss')}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M1 1l8 8M9 1 1 9" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </AriaButton>
        </AriaToast>
      )}
    </AriaToastRegion>
  );
}
