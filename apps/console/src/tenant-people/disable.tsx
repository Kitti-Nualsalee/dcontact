import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, TextField } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid } from './api.js';
import type { PeopleDirectoryApi, PeopleDirectoryUser } from './directory-api.js';

interface PendingDisable {
  commandId: string;
  operationId?: string;
}
function restore(key: string): PendingDisable | undefined {
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

export function PeopleDisable({
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
  const label = translate as (key: string) => string;
  const storageKey = `dc:tenant-disable:${identityKey}:${user.id}`;
  const existing = () =>
    restore(storageKey) ??
    (user.disableOperationId &&
    user.disableCommandId &&
    ['DISABLING', 'ATTENTION_REQUIRED'].includes(user.accountState)
      ? { commandId: user.disableCommandId, operationId: user.disableOperationId }
      : undefined);
  const [pending, setPending] = useState(existing);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState(''),
    [status, setStatus] = useState(''),
    [error, setError] = useState('');
  const mounted = useRef(false),
    inFlight = useRef(false);
  const callbacks = useRef({ onUser, onFailure });
  callbacks.current = { onUser, onFailure };
  function remember(value: PendingDisable | undefined) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    setPending(value);
  }
  function failed(value: unknown) {
    if (!mounted.current) return;
    setError(
      value instanceof CatalogApiError &&
        [
          'LAST_USABLE_ADMIN',
          'CONFIG_BUSY',
          'REVISION_CONFLICT',
          'PROTECTED_OR_FOREIGN_IDENTITY',
        ].includes(value.code)
        ? value.code
        : 'FAILED',
    );
    if (value instanceof CatalogApiError && [401, 403].includes(value.status)) {
      setReady(false);
      setReason('');
      setConfirm(false);
      callbacks.current.onFailure(value);
    }
  }
  async function refresh(reference = pending) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      if (reference && !reference.operationId) {
        const accepted = await api.invitationCommand(reference.commandId, user.id);
        reference = { ...reference, operationId: accepted.operationId };
        if (!mounted.current) return;
        remember(reference);
      }
      if (reference?.operationId) {
        const result = await api.disableOperation!(reference.operationId, user.id);
        if (!mounted.current) return;
        setStatus(result);
        if (['SUCCEEDED', 'REJECTED'].includes(result)) remember(undefined);
      }
      const [detail, enabled] = await Promise.all([api.detail(user.id), api.disableReady!()]);
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
    if (api.disableReady && api.disable && api.disableOperation) {
      const reference = existing();
      if (reference) void refresh(reference);
      else
        void api
          .disableReady()
          .then((enabled) => {
            if (mounted.current) setReady(enabled);
          })
          .catch(failed);
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
  async function submit() {
    if (
      inFlight.current ||
      pending ||
      !ready ||
      !confirm ||
      !reason.trim() ||
      [...reason.trim()].length > 500
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const reference = { commandId: crypto.randomUUID() };
    try {
      remember(reference);
      const accepted = await api.disable!(user.id, {
        commandId: reference.commandId,
        expectedRevision: user.configRevision,
        reasonCode: 'OPERATOR_REQUEST',
        reason: reason.trim(),
      });
      if (!mounted.current) return;
      remember({ ...reference, operationId: accepted.operationId });
      setStatus('WAITING_EXTERNAL');
      setReason('');
      setConfirm(false);
      const detail = await api.detail(user.id);
      if (mounted.current) callbacks.current.onUser(detail);
    } catch (value) {
      const notAccepted =
        value instanceof CatalogApiError &&
        value.status === 503 &&
        ['CAPABILITY_NOT_READY', 'IDENTITY_UNAVAILABLE'].includes(value.code);
      if (
        mounted.current &&
        value instanceof CatalogApiError &&
        ([400, 409, 429].includes(value.status) || notAccepted)
      )
        remember(undefined);
      failed(value);
      if (mounted.current && notAccepted) {
        setReady(false);
        setConfirm(false);
        setError('NOT_ACCEPTED');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  if (!api.disableReady || !api.disable || !api.disableOperation) return null;
  const eligible =
    user.isActive &&
    !['DISABLING', 'DISABLED', 'ATTENTION_REQUIRED', 'PROVISIONING'].includes(user.accountState);
  const displayedStatus =
    status ||
    (user.accountState === 'DISABLED'
      ? 'SUCCEEDED'
      : user.accountState === 'ATTENTION_REQUIRED'
        ? 'ACTION_REQUIRED'
        : user.accountState === 'DISABLING'
          ? 'WAITING_EXTERNAL'
          : '');
  return (
    <section aria-label={label('disable.title')} aria-busy={busy}>
      <h4>{label('disable.title')}</h4>
      <p>{label('disable.warning')}</p>
      {displayedStatus ? <p role="status">{label(`disable.states.${displayedStatus}`)}</p> : null}
      {error ? <p role="alert">{label(`disable.errors.${error}`)}</p> : null}
      {pending ? <p>{label('disable.pending')}</p> : null}
      <TextField
        label={label('invitation.reason')}
        value={reason}
        onChange={setReason}
        isDisabled={busy || !!pending || !ready || !eligible}
      />
      {confirm ? (
        <>
          <p>{label('disable.confirm')}</p>
          <Button
            isDisabled={busy || !!pending || !ready || !eligible || !reason.trim()}
            onPress={() => void submit()}
          >
            {label('disable.submit')}
          </Button>
          <Button isDisabled={busy} onPress={() => setConfirm(false)}>
            {label('disable.cancel')}
          </Button>
        </>
      ) : (
        <Button
          isDisabled={
            busy ||
            !!pending ||
            !ready ||
            !eligible ||
            !reason.trim() ||
            [...reason.trim()].length > 500
          }
          onPress={() => setConfirm(true)}
        >
          {label('disable.start')}
        </Button>
      )}
      <Button isDisabled={busy} onPress={() => void refresh()}>
        {label('disable.refresh')}
      </Button>
    </section>
  );
}
