import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog, TextField } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid } from './api.js';
import {
  commandMissing,
  commandOutcome,
  type PeopleAccountChangeKind,
  type PeopleAccountChangeState,
  type PeopleDirectoryApi,
  type PeopleDirectoryUser,
} from './directory-api.js';
import { accountStatus } from './directory.js';

const KNOWN = [
  'CONFIG_BUSY',
  'REVISION_CONFLICT',
  'ACCOUNT_STATE_CONFLICT',
  'EXTENSION_CONFLICT',
  'REFERENCE_SCOPE_MISMATCH',
  'RESOURCE_LIMIT_REACHED',
  'CREDENTIALS_NOT_READY',
  'PROTECTED_OR_FOREIGN_IDENTITY',
  'IDENTITY_STATE_CONFLICT',
] as const;
type Failure =
  (typeof KNOWN)[number] | 'NOT_ACCEPTED' | 'FORBIDDEN' | 'NOT_SAVED' | 'NOT_RECORDED' | 'FAILED';
const PENDING: readonly PeopleAccountChangeState[] = [
  'QUEUED',
  'WAITING_EXTERNAL',
  'ACTION_REQUIRED',
];

interface PendingChange {
  commandId: string;
  operationId?: string;
}
function restore(key: string): PendingChange | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && 'commandId' in value && peopleUuid(value.commandId)) {
      if ('operationId' in value)
        return peopleUuid(value.operationId)
          ? { commandId: value.commandId, operationId: value.operationId }
          : undefined;
      return { commandId: value.commandId };
    }
  } catch {}
  return undefined;
}

function textLength(value: string) {
  return [...value.trim().replace(/\s+/gu, ' ')].length;
}

/**
 * #998 1B/2: state of one kind of account-change command — only command/operation IDs are kept in sessionStorage (no name/reason)
 * to recover the result after a reload or a lost response; an uncertain result is not resent automatically, the original command's status is polled instead
 */
