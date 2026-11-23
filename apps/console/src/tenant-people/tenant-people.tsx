import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Select, StatusChip, TextField, useShellPageNav } from '@d-contact/ui-react';
import { ConfigPanel } from '../voice-routing/config-panel.js';
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
  const [page, setPage] = useState(() =>
    new URL(window.location.href).searchParams.get('section') === 'agent-skills'
      ? 'agent-skills'
      : 'users',
  );
  useEffect(() => {
    const onPop = () =>
      setPage(
        new URL(window.location.href).searchParams.get('section') === 'agent-skills'
          ? 'agent-skills'
          : 'users',
      );
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  function go(next: string) {
    if (next !== 'users' && next !== 'agent-skills') return;
    const url = new URL(window.location.href);
    url.searchParams.set('section', next);
    url.searchParams.delete('resource');
    window.history.pushState(null, '', url);
    setPage(next);
  }
  return (
    <ConsoleShell {...props.shell} appId="tenant-people" pageId={page} onPageSelect={go}>
      <PeopleContent {...props} page={page} go={go} />
    </ConsoleShell>
  );
}
function PeopleContent(props: Props & { page: string; go(page: string): void }) {
  const inShell = useShellPageNav();
  const { t } = useTranslation('tenantPeople');
  return (
    <>
      {!inShell ? (
        <nav aria-label={t('pages.navigation')}>
          <Button onPress={() => props.go('users')}>{t('pages.users')}</Button>
          <Button onPress={() => props.go('agent-skills')}>{t('pages.agentSkills')}</Button>
        </nav>
      ) : null}
      {props.page === 'agent-skills' ? (
        props.api.config ? (
          <ConfigPanel api={props.api.config} identityKey={props.identityKey} mode="agentSkills" />
        ) : null
      ) : (
        <PeopleSession key={props.identityKey} {...props} />
      )}
    </>
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
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [detailOpen, setDetailOpen] = useState(false);
  const formHeading = useRef<HTMLHeadingElement>(null);
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
    let keepForm = false;
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
        ([401, 403].includes(error.status) ||
          (error.status === 400 && error.code === 'VALIDATION_FAILED') ||
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
          keepForm = true;
          if ([401, 403].includes(error.status)) failure(error);
          else
            setError(
              [
                'VALIDATION_FAILED',
                'IDENTITY_CONFLICT',
                'EXTENSION_CONFLICT',
                'RESOURCE_LIMIT_REACHED',
                'CONFIG_BUSY',
              ].includes(error.code)
                ? error.code
                : 'CREATE_REJECTED',
            );
        }
      } else failure(error);
    } finally {
      requestActive.current = false;
      if (active.current) setBusy(false);
    }
    // คำสั่งที่ server รับแล้ว (หรือผลไม่ชัดเจน) กลับไปหน้ารายการที่มีแถบสถานะคำสั่ง
    if (active.current && !keepForm) {
      if (admitted) {
        setName('');
        setEmail('');
        setExtension('');
      }
      setMode('list');
    }
  }
  function openForm() {
    setError(undefined);
    setMode('form');
    requestAnimationFrame(() => formHeading.current?.focus());
  }
  function closeForm() {
    setError(undefined);
    setMode('list');
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-tp-create]')?.focus());
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
  const operationTone =
    status?.state === 'SUCCEEDED'
      ? 'success'
      : status?.state === 'ACTION_REQUIRED' ||
          status?.accountState === 'ATTENTION_REQUIRED' ||
          status?.state === 'REJECTED'
        ? 'critical'
        : 'info';
  const canSubmit =
    !disabled && !!name.trim() && !!email.trim() && !!teamId && (role !== 'AGENT' || !!extension);
  return (
    <section className="tp-root" aria-busy={busy}>
      {mode === 'list' && !detailOpen ? (
        <header className="tp-head">
          <div>
            <h1>{label('title')}</h1>
            <p className="tp-muted">{label('list.subtitle')}</p>
          </div>
          <Button variant="primary" data-tp-create isDisabled={disabled} onPress={openForm}>
            {label('create')}
          </Button>
        </header>
      ) : null}
      {mode === 'form' ? (
        <header className="tp-head tp-head-form">
          <div>
            <Button variant="ghost" className="tp-back" onPress={closeForm}>
              ← {label('form.back')}
            </Button>
            <h1 ref={formHeading} tabIndex={-1}>
              {label('form.title')}
            </h1>
          </div>
        </header>
      ) : null}
      {error ? (
        <div role="alert" className="tp-alert">
          <p>{label(`errors.${error}`)}</p>
          {error === 'UNAUTHORIZED' && onSignIn ? (
            <Button onPress={onSignIn}>{label('signIn')}</Button>
          ) : null}
        </div>
      ) : null}
      {!busy && !options?.ready ? (
        <p role="status" className="tp-notice">
          {label('notReady')}
        </p>
      ) : null}
      {pending ? (
        <section className="tp-banner" aria-label={label('operation')}>
          <StatusChip status={operationTone}>{label('operation')}</StatusChip>
          <p role="status" className="tp-banner-text">
            {status?.state === 'SUCCEEDED' &&
            status.accountState === 'ACTIVE' &&
            status.activationState === 'ACTIVATED'
              ? label('invitation.active')
              : provisioned
                ? label('provisioned')
                : status?.state === 'ACTION_REQUIRED' ||
                    status?.accountState === 'ATTENTION_REQUIRED'
                  ? label('attention')
                  : status?.state === 'REJECTED'
                    ? label('rejected')
                    : label('pending')}
          </p>
          <Button variant="secondary" isDisabled={busy} onPress={() => void recover()}>
            {label('refresh')}
          </Button>
        </section>
      ) : null}
      {mode === 'form' ? (
        <form
          className="tp-form"
          aria-label={label('create')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void create();
          }}
        >
          <div className="tp-form-main">
            <section className="tp-card" aria-labelledby="tp-profile">
              <h2 id="tp-profile">{label('form.groups.profile')}</h2>
              <div className="tp-field-row">
                <TextField
                  isRequired
                  label={label('name')}
                  value={name}
                  onChange={setName}
                  isDisabled={disabled}
                />
                <TextField
                  isRequired
                  label={label('email')}
                  type="email"
                  value={email}
                  onChange={setEmail}
                  isDisabled={disabled}
                  isInvalid={error === 'IDENTITY_CONFLICT'}
                  errorMessage={label('errors.IDENTITY_CONFLICT')}
                />
              </div>
            </section>
            <section className="tp-card" aria-labelledby="tp-assignment">
              <h2 id="tp-assignment">{label('form.groups.assignment')}</h2>
              <div className="tp-field-row">
                <Select
                  isRequired
                  label={label('team')}
                  placeholder={label('chooseTeam')}
                  selectedKey={teamId || null}
                  onSelectionChange={(key) => setTeamId(String(key ?? ''))}
                  options={(options?.teams ?? []).map((team) => ({
                    id: team.id,
                    label: team.name,
                  }))}
                  isDisabled={disabled}
                  description={options && !options.teams.length ? label('form.noTeams') : undefined}
                />
                {role === 'AGENT' ? (
                  <Select
                    isRequired
                    label={label('extension')}
                    placeholder={label('chooseExtension')}
                    selectedKey={extension || null}
                    onSelectionChange={(key) => setExtension(String(key ?? ''))}
                    options={(options?.extensions ?? []).map((ref) => ({ id: ref, label: ref }))}
                    isDisabled={disabled}
                    isInvalid={error === 'EXTENSION_CONFLICT'}
                    errorMessage={label('errors.EXTENSION_CONFLICT')}
                    description={
                      options && !options.extensions.length ? label('form.noExtensions') : undefined
                    }
                  />
                ) : (
                  <p className="tp-muted tp-help">{label('form.extensionNotNeeded')}</p>
                )}
              </div>
            </section>
          </div>
          <aside className="tp-form-side">
            <section className="tp-card" aria-labelledby="tp-access">
              <h2 id="tp-access">{label('form.groups.access')}</h2>
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
                description={label(`form.roleHelp.${role}`)}
              />
            </section>
            <p className="tp-muted tp-help">{label('notice')}</p>
            {!canSubmit && !disabled ? (
              <p id="tp-required-hint" className="tp-required-hint">
                {label(role === 'AGENT' ? 'form.requiredAgent' : 'form.required')}
              </p>
            ) : null}
            <div className="tp-form-actions">
              <Button type="submit" variant="primary" isDisabled={!canSubmit}>
                {label('create')}
              </Button>
              <Button variant="secondary" onPress={closeForm}>
                {label('form.cancel')}
              </Button>
            </div>
          </aside>
        </form>
      ) : null}
      {mode === 'list' && options && api.directory ? (
        <PeopleDirectory
          identityKey={identityKey}
          api={api.directory}
          teams={options.teams}
          canOpenOperation={!busy && (!pending || !!terminal)}
          onFailure={failure}
          onOperation={(reference) => void recover(reference)}
          onDetailChange={setDetailOpen}
        />
      ) : null}
    </section>
  );
}
