import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Badge, Button, Dialog, Select, TextField, toastQueue } from '@d-contact/ui-react';
import {
  CaseApiError,
  type CaseCommand,
  type CaseDetailResponse,
  type CaseRef,
  type CaseStatus,
  type CasesApi,
  type TeamAgent,
} from './api.js';
import { CaseTimeline } from './case-timeline.js';
import { CaseStatusChip, useDateFormat } from './common.js';
import {
  NOTE_MAX,
  actionsFor,
  classifyFailure,
  commandFor,
  commandSignature,
  validateNote,
  type CaseAction,
  type CommandFailure,
  type PendingCommand,
} from './model.js';

interface Props {
  api: CasesApi;
  caseId: string;
  viewerUserId: string;
  onBack: () => void;
  onSignIn?: () => void;
}

type Load =
  | { phase: 'loading' }
  | { phase: 'ready'; data: CaseDetailResponse }
  | { phase: 'error'; status: number };

type Kind = CaseAction | 'note';
type Focus = 'actions' | 'closed' | 'note';
type TeamLoad =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; agents: TeamAgent[] }
  | { phase: 'error' };

const STATUS_TARGET: Record<'resolve' | 'reopen' | 'close', CaseStatus> = {
  resolve: 'RESOLVED',
  reopen: 'OPEN',
  close: 'CLOSED',
};
const TOAST_KEY = {
  resolve: 'toast.resolved',
  reopen: 'toast.reopened',
  close: 'toast.closed',
} as const;
const TOAST_MS = 5000;

const failureStatus = (error: unknown) => (error instanceof CaseApiError ? error.status : 500);

