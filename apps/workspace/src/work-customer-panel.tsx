import { useEffect, useRef, useState } from 'react';
import { Button, TextField, Select } from '@d-contact/ui-react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  WorkCustomerError,
  type WorkCustomerApi,
  type WorkCustomerView,
  type WorkCandidate,
  type WorkCommand,
} from './work-customer-api.js';

/** #795: Cus360 มี state แยกจาก SIP/media และไม่เรียก Voice controls */
export function WorkCustomerPanel({
  api,
  workId,
  leaseId,
  identityKey,
  sessionReady,
  readOnly = false,
}: {
  api: WorkCustomerApi;
  workId: string;
  leaseId: string;
  identityKey: string;
  sessionReady: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const [view, setView] = useState<WorkCustomerView>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'blocked'>('loading');
  const [message, setMessage] = useState<
    | ''
    | 'unavailable'
    | 'unknown'
    | 'notApplied'
    | 'conflict'
    | 'savedChanged'
    | 'unchanged'
    | 'saved'
    | 'unverified'
    | 'empty'
  >('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ displayName: string; company: string }>();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'PHONE' | 'EMAIL'>('PHONE');
  const [items, setItems] = useState<WorkCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [choice, setChoice] = useState<WorkCandidate | null | undefined>();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<string>();
  const stamp = useRef(0);
  const storageKey = `dcontact.c360.work-command:${identityKey}:${workId}`;
  function closePii() {
    setView(undefined);
    setItems([]);
    setChoice(undefined);
    setQuery('');
    setStatus('blocked');
  }
  async function load(epoch = stamp.current) {
    try {
      const next = await api.read(workId, leaseId);
      if (epoch !== stamp.current) return;
      setView(next);
      setStatus('ready');
    } catch {
      if (epoch === stamp.current) {
        closePii();
        setMessage('unavailable');
      }
    }
  }
  useEffect(() => {
    const epoch = ++stamp.current;
    setBusy(false);
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved && /^[\da-f-]{36}$/.test(saved)) setPending(saved);
    } catch {}
    if (sessionReady) void load(epoch);
    else closePii();
    return () => {
      stamp.current++;
    };
  }, [api, workId, leaseId, identityKey, sessionReady]);
  useEffect(() => {
    if (!draft && !pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, pending]);
  function remember(id: string | undefined) {
    setPending(id);
    try {
      if (id) sessionStorage.setItem(storageKey, id);
      else sessionStorage.removeItem(storageKey);
    } catch {}
  }
  async function terminal(result: WorkCommand, epoch: number) {
    if (epoch !== stamp.current) return;
    if (result.state !== 'TERMINAL' || !result.command) {
      setMessage('unknown');
      return;
    }
    if (result.command.outcome === 'REJECTED') {
      remember(undefined);
      setMessage(result.command.code === 'COMMAND_NOT_APPLIED' ? 'notApplied' : 'conflict');
      await load(epoch);
      return;
    }
    // อัปเดตผลสำเร็จหลังอ่านปัจจุบันกลับแล้วเท่านั้น
    const latest = await api.read(workId, leaseId);
    if (epoch !== stamp.current) return;
    remember(undefined);
    setView(latest);
    setStatus('ready');
    setDraft(undefined);
    setChoice(undefined);
    setReason('');
    setQuery('');
    setItems([]);
    const revisions = result.command.committedRevisions;
    const changed =
      (revisions.linkage !== undefined && revisions.linkage !== latest.linkageRevision) ||
      (revisions.profile !== undefined && revisions.profile !== latest.revisions?.profile);
    setMessage(
      changed ? 'savedChanged' : result.command.outcome === 'NO_OP' ? 'unchanged' : 'saved',
    );
  }
  async function save(operation: 'link' | 'update') {
    if (!view || busy || pending) return;
    const epoch = stamp.current;
    const commandId = crypto.randomUUID();
    remember(commandId);
    setBusy(true);
    setMessage('');
    try {
      const body =
        operation === 'update'
          ? {
              commandId,
              expectedLinkageRevision: view.linkageRevision,
              expectedProfileRevision: view.revisions?.profile,
              expectedLineageRevision: view.revisions?.lineage,
              ...draft,
            }
          : {
              commandId,
              expectedLinkageRevision: view.linkageRevision,
              candidateRef: choice?.candidateRef ?? null,
              ...(view.contact ? { reason, confirmed: true } : {}),
            };
      await terminal(await api.mutate(workId, leaseId, operation, body), epoch);
    } catch (error) {
      if (epoch === stamp.current) {
        if (
          error instanceof WorkCustomerError &&
          [400, 401, 403, 404, 409, 422, 429].includes(error.status)
        ) {
          setMessage(error.status === 409 ? 'conflict' : 'unavailable');
          if (error.status === 409) await load(epoch);
          else closePii();
        } else {
          setMessage('unknown');
          closePii();
        }
      }
    } finally {
      if (epoch === stamp.current) setBusy(false);
    }
  }
  async function search(more = false) {
    if (busy) return;
    const epoch = stamp.current;
    setBusy(true);
    setMessage('');
    try {
      const result = await api.search(workId, leaseId, {
        type: kind,
        query,
        ...(more && cursor ? { cursor } : {}),
      });
      if (epoch !== stamp.current) return;
      setItems(more ? items.concat(result.items) : result.items);
      setCursor(result.nextCursor);
      setMessage(result.items.length ? 'unverified' : 'empty');
    } catch {
      if (epoch === stamp.current) {
        closePii();
        setMessage('unavailable');
      }
    } finally {
      if (epoch === stamp.current) setBusy(false);
    }
  }
  async function recover() {
    if (!pending || busy) return;
    const epoch = stamp.current;
    setBusy(true);
    try {
      let result = await api.receipt(workId, leaseId, pending);
      if (result.state === 'UNKNOWN') result = await api.receipt(workId, leaseId, pending, true);
      await terminal(result, epoch);
    } catch {
      if (epoch === stamp.current) {
        closePii();
        setMessage('unavailable');
      }
    } finally {
      if (epoch === stamp.current) setBusy(false);
    }
  }
  async function reauth() {
    if (busy) return;
    const epoch = stamp.current;
    setBusy(true);
    try {
      if (!readOnly) await api.reauthenticate(workId, leaseId);
      await load(epoch);
    } catch {
      if (epoch === stamp.current) setMessage('unavailable');
    } finally {
      if (epoch === stamp.current) setBusy(false);
    }
  }
  return (
    <section className="aw-card" aria-label={t('customer.title')}>
      <h3>{t('customer.title')}</h3>
      {status === 'loading' ? <p role="status">{t('customer.loading')}</p> : null}
      {message ? (
        <p role={status === 'blocked' ? 'alert' : 'status'}>{t(`customer.${message}`)}</p>
      ) : null}
      {status === 'blocked' ? (
        <>
          <p>{t('customer.quarantined')}</p>
          <Button onPress={() => void reauth()} isDisabled={busy || !sessionReady}>
            {t(readOnly ? 'customer.retry' : 'customer.reauthenticate')}
          </Button>
        </>
      ) : null}
      {pending ? (
        <Button onPress={() => void recover()} isDisabled={busy || !sessionReady}>
          {t('customer.checkCommand')}
        </Button>
      ) : null}
      {status === 'ready' && view ? (
        <>
          {view.contact ? (
            <>
              <p>{view.contact.displayName ?? t('customer.unnamed')}</p>
              <p>{view.contact.company ?? t('customer.noCompany')}</p>
              {view.canEdit && !draft ? (
                <Button
                  onPress={() =>
                    setDraft({
                      displayName: view.contact?.displayName ?? '',
                      company: view.contact?.company ?? '',
                    })
                  }
                  isDisabled={busy || !!pending}
                >
                  {t('customer.edit')}
                </Button>
              ) : null}
            </>
          ) : (
            <p>{t('customer.unlinked')}</p>
          )}
          {draft && view.canEdit ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save('update');
              }}
            >
              <TextField
                label={t('customer.name')}
                value={draft.displayName}
                onChange={(value) => setDraft({ ...draft, displayName: value })}
              />
              <TextField
                label={t('customer.company')}
                value={draft.company}
                onChange={(value) => setDraft({ ...draft, company: value })}
              />
              <Button type="submit" isDisabled={busy || !!pending}>
                {t('customer.save')}
              </Button>
              <Button onPress={() => setDraft(undefined)} isDisabled={busy}>
                {t('customer.discard')}
              </Button>
            </form>
          ) : null}
          {view.canLink ? (
            <>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void search();
                }}
              >
                <Select
                  label={t('customer.searchType')}
                  selectedKey={kind}
                  onSelectionChange={(key) => {
                    setKind(key as 'PHONE' | 'EMAIL');
                    setQuery('');
                    setItems([]);
                    setCursor(null);
                  }}
                  options={[
                    { id: 'PHONE', label: t('customer.phone') },
                    { id: 'EMAIL', label: t('customer.email') },
                  ]}
                />
                <TextField
                  label={t('customer.query')}
                  value={query}
                  onChange={(value) => {
                    setQuery(value);
                    setItems([]);
                    setChoice(undefined);
                    setCursor(null);
                  }}
                />
                <Button type="submit" isDisabled={busy || !!pending}>
                  {t('customer.search')}
                </Button>
              </form>
              <p>{t('customer.unverified')}</p>
              <ul>
                {items.map((item) => (
                  <li key={item.candidateRef}>
                    {item.displayName ?? t('customer.unnamed')} — {item.company} —{' '}
                    {item.matchingChannel}{' '}
                    <Button
                      onPress={() => {
                        setChoice(item);
                        setReason('');
                      }}
                      isDisabled={busy || !!pending}
                    >
                      {t('customer.select')}
                    </Button>
                  </li>
                ))}
              </ul>
              {cursor ? (
                <Button onPress={() => void search(true)} isDisabled={busy}>
                  {t('customer.more')}
                </Button>
              ) : null}
              {view.contact ? (
                <Button
                  onPress={() => {
                    setChoice(null);
                    setReason('');
                  }}
                  isDisabled={busy || !!pending}
                >
                  {t('customer.detach')}
                </Button>
              ) : null}
              {choice !== undefined ? (
                <div role="group" aria-label={t('customer.confirmTitle')}>
                  <p>
                    {choice
                      ? `${t('customer.confirmSelect')} ${choice.displayName ?? t('customer.unnamed')}`
                      : t('customer.confirmDetach')}
                  </p>
                  {view.contact ? (
                    <TextField label={t('customer.reason')} value={reason} onChange={setReason} />
                  ) : null}
                  <Button
                    onPress={() => void save('link')}
                    isDisabled={busy || !!pending || (!!view.contact && !reason.trim())}
                  >
                    {t('customer.confirm')}
                  </Button>
                  <Button onPress={() => setChoice(undefined)} isDisabled={busy}>
                    {t('customer.cancel')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
