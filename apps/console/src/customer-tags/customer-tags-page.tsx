import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Dialog,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
  TextField,
  toastQueue,
} from '@d-contact/ui-react';
import { CustomersApiError, customerUuid } from '../customers/api.js';
import { Skeleton } from '../customers/skeleton.js';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import type { CatalogTag, CustomerTagsApi, TagCommandResult, TagFilter } from './api.js';
import '../customers/customers.css';

type Pending = { commandId: string; tagId: string | null };
type Draft = { kind: 'create' | 'rename'; name: string; tag?: CatalogTag };
type Props = {
  api: CustomerTagsApi;
  identityKey: string;
  signedIn?: boolean;
  onSignIn?: () => void;
  shell: Omit<ConsoleShellProps, 'appId' | 'children'>;
};

export function CustomerTagsPage(props: Props) {
  return (
    <ConsoleShell {...props.shell} appId="customer-tags">
      <TagSession key={props.identityKey} {...props} />
    </ConsoleShell>
  );
}

function TagSession({ api, identityKey, signedIn = true, onSignIn }: Props) {
  const { t: translate } = useTranslation('customerTags');
  const t = translate as (key: string) => string;
  const [filter, setFilter] = useState<TagFilter>('ALL');
  const [items, setItems] = useState<CatalogTag[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState<Draft>();
  const [latest, setLatest] = useState<CatalogTag>();
  const [retiring, setRetiring] = useState<CatalogTag>();
  const [pending, setPending] = useState<Pending | null>(null);
  const [storageKey, setStorageKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const verified = useRef(false);
  const priorSignedIn = useRef(signedIn);
  if (priorSignedIn.current !== signedIn) {
    priorSignedIn.current = signedIn;
    verified.current = false;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      if (!crypto.subtle) throw new Error('storage unavailable');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identityKey));
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const key = `dcontact.customer360.tags.pending:${hash}`;
      const value = sessionStorage.getItem(key);
      if (!live) return;
      if (value) {
        const parsed = JSON.parse(value) as Pending;
        if (
          !customerUuid(parsed.commandId) ||
          (parsed.tagId !== null && !customerUuid(parsed.tagId)) ||
          Object.keys(parsed).some((field) => !['commandId', 'tagId'].includes(field))
        )
          throw new Error('invalid reference');
        setPending(parsed);
      }
      setStorageKey(key);
    })().catch(() => {
      if (live) setMessage('storage');
    });
    return () => {
      live = false;
    };
  }, [identityKey]);

  const closeForAccess = useCallback((failure: unknown) => {
    if (!(failure instanceof CustomersApiError) || ![401, 403, 404, 503].includes(failure.status))
      return false;
    generation.current += 1;
    verified.current = false;
    setItems([]);
    setCursor(null);
    setLatest(undefined);
    setBlocked(true);
    setMessage(
      failure.status === 401 ? 'session' : failure.status === 503 ? 'unavailable' : 'access',
    );
    return true;
  }, []);

  useEffect(() => {
    const request = ++generation.current;
    const controller = new AbortController();
    if (!signedIn || blocked) {
      setItems([]);
      setCursor(null);
      setLoading(false);
      return () => controller.abort();
    }
    setItems([]);
    setCursor(null);
    setLoading(true);
    setLoaded(false);
    void api
      .list({ state: filter, signal: controller.signal })
      .then(async (page) => {
        const tagId = draft?.tag?.id ?? retiring?.id;
        const current =
          tagId && !verified.current ? await api.detail(tagId, controller.signal) : null;
        if (request !== generation.current) return;
        const previous = draft?.tag ?? retiring;
        if (
          current &&
          previous &&
          (current.state !== 'ACTIVE' || current.revision !== previous.revision)
        ) {
          setLatest(current);
          setMessage('conflict');
          if (!draft) setRetiring(undefined);
        }
        verified.current = true;
        setItems(page.items);
        setCursor(page.nextCursor);
        setLoading(false);
        setLoaded(true);
      })
      .catch((failure: unknown) => {
        if (request !== generation.current || controller.signal.aborted) return;
        setLoading(false);
        if (!closeForAccess(failure)) setMessage('failed');
      });
    return () => {
      controller.abort();
      generation.current += 1;
    };
  }, [api, filter, version, signedIn, blocked, closeForAccess]);

  useEffect(() => {
    if (!draft && !pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, pending]);

  function clearPending() {
    if (storageKey) sessionStorage.removeItem(storageKey);
    setPending(null);
  }
  async function finish(result: TagCommandResult, context: Pending, request: number) {
    if (request !== generation.current || !mounted.current) return;
    if (result.state !== 'TERMINAL') {
      setMessage('pending');
      return;
    }
    if (result.command.outcome === 'REJECTED') {
      if (result.command.code === 'REVISION_CONFLICT' && context.tagId) {
        const current = await api.detail(context.tagId);
        if (request !== generation.current) return;
        clearPending();
        setLatest(current);
        setMessage('conflict');
        if (!draft) {
          setRetiring(undefined);
          setVersion((value) => value + 1);
        }
      } else {
        clearPending();
        setMessage(
          result.command.code === 'COMMAND_NOT_APPLIED'
            ? 'notApplied'
            : result.command.code === 'TAG_NAME_CONFLICT'
              ? 'duplicate'
              : 'failed',
        );
      }
      return;
    }
    const tagId =
      result.command.resourceRefs.find((ref) => ref.type === 'TAG')?.id ?? context.tagId;
    if (!tagId) {
      setMessage('readback');
      return;
    }
    let current: CatalogTag;
    try {
      current = await api.detail(tagId);
    } catch (failure) {
      if (request === generation.current && !closeForAccess(failure)) setMessage('readback');
      return;
    }
    if (request !== generation.current) return;
    clearPending();
    setDraft(undefined);
    setRetiring(undefined);
    setLatest(undefined);
    setMessage('');
    const changed =
      result.command.committedRevisions.tag !== undefined &&
      result.command.committedRevisions.tag !== current.revision;
    toastQueue.add(
      {
        title: t(
          changed ? 'changedAfterSave' : result.command.outcome === 'NO_OP' ? 'unchanged' : 'saved',
        ),
        tone: 'success',
      },
      { timeout: 6000 },
    );
    setVersion((value) => value + 1);
  }
  async function run(
    tagId: string | null,
    submit: (commandId: string) => Promise<TagCommandResult>,
  ) {
    if (!storageKey || pending || busy || inFlight.current) return;
    inFlight.current = true;
    const context = { commandId: crypto.randomUUID(), tagId };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(context));
    } catch {
      setMessage('storage');
      inFlight.current = false;
      return;
    }
    setPending(context);
    setBusy(true);
    setMessage('pending');
    const request = generation.current;
    try {
      await finish(await submit(context.commandId), context, request);
    } catch (failure) {
      if (request !== generation.current) return;
      if (
        failure instanceof CustomersApiError &&
        (failure.status === 400 || failure.status === 429)
      ) {
        clearPending();
        setMessage(failure.status === 400 ? 'invalid' : 'failed');
      } else if (!closeForAccess(failure)) setMessage('pending');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function recover() {
    if (!pending || busy || inFlight.current) return;
    inFlight.current = true;
    const request = generation.current;
    setBusy(true);
    try {
      let result = await api.command(pending.commandId);
      if (request !== generation.current) return;
      if (result.state !== 'TERMINAL') result = await api.reconcile(pending.commandId);
      await finish(result, pending, request);
    } catch (failure) {
      if (request === generation.current && !closeForAccess(failure)) setMessage('pending');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function loadMore() {
    if (!cursor || more) return;
    const request = generation.current;
    setMore(true);
    try {
      const page = await api.list({ state: filter, cursor });
      if (request !== generation.current) return;
      setItems((old) => [
        ...old,
        ...page.items.filter((item) => !old.some((existing) => existing.id === item.id)),
      ]);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (request === generation.current && !closeForAccess(failure)) setMessage('failed');
    } finally {
      if (mounted.current) setMore(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    if (
      !draft.name.trim() ||
      draft.name.trim().normalize('NFC').length > 80 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cs}]/u.test(draft.name)
    ) {
      setMessage('invalid');
      return;
    }
    if (draft.kind === 'create')
      void run(null, (commandId) => api.create({ commandId, name: draft.name }));
    else if (draft.tag) {
      const tag = draft.tag;
      void run(tag.id, (commandId) =>
        api.rename(tag.id, { commandId, expectedRevision: tag.revision, name: draft.name }),
      );
    }
  }

  return (
    <main className="cu-root">
      <h1>{t('title')}</h1>
      <p className="cu-muted">{t('description')}</p>
      {!signedIn || blocked ? (
        <div role="alert" className="cu-alert">
          <p>{t(!signedIn ? 'session' : message || 'access')}</p>
          {onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          <Button
            onPress={() => {
              setBlocked(false);
              setMessage('');
              setVersion((value) => value + 1);
            }}
          >
            {t('retry')}
          </Button>
        </div>
      ) : (
        <>
          {message || pending ? (
            <div role="status" className="cu-notice">
              <p>{t(message || 'pending')}</p>
              {pending ? (
                <Button isDisabled={busy} onPress={() => void recover()}>
                  {t('check')}
                </Button>
              ) : null}
              {!pending && message === 'failed' ? (
                <Button
                  onPress={() => {
                    setMessage('');
                    setVersion((value) => value + 1);
                  }}
                >
                  {t('retry')}
                </Button>
              ) : null}
              {!draft && latest ? (
                <p>
                  {t('latest')}: {latest.name}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="cu-search">
            <Select
              label={t('filter')}
              options={(['ALL', 'ACTIVE', 'RETIRED'] as const).map((value) => ({
                id: value,
                label: t(`states.${value}`),
              }))}
              selectedKey={filter}
              onSelectionChange={(key) => setFilter(key as TagFilter)}
            />
            <div className="cu-actions">
              <Button
                variant="primary"
                isDisabled={!!pending || !storageKey || busy || loading || !loaded}
                onPress={() => {
                  setDraft({ kind: 'create', name: '' });
                  setMessage('');
                }}
              >
                {t('create')}
              </Button>
            </div>
          </div>
          {loading ? (
            <Skeleton label={t('loading')} rows={6} />
          ) : !loaded ? null : items.length === 0 ? (
            <p>{t('empty')}</p>
          ) : (
            <Table aria-label={t('title')} className="cu-table">
              <TableHeader>
                <Column isRowHeader>{t('name')}</Column>
                <Column>{t('status')}</Column>
                <Column>{t('actions')}</Column>
              </TableHeader>
              <TableBody>
                {items.map((tag) => (
                  <Row key={tag.id} id={tag.id}>
                    <Cell>{tag.name}</Cell>
                    <Cell>
                      <Badge tone="neutral">{t(`states.${tag.state}`)}</Badge>
                    </Cell>
                    <Cell>
                      {tag.state === 'ACTIVE' ? (
                        <div className="cu-actions">
                          <Button
                            isDisabled={!!pending || busy}
                            onPress={() => {
                              setDraft({ kind: 'rename', name: tag.name, tag });
                              setLatest(undefined);
                              setMessage('');
                            }}
                          >
                            {t('rename')}
                          </Button>
                          <Button isDisabled={!!pending || busy} onPress={() => setRetiring(tag)}>
                            {t('retire')}
                          </Button>
                        </div>
                      ) : null}
                    </Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          )}
          {cursor ? (
            <div className="cu-more">
              <Button isDisabled={more} onPress={() => void loadMore()}>
                {t('more')}
              </Button>
            </div>
          ) : null}
          <Dialog
            title={t(draft?.kind === 'create' ? 'create' : 'rename')}
            isOpen={!!draft && loaded && verified.current}
            onOpenChange={(open) => {
              if (!open && !pending) {
                setDraft(undefined);
                setLatest(undefined);
              }
            }}
            isDismissable={false}
            isKeyboardDismissDisabled={!!pending}
          >
            {draft ? (
              <form onSubmit={save} noValidate>
                {!pending && message && !['invalid', 'duplicate', 'conflict'].includes(message) ? (
                  <div role="alert">
                    <p>{t(message)}</p>
                  </div>
                ) : null}
                {pending ? (
                  <div role="status">
                    <p>{t(message || 'pending')}</p>
                    <Button isDisabled={busy} onPress={() => void recover()}>
                      {t('check')}
                    </Button>
                  </div>
                ) : null}
                <TextField
                  label={t('name')}
                  value={draft.name}
                  onChange={(name) => setDraft({ ...draft, name })}
                  isDisabled={!!pending}
                  isInvalid={message === 'invalid' || message === 'duplicate'}
                  errorMessage={message === 'duplicate' ? t('duplicate') : t('invalid')}
                  autoComplete="off"
                />
                {latest ? (
                  <div role="status">
                    <p>{t('conflict')}</p>
                    <p>
                      {t('latest')}: {latest.name} · {t(`states.${latest.state}`)}
                    </p>
                    <Button
                      isDisabled={latest.state !== 'ACTIVE'}
                      onPress={() => {
                        setDraft({ ...draft, tag: latest });
                        setLatest(undefined);
                      }}
                    >
                      {t('retry')}
                    </Button>
                  </div>
                ) : null}
                <div className="cu-actions">
                  <Button
                    type="submit"
                    variant="primary"
                    isDisabled={!!pending || !!latest || busy}
                  >
                    {t('save')}
                  </Button>
                  <Button
                    onPress={() => {
                      setDraft(undefined);
                      setLatest(undefined);
                    }}
                    isDisabled={!!pending}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </form>
            ) : null}
          </Dialog>
          <Dialog
            role="alertdialog"
            title={t('retireTitle')}
            isOpen={!!retiring && loaded && verified.current}
            onOpenChange={(open) => {
              if (!open && !pending) setRetiring(undefined);
            }}
          >
            <p>{t('retireBody')}</p>
            <p>{retiring?.name}</p>
            {!pending && message ? (
              <div role="alert">
                <p>{t(message)}</p>
              </div>
            ) : null}
            {pending ? (
              <div role="status">
                <p>{t(message || 'pending')}</p>
                <Button isDisabled={busy} onPress={() => void recover()}>
                  {t('check')}
                </Button>
              </div>
            ) : null}
            <div className="cu-actions">
              <Button onPress={() => setRetiring(undefined)} isDisabled={!!pending}>
                {t('cancel')}
              </Button>
              <Button
                variant="primary"
                isDisabled={!!pending || busy}
                onPress={() => {
                  if (retiring)
                    void run(retiring.id, (commandId) =>
                      api.retire(retiring.id, { commandId, expectedRevision: retiring.revision }),
                    );
                }}
              >
                {t('retire')}
              </Button>
            </div>
          </Dialog>
        </>
      )}
    </main>
  );
}
