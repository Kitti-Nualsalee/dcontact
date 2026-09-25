import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  Switch as AriaSwitch,
  type CheckboxProps as AriaCheckboxProps,
  type SwitchProps as AriaSwitchProps,
} from 'react-aria-components';
import { cx } from '../cx.js';
import styles from './Toggle.module.css';

export interface CheckboxProps extends Omit<AriaCheckboxProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export function Checkbox({ children, className, ...props }: CheckboxProps) {
  return (
    <AriaCheckbox {...props} className={cx(styles.toggle, className)}>
      {({ isIndeterminate }) => (
        <>
          <span className={styles.box} aria-hidden="true">
            <svg width="10" height="10" viewBox="0 0 10 10">
              {isIndeterminate ? (
                <path d="M2 5h6" stroke="currentColor" strokeWidth="1.8" />
              ) : (
                <path
                  d="m1.5 5.2 2.3 2.3 4.7-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              )}
            </svg>
          </span>
          {children}
        </>
      )}
    </AriaCheckbox>
  );
}

export interface SwitchProps extends Omit<AriaSwitchProps, 'className' | 'children'> {
  children?: ReactNode;
  className?: string;
}

export function Switch({ children, className, ...props }: SwitchProps) {
  return (
    <AriaSwitch {...props} className={cx(styles.toggle, className)}>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {children}
    </AriaSwitch>
  );
}
