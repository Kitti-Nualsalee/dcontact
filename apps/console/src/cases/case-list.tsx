import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
} from '@d-contact/ui-react';
import { CaseApiError, type CaseListPage, type CasesApi, type CaseSummary } from './api.js';
import { CaseStatusChip, useDateFormat } from './common.js';
import {
  DEFAULT_FILTER,
  FIRST_PAGE,
  casesHref,
  currentCursor,
  goNext,
  goPrevious,
  isDefaultFilter,
  pageRange,
  toListFilter,
  type AssigneeScope,
  type CaseFilterState,
  type CursorStack,
  type StatusFilterValue,
} from './model.js';

interface Props {
  api: CasesApi;
  filter: CaseFilterState;
  viewerUserId: string;
  /** the most recently opened case — after returning from detail, focus that row's button */
  focusCaseId?: string;
  onFilterChange: (filter: CaseFilterState) => void;
  onOpen: (caseId: string) => void;
  onSignIn?: () => void;
}

type ListState =
  | { phase: 'loading'; page?: CaseListPage }
  | { phase: 'ready'; page: CaseListPage }
  | { phase: 'error'; status: number };

export const openButtonId = (caseId: string) => `cs-open-${caseId}`;

export function CaseList({
  api,
  filter,
  viewerUserId,
  focusCaseId,
  onFilterChange,
  onOpen,
  onSignIn,
}: Props) {
  const { t } = useTranslation('cases');
  const format = useDateFormat();
  const [stack, setStack] = useState<CursorStack>(FIRST_PAGE);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const cursor = currentCursor(stack);

  useEffect(() => {
    let active = true;
    setState((current) => ({
      phase: 'loading',
      page: 'page' in current ? current.page : undefined,
    }));
    api
      .list(toListFilter(filter, cursor))
      .then((page) => active && setState({ phase: 'ready', page }))
      .catch(
        (failure: unknown) =>
          active &&
          setState({
            phase: 'error',
            status: failure instanceof CaseApiError ? failure.status : 500,
          }),
      );
    return () => {
      active = false;
    };
  }, [api, filter.status, filter.assignee, cursor, revision]);

  const page = state.phase === 'error' ? undefined : state.page;
  const loading = state.phase === 'loading';

  useEffect(() => {
    if (state.phase === 'ready' && focusCaseId)
      document.getElementById(openButtonId(focusCaseId))?.focus();
    // only when the first page finishes loading after returning from detail
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase === 'ready']);

  const change = (next: CaseFilterState) => {
    setStack(FIRST_PAGE);
    onFilterChange(next);
  };

  const statusOptions = useMemo(
    () => [
      { id: 'NOT_CLOSED', label: t('filter.statusActive') },
      { id: 'OPEN', label: t('status.OPEN') },
      { id: 'RESOLVED', label: t('status.RESOLVED') },
      { id: 'CLOSED', label: t('status.CLOSED') },
      { id: 'ALL', label: t('filter.statusAll') },
    ],
    [t],
  );
  const assigneeOptions = [
    { id: 'me', label: t('filter.mine') },
    { id: 'team', label: t('filter.team') },
  ];

  return (
    <div className="cs-list" aria-busy={loading}>
      <header className="cs-head">
        <div>
          <h1>{t('title')}</h1>
          {/* always reserve the height so the filter does not jump once the team name is known */}
          <p className="cs-muted cs-subtitle">
            {page ? t('subtitle', { team: page.teamName }) : null}
          </p>
        </div>
        <Button isDisabled={loading} onPress={() => setRevision((current) => current + 1)}>
          {t('refresh')}
        </Button>
      </header>

      <section className="cs-card cs-filters" role="group" aria-label={t('filter.label')}>
        <Select
          label={t('filter.status')}
          options={statusOptions}
          selectedKey={filter.status}
          onSelectionChange={(key) =>
            key && change({ ...filter, status: String(key) as StatusFilterValue })
          }
        />
        <Select
          label={t('filter.assignee')}
          options={assigneeOptions}
          selectedKey={filter.assignee}
          onSelectionChange={(key) =>
            key && change({ ...filter, assignee: String(key) as AssigneeScope })
          }
        />
        {isDefaultFilter(filter) ? null : (
          <Button variant="ghost" onPress={() => change(DEFAULT_FILTER)}>
            {t('filter.clear')}
          </Button>
        )}
      </section>

      {state.phase === 'error' ? (
        <ListError
          status={state.status}
          onSignIn={onSignIn}
          onRetry={() => setRevision((n) => n + 1)}
        />
      ) : null}
      {loading && !page ? <ListSkeleton label={t('loading')} /> : null}
      {page && page.items.length === 0 && !loading ? (
        <ListEmpty filter={filter} onChange={change} />
      ) : null}
      {page && page.items.length > 0 ? (
        <section className="cs-card cs-table" data-stale={loading || undefined}>
          <div className="cs-scroll">
            <Table aria-label={t('list')}>
              <TableHeader>
                <Column isRowHeader className="cs-col-subject">
                  {t('col.subject')}
                </Column>
                <Column className="cs-col-customer">{t('col.customer')}</Column>
                <Column className="cs-col-status">{t('col.status')}</Column>
                <Column className="cs-col-assignee">{t('col.assignee')}</Column>
                <Column className="cs-col-updated">{t('col.updated')}</Column>
                <Column className="cs-col-links">{t('col.links')}</Column>
                <Column className="cs-col-action">
                  <span className="cs-sr">{t('col.actions')}</span>
                </Column>
              </TableHeader>
              <TableBody>
                {page.items.map((item) => (
                  <CaseRow
                    key={item.id}
                    item={item}
                    page={page}
                    filter={filter}
                    viewerUserId={viewerUserId}
                    format={format}
                    onOpen={onOpen}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <footer className="cs-foot">
            <span aria-live="polite">{t('page.range', pageRange(stack, page.items.length))}</span>
            <span className="cs-pager">
              <Button
                variant="ghost"
                isDisabled={loading || stack.length === 1}
                onPress={() => setStack(goPrevious(stack))}
              >
                {t('page.prev')}
              </Button>
              <Button
                variant="ghost"
                isDisabled={loading || !page.nextCursor}
                onPress={() => page.nextCursor && setStack(goNext(stack, page.nextCursor))}
              >
                {t('page.next')}
              </Button>
            </span>
          </footer>
        </section>
      ) : null}
    </div>
  );
}

function CaseRow({
  item,
  page,
  filter,
  viewerUserId,
  format,
  onOpen,
}: {
  item: CaseSummary;
  filter: CaseFilterState;
  page: CaseListPage;
  viewerUserId: string;
  format: (value: string) => string;
  onOpen: (caseId: string) => void;
}) {
  const { t } = useTranslation('cases');
  const subject = item.subject ?? t('automationSubject');
  const customer =
    item.contactDisplayName === undefined
      ? { text: t('customerUnavailable'), muted: true }
      : { text: item.contactDisplayName ?? t('unnamed'), muted: false };
  const assignee = item.assigneeUserId
    ? (page.people[item.assigneeUserId] ?? t('actor.unknown'))
    : t('unassigned');
  const href = casesHref(new URL(window.location.href), {
    ...filter,
    caseId: item.id,
  });
  return (
    <Row id={item.id} onAction={() => onOpen(item.id)}>
      <Cell className="cs-trunc">
        <a
          href={href.pathname + href.search}
          title={subject}
          className="cs-link"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onOpen(item.id);
          }}
        >
          {subject}
        </a>
      </Cell>
      <Cell className={customer.muted ? 'cs-trunc cs-muted' : 'cs-trunc'}>
        <span title={customer.text}>{customer.text}</span>
      </Cell>
      <Cell>
        <CaseStatusChip status={item.status} />
      </Cell>
      <Cell className="cs-trunc">
        <span title={assignee}>{assignee}</span>
        {item.assigneeUserId === viewerUserId ? (
          <Badge tone="neutral" className="cs-you">
            {t('you')}
          </Badge>
        ) : null}
      </Cell>
      <Cell className="cs-nowrap">{format(item.updatedAt)}</Cell>
      <Cell className="cs-num">{item.linkedWorkCount}</Cell>
      <Cell>
        <Button
          id={openButtonId(item.id)}
          size="sm"
          aria-label={t('openItem', {
            // cases opened by automation share one fallback subject: add the customer so each row reads apart
            subject: item.subject === null ? `${subject} ${customer.text}` : subject,
          })}
          onPress={() => onOpen(item.id)}
        >
          {t('open')}
        </Button>
      </Cell>
    </Row>
  );
}

function ListError({
  status,
  onSignIn,
  onRetry,
}: {
  status: number;
  onSignIn?: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('cases');
  if (status === 403)
    return (
      <section className="cs-card cs-state" role="status">
        <h2>{t('noTeam')}</h2>
        <p className="cs-muted">{t('noTeamCopy')}</p>
      </section>
    );
  return (
    <section className="cs-bar cs-bar-critical" role="alert">
      <p>{status === 401 ? t('unauthorized') : t('failed')}</p>
      {status === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
      <Button onPress={onRetry}>{t('retry')}</Button>
    </section>
  );
}

function ListEmpty({
  filter,
  onChange,
}: {
  filter: CaseFilterState;
  onChange: (filter: CaseFilterState) => void;
}) {
  const { t } = useTranslation('cases');
  if (isDefaultFilter(filter))
    return (
      <section className="cs-card cs-state">
        <h2>{t('emptyMine')}</h2>
        <p className="cs-muted">{t('emptyMineCopy')}</p>
        <Button onPress={() => onChange({ ...filter, assignee: 'team' })}>{t('viewTeam')}</Button>
      </section>
    );
  if (filter.status === 'ALL' && filter.assignee === 'team')
    return (
      <section className="cs-card cs-state">
        <h2>{t('emptyTeam')}</h2>
      </section>
    );
  return (
    <section className="cs-card cs-state">
      <h2>{t('emptyFilter')}</h2>
      <Button onPress={() => onChange(DEFAULT_FILTER)}>{t('filter.clear')}</Button>
    </section>
  );
}

/** ui-react has no skeleton yet — 8 rows as tall as real rows */
function ListSkeleton({ label }: { label: string }) {
  return (
    <section className="cs-card cs-skeleton" role="status" aria-label={label}>
      {Array.from({ length: 8 }, (_, row) => (
        <div key={row} className="cs-skeleton-row">
          <span style={{ inlineSize: '34%' }} />
          <span style={{ inlineSize: '17%' }} />
          <span style={{ inlineSize: '10%' }} />
          <span style={{ inlineSize: '17%' }} />
        </div>
      ))}
    </section>
  );
}
