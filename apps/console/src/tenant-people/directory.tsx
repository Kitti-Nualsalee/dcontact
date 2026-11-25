import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Row,
  SearchField,
  Select,
  StatusChip,
  Table,
  TableBody,
  TableHeader,
  type BadgeTone,
} from '@d-contact/ui-react';
import { CatalogApiError } from '../voice-routing/api.js';
import {
  PEOPLE_DIRECTORY_STATUSES,
  type PeopleDirectoryApi,
  type PeopleDirectoryFilters,
  type PeopleDirectoryUser,
} from './directory-api.js';
import { PeopleInvitation } from './invitation.js';
import { PeopleDisable } from './disable.js';
import { PeopleTeamChange } from './team-change.js';
import { PeopleEnable, PeopleProfileEdit } from './account-change.js';

export type AccountStatus =
  | 'ATTENTION_REQUIRED'
  | 'REJECTED'
  | 'DISABLED'
  | 'DISABLING'
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'PENDING_ACTIVATION'
  | 'UNKNOWN';

/** the single account status, in priority order — the first match wins */
export function accountStatus(user: PeopleDirectoryUser): AccountStatus {
  if (user.accountState === 'ATTENTION_REQUIRED') return 'ATTENTION_REQUIRED';
  if (user.provisioningState === 'REJECTED') return 'REJECTED';
  if (user.accountState === 'DISABLED') return 'DISABLED';
  if (user.accountState === 'DISABLING') return 'DISABLING';
  if (user.accountState === 'PROVISIONING' || user.provisioningState === 'PENDING')
    return 'PROVISIONING';
  if (user.accountState === 'ACTIVE' && user.activationState === 'ACTIVATED' && user.isActive)
    return 'ACTIVE';
  if (
    user.accountState === 'PENDING_ACTIVATION' &&
    user.provisioningState === 'PROVISIONED' &&
    user.activationState === 'PENDING'
  )
    return 'PENDING_ACTIVATION';
  return 'UNKNOWN';
}

const STATUS_TONE: Record<AccountStatus, BadgeTone> = {
  ATTENTION_REQUIRED: 'critical',
  REJECTED: 'critical',
  DISABLED: 'neutral',
  DISABLING: 'attention',
  PROVISIONING: 'info',
  ACTIVE: 'success',
  PENDING_ACTIVATION: 'info',
  UNKNOWN: 'neutral',
};

const DELIVERY_TONE: Record<string, BadgeTone> = {
  SENT: 'info',
  INTENT: 'neutral',
  NOT_STARTED: 'neutral',
  DISPATCHING: 'attention',
  AMBIGUOUS: 'attention',
  EXPIRED: 'attention',
  FAILED: 'critical',
  UNKNOWN: 'neutral',
};

export function AccountStatusChip({ user }: { user: PeopleDirectoryUser }) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string) => string;
  const status = accountStatus(user);
  return <StatusChip status={STATUS_TONE[status]}>{label(`status.${status}`)}</StatusChip>;
}

type Filters = { search: string; role: string; status: string; team: string };
const NO_FILTERS: Filters = { search: '', role: 'ALL', status: 'ALL', team: 'ALL' };
const SEARCH_DELAY_MS = 300;

function serverFilters(filters: Filters, search: string): PeopleDirectoryFilters {
  return {
    ...(search.trim() ? { q: search.trim() } : {}),
    ...(filters.role === 'AGENT' || filters.role === 'SUPERVISOR' || filters.role === 'ADMIN'
      ? { role: filters.role }
      : {}),
    ...(filters.team !== 'ALL' ? { teamId: filters.team } : {}),
    ...(filters.status !== 'ALL' ? { status: filters.status } : {}),
  };
}

