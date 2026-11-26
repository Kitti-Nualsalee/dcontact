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
  /** dialog footer buttons — receives `close` to close after the work is done */
  footer?: (close: () => void) => ReactNode;
  /** `alertdialog` for irreversible confirmations */
  role?: 'dialog' | 'alertdialog';
  className?: string;
}

/**
 * focus-trapping modal: Esc closes, focus returns to the button that opened it (React Aria)
 * use with `<DialogTrigger>` or control with `isOpen`/`onOpenChange`
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
