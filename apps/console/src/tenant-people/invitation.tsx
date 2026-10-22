import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, TextField } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid } from './api.js';
import type { PeopleDirectoryApi, PeopleDirectoryUser } from './directory-api.js';

interface PendingInvitation {
  commandId: string;
  operationId?: string;
}
function restore(key: string): PendingInvitation | undefined {
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

export function PeopleInvitation({
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
  const storageKey = `dc:tenant-invitation:${identityKey}:${user.id}`;
  const [pending, setPending] = useState(() => restore(storageKey));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);
  const [limited, setLimited] = useState(false);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const callbacks = useRef({ onUser, onFailure });
  callbacks.current = { onUser, onFailure };
  function failed(error: unknown) {
    if (!mounted.current) return;
    setError(true);
    if (error instanceof CatalogApiError && error.status === 429) setLimited(true);
    if (error instanceof CatalogApiError && [401, 403].includes(error.status)) {
      setReady(false);
      callbacks.current.onFailure(error);
    }
  }
  function remember(value: PendingInvitation | undefined) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    setPending(value);
  }
  async function recover() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    setLimited(false);
    try {
      let reference = pending;
      if (reference && !reference.operationId) {
        const accepted = await api.invitationCommand(reference.commandId, user.id);
        reference = { ...reference, operationId: accepted.operationId };
        if (!mounted.current) return;
        remember(reference);
      }
      if (reference?.operationId) {
        const state = await api.invitationOperation(reference.operationId, user.id);
        if (!mounted.current) return;
        if (['SUCCEEDED', 'REJECTED', 'ACTION_REQUIRED'].includes(state)) remember(undefined);
      }
      const [detail, enabled] = await Promise.all([api.detail(user.id), api.invitationReady()]);
      if (mounted.current) {
        callbacks.current.onUser(detail);
        setReady(enabled);
      }
    } catch (error) {
      failed(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function submit(kind: 'resend' | 'reconcile') {
    if (inFlight.current || pending || !ready || !reason.trim() || [...reason.trim()].length > 500)
      return;
    inFlight.current = true;
    setBusy(true);
    setError(false);
    const reference = { commandId: crypto.randomUUID() };
    try {
      remember(reference);
      const accepted = await api.invitation(user.id, kind, {
        commandId: reference.commandId,
        expectedRevision: user.configRevision,
        reasonCode: kind === 'resend' ? 'REQUEST_RESEND' : 'DELIVERY_CHECK',
        reason: reason.trim(),
      });
      if (mounted.current) {
        remember({ ...reference, operationId: accepted.operationId });
        setReason('');
      }
    } catch (error) {
      if (
        mounted.current &&
        error instanceof CatalogApiError &&
        [400, 409, 429].includes(error.status)
      )
        remember(undefined);
      failed(error);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (pending) void recover();
    else
      void api
        .invitationReady()
        .then((enabled) => {
          if (mounted.current) setReady(enabled);
        })
        .catch(failed);
    return () => {
      mounted.current = false;
    };
  }, [api, storageKey]);
  useEffect(() => {
    if (!pending || busy) return;
    const visible = () => {
      if (document.visibilityState === 'visible') void recover();
    };
    document.addEventListener('visibilitychange', visible);
    const timer = setTimeout(() => {
      if (document.visibilityState === 'visible') void recover();
    }, 5000);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [pending, busy]);
  const pendingAccount =
    user.accountState === 'PENDING_ACTIVATION' &&
    user.activationState === 'PENDING' &&
    user.provisioningState === 'PROVISIONED';
  const resend =
    pendingAccount &&
    !!user.operationId &&
    ['SENT', 'FAILED', 'EXPIRED'].includes(user.deliveryState);
  const reconcile =
    pendingAccount &&
    !!user.operationId &&
    ['DISPATCHING', 'AMBIGUOUS'].includes(user.deliveryState);
  return (
    <section aria-label={label('invitation.title')} aria-busy={busy}>
      <h4>{label('invitation.title')}</h4>
      <dl>
        <dt>{label('invitation.provisioning')}</dt>
        <dd>
          {label(
            `invitation.provisioningStates.${['PENDING', 'PROVISIONED', 'REJECTED'].includes(user.provisioningState) ? user.provisioningState : 'UNKNOWN'}`,
          )}
        </dd>
        <dt>{label('invitation.delivery')}</dt>
        <dd>{label(`invitation.deliveryStates.${user.deliveryState}`)}</dd>
        <dt>{label('invitation.activation')}</dt>
        <dd>
          {label(
            `invitation.activationStates.${user.activationState === 'ACTIVATED' && user.isActive && user.accountState === 'ACTIVE' ? 'ACTIVATED' : user.activationState === 'PENDING' ? 'PENDING' : 'UNKNOWN'}`,
          )}
        </dd>
        <dt>{label('invitation.generation')}</dt>
        <dd>{user.invitationGeneration ?? label('directory.none')}</dd>
      </dl>
      {error ? (
        <p role="alert">{label(limited ? 'invitation.limited' : 'invitation.failed')}</p>
      ) : null}
      {pending ? <p role="status">{label('invitation.pending')}</p> : null}
      {ready && (resend || reconcile) ? (
        <>
          <TextField
            label={label('invitation.reason')}
            value={reason}
            onChange={setReason}
            isDisabled={busy || !!pending}
          />
          <Button
            isDisabled={
              busy ||
              !!pending ||
              !resend ||
              !reason.trim() ||
              [...reason.trim()].length > 500 ||
              limited
            }
            onPress={() => void submit('resend')}
          >
            {label('invitation.resend')}
          </Button>
          <Button
            isDisabled={
              busy || !!pending || !reconcile || !reason.trim() || [...reason.trim()].length > 500
            }
            onPress={() => void submit('reconcile')}
          >
            {label('invitation.reconcile')}
          </Button>
        </>
      ) : null}
      <Button isDisabled={busy} onPress={() => void recover()}>
        {label('invitation.refresh')}
      </Button>
    </section>
  );
}
