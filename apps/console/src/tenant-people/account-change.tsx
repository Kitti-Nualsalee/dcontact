import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog, TextField } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid } from './api.js';
import type {
  PeopleAccountChangeKind,
  PeopleAccountChangeState,
  PeopleDirectoryApi,
  PeopleDirectoryUser,
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
type Failure = (typeof KNOWN)[number] | 'NOT_ACCEPTED' | 'FAILED';
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
 * #998 1B/2: สถานะคำสั่งแก้บัญชีหนึ่งชนิด — เก็บเฉพาะ command/operation IDs ใน sessionStorage (ไม่เก็บชื่อ/เหตุผล)
 * เพื่อกู้ผลหลัง reload หรือ response หาย; ผลไม่ชัดเจนไม่ส่งซ้ำเอง แต่ poll สถานะคำสั่งเดิม
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
  const [ready, setReady] = useState(false);
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
  function failed(value: unknown) {
    if (!mounted.current) return;
    if (value instanceof CatalogApiError && [401, 403].includes(value.status)) {
      setReady(false);
      callbacks.current.onFailure(value);
      return;
    }
    setError(
      value instanceof CatalogApiError && (KNOWN as readonly string[]).includes(value.code)
        ? (value.code as Failure)
        : 'FAILED',
    );
  }
  async function refresh(reference = pending) {
    if (inFlight.current || !supported) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (reference && !reference.operationId) {
        const accepted = await api.invitationCommand(reference.commandId, user.id);
        reference = { ...reference, operationId: accepted.operationId };
        if (!mounted.current) return;
        remember(reference);
      }
      if (reference?.operationId) {
        const result = await api.accountChangeOperation!(reference.operationId, user.id, kind);
        if (!mounted.current) return;
        setStatus(result);
        if (result === 'SUCCEEDED' || result === 'REJECTED') remember(undefined);
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
  /** คืน true เมื่อรับคำสั่งแล้ว (ปิด Dialog ได้) หรือผลไม่ชัดเจน (ปิด Dialog แล้ว poll คำสั่งเดิม) */
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
      const notAccepted =
        value instanceof CatalogApiError &&
        value.status === 503 &&
        ['CAPABILITY_NOT_READY', 'IDENTITY_UNAVAILABLE'].includes(value.code);
      const rejected =
        value instanceof CatalogApiError && ([400, 409, 429].includes(value.status) || notAccepted);
      if (mounted.current && rejected) remember(undefined);
      failed(value);
      if (mounted.current && notAccepted) {
        setReady(false);
        setError('NOT_ACCEPTED');
      }
      // ไม่ได้ปฏิเสธชัด: ไม่รู้ว่ารับคำสั่งหรือยัง ปิด Dialog ให้แผงตามคำสั่งเดิมด้วย commandId ที่เก็บไว้
      return !rejected;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { supported, ready, busy, pending, status, error, setError, refresh, submit };
}

/** #998 1B: แก้ชื่อที่แสดงทั้งในระบบและ Keycloak (ชื่อบนหน้าลงชื่อเข้าใช้) */
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
  const eligible = status === 'ACTIVE' || (status === 'UNKNOWN' && user.isActive);
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
  /** ปิดหลังส่งคำสั่ง: คงข้อความ error (เช่นผลไม่ชัดเจน) ให้แสดงนอก Dialog */
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
      {!change.ready && !change.busy && !change.pending ? (
        <p className="tp-muted tp-help">{label('accountChange.notReady')}</p>
      ) : null}
      {change.ready && !eligible && !change.pending ? (
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

/** #998 2: เปิดบัญชีที่ปิดแล้วกลับ ผู้ใช้ลงชื่อเข้าใช้ด้วยรหัสผ่านและ TOTP เดิม */
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
  // แสดงแผงเฉพาะบัญชีที่ปิดแล้ว หรือมีคำสั่งเปิดกลับที่ต้องตามผล
  if (!disabled && !change.pending && !change.status) return null;
  const valid = textLength(reason) >= 1 && textLength(reason) <= 500;
  function close() {
    setOpen(false);
    setReason('');
    change.setError(undefined);
  }
  /** ปิดหลังส่งคำสั่ง: คงข้อความ error (เช่นผลไม่ชัดเจน) ให้แสดงนอก Dialog */
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