export function PeopleDirectory({
  api,
  onFailure,
  onOperation,
  onDetailChange,
  canOpenOperation,
  identityKey,
  teams,
}: {
  api: PeopleDirectoryApi;
  identityKey: string;
  canOpenOperation: boolean;
  teams: { id: string; name: string }[];
  onFailure(error: unknown): void;
  onOperation(reference: { commandId: string; operationId: string }): void;
  onDetailChange?(open: boolean): void;
}) {
  const { t: translate } = useTranslation('tenantPeople');
  const label = translate as (key: string, values?: Record<string, unknown>) => string;
  const [items, setItems] = useState<PeopleDirectoryUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<PeopleDirectoryUser>();
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const busy = listBusy || detailBusy;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<'list' | 'more' | 'detail'>();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  // the search query waits for the user to stop typing before sending; other filters send immediately
  const [search, setSearch] = useState('');
  // the list and the detail use separate refs so opening a detail does not unlock "Load more" of a list that is still loading
  const active = useRef(false),
    listInFlight = useRef(false),
    detailInFlight = useRef(false),
    generation = useRef(0);
  const lastOpened = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onFailure, onOperation, onDetailChange });
  callbacks.current = { onFailure, onOperation, onDetailChange };
  const teamName = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);
  function failed(error: unknown, kind: 'list' | 'more' | 'detail') {
    if (!active.current) return;
    setError(kind);
    if (error instanceof CatalogApiError && [401, 403].includes(error.status)) {
      setItems([]);
      setSelected(undefined);
      setNextCursor(null);
      callbacks.current.onFailure(error);
    }
  }
  /** reload the first page every time a filter changes; the results of an old, slowly answering request are dropped */
  async function load(cursor?: string) {
    if (cursor && listInFlight.current) return;
    const current = ++generation.current;
    listInFlight.current = true;
    setListBusy(true);
    setError(undefined);
    // the cursor of the old filter cannot be used with the new filter
    if (!cursor) setNextCursor(null);
    try {
      const result = await api.list(cursor, serverFilters(filters, search));
      if (active.current && current === generation.current) {
        setItems((previous) => (cursor ? [...previous, ...result.items] : result.items));
        setNextCursor(result.nextCursor);
        setLoaded(true);
      }
    } catch (error) {
      if (current === generation.current) failed(error, cursor ? 'more' : 'list');
    } finally {
      if (current === generation.current) {
        listInFlight.current = false;
        if (active.current) setListBusy(false);
      }
    }
  }
  async function select(userId: string) {
    if (detailInFlight.current) return;
    detailInFlight.current = true;
    lastOpened.current = userId;
    setDetailBusy(true);
    setError(undefined);
    setSelected(undefined);
    try {
      const value = await api.detail(userId);
      if (active.current) {
        setSelected(value);
        callbacks.current.onDetailChange?.(true);
      }
    } catch (error) {
      failed(error, 'detail');
    } finally {
      detailInFlight.current = false;
      if (active.current) setDetailBusy(false);
    }
  }
  function back() {
    setSelected(undefined);
    setError(undefined);
    callbacks.current.onDetailChange?.(false);
    const id = lastOpened.current;
    if (id)
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-tp-open="${CSS.escape(id)}"]`)?.focus(),
      );
  }
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(filters.search), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [filters.search]);
  useEffect(() => {
    void load();
  }, [api, search, filters.role, filters.status, filters.team]);

  // the count badge and the empty result refer to the filter actually sent (the debounced query), while the clear button refers to the value the user set
  const filtering = Object.keys(serverFilters(filters, search)).length > 0;
  const dirty =
    filters.search.trim() !== '' ||
    filters.role !== 'ALL' ||
    filters.status !== 'ALL' ||
    filters.team !== 'ALL';
  function clearFilters() {
    setFilters(NO_FILTERS);
    setSearch('');
  }

  if (selected)
    return (
      <PeopleDetail
        user={selected}
        api={api}
        identityKey={identityKey}
        teamName={teamName}
        teams={teams}
        busy={busy}
        canOpenOperation={canOpenOperation}
        onBack={back}
        onUser={setSelected}
        onFailure={(error) => failed(error, 'detail')}
        onOperation={(reference) => callbacks.current.onOperation(reference)}
      />
    );

  return (
    <section className="tp-directory" aria-label={label('directory.title')} aria-busy={busy}>
      <h2 className="tp-visually-hidden">{label('directory.title')}</h2>
      <div className="tp-filters" role="search" aria-label={label('filters.label')}>
        <SearchField
          className="tp-search"
          label={label('filters.searchLabel')}
          placeholder={label('filters.search')}
          value={filters.search}
          onChange={(search) => setFilters((value) => ({ ...value, search }))}
        />
        <Select
          label={label('role')}
          selectedKey={filters.role}
          onSelectionChange={(key) => setFilters((value) => ({ ...value, role: String(key) }))}
          options={[
            { id: 'ALL', label: label('filters.allRoles') },
            ...(['AGENT', 'SUPERVISOR', 'ADMIN'] as const).map((role) => ({
              id: role,
              label: label(`roles.${role}`),
            })),
          ]}
        />
        <Select
          label={label('filters.status')}
          selectedKey={filters.status}
          onSelectionChange={(key) => setFilters((value) => ({ ...value, status: String(key) }))}
          options={[
            { id: 'ALL', label: label('filters.allStatuses') },
            ...PEOPLE_DIRECTORY_STATUSES.map((status) => ({
              id: status,
              label: label(`status.${status}`),
            })),
          ]}
        />
        <Select
          label={label('team')}
          selectedKey={filters.team}
          onSelectionChange={(key) => setFilters((value) => ({ ...value, team: String(key) }))}
          options={[
            { id: 'ALL', label: label('filters.allTeams') },
            ...teams.map((team) => ({ id: team.id, label: team.name })),
          ]}
        />
        <div className="tp-filter-actions">
          {dirty ? (
            <Button variant="ghost" onPress={clearFilters}>
              {label('filters.clear')}
            </Button>
          ) : null}
          <Button variant="secondary" isDisabled={busy} onPress={() => void load()}>
            {label('directory.reload')}
          </Button>
        </div>
      </div>

      {loaded && items.length > 0 ? (
        <p className="tp-count" role="status">
          {label(
            nextCursor ? 'list.countMore' : filtering ? 'list.countMatched' : 'list.countAll',
            { count: items.length },
          )}
        </p>
      ) : null}

      {error === 'list' || error === 'detail' ? (
        <div role="alert" className="tp-alert">
          <p>{label(error === 'list' ? 'list.loadFailed' : 'detail.loadFailed')}</p>
          <Button variant="secondary" isDisabled={busy} onPress={() => void load()}>
            {label('list.retry')}
          </Button>
        </div>
      ) : null}

      {!loaded && busy ? (
        <div className="tp-skeleton" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
      ) : null}

      {loaded && !items.length && !error && !filtering ? (
        <div className="tp-empty">
          <p className="tp-empty-title">{label('list.emptyTitle')}</p>
          <p>{label('list.emptyBody')}</p>
        </div>
      ) : null}

      {loaded && !items.length && !error && filtering ? (
        <div className="tp-empty">
          <p className="tp-empty-title">{label('list.noMatch')}</p>
          <Button variant="secondary" onPress={clearFilters}>
            {label('filters.clear')}
          </Button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="tp-table-wrap">
          <Table
            aria-label={label('directory.title')}
            className="tp-table"
            onRowAction={(key) => void select(String(key))}
          >
            <TableHeader>
              <Column isRowHeader>{label('columns.name')}</Column>
              <Column>{label('email')}</Column>
              <Column>{label('role')}</Column>
              <Column>{label('team')}</Column>
              <Column>{label('extension')}</Column>
              <Column>{label('columns.status')}</Column>
              <Column>
                <span className="tp-visually-hidden">{label('columns.actions')}</span>
              </Column>
            </TableHeader>
            <TableBody>
              {items.map((user) => {
                const status = accountStatus(user);
                return (
                  <Row key={user.id} id={user.id}>
                    <Cell>
                      <span className="tp-ellipsis tp-name" title={user.displayName}>
                        {user.displayName}
                      </span>
                    </Cell>
                    <Cell>
                      <span className="tp-ellipsis tp-muted" title={user.email}>
                        {user.email}
                      </span>
                    </Cell>
                    <Cell>{label(`roles.${user.role}`)}</Cell>
                    <Cell>
                      <span className="tp-ellipsis">
                        {user.teamId
                          ? (teamName.get(user.teamId) ?? label('list.unknownTeam'))
                          : '—'}
                      </span>
                    </Cell>
                    <Cell>
                      <span className="tp-num">{user.extensionRef ?? '—'}</span>
                    </Cell>
                    <Cell>
                      <span className="tp-badges">
                        <AccountStatusChip user={user} />
                        {status === 'PENDING_ACTIVATION' ? (
                          <Badge tone={DELIVERY_TONE[user.deliveryState] ?? 'neutral'}>
                            {label(
                              `deliveryShort.${user.deliveryState in DELIVERY_TONE ? user.deliveryState : 'UNKNOWN'}`,
                            )}
                          </Badge>
                        ) : null}
                      </span>
                    </Cell>
                    <Cell>
                      <Button
                        variant="ghost"
                        data-tp-open={user.id}
                        isDisabled={busy}
                        aria-label={`${label('directory.open')} ${user.displayName}`}
                        onPress={() => void select(user.id)}
                      >
                        {label('list.openRow')}
                      </Button>
                    </Cell>
                  </Row>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {error === 'more' ? (
        <div role="alert" className="tp-alert">
          <p>{label('list.moreFailed')}</p>
        </div>
      ) : null}
      {nextCursor ? (
        <div className="tp-more">
          <Button variant="secondary" isDisabled={busy} onPress={() => void load(nextCursor)}>
            {label('directory.more')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function PeopleDetail({
  user,
  api,
  identityKey,
  teamName,
  teams,
  busy,
  canOpenOperation,
  onBack,
  onUser,
  onFailure,
  onOperation,
}: {
  user: PeopleDirectoryUser;
  api: PeopleDirectoryApi;
  identityKey: string;
  teamName: Map<string, string>;
  teams: { id: string; name: string }[];
  busy: boolean;
  canOpenOperation: boolean;
  onBack(): void;
  onUser(user: PeopleDirectoryUser): void;
  onFailure(error: unknown): void;
  onOperation(reference: { commandId: string; operationId: string }): void;
}) {
  const { t: translate, i18n } = useTranslation('tenantPeople');
  const label = translate as (key: string) => string;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [user.id]);
  const team = user.teamId ? (teamName.get(user.teamId) ?? label('list.unknownTeam')) : '—';
  const expires = user.invitationExpiresAt ? new Date(user.invitationExpiresAt) : undefined;
  return (
    <section className="tp-detail" aria-label={label('directory.detail')}>
      <Button variant="ghost" className="tp-back" onPress={onBack}>
        ← {label('detail.back')}
      </Button>
      <header className="tp-detail-head">
        <div className="tp-detail-identity">
          <h2 ref={heading} tabIndex={-1} className="tp-detail-name">
            {user.displayName}
          </h2>
          <span className="tp-badges">
            <AccountStatusChip user={user} />
            <Badge tone="accent">{label(`roles.${user.role}`)}</Badge>
          </span>
          <p className="tp-muted">
            {[user.email, user.extensionRef, team].filter(Boolean).join(' · ')}
          </p>
        </div>
        {user.operationId && user.commandId ? (
          <Button
            variant="secondary"
            isDisabled={busy || !canOpenOperation}
            onPress={() =>
              onOperation({ operationId: user.operationId!, commandId: user.commandId! })
            }
          >
            {label('directory.status')}
          </Button>
        ) : null}
      </header>
      <div className="tp-detail-grid">
        <div className="tp-detail-main">
          <section className="tp-card" aria-labelledby="tp-account-title">
            <div className="tp-card-head">
              <h3 id="tp-account-title">{label('detail.account')}</h3>
            </div>
            <dl className="tp-dl">
              <dt>{label('name')}</dt>
              <dd>{user.displayName}</dd>
              <dt>{label('email')}</dt>
              <dd>{user.email}</dd>
              <dt>{label('role')}</dt>
              <dd>{label(`roles.${user.role}`)}</dd>
              <dt>{label('team')}</dt>
              <dd>{team}</dd>
              <dt>{label('extension')}</dt>
              <dd>{user.extensionRef ?? label('directory.none')}</dd>
              {expires && !Number.isNaN(expires.valueOf()) ? (
                <>
                  <dt>{label('detail.expiresAt')}</dt>
                  <dd>
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(expires)}
                  </dd>
                </>
              ) : null}
            </dl>
            <div className="tp-panel">
              <PeopleProfileEdit
                key={`profile:${user.id}`}
                api={api}
                user={user}
                identityKey={identityKey}
                onUser={onUser}
                onFailure={onFailure}
              />
              <PeopleTeamChange
                key={`team:${user.id}`}
                api={api}
                user={user}
                teams={teams}
                onUser={onUser}
                onFailure={onFailure}
              />
            </div>
          </section>
          <div className="tp-card">
            <PeopleInvitation
              key={user.id}
              api={api}
              user={user}
              identityKey={identityKey}
              onUser={onUser}
              onFailure={onFailure}
            />
          </div>
        </div>
        <aside className="tp-detail-side">
          <PeopleEnableCard
            api={api}
            user={user}
            identityKey={identityKey}
            teamName={team}
            onUser={onUser}
            onFailure={onFailure}
          />
          <div className="tp-card">
            <PeopleDisable
              key={`disable:${user.id}`}
              api={api}
              user={user}
              identityKey={identityKey}
              onUser={onUser}
              onFailure={onFailure}
            />
          </div>
          <p className="tp-muted tp-help">{label('detail.help')}</p>
        </aside>
      </div>
    </section>
  );
}

/** a card separate from "Disable account", shown when PeopleEnable has content (an account already disabled or a pending re-enable command) */
function PeopleEnableCard(props: Parameters<typeof PeopleEnable>[0]) {
  return (
    <div className="tp-card tp-card-optional">
      <PeopleEnable key={`enable:${props.user.id}`} {...props} />
    </div>
  );
}
