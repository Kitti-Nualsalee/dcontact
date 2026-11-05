import { useEffect, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog, Select, TextField } from '@d-contact/ui-react';
import {
  CustomersApiError,
  type CustomerCommandResult,
  type CustomerProfile,
  type CustomersApi,
} from './api.js';

interface Props {
  api: CustomersApi;
  profile: CustomerProfile;
  disabled: boolean;
  run(
    contactId: string | null,
    submit: (commandId: string) => Promise<CustomerCommandResult>,
  ): Promise<string | null>;
  onAccessFailure(error: unknown): void;
  onDirtyChange(dirty: boolean): void;
}

/** ช่องทางและแท็กใช้ command แยก เพื่อคง revision และผลลัพธ์ที่ตรวจสอบได้ของแต่ละ owner */
export function CustomerRelatedEditors({
  api,
  profile,
  disabled,
  run,
  onAccessFailure,
  onDirtyChange,
}: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string) => string;
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [optionsState, setOptionsState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [selected, setSelected] = useState(() => profile.tags.map((tag) => tag.id));
  const [kind, setKind] = useState<'PHONE' | 'EMAIL'>('PHONE');
  const [value, setValue] = useState('');
  const [replacement, setReplacement] = useState<string>('');
  const [retiring, setRetiring] = useState<{ id: string; value: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pointInvalid, setPointInvalid] = useState(false);
  const tagsDirty =
    selected.length !== profile.tags.length ||
    selected.some((id) => !profile.tags.some((tag) => tag.id === id));
  const pointDirty = !!value || !!replacement;
  useEffect(() => {
    onDirtyChange(pointDirty || tagsDirty);
  }, [pointDirty, tagsDirty, onDirtyChange]);
  useEffect(() => {
    let active = true;
    setOptionsState('loading');
    void api
      .tagOptions()
      .then((result) => {
        if (active) {
          setOptions(result.items);
          setOptionsState('ready');
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setOptionsState('unavailable');
          onAccessFailure(error);
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, profile.contact.id, optionsAttempt]);
  async function point(operation: 'ADD' | 'RETIRE' | 'REPLACE', pointId: string | null) {
    setBusy(true);
    setMessage('');
    setPointInvalid(false);
    try {
      const result = await run(profile.contact.id, (commandId) =>
        api.point(profile.contact.id, pointId, operation, {
          commandId,
          expectedProfileRevision: profile.revisions.profile,
          expectedLineageRevision: String(profile.revisions.lineage),
          ...(operation === 'RETIRE' ? {} : { kind, value }),
        }),
      );
      if (result) setMessage(result === 'REVISION_CONFLICT' ? 'relatedConflict' : 'relatedFailed');
    } catch (error) {
      if (error instanceof CustomersApiError && error.status === 400) setPointInvalid(true);
      onAccessFailure(error);
      setMessage('relatedFailed');
    } finally {
      setBusy(false);
    }
  }
  async function saveTags() {
    setBusy(true);
    setMessage('');
    const original = profile.tags.map((tag) => tag.id);
    try {
      const result = await run(profile.contact.id, (commandId) =>
        api.tags(profile.contact.id, {
          commandId,
          expectedTagRevision: profile.revisions.tag,
          expectedLineageRevision: String(profile.revisions.lineage),
          attachTagIds: selected.filter((id) => !original.includes(id)),
          detachTagIds: original.filter((id) => !selected.includes(id)),
        }),
      );
      if (result) setMessage(result === 'REVISION_CONFLICT' ? 'relatedConflict' : 'relatedFailed');
    } catch (error) {
      onAccessFailure(error);
      setMessage('relatedFailed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {message ? (
        <p className="cu-alert" role="alert">
          {t(`write.${message}`)}
        </p>
      ) : null}
      {disabled ? <p className="cu-muted">{t('write.saveProfileFirst')}</p> : null}
      <section className="cu-form-section" aria-labelledby="edit-points-title">
        <h3 id="edit-points-title">{t('write.points')}</h3>
        <ul>
          {profile.contactPoints.map((item) => (
            <li key={item.id}>
              <bdi>{item.value}</bdi>{' '}
              <Button
                isDisabled={disabled || busy || tagsDirty || pointDirty}
                onPress={() => {
                  setKind(item.kind);
                  setValue('');
                  setReplacement(item.id);
                }}
              >
                {t('write.replace')}
              </Button>{' '}
              <Button
                isDisabled={disabled || busy || tagsDirty || pointDirty}
                onPress={() => setRetiring({ id: item.id, value: item.value })}
              >
                {t('write.retire')}
              </Button>
            </li>
          ))}
        </ul>
        <Select
          label={t('write.pointKind')}
          selectedKey={kind}
          onSelectionChange={(key) => setKind(key as 'PHONE' | 'EMAIL')}
          isDisabled={!!replacement || disabled || busy || tagsDirty}
          options={[
            { id: 'PHONE', label: t('write.phone') },
            { id: 'EMAIL', label: t('write.email') },
          ]}
        />
        <TextField
          label={replacement ? t('write.replacementValue') : t('write.pointValue')}
          value={value}
          onChange={setValue}
          isDisabled={disabled || busy || tagsDirty}
          isInvalid={pointInvalid}
          errorMessage={t('write.fieldInvalid')}
          description={kind === 'PHONE' ? t('write.phoneHint') : undefined}
        />
        <div className="cu-actions">
          <Button
            isDisabled={disabled || busy || tagsDirty || !value.trim()}
            onPress={() => void point(replacement ? 'REPLACE' : 'ADD', replacement || null)}
          >
            {t(replacement ? 'write.saveReplacement' : 'write.addPoint')}
          </Button>
          {replacement ? (
            <Button
              onPress={() => {
                setReplacement('');
                setValue('');
              }}
            >
              {t('write.cancelReplacement')}
            </Button>
          ) : null}
        </div>
      </section>
      <Dialog
        role="alertdialog"
        title={t('write.retire')}
        isOpen={!!retiring}
        onOpenChange={(open) => {
          if (!open) setRetiring(undefined);
        }}
      >
        <p>
          {t('write.retireConfirm')} <bdi>{retiring?.value}</bdi>
        </p>
        <div className="cu-actions">
          <Button
            variant="danger"
            onPress={() => {
              const id = retiring?.id;
              setRetiring(undefined);
              if (id) void point('RETIRE', id);
            }}
          >
            {t('write.retire')}
          </Button>
          <Button onPress={() => setRetiring(undefined)}>{t('write.cancel')}</Button>
        </div>
      </Dialog>
      <section className="cu-form-section" aria-labelledby="edit-tags-title">
        <h3 id="edit-tags-title">{t('write.tags')}</h3>
        {optionsState === 'loading' ? <p role="status">{t('loading')}</p> : null}
        {optionsState === 'unavailable' ? (
          <div role="status" className="cu-notice">
            <p>{t('write.tagsUnavailable')}</p>
            <Button onPress={() => setOptionsAttempt((value) => value + 1)}>{t('retry')}</Button>
          </div>
        ) : null}
        {Array.from(
          new Map([
            ...profile.tags.map(
              ({ id, name, state }) => [id, { id, name, retired: state !== 'ACTIVE' }] as const,
            ),
            ...options.map(({ id, name }) => [id, { id, name, retired: false }] as const),
          ]).values(),
        ).map((tag) => (
          <label key={tag.id}>
            <input
              type="checkbox"
              checked={selected.includes(tag.id)}
              disabled={disabled || busy || pointDirty || optionsState !== 'ready'}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, tag.id]
                    : current.filter((id) => id !== tag.id),
                )
              }
            />{' '}
            {tag.name}
            {tag.retired ? ` (${t('write.retiredTag')})` : ''}
          </label>
        ))}
        <div className="cu-actions">
          <Button
            isDisabled={disabled || busy || pointDirty || optionsState !== 'ready'}
            onPress={() => void saveTags()}
          >
            {t('write.saveTags')}
          </Button>
        </div>
      </section>
    </>
  );
}
