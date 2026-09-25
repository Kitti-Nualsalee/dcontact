import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  FieldError,
  Group,
  Input,
  Label,
  SearchField as AriaSearchField,
  Text,
  TextField as AriaTextField,
  type SearchFieldProps as AriaSearchFieldProps,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import { cx } from '../cx.js';
import { useUiText } from '../i18n.js';
import styles from './Field.module.css';

interface FieldTextProps {
  /** ป้ายที่มองเห็นได้ — ถ้าไม่มีต้องส่ง `aria-label` แทน */
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  placeholder?: string;
  className?: string;
}

export interface TextFieldProps extends Omit<AriaTextFieldProps, 'className'>, FieldTextProps {}

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField {...props} className={cx(styles.field, className)}>
      {label ? <Label className={styles.label}>{label}</Label> : null}
      <Group className={styles.control}>
        <Input className={styles.input} placeholder={placeholder} />
      </Group>
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <FieldError className={styles.error}>{errorMessage}</FieldError>
    </AriaTextField>
  );
}

export interface SearchFieldProps extends Omit<AriaSearchFieldProps, 'className'>, FieldTextProps {}

export function SearchField({
  label,
  description,
  errorMessage,
  placeholder,
  className,
  ...props
}: SearchFieldProps) {
  const t = useUiText();
  return (
    <AriaSearchField {...props} className={cx(styles.field, className)}>
      {label ? <Label className={styles.label}>{label}</Label> : null}
      <Group className={styles.control}>
        <svg className={styles.icon} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="m11 11 3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <Input className={styles.input} placeholder={placeholder} />
        <AriaButton className={styles.clear} aria-label={t('searchField.clear')}>
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1l8 8M9 1 1 9" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </AriaButton>
      </Group>
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <FieldError className={styles.error}>{errorMessage}</FieldError>
    </AriaSearchField>
  );
}
