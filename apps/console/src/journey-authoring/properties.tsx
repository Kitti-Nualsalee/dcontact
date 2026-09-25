/**
 * J5.6 (#344): typed properties ของ node ที่เลือก และ settings ระดับ Journey
 *
 * field ข้อความ commit ตอน blur/Enter เพื่อให้ undo หนึ่งครั้งคือหนึ่งการแก้ field ไม่ใช่หนึ่งตัวอักษร
 * ค่าที่ใส่ถูกตรวจแค่รูปพื้นฐานเพื่อบอกผู้ใช้ทันที — ความถูกต้องจริงตัดสินที่ server validate/compile
 */
import { useEffect, useId, useState } from 'react';
import type { AuthoringDocumentV1 } from '@d-contact/cxa-contracts';
import { useTranslation } from '@d-contact/i18n/react';
import {
  CONFIG_FIELDS,
  NODE_LABELS,
  nodeTitle,
  nodeTypeOf,
  type AuthoringCommand,
  type ConfigFieldSpec,
  type SettingKey,
} from './model.js';

function CommitField({
  label,
  value,
  kind,
  required,
  readOnly,
  description,
  onCommit,
}: {
  label: string;
  value: string;
  kind: 'text' | 'number' | 'json';
  required: boolean;
  readOnly: boolean;
  description?: string;
  onCommit: (raw: string) => string | null;
}) {
  const inputId = useId();
  const hintId = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);
  const commit = () => {
    if (draft === value) return;
    setError(onCommit(draft));
  };
  const describedBy = [description ? `${hintId}-d` : null, error ? `${hintId}-e` : null]
    .filter(Boolean)
    .join(' ');
  const common = {
    id: inputId,
    value: draft,
    readOnly,
    required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy || undefined,
    onBlur: commit,
  } as const;
  return (
    <div className="j5-field">
      <label htmlFor={inputId}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {kind === 'json' ? (
        <textarea {...common} rows={6} onChange={(event) => setDraft(event.target.value)} />
      ) : (
        <input
          {...common}
          type="text"
          inputMode={kind === 'number' ? 'numeric' : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      )}
      {description ? (
        <small id={`${hintId}-d`} className="j5-help">
          {description}
        </small>
      ) : null}
      {error ? (
        <small id={`${hintId}-e`} className="j5-field-error">
          {error}
        </small>
      ) : null}
    </div>
  );
}

function ConfigField({
  spec,
  value,
  readOnly,
  onChange,
}: {
  spec: ConfigFieldSpec;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation('journeys');
  const selectId = useId();
  if (spec.kind === 'select' || spec.kind === 'fixed') {
    return (
      <div className="j5-field">
        <label htmlFor={selectId}>{spec.label}</label>
        <select
          id={selectId}
          value={String(value ?? '')}
          disabled={readOnly || spec.kind === 'fixed'}
          onChange={(event) => onChange(event.target.value)}
        >
          {(spec.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (spec.kind === 'expression') {
    return (
      <CommitField
        label={spec.label}
        kind="json"
        required={spec.required}
        readOnly={readOnly}
        description={spec.description}
        value={JSON.stringify(value ?? null, null, 2)}
        onCommit={(raw) => {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
              return t('properties.mustBeObject');
            onChange(parsed);
            return null;
          } catch {
            return t('properties.invalidJson');
          }
        }}
      />
    );
  }
  const numeric = spec.kind === 'positive' || spec.kind === 'nonNegative';
  return (
    <CommitField
      label={spec.label}
      kind={numeric ? 'number' : 'text'}
      required={spec.required}
      readOnly={readOnly}
      description={spec.description}
      value={value === undefined ? '' : String(value)}
      onCommit={(raw) => {
        const text = raw.trim();
        if (!text) {
          if (spec.required) return t('properties.required');
          onChange(undefined);
          return null;
        }
        if (numeric) {
          const number = Number(text);
          if (!Number.isFinite(number) || (spec.kind === 'positive' ? number <= 0 : number < 0))
            return spec.kind === 'positive'
              ? t('properties.positive')
              : t('properties.nonNegative');
          onChange(number);
          return null;
        }
        if (spec.kind === 'opaque' && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(text))
          return t('properties.opaque');
        onChange(text);
        return null;
      }}
    />
  );
}

export function NodeProperties({
  document,
  nodeId,
  readOnly,
  onCommand,
}: {
  document: AuthoringDocumentV1;
  nodeId: string;
  readOnly: boolean;
  onCommand: (command: AuthoringCommand) => void;
}) {
  const { t } = useTranslation('journeys');
  const type = nodeTypeOf(document, nodeId);
  if (!type) return null;
  const node =
    document.trigger.nodeId === nodeId
      ? document.trigger
      : document.nodes.find((entry) => entry.nodeId === nodeId)!;
  if (type === 'UNSUPPORTED') {
    return (
      <div className="j5-readonly-note">
        <p>{t('properties.unsupported')}</p>
      </div>
    );
  }
  const config = (node as { config: Record<string, unknown> }).config;
  return (
    <div className="j5-properties">
      <p className="j5-eyebrow">{NODE_LABELS[type]}</p>
      <CommitField
        label={t('properties.displayName')}
        kind="text"
        required={false}
        readOnly={readOnly}
        value={(node as { label?: string }).label ?? ''}
        onCommit={(raw) => {
          onCommand({ kind: 'SET_LABEL', nodeId, label: raw });
          return null;
        }}
      />
      {CONFIG_FIELDS[type].map((spec) => (
        <ConfigField
          key={`${nodeId}-${spec.key}`}
          spec={spec}
          value={config[spec.key]}
          readOnly={readOnly}
          onChange={(value) => onCommand({ kind: 'SET_CONFIG', nodeId, key: spec.key, value })}
        />
      ))}
      <p className="j5-help">{t('properties.nodeId', { id: nodeId })}</p>
      <p className="j5-sr">{t('properties.editing', { title: nodeTitle(document, nodeId) })}</p>
    </div>
  );
}

export function JourneySettings({
  document,
  readOnly,
  onCommand,
}: {
  document: AuthoringDocumentV1;
  readOnly: boolean;
  onCommand: (command: AuthoringCommand) => void;
}) {
  const { t } = useTranslation('journeys');
  const settings = document.settings;
  const text = (key: SettingKey, label: string, value: string, description?: string) => (
    <CommitField
      label={label}
      kind="text"
      required
      readOnly={readOnly}
      value={value}
      description={description}
      onCommit={(raw) => {
        if (!raw.trim()) return t('properties.required');
        onCommand({ kind: 'SET_SETTING', key, value: raw.trim() });
        return null;
      }}
    />
  );
  return (
    <div className="j5-properties">
      {text('name', t('properties.name'), settings.name)}
      {text('purpose', t('properties.purpose'), settings.purpose)}
      {text('senderIdentityId', t('properties.sender'), settings.senderIdentityId)}
      {text('goalEventType', t('properties.goal'), settings.goal.eventType)}
      <CommitField
        label={t('properties.maxDuration')}
        kind="number"
        required
        readOnly={readOnly}
        value={String(settings.maxDurationDays)}
        onCommit={(raw) => {
          const days = Number(raw.trim());
          if (!Number.isInteger(days) || days < 1) return t('properties.maxDurationInvalid');
          onCommand({ kind: 'SET_SETTING', key: 'maxDurationDays', value: days });
          return null;
        }}
      />
    </div>
  );
}
