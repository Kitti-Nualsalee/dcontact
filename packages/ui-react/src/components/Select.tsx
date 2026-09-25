import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  FieldError,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type Key,
  type SelectProps as AriaSelectProps,
} from 'react-aria-components';
import { cx } from '../cx.js';
import { useUiText } from '../i18n.js';
import field from './Field.module.css';
import styles from './Select.module.css';

export interface SelectOption {
  id: Key;
  label: string;
  isDisabled?: boolean;
}

export interface SelectProps extends Omit<
  AriaSelectProps<SelectOption>,
  'className' | 'children' | 'items'
> {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  options: readonly SelectOption[];
  className?: string;
}

export function Select({
  label,
  description,
  errorMessage,
  options,
  placeholder,
  className,
  ...props
}: SelectProps) {
  const t = useUiText();
  return (
    <AriaSelect
      {...props}
      placeholder={placeholder ?? t('select.placeholder')}
      className={cx(field.field, className)}
    >
      {label ? <Label className={field.label}>{label}</Label> : null}
      <AriaButton className={cx(field.control, styles.trigger)}>
        <SelectValue className={styles.value} />
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden="true"
          className={styles.chevron}
        >
          <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </AriaButton>
      {description ? (
        <Text slot="description" className={field.description}>
          {description}
        </Text>
      ) : null}
      <FieldError className={field.error}>{errorMessage}</FieldError>
      <Popover className={styles.popover} offset={4}>
        <ListBox className={styles.listbox} items={options}>
          {(option) => (
            <ListBoxItem
              id={option.id}
              textValue={option.label}
              isDisabled={option.isDisabled}
              className={styles.option}
            >
              {option.label}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
