import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, TextField } from '@d-contact/ui-react';
import {
  CustomersApiError,
  type CustomerCapabilities,
  type CustomerProfile,
  type CustomerProfileInput,
  type CustomersApi,
  type CustomerCommandResult,
} from './api.js';
import { closesCustomerData, errorKind } from './model.js';
import { CustomerRelatedEditors } from './customer-related-editors.js';

interface Props {
  api: CustomersApi;
  profile?: CustomerProfile;
  validation?: CustomerCapabilities['validation'];
  pending: boolean;
  signedIn: boolean;
  accessBlocked: boolean;
  onAccessRestored(): void;
  recoveryConflict: boolean;
  onConflictAcknowledged(): void;
  onCancel(): void;
  onSignIn?: () => void;
  run(
    contactId: string | null,
    submit: (commandId: string) => Promise<CustomerCommandResult>,
  ): Promise<string | null>;
}

/** ร่างอยู่ใน memory เท่านั้น; การบันทึกใช้ command เดียวและรอ readback ที่ผู้ใช้ยังมีสิทธิ์ */
export function CustomerForm({
  api,
  profile,
  validation,
  pending,
  signedIn,
  accessBlocked,
  onAccessRestored,
  recoveryConflict,
  onConflictAcknowledged,
  onCancel,
  onSignIn,
  run,
}: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string) => string;
  const [name, setName] = useState(profile?.contact.displayName ?? '');
  const [company, setCompany] = useState(profile?.contact.company ?? '');
  const [vip, setVip] = useState(profile?.contact.vip ?? false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [revision, setRevision] = useState(profile?.revisions);
  const [latest, setLatest] = useState<CustomerProfile>();
  const [error, setError] = useState('');
  const [fields, setFields] = useState<string[]>([]);
  const [closed, setClosed] = useState(false);
  const [authorized, setAuthorized] = useState(signedIn);
  const [busy, setBusy] = useState(false);
  const [relatedDirty, setRelatedDirty] = useState(false);
  const dirty =
    name !== (profile?.contact.displayName ?? '') ||
    company !== (profile?.contact.company ?? '') ||
    vip !== (profile?.contact.vip ?? false) ||
    !!phone ||
    !!email;
  const generation = useRef(0);
  useEffect(() => {
    if (recoveryConflict) setError('conflict');
  }, [recoveryConflict]);
  function closeAccess() {
    generation.current += 1;
    setClosed(true);
    setAuthorized(false);
    setError('access');
  }

  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (dirty || relatedDirty || pending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty, relatedDirty, pending]);

  async function reauthorize(restoreBlocked = false) {
    const current = ++generation.current;
    try {
      if (profile) {
        const [fresh, actor] = await Promise.all([
          api.profile(profile.contact.id),
          api.capabilities(),
        ]);
        if (
          !actor.writeReady ||
          !fresh.capabilities.manage ||
          fresh.identity.state !== 'ACTIVE' ||
          fresh.revisions.lineage === null
        )
          throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
      } else if (!(await api.capabilities()).create)
        throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
      if (current === generation.current) {
        setClosed(false);
        setAuthorized(true);
        setError('');
        if (restoreBlocked) onAccessRestored();
      }
    } catch (failure) {
      if (current === generation.current && closesCustomerData(errorKind(failure))) {
        closeAccess();
      }
    }
  }
  useEffect(() => {
    if (!signedIn) {
      generation.current++;
      setAuthorized(false);
    } else if (!authorized) void reauthorize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') void reauthorize();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      generation.current++;
      document.removeEventListener('visibilitychange', visible);
    };
    // identity และ profile คงเดิมตลอดอายุของฟอร์ม
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, profile?.contact.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || pending || closed || relatedDirty) return;
    const invalid = !name.trim() ? ['displayName'] : [];
    if (invalid.length) {
      setFields(invalid);
      return;
    }
    setBusy(true);
    setError('');
    setFields([]);
    const values: CustomerProfileInput = {
      displayName: name,
      company: company.trim() ? company : null,
      vip,
    };
    try {
      const result = profile
        ? await run(profile.contact.id, (commandId) =>
            api.update(profile.contact.id, {
              ...values,
              commandId,
              expectedProfileRevision: revision!.profile,
              expectedLineageRevision: String(revision!.lineage),
            }),
          )
        : await run(null, (commandId) =>
            api.create({
              ...values,
              commandId,
              points: [
                ...(phone ? [{ kind: 'PHONE' as const, value: phone }] : []),
                ...(email ? [{ kind: 'EMAIL' as const, value: email }] : []),
              ],
            }),
          );
      if (result === 'REVISION_CONFLICT') setError('conflict');
      else if (result) setError('rejected');
    } catch (failure) {
      if (failure instanceof CustomersApiError && failure.status === 400) {
        setFields(failure.fieldErrors.map((item) => item.field));
        setError('validation');
      } else if (closesCustomerData(errorKind(failure))) {
        closeAccess();
      } else setError('failed');
    } finally {
      setBusy(false);
    }
  }
  async function loadCurrent() {
    if (!profile) return;
    try {
      const fresh = await api.profile(profile.contact.id);
      if (
        !fresh.capabilities.manage ||
        fresh.identity.state !== 'ACTIVE' ||
        fresh.revisions.lineage === null
      )
        throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
      setLatest(fresh);
      setRevision(fresh.revisions);
      setError('refreshed');
      onConflictAcknowledged();
    } catch (failure) {
      if (closesCustomerData(errorKind(failure))) {
        closeAccess();
      } else setError('failed');
    }
  }
  function cancel() {
    if (!(dirty || relatedDirty) || window.confirm(t('write.leaveWarning'))) onCancel();
  }
  if (!signedIn || !authorized || closed || accessBlocked)
    return (
      <div className="cu-alert" role="alert">
        <p>{t('write.access')}</p>
        {onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
        {signedIn ? <Button onPress={() => void reauthorize(true)}>{t('retry')}</Button> : null}
      </div>
    );
  return (
    <form className="cu-card cu-form" onSubmit={(event) => void submit(event)}>
      <h2>{t(profile ? 'write.edit' : 'write.create')}</h2>
      {error ? (
        <div role="alert" className="cu-alert">
          <p>{t(`write.${error}`)}</p>
          {error === 'conflict' ? (
            <Button onPress={() => void loadCurrent()}>{t('write.loadCurrent')}</Button>
          ) : null}
        </div>
      ) : null}
      {latest ? (
        <p className="cu-notice">
          {t('write.latestValues')}:{' '}
          <bdi>
            {latest.contact.displayName ?? '—'} / {latest.contact.company ?? '—'} /{' '}
            {latest.contact.vip ? t('write.vip') : t('write.notVip')}
          </bdi>
        </p>
      ) : null}
      <TextField
        label={t('write.name')}
        value={name}
        onChange={setName}
        maxLength={validation?.displayNameMax}
        isRequired
        description={t('write.nameHint')}
        isInvalid={fields.includes('displayName')}
        errorMessage={t('write.fieldInvalid')}
      />
      <TextField
        label={t('write.company')}
        value={company}
        onChange={setCompany}
        maxLength={validation?.companyMax}
        isInvalid={fields.includes('company')}
        errorMessage={t('write.fieldInvalid')}
      />
      {!profile ? (
        <>
          <TextField
            label={t('write.phone')}
            value={phone}
            onChange={setPhone}
            maxLength={validation?.phoneRawMax}
            description={t('write.phoneHint')}
            isInvalid={!!phone && fields.some((field) => field.startsWith('points.0'))}
            errorMessage={t('write.fieldInvalid')}
          />
          <TextField
            label={t('write.email')}
            value={email}
            onChange={setEmail}
            maxLength={validation?.emailRawMax}
            isInvalid={
              !!email && fields.some((field) => field.startsWith(phone ? 'points.1' : 'points.0'))
            }
            errorMessage={t('write.fieldInvalid')}
          />
        </>
      ) : null}
      <label>
        <input type="checkbox" checked={vip} onChange={(event) => setVip(event.target.checked)} />{' '}
        {t('write.vip')}
      </label>
      <div className="cu-actions">
        <Button
          type="submit"
          variant="primary"
          isDisabled={busy || pending || relatedDirty || error === 'conflict'}
        >
          {t('write.save')}
        </Button>
        <Button onPress={cancel} isDisabled={busy || pending}>
          {t('write.cancel')}
        </Button>
      </div>
      {profile ? (
        <CustomerRelatedEditors
          api={api}
          profile={profile}
          disabled={dirty || pending}
          run={run}
          onDirtyChange={setRelatedDirty}
          onAccessFailure={(failure) => {
            if (closesCustomerData(errorKind(failure))) {
              closeAccess();
            }
          }}
        />
      ) : null}
    </form>
  );
}