export function CaseDetailView({ api, caseId, viewerUserId, onBack, onSignIn }: Props) {
  const { t } = useTranslation('cases');
  const { locale } = useLocale();
  const format = useDateFormat();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [reloading, setReloading] = useState(false);
  const [busy, setBusy] = useState<Kind>();
  const [unknown, setUnknown] = useState<{ kind: Kind; command: PendingCommand }>();
  const [stale, setStale] = useState(false);
  const [failure, setFailure] = useState<CommandFailure>();
  const [draft, setDraft] = useState('');
  const [noteInvalid, setNoteInvalid] = useState(false);
  const [dialog, setDialog] = useState<'assign' | 'close'>();
  const [team, setTeam] = useState<TeamLoad>({ phase: 'idle' });
  const [assignee, setAssignee] = useState('');
  const [assigneeRejected, setAssigneeRejected] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<Focus | undefined>(undefined);

  const loadInitial = useCallback(() => {
    setLoad({ phase: 'loading' });
    api.detail(caseId).then(
      (data) => setLoad({ phase: 'ready', data }),
      (error: unknown) => setLoad({ phase: 'error', status: failureStatus(error) }),
    );
  }, [api, caseId]);

  useEffect(() => {
    let active = true;
    api.detail(caseId).then(
      (data) => active && setLoad({ phase: 'ready', data }),
      (error: unknown) => active && setLoad({ phase: 'error', status: failureStatus(error) }),
    );
    return () => {
      active = false;
    };
  }, [api, caseId]);

  const ready = load.phase === 'ready';
  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready]);

  const data = load.phase === 'ready' ? load.data : undefined;
  // the original set of buttons is replaced after a reload, so place focus explicitly rather than letting it fall to body
  useEffect(() => {
    const target = focusAfter.current;
    if (!target || !data) return;
    focusAfter.current = undefined;
    if (target === 'actions') actionsRef.current?.querySelector('button')?.focus();
    else if (target === 'closed') closedRef.current?.focus();
    else noteRef.current?.querySelector('textarea')?.focus();
  }, [data]);

  if (load.phase === 'loading') return <DetailSkeleton label={t('detail.loading')} />;
  if (load.phase === 'error' || !data) {
    const status = load.phase === 'error' ? load.status : 500;
    return (
      <div className="cs-detail">
        <Button variant="ghost" className="cs-back" onPress={onBack}>
          ← {t('detail.back')}
        </Button>
        {status === 403 || status === 404 ? (
          <section className="cs-card cs-state" role="status">
            <h1>{t('detail.notFound')}</h1>
            <p className="cs-muted">{t('detail.notFoundCopy')}</p>
          </section>
        ) : (
          <section className="cs-bar cs-bar-critical" role="alert">
            <p>{status === 401 ? t('unauthorized') : t('detail.failed')}</p>
            {status === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
            <Button onPress={loadInitial}>{t('retry')}</Button>
          </section>
        )}
      </div>
    );
  }

  const { case: item, people, customer, teamName } = data;
  const closed = item.status === 'CLOSED';
  const subject = item.subject ?? t('automationSubject');
  const name = (userId: string | null | undefined) =>
    userId ? (people[userId] ?? t('actor.unknown')) : t('unassigned');
  const customerName = customer
    ? (customer.displayName ?? t('unnamed'))
    : item.contactDisplayName === undefined
      ? t('customerUnavailable')
      : (item.contactDisplayName ?? t('unnamed'));
  const locked = stale || busy !== undefined;

  async function reload(focus?: Focus) {
    setReloading(true);
    try {
      const next = await api.detail(caseId);
      focusAfter.current = focus;
      setLoad({ phase: 'ready', data: next });
      return true;
    } catch (error) {
      if (failureStatus(error) === 401) setFailure('unauthorized');
      return false;
    } finally {
      setReloading(false);
    }
  }

  /** every press creates a commandId once; pressing again after "unknown result" reuses the id when the command is exactly the same */
  async function run(
    kind: Kind,
    signature: string,
    call: (command: CaseCommand) => Promise<CaseRef>,
    onDone: () => Promise<void>,
  ) {
    const command = commandFor(
      unknown?.kind === kind ? unknown.command : undefined,
      signature,
      () => crypto.randomUUID(),
    );
    setBusy(kind);
    setFailure(undefined);
    try {
      await call({ caseId: item.id, expectedVersion: item.version, commandId: command.commandId });
      setUnknown(undefined);
      await onDone();
    } catch (error) {
      const result = classifyFailure(error);
      setUnknown(result === 'unknown' ? { kind, command } : undefined);
      if (result === 'stale') {
        setStale(true);
        setDialog(undefined);
        requestAnimationFrame(() => alertRef.current?.focus());
      } else if (result === 'assignee') {
        setAssigneeRejected(true);
        setAssignee('');
        void loadTeam(true);
      } else if (result === 'invalid' && kind === 'note') setNoteInvalid(true);
      else setFailure(result);
    } finally {
      setBusy(undefined);
    }
  }

  async function loadTeam(force = false) {
    if (!force && (team.phase === 'loading' || team.phase === 'ready')) return;
    setTeam({ phase: 'loading' });
    try {
      const agents = await api.teamAgents();
      setTeam({
        phase: 'ready',
        agents: [...agents].sort((a, b) => a.displayName.localeCompare(b.displayName, locale)),
      });
    } catch {
      setTeam({ phase: 'error' });
    }
  }

  const saveNote = () => {
    const note = validateNote(draft);
    if (!note.ok) {
      setNoteInvalid(true);
      return;
    }
    setNoteInvalid(false);
    void run(
      'note',
      commandSignature('note', item.id, item.version, note.value),
      (command) => api.addNote(command, note.value),
      async () => {
        setDraft('');
        if (await reload('note'))
          toastQueue.add({ title: t('toast.noteSaved'), tone: 'success' }, { timeout: TOAST_MS });
      },
    );
  };

  const changeStatus = (action: 'resolve' | 'reopen' | 'close') => {
    const target = STATUS_TARGET[action];
    void run(
      action,
      commandSignature('status', item.id, item.version, target),
      (command) => api.changeStatus(command, target),
      async () => {
        setDialog(undefined);
        if (await reload(action === 'close' ? 'closed' : 'actions'))
          toastQueue.add({ title: t(TOAST_KEY[action]), tone: 'success' }, { timeout: TOAST_MS });
      },
    );
  };

  const submitAssign = () => {
    if (!assignee) return;
    const target =
      team.phase === 'ready' ? team.agents.find((a) => a.userId === assignee) : undefined;
    void run(
      'assign',
      commandSignature('assign', item.id, item.version, assignee),
      (command) => api.assign(command, assignee),
      async () => {
        setDialog(undefined);
        if (await reload())
          toastQueue.add(
            { title: t('toast.assigned', { name: target?.displayName ?? '' }), tone: 'success' },
            { timeout: TOAST_MS },
          );
      },
    );
  };

  const reloadLatest = async () => {
    setUnknown(undefined);
    if (await reload('note')) setStale(false);
  };

  const unknownFor = (kind: Kind) => unknown?.kind === kind;
  const actions = actionsFor(item.status);
  const primary: CaseAction | undefined =
    item.status === 'OPEN' ? 'resolve' : item.status === 'RESOLVED' ? 'close' : undefined;
  const buttonText: Record<CaseAction, string> = {
    assign: t('action.assign'),
    resolve: t('action.resolve'),
    reopen: t('action.reopen'),
    close: t('action.close'),
  };
  const actionLabel = (action: CaseAction) =>
    busy === action
      ? t('action.pending')
      : unknownFor(action)
        ? t('action.unknown')
        : buttonText[action];
  const press = (action: CaseAction) => {
    if (action === 'assign') {
      setAssigneeRejected(false);
      setAssignee(item.assigneeUserId ?? '');
      setDialog('assign');
      void loadTeam();
    } else if (action === 'close') setDialog('close');
    else changeStatus(action);
  };
  const agentLabel = (agent: TeamAgent) =>
    agent.userId === item.assigneeUserId
      ? t('assign.current', { name: agent.displayName })
      : agent.userId === viewerUserId
        ? t('assign.you', { name: agent.displayName })
        : agent.displayName;
  const assignOptions =
    team.phase === 'ready' ? team.agents.map((a) => ({ id: a.userId, label: agentLabel(a) })) : [];
  const assignChanged = assignee !== '' && assignee !== item.assigneeUserId;
  const noteLocked = busy === 'note' || unknownFor('note');

  return (
    <div className="cs-detail" aria-busy={reloading}>
      <Button variant="ghost" onPress={onBack} className="cs-back">
        ← {t('detail.back')}
      </Button>
      <header className="cs-detail-head">
        <div className="cs-detail-title">
          <div className="cs-title-line">
            <h1 ref={headingRef} tabIndex={-1} title={subject}>
              {subject}
            </h1>
            <CaseStatusChip status={item.status} />
          </div>
          <p className="cs-muted">
            {t('detail.meta', {
              customer: customerName,
              assignee: name(item.assigneeUserId),
              time: format(item.updatedAt),
            })}
          </p>
        </div>
        {actions.length > 0 ? (
          <div
            className="cs-actions"
            ref={actionsRef}
            role="group"
            aria-label={t('detail.actions')}
          >
            {actions.map((action) => (
              <Button
                key={action}
                variant={action === primary ? 'primary' : 'secondary'}
                isDisabled={locked}
                onPress={() => press(action)}
              >
                {actionLabel(action)}
              </Button>
            ))}
          </div>
        ) : null}
      </header>

      {stale ? (
        <div className="cs-bar cs-bar-attention" role="alert" tabIndex={-1} ref={alertRef}>
          <p>{t('conflict')}</p>
          <Button onPress={() => void reloadLatest()} isDisabled={reloading}>
            {t('conflictReload')}
          </Button>
        </div>
      ) : null}
      {closed ? (
        <div className="cs-bar cs-bar-brand" role="status" tabIndex={-1} ref={closedRef}>
          <p>{t('closedNotice', { time: format(item.closedAt ?? item.updatedAt) })}</p>
        </div>
      ) : null}
      {unknown && !dialog ? (
        <div className="cs-bar cs-bar-attention" role="status">
          <p>{t('unknownNotice')}</p>
        </div>
      ) : null}
      {failure && !dialog ? (
        <div className="cs-bar cs-bar-critical" role="alert">
          <p>{failure === 'unauthorized' ? t('unauthorized') : t('actionFailed')}</p>
          {failure === 'unauthorized' && onSignIn ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
        </div>
      ) : null}

      <div className="cs-grid">
        <section className="cs-card cs-main">
          <CaseTimeline activities={item.activities} people={people} />
          <div className="cs-note-form" ref={noteRef}>
            {closed ? (
              draft ? (
                <>
                  <TextField
                    multiline
                    isReadOnly
                    label={t('note.draftClosed')}
                    value={draft}
                    maxLength={NOTE_MAX}
                  />
                  <Button
                    onPress={() => {
                      void navigator.clipboard?.writeText(draft);
                      toastQueue.add({ title: t('note.copied'), tone: 'info' }, { timeout: 3000 });
                    }}
                  >
                    {t('note.copyDraft')}
                  </Button>
                </>
              ) : null
            ) : (
              <>
                <TextField
                  multiline
                  label={t('note.label')}
                  placeholder={t('note.placeholder')}
                  value={draft}
                  onChange={(value) => {
                    setDraft(value);
                    setNoteInvalid(false);
                  }}
                  isReadOnly={noteLocked}
                  isInvalid={noteInvalid}
                  errorMessage={t('note.required')}
                  description={
                    <span className="cs-hint">
                      <span>{t('note.help')}</span>
                      <span>
                        {t('note.count', { count: draft.length.toLocaleString('en-US') })}
                      </span>
                    </span>
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      if (!locked) saveNote();
                    }
                  }}
                />
                <Button isDisabled={locked} onPress={saveNote}>
                  {busy === 'note'
                    ? t('action.pending')
                    : unknownFor('note')
                      ? t('action.unknown')
                      : t('note.submit')}
                </Button>
              </>
            )}
          </div>
        </section>

        <aside className="cs-side">
          <section className="cs-card">
            <h2>{t('summary.title')}</h2>
            <dl className="cs-dl">
              <dt>{t('summary.status')}</dt>
              <dd>
                <CaseStatusChip status={item.status} />
              </dd>
              <dt>{t('summary.assignee')}</dt>
              <dd>
                <strong>{name(item.assigneeUserId)}</strong>
                {item.assigneeUserId && !item.assigneeInTeam ? (
                  <>
                    <Badge tone="attention" className="cs-you">
                      {t('summary.assigneeInactive')}
                    </Badge>
                    <span className="cs-muted cs-dd-hint">{t('summary.reassignHint')}</span>
                  </>
                ) : null}
              </dd>
              <dt>{t('summary.team')}</dt>
              <dd>{teamName}</dd>
              <dt>{t('summary.openedBy')}</dt>
              <dd>{item.createdByUserId ? name(item.createdByUserId) : t('actor.automation')}</dd>
              <dt>{t('summary.openedAt')}</dt>
              <dd>{format(item.createdAt)}</dd>
              {item.closedAt ? (
                <>
                  <dt>{t('summary.closedAt')}</dt>
                  <dd>{format(item.closedAt)}</dd>
                </>
              ) : null}
              <dt>{t('summary.links')}</dt>
              <dd>{item.linkedWorkCount}</dd>
            </dl>
          </section>
          <section className="cs-card">
            <h2>{t('customer.title')}</h2>
            {customer ? (
              <>
                <p>
                  <strong>{customer.displayName ?? t('unnamed')}</strong>
                </p>
                {customer.company ? <p className="cs-muted">{customer.company}</p> : null}
              </>
            ) : (
              <div className="cs-bar cs-bar-attention" role="status">
                <p>{t('customer.failed')}</p>
                <Button size="sm" isDisabled={reloading} onPress={() => void reload()}>
                  {t('retry')}
                </Button>
              </div>
            )}
          </section>
        </aside>
      </div>

      <Dialog
        isOpen={dialog === 'assign'}
        onOpenChange={(open) => !open && !busy && setDialog(undefined)}
        title={t('assign.title')}
        footer={(close) => (
          <>
            <Button variant="ghost" isDisabled={busy === 'assign'} onPress={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={
                busy === 'assign' ||
                team.phase !== 'ready' ||
                (!assignChanged && !unknownFor('assign'))
              }
              onPress={submitAssign}
            >
              {busy === 'assign'
                ? t('action.pending')
                : unknownFor('assign')
                  ? t('action.unknown')
                  : t('assign.submit')}
            </Button>
          </>
        )}
      >
        {team.phase === 'error' ? (
          <div className="cs-bar cs-bar-critical" role="alert">
            <p>{t('assign.loadFailed')}</p>
            <Button size="sm" onPress={() => void loadTeam(true)}>
              {t('retry')}
            </Button>
          </div>
        ) : (
          <Select
            autoFocus
            label={t('assign.field')}
            description={t('assign.help', { team: teamName })}
            options={assignOptions}
            placeholder={team.phase === 'loading' ? t('assign.loadingTeam') : undefined}
            selectedKey={assignee || null}
            isDisabled={team.phase !== 'ready' || busy === 'assign' || unknownFor('assign')}
            isInvalid={assigneeRejected}
            errorMessage={t('assign.rejected')}
            onSelectionChange={(key) => {
              setAssignee(key ? String(key) : '');
              setAssigneeRejected(false);
            }}
          />
        )}
        {unknownFor('assign') ? (
          <p className="cs-bar cs-bar-attention" role="status">
            {t('unknownNotice')}
          </p>
        ) : null}
        {failure && dialog === 'assign' ? (
          <p className="cs-bar cs-bar-critical" role="alert">
            {t('actionFailed')}
          </p>
        ) : null}
      </Dialog>

      <Dialog
        role="alertdialog"
        isDismissable={false}
        isOpen={dialog === 'close'}
        onOpenChange={(open) => !open && !busy && setDialog(undefined)}
        title={t('close.title', { subject })}
        footer={(close) => (
          <>
            <Button autoFocus variant="ghost" isDisabled={busy === 'close'} onPress={close}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              isDisabled={busy === 'close'}
              onPress={() => changeStatus('close')}
            >
              {busy === 'close'
                ? t('action.pending')
                : unknownFor('close')
                  ? t('action.unknown')
                  : t('close.confirm')}
            </Button>
          </>
        )}
      >
        <p>{t('close.body')}</p>
        {unknownFor('close') ? (
          <p className="cs-bar cs-bar-attention" role="status">
            {t('unknownNotice')}
          </p>
        ) : null}
        {failure && dialog === 'close' ? (
          <p className="cs-bar cs-bar-critical" role="alert">
            {t('actionFailed')}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div className="cs-detail" role="status" aria-label={label} aria-busy="true">
      <span className="cs-skeleton-bar" style={{ inlineSize: '40%', blockSize: '28px' }} />
      <div className="cs-grid">
        <section className="cs-card cs-main">
          {Array.from({ length: 5 }, (_, row) => (
            <span
              key={row}
              className="cs-skeleton-bar"
              style={{ inlineSize: `${80 - row * 8}%` }}
            />
          ))}
        </section>
        <aside className="cs-side">
          <section className="cs-card cs-skeleton-card" />
          <section className="cs-card cs-skeleton-card" />
        </aside>
      </div>
    </div>
  );
}
