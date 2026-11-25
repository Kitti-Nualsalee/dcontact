import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog, TextField } from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import { peopleUuid } from './api.js';
import {
  commandMissing,
  commandOutcome,
  type PeopleDirectoryApi,
  type PeopleDirectoryUser,
} from './directory-api.js';
import { accountStatus } from './directory.js';

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
  const label = translate as (key: string, values?: Record<string, unknown>) => string;
  const storageKey = `dc:tenant-disable:${identityKey}:${user.id}`;
  const existing = () =>
    restore(storageKey) ??
    (user.disableOperationId &&
    user.disableCommandId &&
    ['DISABLING', 'ATTENTION_REQUIRED'].includes(user.accountState)
      ? { commandId: user.disableCommandId, operationId: user.disableOperationId }
      : undefined);
  const [pending, setPending] = useState(existing);
  // undefined = กำลังตรวจ capabilities ครั้งแรก
  const [ready, setReady] = useState<boolean>(),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState(''),
    [status, setStatus] = useState(''),
    [error, setError] = useState('');
  const mounted = useRef(false),
    inFlight = useRef(false);
  const callbacks = useRef({ onUser, onFailure });
  callbacks.current = { onUser, onFailure };
  function closeConfirm() {
    setConfirm(false);
    setReason('');
    setError('');
  }
  function remember(value: PendingDisable | undefined) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
    setPending(value);
  }
  /** 401 ส่งต่อให้หน้า People เสมอ; 403 ของคำสั่งปิดบัญชีแสดงใน Dialog/การ์ด ไม่แทนทั้งหน้า */
  function failed(value: unknown, write = false) {
    if (!mounted.current) return;
    setReady((current) => current ?? false);
    const definite = write && commandOutcome(value) === 'REJECTED';
    setError(
      value instanceof CatalogApiError &&
        [
          'LAST_USABLE_ADMIN',
          'CONFIG_BUSY',
          'REVISION_CONFLICT',
          'PROTECTED_OR_FOREIGN_IDENTITY',
        ].includes(value.code)
        ? value.code
        : definite && value instanceof CatalogApiError && value.status === 403
          ? 'FORBIDDEN'
          : definite
            ? 'NOT_SAVED'
            : 'FAILED',
    );
    if (
      value instanceof CatalogApiError &&
      (value.status === 401 || (value.status === 403 && !write))
    ) {
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
    // server ไม่มีคำสั่ง/operation นี้: ไม่ได้บันทึกไว้ ล้างคำสั่งค้างแล้วเปิดให้ส่งใหม่ได้
    const missing = (value: unknown) => {
      if (!commandMissing(value)) throw value;
      return undefined;
    };
    try {
      if (reference && !reference.operationId) {
        const accepted = await api.invitationCommand(reference.commandId, user.id).catch(missing);
        if (!mounted.current) return;
        reference = accepted ? { ...reference, operationId: accepted.operationId } : undefined;
        remember(reference);
        if (!reference) {
          setStatus('');
          setError('NOT_RECORDED');
        }
      }
      if (reference?.operationId) {
        const result = await api.disableOperation!(reference.operationId, user.id).catch(missing);
        if (!mounted.current) return;
        if (!result) {
          remember(undefined);
          setStatus('');
          setError('NOT_RECORDED');
        } else {
          setStatus(result);
          if (['SUCCEEDED', 'REJECTED'].includes(result)) remember(undefined);
        }
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
      // คำสั่งรับแล้ว: อ่านรายละเอียดไม่สำเร็จไม่ทำให้ล้างคำสั่งค้าง
      const detail = await api.detail(user.id).catch(() => undefined);
      if (detail && mounted.current) callbacks.current.onUser(detail);
    } catch (value) {
      if (!mounted.current) return;
      let outcome = commandOutcome(value);
      // 408/CONFIG_BUSY: ตรวจคำสั่งเดิมทันที ถ้า server ไม่มีคำสั่งนี้ก็ถือว่าปฏิเสธแน่นอน
      if (outcome === 'AMBIGUOUS') {
        try {
          const accepted = await api.invitationCommand(reference.commandId, user.id);
          if (!mounted.current) return;
          remember({ ...reference, operationId: accepted.operationId });
          setStatus('WAITING_EXTERNAL');
          setReason('');
          setConfirm(false);
          return;
        } catch (lookup) {
          if (!mounted.current) return;
          outcome = commandMissing(lookup) ? 'REJECTED' : 'UNKNOWN';
        }
      }
      const notAccepted =
        value instanceof CatalogApiError &&
        value.status === 503 &&
        ['CAPABILITY_NOT_READY', 'IDENTITY_UNAVAILABLE'].includes(value.code);
      const rejected = outcome === 'REJECTED';
      if (rejected) remember(undefined);
      failed(value, true);
      // ผลไม่ชัดเจน: ปิด dialog ให้แผงแสดงคำสั่งค้างและปุ่มตรวจผลเดิม
      if (mounted.current && !rejected) setConfirm(false);
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
  // บัญชีที่ไม่มี lifecycle ของ People (เช่นบัญชีจาก seed) ระบบยืนยันตัวตนไม่ยอมให้ปิดผ่าน People
  const managed = accountStatus(user) !== 'UNKNOWN';
  const eligible =
    managed &&
    user.isActive &&
    !['DISABLING', 'DISABLED', 'ATTENTION_REQUIRED', 'PROVISIONING'].includes(user.accountState);
  // บัญชีปิดแล้วและไม่มีคำสั่งค้าง: การ์ดนี้ย่อเหลือบรรทัดเดียว ให้การ์ด "เปิดบัญชีกลับ" เป็นจุดทำงานต่อ
  const closed = user.accountState === 'DISABLED' && !user.isActive && !pending;
  const displayedStatus =
    (status === 'SUCCEEDED' && user.isActive ? '' : status) ||
    (user.accountState === 'DISABLED'
      ? 'SUCCEEDED'
      : user.accountState === 'ATTENTION_REQUIRED'
        ? 'ACTION_REQUIRED'
        : user.accountState === 'DISABLING'
          ? 'WAITING_EXTERNAL'
          : '');
  const unresolved =
    !!pending || ['QUEUED', 'WAITING_EXTERNAL', 'ACTION_REQUIRED'].includes(displayedStatus);
  const canRefresh = !closed && (unresolved || (!!error && !confirm));
  return (
    <section className="tp-panel" aria-label={label('disable.title')} aria-busy={busy}>
      <h3>{label('disable.title')}</h3>
      {!managed && !pending && !closed ? (
        <p className="tp-muted">{label('disable.notManaged')}</p>
      ) : ready && !eligible && !pending && !closed ? (
        <p className="tp-muted">{label('disable.notEligible')}</p>
      ) : null}
      {closed && !status ? <p className="tp-muted">{label('disable.closed')}</p> : null}
      {displayedStatus && (!closed || status) ? (
        <p role="status" className={closed ? 'tp-muted' : undefined}>
          {label(`disable.states.${displayedStatus}`)}
        </p>
      ) : null}
      {error && !confirm ? <p role="alert">{label(`disable.errors.${error}`)}</p> : null}
      {pending ? <p>{label('disable.pending')}</p> : null}
      {closed ? null : (
        <Button
          variant="danger"
          isDisabled={busy || !!pending || !ready || !eligible}
          onPress={() => {
            setError('');
            setReason('');
            setConfirm(true);
          }}
        >
          {label('disable.start')}
        </Button>
      )}
      <Dialog
        role="alertdialog"
        title={label('disable.dialogTitle', { name: user.displayName })}
        isOpen={confirm}
        isDismissable={false}
        onOpenChange={(open) => {
          if (!open && !busy) closeConfirm();
        }}
        footer={() => (
          <>
            <Button isDisabled={busy} onPress={closeConfirm}>
              {label('disable.cancel')}
            </Button>
            <Button
              variant="danger"
              isDisabled={
                busy ||
                !!pending ||
                !ready ||
                !eligible ||
                !reason.trim() ||
                [...reason.trim()].length > 500
              }
              onPress={() => void submit()}
            >
              {busy ? label('disable.submitting') : label('disable.submit')}
            </Button>
          </>
        )}
      >
        <div className="tp-dialog-body">
          <p>{label('disable.warning')}</p>
          <p className="tp-confirm">{label('disable.confirm')}</p>
          <TextField
            autoFocus
            label={label('invitation.reason')}
            value={reason}
            onChange={setReason}
            isDisabled={busy}
            description={`${[...reason.trim()].length}/500`}
          />
          {error ? <p role="alert">{label(`disable.errors.${error}`)}</p> : null}
        </div>
      </Dialog>
      {canRefresh ? (
        <Button variant="ghost" isDisabled={busy} onPress={() => void refresh()}>
          {label('disable.refresh')}
        </Button>
      ) : null}
    </section>
  );
}