function useAccountChange(
  kind: PeopleAccountChangeKind,
  api: PeopleDirectoryApi,
  user: PeopleDirectoryUser,
  identityKey: string,
  onUser: (user: PeopleDirectoryUser) => void,
  onFailure: (error: unknown) => void,
) {
  const storageKey = `dc:tenant-account:${identityKey}:${user.id}:${kind}`;
  const existing = (): PendingChange | undefined =>
    restore(storageKey) ??
    (user.accountChange?.kind === kind && PENDING.includes(user.accountChange.state)
      ? { commandId: user.accountChange.commandId, operationId: user.accountChange.operationId }
      : undefined);
  const [pending, setPending] = useState(existing);
  /** undefined = first capabilities check in progress (not yet known whether it is ready) */
  const [ready, setReady] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PeopleAccountChangeState | ''>('');
  const [error, setError] = useState<Failure>();
  const mounted = useRef(false),
    inFlight = useRef(false);
  const callbacks = useRef({ onUser, onFailure });
  callbacks.current = { onUser, onFailure };
  const supported = !!(api.accountChangeReady && api.changeAccount && api.accountChangeOperation);
  function remember(value: PendingChange | undefined) {
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {}
    setPending(value);
  }
  /**
   * 401 (session expired) is always passed on to the People page; 403 is passed on only when reading (capabilities/detail)
   * while a 403 on a change command is shown in the card/Dialog and the detail page stays
   */
  function failed(value: unknown, write = false) {
    if (!mounted.current) return;
    setReady((current) => current ?? false);
    if (
      value instanceof CatalogApiError &&
      (value.status === 401 || (value.status === 403 && !write))
    ) {
      setReady(false);
      callbacks.current.onFailure(value);
      return;
    }
    const definite = write && commandOutcome(value) === 'REJECTED';
    setError(
      value instanceof CatalogApiError && (KNOWN as readonly string[]).includes(value.code)
        ? (value.code as Failure)
        : definite && value instanceof CatalogApiError && value.status === 403
          ? 'FORBIDDEN'
          : definite
            ? 'NOT_SAVED'
            : 'FAILED',
    );
  }
  /** read the result of the original command; returns undefined when the server has no such command/operation (stale command cleared) */
  async function follow(reference: PendingChange): Promise<PendingChange | undefined> {
    try {
      if (!reference.operationId) {
        const accepted = await api.invitationCommand(reference.commandId, user.id);
        reference = { ...reference, operationId: accepted.operationId };
        if (mounted.current) remember(reference);
      }
      return reference;
    } catch (value) {
      if (!commandMissing(value)) throw value;
      if (mounted.current) remember(undefined);
      return undefined;
    }
  }
  async function refresh(reference = pending) {
    if (inFlight.current || !supported) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    let missing = false;
    try {
      if (reference) {
        const followed = await follow(reference);
        if (!mounted.current) return;
        if (!followed) missing = true;
        else {
          const result = await api.accountChangeOperation!(
            followed.operationId!,
            user.id,
            kind,
          ).catch((value: unknown) => {
            if (!commandMissing(value)) throw value;
            return undefined;
          });
          if (!mounted.current) return;
          if (!result) {
            missing = true;
            remember(undefined);
          } else {
            setStatus(result);
            if (result === 'SUCCEEDED' || result === 'REJECTED') remember(undefined);
          }
        }
      }
      // the server has no original command: nothing changed, tell the user and allow sending again
      if (missing) {
        setStatus('');
        setError('NOT_RECORDED');
      }
      const [detail, enabled] = await Promise.all([api.detail(user.id), api.accountChangeReady!()]);
      if (mounted.current) {
        callbacks.current.onUser(detail);
        setReady(enabled);
      }
    } catch (value) {
      failed(value);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (supported) {
      const reference = existing();
      if (reference) void refresh(reference);
      else
        void api.accountChangeReady!()
          .then((enabled) => {
            if (mounted.current) setReady(enabled);
          })
          .catch((value: unknown) => failed(value));
    }
    return () => {
      mounted.current = false;
    };
  }, [api, storageKey]);
  useEffect(() => {
    if (!pending) return;
    const poll = () => {
      if (document.visibilityState === 'visible') void refresh(pending);
    };
    const timer = setInterval(poll, 5_000);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [api, storageKey, pending?.commandId, pending?.operationId]);
  /** returns true when the command was accepted (the Dialog may close) or the result is uncertain (close the Dialog and poll the original command) */
  async function submit(command: { reason: string; displayName?: string }): Promise<boolean> {
    if (inFlight.current || pending || !ready || !supported) return false;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    const reference = { commandId: crypto.randomUUID() };
    try {
      remember(reference);
      const accepted = await api.changeAccount!(user.id, kind, {
        commandId: reference.commandId,
        expectedRevision: user.configRevision,
        ...command,
      });
      if (!mounted.current) return true;
      remember({ ...reference, operationId: accepted.operationId });
      setStatus('QUEUED');
      const detail = await api.detail(user.id).catch(() => undefined);
      if (detail && mounted.current) callbacks.current.onUser(detail);
      return true;
    } catch (value) {
      if (!mounted.current) return true;
      let outcome = commandOutcome(value);
      // 408/CONFIG_BUSY: check the original command immediately; if the server has no such command it is definitely rejected
      if (outcome === 'AMBIGUOUS') {
        try {
          const accepted = await api.invitationCommand(reference.commandId, user.id);
          if (!mounted.current) return true;
          remember({ ...reference, operationId: accepted.operationId });
          setStatus('QUEUED');
          return true;
        } catch (lookup) {
          if (!mounted.current) return true;
          outcome = commandMissing(lookup) ? 'REJECTED' : 'UNKNOWN';
        }
      }
      const rejected = outcome === 'REJECTED';
      if (rejected) remember(undefined);
      failed(value, true);
      if (
        rejected &&
        value instanceof CatalogApiError &&
        value.status === 503 &&
        ['CAPABILITY_NOT_READY', 'IDENTITY_UNAVAILABLE'].includes(value.code)
      ) {
        setReady(false);
        setError('NOT_ACCEPTED');
      }
      // definitely rejected: keep the Dialog to edit/retry; result unknown: close the Dialog so the panel follows the original command by the stored commandId
      return !rejected;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { supported, ready, busy, pending, status, error, setError, refresh, submit };
}

/** #998 1B: edit the display name both in the system and in Keycloak (the name on the sign-in page) */
export function PeopleProfileEdit({
  api,
  user,
  identityKey,
  onUser,
  onFailure,
}: {
  api: PeopleDirectoryApi;
  user: PeopleDirectoryUser;
  identityKey: string;
  onUser(user: PeopleDirectoryUser): void;
  onFailure(error: unknown): void;
}) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string, values?: Record<string, unknown>) => string;
  const change = useAccountChange('UPDATE_PROFILE', api, user, identityKey, onUser, onFailure);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  if (!change.supported) return null;
  const status = accountStatus(user);
  // an account with no People lifecycle (e.g. an account from seed): the identity system does not allow editing it through People
  const managed = status !== 'UNKNOWN';
  const eligible = status === 'ACTIVE';
  const checking = change.ready === undefined;
  const normalized = name.trim().replace(/\s+/gu, ' ');
  const valid =
    textLength(name) >= 1 &&
    textLength(name) <= 120 &&
    normalized !== user.displayName &&
    textLength(reason) >= 1 &&
    textLength(reason) <= 500;
  function close() {
    setOpen(false);
    setReason('');
    change.setError(undefined);
  }
  /** closed after sending the command: keep the error message (e.g. uncertain result) shown outside the Dialog */
  function dismiss() {
    setOpen(false);
    setReason('');
  }
  return (
    <div className="tp-account-change">
      <Button
        variant="secondary"
        isDisabled={change.busy || !!change.pending || !change.ready || !eligible}
        onPress={() => {
          change.setError(undefined);
          setName(user.displayName);
          setReason('');
          setOpen(true);
        }}
      >
        {label('profile.start')}
      </Button>
      {change.status ? (
        <p role="status" className="tp-muted tp-help">
          {label(`profile.states.${change.status}`)}
        </p>
      ) : null}
      {change.pending ? (
        <p className="tp-muted tp-help">
          {label('profile.pending')}{' '}
          <Button variant="ghost" isDisabled={change.busy} onPress={() => void change.refresh()}>
            {label('profile.refresh')}
          </Button>
        </p>
      ) : null}
      {!managed && !change.pending ? (
        <p className="tp-muted tp-help">{label('profile.notManaged')}</p>
      ) : checking && !change.pending ? (
        <p role="status" className="tp-muted tp-help">
          {label('accountChange.checking')}
        </p>
      ) : change.ready === false && !change.busy && !change.pending ? (
        <p className="tp-muted tp-help">{label('accountChange.notReady')}</p>
      ) : change.ready && !eligible && !change.pending ? (
        <p className="tp-muted tp-help">{label('profile.notEligible')}</p>
      ) : null}
      {change.error && !open ? (
        <p role="alert" className="tp-help">
          {label(`accountChange.errors.${change.error}`)}
        </p>
      ) : null}
      <Dialog
        title={label('profile.title', { name: user.displayName })}
        isOpen={open}
        isDismissable={!change.busy}
        onOpenChange={(next) => {
          if (!next && !change.busy) close();
        }}
        footer={() => (
          <>
            <Button isDisabled={change.busy} onPress={close}>
              {label('accountChange.cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={change.busy || !valid}
              onPress={() =>
                void change
                  .submit({ displayName: normalized, reason: reason.trim() })
                  .then((closeDialog) => {
                    if (closeDialog) dismiss();
                  })
              }
            >
              {change.busy ? label('profile.saving') : label('profile.submit')}
            </Button>
          </>
        )}
      >
        <div className="tp-dialog-body">
          <p>{label('profile.body')}</p>
          <TextField
            autoFocus
            label={label('profile.newName')}
            isRequired
            value={name}
            onChange={setName}
            isDisabled={change.busy}
            description={
              normalized === user.displayName
                ? `${label('profile.unchanged')} · ${textLength(name)}/120`
                : `${textLength(name)}/120`
            }
          />
          <TextField
            label={label('accountChange.reason')}
            isRequired
            value={reason}
            onChange={setReason}
            isDisabled={change.busy}
            description={`${textLength(reason)}/500`}
          />
          {change.error ? (
            <p role="alert">{label(`accountChange.errors.${change.error}`)}</p>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

/** #998 2: re-enable a disabled account; the user signs in with the original password and TOTP */
export function PeopleEnable({
  api,
  user,
  identityKey,
  teamName,
  onUser,
  onFailure,
}: {
  api: PeopleDirectoryApi;
  user: PeopleDirectoryUser;
  identityKey: string;
  teamName: string;
  onUser(user: PeopleDirectoryUser): void;
  onFailure(error: unknown): void;
}) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string, values?: Record<string, unknown>) => string;
  const change = useAccountChange('ENABLE_ACCOUNT', api, user, identityKey, onUser, onFailure);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!change.supported) return null;
  const disabled = accountStatus(user) === 'DISABLED' && !user.isActive;
  // show the panel only for a disabled account, or one with an enable command whose result must be followed
  if (!disabled && !change.pending && !change.status) return null;
  const valid = textLength(reason) >= 1 && textLength(reason) <= 500;
  function close() {
    setOpen(false);
    setReason('');
    change.setError(undefined);
  }
  /** closed after sending the command: keep the error message (e.g. uncertain result) shown outside the Dialog */
  function dismiss() {
    setOpen(false);
    setReason('');
  }
  return (
    <section className="tp-panel" aria-labelledby="tp-enable-title" aria-busy={change.busy}>
      <h3 id="tp-enable-title">{label('enable.title')}</h3>
      {change.status ? <p role="status">{label(`enable.states.${change.status}`)}</p> : null}
      {change.error && !open ? (
        <p role="alert">{label(`accountChange.errors.${change.error}`)}</p>
      ) : null}
      {change.pending ? <p>{label('enable.pending')}</p> : null}
      {disabled && !change.pending ? <p className="tp-muted">{label('enable.help')}</p> : null}
      <Button
        variant="primary"
        isDisabled={change.busy || !!change.pending || !change.ready || !disabled}
        onPress={() => {
          change.setError(undefined);
          setReason('');
          setOpen(true);
        }}
      >
        {label('enable.start')}
      </Button>
      <Dialog
        role="alertdialog"
        title={label('enable.dialogTitle', { name: user.displayName })}
        isOpen={open}
        isDismissable={false}
        onOpenChange={(next) => {
          if (!next && !change.busy) close();
        }}
        footer={() => (
          <>
            <Button isDisabled={change.busy} onPress={close}>
              {label('accountChange.cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={change.busy || !valid}
              onPress={() =>
                void change.submit({ reason: reason.trim() }).then((closeDialog) => {
                  if (closeDialog) dismiss();
                })
              }
            >
              {change.busy ? label('enable.submitting') : label('enable.submit')}
            </Button>
          </>
        )}
      >
        <div className="tp-dialog-body">
          <p>
            {label('enable.body', {
              team: teamName,
              extension: user.extensionRef ?? label('directory.none'),
            })}
          </p>
          <TextField
            autoFocus
            label={label('accountChange.reason')}
            isRequired
            value={reason}
            onChange={setReason}
            isDisabled={change.busy}
            description={`${textLength(reason)}/500`}
          />
          {change.error ? (
            <p role="alert">{label(`accountChange.errors.${change.error}`)}</p>
          ) : null}
        </div>
      </Dialog>
      {change.pending ? (
        <Button variant="ghost" isDisabled={change.busy} onPress={() => void change.refresh()}>
          {label('enable.refresh')}
        </Button>
      ) : null}
    </section>
  );
}
