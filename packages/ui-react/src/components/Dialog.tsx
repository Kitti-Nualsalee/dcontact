import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
} from 'react-aria-components';
import { cx } from '../cx.js';
import { useUiText } from '../i18n.js';
import styles from './Dialog.module.css';

export { DialogTrigger };

export interface DialogProps extends Omit<ModalOverlayProps, 'className' | 'children'> {
  title: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  /** ปุ่มท้าย dialog — รับ `close` เพื่อปิดหลังทำงานเสร็จ */
  footer?: (close: () => void) => ReactNode;
  /** `alertdialog` สำหรับการยืนยันที่ย้อนไม่ได้ */
  role?: 'dialog' | 'alertdialog';
  className?: string;
}

/**
 * modal แบบ trap focus: Esc ปิด, focus กลับไปที่ปุ่มที่เปิด (React Aria)
 * ใช้คู่กับ `<DialogTrigger>` หรือควบคุมด้วย `isOpen`/`onOpenChange`
 */
export function Dialog({
  title,
  children,
  footer,
  role = 'dialog',
  className,
  isDismissable = true,
  ...props
}: DialogProps) {
  const t = useUiText();
  return (
    <ModalOverlay {...props} isDismissable={isDismissable} className={styles.overlay}>
      <Modal className={cx(styles.modal, className)}>
        <AriaDialog role={role} className={styles.dialog}>
          {({ close }) => (
            <>
              <header className={styles.header}>
                <Heading slot="title" className={styles.title}>
                  {title}
                </Heading>
                <AriaButton className={styles.close} aria-label={t('dialog.close')} onPress={close}>
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </AriaButton>
              </header>
              <div className={styles.body}>
                {typeof children === 'function' ? children(close) : children}
              </div>
              {footer ? <footer className={styles.footer}>{footer(close)}</footer> : null}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
