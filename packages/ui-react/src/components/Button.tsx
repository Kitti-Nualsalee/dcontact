import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { cx } from '../cx.js';
import styles from './Button.module.css';

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  /** primary = one main action per area; danger = irreversible delete/cancel */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** md = `--dc-control-md` (32px), sm = `--dc-control-sm` (26px) */
  size?: 'md' | 'sm';
  className?: string;
}

export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonProps) {
  return (
    <AriaButton
      {...props}
      className={cx(styles.button, styles[variant], styles[size], className)}
    />
  );
}
