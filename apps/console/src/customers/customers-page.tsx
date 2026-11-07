import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import {
  customerUuid,
  CustomersApiError,
  type CustomerCapabilities,
  type CustomerCommandResult,
  type CustomerProfile,
  type CustomersApi,
} from './api.js';
import { CustomerDirectory } from './directory.js';
import { parseCustomersRoute, customersHref, closesCustomerData, errorKind } from './model.js';
import { CustomerProfileView } from './profile.js';
import { CustomerForm } from './customer-form.js';
import './customers.css';

interface Props {
  api: CustomersApi;
  identityKey: string;
  onSignIn?: () => void;
  signedIn?: boolean;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
}
interface Pending {
  commandId: string;
  contactId: string | null;
}

export function CustomersPage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="customers">
      <CustomersSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}

function CustomersSession({ api, shell, onSignIn, identityKey, signedIn = true }: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string) => string;
  const [returned, setReturned] = useState(false);
  const [route, setRoute] = useState(() => parseCustomersRoute(new URL(window.location.href)));
  const [editor, setEditor] = useState<{ profile?: CustomerProfile }>();
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [capabilities, setCapabilities] = useState<CustomerCapabilities>();
  const [capabilityState, setCapabilityState] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingKey, setPendingKey] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [accessBlocked, setAccessBlocked] = useState(false);
  const [savedMessage, setSavedMessage] = useState<'saved' | 'unchanged'>();
  const [changedRevisions, setChangedRevisions] = useState<
    { dimension: keyof CustomerProfile['revisions']; committed: string; current: string }[]
  >([]);
  const [pageVersion, setPageVersion] = useState(0);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    let current = true;
    if (!globalThis.crypto?.subtle) {
      setRecoveryMessage('storageUnavailable');
      return;
    }
    void crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(identityKey))
      .then((digest) => {
        if (!current) return;
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        const key = `dcontact.customer360.pending:${hash}`;
        const stored = sessionStorage.getItem(key);
        if (stored) {
          const saved = JSON.parse(stored) as Pending;
          if (
            !customerUuid(saved.commandId) ||
            (saved.contactId !== null && !customerUuid(saved.contactId))
          )
            throw new Error('invalid command reference');
          setPending(saved);
        }
        setPendingKey(key);
      })
      .catch(() => {
        if (current) setRecoveryMessage('storageUnavailable');
      });
    return () => {
      current = false;
    };
  }, [identityKey]);
  useEffect(() => {
    let current = true;
    if (!signedIn) {
      setCapabilities(undefined);
      return;
    }
    setCapabilityState('loading');
    void api
      .capabilities()
      .then((result) => {
        if (current) {
          setCapabilities(result);
          setCapabilityState('ready');
        }
      })
      .catch(() => {
        if (current) {
          setCapabilities(undefined);
          setCapabilityState('unavailable');
        }
      });
    return () => {
      current = false;
    };
  }, [api, signedIn, capabilityAttempt]);
  useEffect(() => {
    const onPop = () => {
      if (editorRef.current && !window.confirm(t('write.leaveWarning'))) {
        window.history.pushState(
          null,
          '',
          customersHref(shell.tenantAlias, routeRef.current.contactId ?? undefined),
        );
        return;
      }
      setEditor(undefined);
      setRoute(parseCustomersRoute(new URL(window.location.href)));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [shell.tenantAlias, t]);

  function go(contactId?: string) {
    window.history.pushState(null, '', customersHref(shell.tenantAlias, contactId));
    setEditor(undefined);
    setSavedMessage(undefined);
    setChangedRevisions([]);
    setPageVersion((value) => value + 1);
    setReturned(!contactId);
    setRoute(contactId ? { contactId } : {});
    window.scrollTo?.({ top: 0 });
  }
  function clearPending() {
    if (pendingKey) sessionStorage.removeItem(pendingKey);
    setPending(null);
  }
  async function finish(result: CustomerCommandResult, context: Pending): Promise<string | null> {
    if (result.state !== 'TERMINAL') {
      setRecoveryMessage('pending');
      return null;
    }
    if (result.command.outcome === 'REJECTED') {
      if (result.command.code === 'COMMAND_NOT_APPLIED') {
        if (context.contactId) {
          const current = await api.profile(context.contactId);
          if (!current.capabilities.manage || current.identity.state !== 'ACTIVE')
            throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
        } else if (!(await api.capabilities()).create)
          throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
      }
      clearPending();
      return result.command.code ?? 'REJECTED';
    }
    const contactId =
      result.command.resourceRefs.find((ref) => ref.type === 'CONTACT')?.id ?? context.contactId;
    if (!contactId) {
      setRecoveryMessage('readbackUnavailable');
      return null;
    }
    let current: CustomerProfile;
    try {
      current = await api.profile(contactId);
    } catch (failure) {
      setRecoveryMessage('readbackUnavailable');
      if (
        failure instanceof CustomersApiError &&
        (failure.status === 401 ||
          failure.status === 403 ||
          failure.status === 404 ||
          failure.code === 'SCOPE_UNAVAILABLE')
      )
        throw failure;
      return null;
    }
    clearPending();
    setRecoveryMessage('');
    setAccessBlocked(false);
    go(contactId);
    setSavedMessage(result.command.outcome === 'NO_OP' ? 'unchanged' : 'saved');
    setChangedRevisions(
      (['profile', 'tag', 'lineage'] as const).flatMap((dimension) => {
        const committed = result.command.committedRevisions[dimension];
        const readback = current.revisions[dimension];
        return committed !== undefined && committed !== String(readback)
          ? [{ dimension, committed, current: readback === null ? '—' : String(readback) }]
          : [];
      }),
    );
    return null;
  }
  async function run(
    contactId: string | null,
    submit: (commandId: string) => Promise<CustomerCommandResult>,
  ) {
    if (pending || !pendingKey) throw new Error('command pending or storage unavailable');
    const context = { commandId: crypto.randomUUID(), contactId };
    sessionStorage.setItem(pendingKey, JSON.stringify(context));
    setPending(context);
    let received = false;
    try {
      const result = await submit(context.commandId);
      received = true;
      return await finish(result, context);
    } catch (failure) {
      if (
        !received &&
        failure instanceof CustomersApiError &&
        (failure.status === 400 ||
          failure.status === 403 ||
          failure.status === 404 ||
          failure.status === 429)
      )
        clearPending();
      else setRecoveryMessage('pending');
      throw failure;
    }
  }
  async function recover() {
    if (!pending || checking) return;
    setChecking(true);
    setRecoveryMessage('');
    try {
      let result = await api.command(pending.commandId);
      if (result.state === 'UNKNOWN' || result.state === 'PENDING')
        result = await api.reconcile(pending.commandId);
      const rejection = await finish(result, pending);
      if (rejection === 'COMMAND_NOT_APPLIED') setRecoveryMessage('notApplied');
      else if (rejection === 'REVISION_CONFLICT') setRecoveryMessage('conflict');
      else if (rejection) setRecoveryMessage('rejected');
    } catch (failure) {
      if (closesCustomerData(errorKind(failure))) setAccessBlocked(true);
      setRecoveryMessage('recoveryFailed');
    } finally {
      setChecking(false);
    }
  }
  async function restoreAccess() {
    try {
      const actor = await api.capabilities();
      if (pending?.contactId) {
        const current = await api.profile(pending.contactId);
        if (
          !actor.writeReady ||
          !current.capabilities.manage ||
          current.identity.state !== 'ACTIVE'
        )
          throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
      } else if (!actor.create) throw new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED');
      setAccessBlocked(false);
    } catch {
      setRecoveryMessage('recoveryFailed');
    }
  }
  return (
    <main className="cu-root">
      <h1>{t('title')}</h1>
      {savedMessage ? (
        <p role="status" className="cu-notice">
          {t(`write.${savedMessage}`)}
        </p>
      ) : null}
      {changedRevisions.length ? (
        <div role="status" className="cu-notice">
          <p>{t('write.revisionChanged')}</p>
          <ul>
            {changedRevisions.map(({ dimension, committed, current }) => (
              <li key={dimension}>
                {t(`write.revision.${dimension}`)}: {t('write.committedRevision')}{' '}
                <bdi>{committed}</bdi>; {t('write.currentRevision')} <bdi>{current}</bdi>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {signedIn && !editor && capabilityState === 'ready' && !capabilities?.create ? (
        <p className="cu-muted">
          {t(capabilities?.runtimeReady ? 'readOnly' : 'write.runtimeUnavailable')}
        </p>
      ) : null}
      {signedIn && !editor && capabilityState === 'unavailable' ? (
        <div className="cu-notice" role="status">
          <p>{t('write.capabilityUnavailable')}</p>
          <Button onPress={() => setCapabilityAttempt((value) => value + 1)}>{t('retry')}</Button>
        </div>
      ) : null}
      {pending || recoveryMessage ? (
        <div role="status" className="cu-notice">
          <p>{t(`write.${recoveryMessage || 'pending'}`)}</p>
          {pending ? (
            <Button onPress={() => void recover()} isDisabled={checking}>
              {t('write.checkResult')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {editor ? (
        <CustomerForm
          api={api}
          profile={editor.profile}
          validation={capabilities?.validation}
          pending={!!pending}
          accessBlocked={accessBlocked}
          onAccessRestored={() => setAccessBlocked(false)}
          recoveryConflict={recoveryMessage === 'conflict'}
          onConflictAcknowledged={() => setRecoveryMessage('')}
          signedIn={signedIn}
          onCancel={() => setEditor(undefined)}
          onSignIn={onSignIn}
          run={run}
        />
      ) : !signedIn || accessBlocked ? (
        <div role="alert" className="cu-alert">
          <p>{t(accessBlocked ? 'write.access' : 'errors.unauthorized')}</p>
          {onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          {signedIn && accessBlocked ? (
            <Button onPress={() => void restoreAccess()}>{t('retry')}</Button>
          ) : null}
        </div>
      ) : route.contactId === undefined ? (
        <>
          <div className="cu-actions">
            {capabilities?.create ? (
              <Button
                variant="primary"
                onPress={() => setEditor({})}
                isDisabled={!!pending || !pendingKey}
              >
                {t('write.create')}
              </Button>
            ) : null}
          </div>
          <CustomerDirectory api={api} onOpen={go} onSignIn={onSignIn} focusHeading={returned} />
        </>
      ) : (
        <CustomerProfileView
          key={`${route.contactId ?? 'invalid'}:${pageVersion}`}
          api={api}
          contactId={route.contactId}
          onBack={() => go()}
          onOpen={go}
          onSignIn={onSignIn}
          writeReady={!!capabilities?.writeReady && !!pendingKey && !pending}
          onEdit={(profile) => setEditor({ profile })}
        />
      )}
    </main>
  );
}
