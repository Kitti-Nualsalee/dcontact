import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Select, TextField } from '@d-contact/ui-react';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid, type PeopleApi, type PeopleRole, type PeopleStatus } from './api.js';
import './tenant-people.css';
import { PeopleDirectory } from './directory.js';

interface Pending {
  commandId: string;
  operationId?: string;
}
function restore(key: string): Pending | undefined {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (raw && typeof raw === 'object' && 'commandId' in raw && peopleUuid(raw.commandId)) {
      if ('operationId' in raw)
        return peopleUuid(raw.operationId)
          ? { commandId: raw.commandId, operationId: raw.operationId }
          : undefined;
      return { commandId: raw.commandId };
    }
  } catch {}
  return undefined;
}
type Props = {
  api: PeopleApi;
  identityKey: string;
  onSignIn?: () => void;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
};
export function TenantPeoplePage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="tenant-people">
      <PeopleSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}
function PeopleSession({ api, identityKey, onSignIn }: Props) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string) => string;
  const storageKey = `dc:tenant-people:pending:${identityKey}`;
  const [pending, setPending] = useState(() => restore(storageKey));
  const [options, setOptions] = useState<Awaited<ReturnType<PeopleApi['options']>>>();
  const [status, setStatus] = useState<PeopleStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [teamId, setTeamId] = useState(''),
    [extension, setExtension] = useState('');
  const [role, setRole] = useState<PeopleRole>('AGENT');
  const active = useRef(true);
  const requestActive = useRef(false);
  function remember(value: Pending | undefined) {
    setPending(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }
  function failure(value: unknown) {
    if (!active.current) return;
    if (value instanceof CatalogApiError && [401, 403].includes(value.status)) {
      setOptions(undefined);
      setStatus(undefined);
      setName('');
      setEmail('');
    }
    setError(
      value instanceof CatalogApiError && [401, 403].includes(value.status)
        ? value.status === 401
          ? 'UNAUTHORIZED'
          : 'FORBIDDEN'
        : 'FAILED',
    );
  }
  async function read(value: Pending) {
    const accepted = value.operationId
      ? { operationId: value.operationId }
      : await api.command(value.commandId);
    if (!active.current) return;
    const next = { commandId: value.commandId, operationId: accepted.operationId };
    remember(next);
    const result = await api.operation(accepted.operationId);
    if (active.current) setStatus(result);
  }
  useEffect(() => {
    active.current = true;
    async function load() {
      try {
        const result = await api.options();
        if (!active.current) return;
        setOptions(result);
        const saved = restore(storageKey);
        if (saved) await read(saved);
      } catch (error) {
        failure(error);
      } finally {
        if (active.current) setBusy(false);
      }
    }
    void load();
    return () => {
      active.current = false;
    };
  }, [api, storageKey]);
  async function recover(reference = pending) {
    if (!active.current || !reference || busy || requestActive.current) return;
    if (reference.operationId !== pending?.operationId && pending && !terminal) return;
    requestActive.current = true;
    setBusy(true);
    setError(undefined);
    if (reference.operationId !== pending?.operationId) setStatus(undefined);
    try {
      await read(reference);
    } catch (error) {
      failure(error);
    } finally {
      requestActive.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function create() {
    if (
      busy ||
      requestActive.current ||
      !options?.ready ||
      !teamId ||
      !name.trim() ||
      !email.trim() ||
      (role === 'AGENT' && !options.extensions.includes(extension))
    )
      return;
    const intent = { commandId: crypto.randomUUID() };
    requestActive.current = true;
    remember(intent);
    setBusy(true);
    setStatus(undefined);
    setError(undefined);
    let admitted = false;
    try {
      const accepted = await api.create({
        ...intent,
        displayName: name,
        email,
        role,
        teamId,
        ...(role === 'AGENT' ? { extensionRef: extension } : {}),
      });
      admitted = true;
      if (active.current) await read({ ...intent, operationId: accepted.operationId });
    } catch (error) {
      if (
        !admitted &&
        error instanceof CatalogApiError &&
        ((error.status === 400 && error.code === 'VALIDATION_FAILED') ||
          (error.status === 409 &&
            [
              'IDENTITY_CONFLICT',
              'EXTENSION_CONFLICT',
              'CONFIG_BUSY',
              'REFERENCE_SCOPE_MISMATCH',
              'RESOURCE_POLICY_STALE',
            ].includes(error.code)) ||
          (error.status === 429 && error.code === 'RESOURCE_LIMIT_REACHED') ||
          (error.status === 503 &&
            ['CAPABILITY_NOT_READY', 'RESOURCE_POLICY_NOT_READY'].includes(error.code)))
      ) {
        if (active.current) {
          remember(undefined);
          setError(error.code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : 'CREATE_REJECTED');
        }
      } else failure(error);
    } finally {
      requestActive.current = false;
      if (active.current) setBusy(false);
    }
  }
  const terminal = status && ['SUCCEEDED', 'REJECTED', 'ACTION_REQUIRED'].includes(status.state);
  useEffect(() => {
    if (!pending || busy || terminal || error === 'UNAUTHORIZED' || error === 'FORBIDDEN') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      if (timer) clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = setTimeout(() => void recover(), 5_000);
    }
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [pending, busy, terminal, error, api]);
  const disabled = busy || !options?.ready || (!!pending && !terminal);
  const provisioned =
    status?.state === 'SUCCEEDED' &&
    status.provisioningState === 'PROVISIONED' &&
    status.accountState === 'PENDING_ACTIVATION' &&
    status.activationState === 'PENDING';
  return (
    <section className="tp-root" aria-busy={busy}>
      <h1>{label('title')}</h1>
      <p>{label('notice')}</p>
      {error ? (
        <div role="alert">
          <p>{label(`errors.${error}`)}</p>
          {error === 'UNAUTHORIZED' && onSignIn ? (
            <Button onPress={onSignIn}>{label('signIn')}</Button>
          ) : null}
        </div>
      ) : null}
      {!busy && !options?.ready ? <p role="status">{label('notReady')}</p> : null}
      {pending ? (
        <section aria-label={label('operation')}>
          <p role="status">
            {provisioned
              ? label('provisioned')
              : status?.state === 'ACTION_REQUIRED' || status?.accountState === 'ATTENTION_REQUIRED'
                ? label('attention')
                : status?.state === 'REJECTED'
                  ? label('rejected')
                  : label('pending')}
          </p>
          <Button isDisabled={busy} onPress={() => void recover()}>
            {label('refresh')}
          </Button>
        </section>
      ) : null}
      <section className="tp-form" aria-label={label('create')}>
        <TextField label={label('name')} value={name} onChange={setName} isDisabled={disabled} />
        <TextField
          label={label('email')}
          type="email"
          value={email}
          onChange={setEmail}
          isDisabled={disabled}
        />
        <Select
          label={label('role')}
          placeholder={label('chooseRole')}
          selectedKey={role}
          onSelectionChange={(key) => {
            if (key === 'AGENT' || key === 'SUPERVISOR' || key === 'ADMIN') {
              setRole(key);
              setExtension('');
            }
          }}
          options={(['AGENT', 'SUPERVISOR', 'ADMIN'] as const).map((value) => ({
            id: value,
            label: label(`roles.${value}`),
          }))}
          isDisabled={disabled}
        />
        <Select
          label={label('team')}
          placeholder={label('chooseTeam')}
          selectedKey={teamId || null}
          onSelectionChange={(key) => setTeamId(String(key ?? ''))}
          options={(options?.teams ?? []).map((team) => ({ id: team.id, label: team.name }))}
          isDisabled={disabled}
        />
        {role === 'AGENT' ? (
          <Select
            label={label('extension')}
            placeholder={label('chooseExtension')}
            selectedKey={extension || null}
            onSelectionChange={(key) => setExtension(String(key ?? ''))}
            options={(options?.extensions ?? []).map((ref) => ({ id: ref, label: ref }))}
            isDisabled={disabled}
          />
        ) : null}
        <Button
          isDisabled={
            disabled || !name.trim() || !email.trim() || !teamId || (role === 'AGENT' && !extension)
          }
          onPress={() => void create()}
        >
          {label('create')}
        </Button>
      </section>
      {options && api.directory ? (
        <PeopleDirectory
          api={api.directory}
          canOpenOperation={!busy && (!pending || !!terminal)}
          onFailure={failure}
          onOperation={(reference) => void recover(reference)}
        />
      ) : null}
    </section>
  );
}
