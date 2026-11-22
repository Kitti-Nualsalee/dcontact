import { useEffect, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import {
  Button,
  Cell,
  Column,
  Row,
  Select,
  Table,
  TableBody,
  TableHeader,
} from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import {
  SUMMARY_PERIODS,
  dispositionFrom,
  filterHref,
  formatTalk,
  periodFrom,
  type SummaryPeriod,
} from '../agent-history/model.js';
import {
  TeamHistoryApiError,
  type AgentRef,
  type TeamHistoryApi,
  type TeamHistoryDetail,
  type TeamHistoryItem,
  type TeamHistorySummary,
  type TeamOption,
} from './api.js';
import '../agent-history/agent-history.css';
import './team-history.css';

interface Props {
  api: TeamHistoryApi;
  identityKey: string;
  onSignIn?: () => void;
}

type SummaryState =
  | { phase: 'loading'; summary?: TeamHistorySummary }
  | { phase: 'ready'; summary: TeamHistorySummary }
  | { phase: 'error'; status: number };

const ALL = '__all__';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidParam = (value: string | null) => (value && UUID.test(value) ? value : undefined);
const statusOf = (failure: unknown) =>
  failure instanceof TeamHistoryApiError ? failure.status : 500;

function zoneName(locale: string, timeZone: string): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longGeneric' })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? timeZone
    );
  } catch {
    return timeZone;
  }
}

/** เขียนตัวกรองทีม/Agent ลง URL ปัจจุบันโดยคงพารามิเตอร์อื่น */
function scopeHref(href: string, teamId: string | undefined, agentId: string | undefined) {
  const url = new URL(href);
  if (teamId) url.searchParams.set('team', teamId);
  else url.searchParams.delete('team');
  if (agentId) url.searchParams.set('agent', agentId);
  else url.searchParams.delete('agent');
  return url.toString();
}

/** #986 ประวัติและสรุปงานของทีม — Supervisor เห็นทีมตัวเอง Admin เลือกทีมหรือดูทุกทีม */
export function TeamHistory(props: Props) {
  return <TeamHistorySession key={props.identityKey} {...props} />;
}

function TeamHistorySession({ api, onSignIn }: Props) {
  const { t } = useTranslation('teamHistory');
  const { locale } = useLocale();
  const ready = useShellTokens();
  const initial = new URL(window.location.href).searchParams;
  const [period, setPeriod] = useState<SummaryPeriod>(() => periodFrom(initial.get('period')));
  const [disposition, setDisposition] = useState<string | null | undefined>(() =>
    dispositionFrom(initial.get('disposition')),
  );
  const [teamId, setTeamId] = useState<string | undefined>(() => uuidParam(initial.get('team')));
  const [agentId, setAgentId] = useState<string | undefined>(() => uuidParam(initial.get('agent')));
  const [teams, setTeams] = useState<{ allTeams: boolean; items: TeamOption[] }>();
  const [summaryState, setSummaryState] = useState<SummaryState>({ phase: 'loading' });
  const [items, setItems] = useState<TeamHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(() => initial.get('interaction'));
  const [detail, setDetail] = useState<TeamHistoryDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number>();
  const [revision, setRevision] = useState(0);
  const [pageCursor, setPageCursor] = useState<string>();
  const summary = summaryState.phase === 'ready' ? summaryState.summary : undefined;
  const windowFrom = summary?.period.from ?? null;
  const windowTo = summary?.period.to ?? null;
  const format = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(value),
        )
      : t('unavailable');
  const dispositionLabel = (value: string | null) =>
    value === 'CUSTOMER_ASSISTED'
      ? t('assisted')
      : value === 'FOLLOW_UP_REQUIRED'
        ? t('followUp')
        : (value ?? t('unavailable'));
  const groupLabel = (value: string | null) =>
    value === null ? t('summary.noDisposition') : dispositionLabel(value);
  const agentName = (agent: AgentRef) => agent.displayName ?? t('unknownAgent');

  useEffect(() => {
    let active = true;
    void api
      .teams()
      .then((result) => {
        if (active) setTeams(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (selected) return;
    let active = true;
    setSummaryState((current) => ({
      phase: 'loading',
      summary: current.phase === 'error' ? undefined : current.summary,
    }));
    void api
      .summary(period, teamId)
      .then((result) => {
        if (active) setSummaryState({ phase: 'ready', summary: result });
      })
      .catch((failure: unknown) => {
        if (active) setSummaryState({ phase: 'error', status: statusOf(failure) });
      });
    return () => {
      active = false;
    };
  }, [api, selected, period, teamId, revision]);

  useEffect(() => {
    if (!selected && summaryState.phase !== 'ready') {
      // รายการรอช่วงเวลาจากสรุป เพื่อให้ตัวเลขกับรายการใช้ช่วงเดียวกัน
      setLoading(summaryState.phase === 'loading');
      return;
    }
    let active = true;
    setLoading(true);
    setError(undefined);
    setDetail(undefined);
    if (!selected && !pageCursor) setItems([]);
    const request = selected
      ? api.item(selected)
      : api.list(pageCursor, { from: windowFrom, to: windowTo, disposition, teamId, agentId });
    void request
      .then((result) => {
        if (!active) return;
        if ('items' in result) {
          setItems((current) => (pageCursor ? [...current, ...result.items] : result.items));
          setCursor(result.nextCursor);
        } else setDetail(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(statusOf(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // summaryState.phase เปลี่ยนตาม revision/period/team แล้ว — ไม่ใส่ object ทั้งก้อนเพื่อไม่โหลดซ้ำ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    selected,
    pageCursor,
    revision,
    windowFrom,
    windowTo,
    disposition,
    teamId,
    agentId,
    summaryState.phase,
  ]);

  function open(interactionId?: string) {
    const url = new URL(window.location.href);
    if (interactionId) url.searchParams.set('interaction', interactionId);
    else url.searchParams.delete('interaction');
    window.history.replaceState(null, '', url);
    setSelected(interactionId ?? null);
    setPageCursor(undefined);
  }
  function applyFilter(nextPeriod: SummaryPeriod, nextDisposition: string | null | undefined) {
    window.history.replaceState(
      null,
      '',
      filterHref(window.location.href, nextPeriod, nextDisposition),
    );
    setPeriod(nextPeriod);
    setDisposition(nextDisposition);
    setPageCursor(undefined);
  }
  function applyScope(nextTeam: string | undefined, nextAgent: string | undefined) {
    window.history.replaceState(null, '', scopeHref(window.location.href, nextTeam, nextAgent));
    setTeamId(nextTeam);
    setAgentId(nextAgent);
    setPageCursor(undefined);
  }
  if (!ready) return null;
  const failure = summaryState.phase === 'error' ? summaryState.status : error;
  const errorKey =
    failure === 401
      ? 'unauthorized'
      : failure === 403
        ? 'forbidden'
        : failure === 404
          ? 'notFound'
          : 'failed';
  const periodLabel = (key: SummaryPeriod) => t(`summary.period.${key}`);
  const shownSummary = summaryState.phase === 'error' ? undefined : summaryState.summary;
  const range = (() => {
    if (!shownSummary?.period.from || !shownSummary.period.to) return t('summary.allTime');
    const dates = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: shownSummary.period.timeZone,
    });
    const fromText = dates.format(new Date(shownSummary.period.from));
    const lastText = dates.format(new Date(new Date(shownSummary.period.to).getTime() - 1));
    return fromText === lastText ? fromText : `${fromText} – ${lastText}`;
  })();
  const selectedAgent = shownSummary?.byAgent.find((row) => row.agent.id === agentId);
  // จำนวนของตัวกรองที่เลือก: ผลบันทึกแยกตาม Agent ไม่มีในสรุป จึงแสดงเมื่อเลือกอย่างใดอย่างหนึ่ง
  const filterCount = shownSummary
    ? agentId
      ? disposition === undefined
        ? selectedAgent?.completed
        : undefined
      : disposition === undefined
        ? shownSummary.completed
        : (shownSummary.byDisposition.find((group) => group.disposition === disposition)?.count ??
          0)
    : undefined;
  const teamLabel = (team: TeamOption) =>
    team.isActive ? team.name : t('teamInactive', { name: team.name });
  return (
    <main className="ah-root">
      <h1>{t('title')}</h1>
      <p>{teams?.allTeams ? t('readOnlyAdmin') : t('readOnlySupervisor')}</p>
      <p className="th-note">{t('evidenceNote')}</p>
      {selected ? (
        <Button onPress={() => open()}>{t('back')}</Button>
      ) : (
        <>
          {teams?.allTeams ? (
            <div className="th-scope">
              <Select
                label={t('team')}
                selectedKey={teamId ?? ALL}
                onSelectionChange={(value) => {
                  const next = String(value ?? ALL);
                  applyScope(next === ALL ? undefined : next, undefined);
                }}
                options={[
                  { id: ALL, label: t('allTeams') },
                  ...teams.items.map((team) => ({ id: team.id, label: teamLabel(team) })),
                ]}
              />
            </div>
          ) : teams?.items[0] ? (
            <p className="th-scope">
              {t('team')}: <strong>{teamLabel(teams.items[0])}</strong>
            </p>
          ) : null}
          <section className="ah-summary" aria-labelledby="th-summary-title">
            <div className="ah-summary-head">
              <h2 id="th-summary-title">{t('summary.title')}</h2>
              <div className="ah-segmented" role="group" aria-label={t('summary.periodLabel')}>
                {SUMMARY_PERIODS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={period === key}
                    onClick={() => applyFilter(key, disposition)}
                  >
                    {periodLabel(key)}
                  </button>
                ))}
              </div>
              <Button
                isDisabled={loading || summaryState.phase === 'loading'}
                onPress={() => {
                  setPageCursor(undefined);
                  setRevision((current) => current + 1);
                }}
              >
                {t('refresh')}
              </Button>
            </div>
            {shownSummary ? (
              <>
                <p className="ah-range">
                  {t('summary.range', {
                    range,
                    timeZone: zoneName(locale, shownSummary.period.timeZone),
                  })}
                </p>
                <dl className="ah-metrics">
                  <div className="ah-metric">
                    <dt>{t('summary.completed')}</dt>
                    <dd>
                      <button
                        type="button"
                        className="ah-metric-value"
                        aria-pressed={disposition === undefined && agentId === undefined}
                        aria-label={t('summary.showAll', { count: shownSummary.completed })}
                        onClick={() => {
                          applyScope(teamId, undefined);
                          applyFilter(period, undefined);
                        }}
                      >
                        {shownSummary.completed}
                      </button>
                    </dd>
                  </div>
                  <div className="ah-metric">
                    <dt>{t('summary.talk')}</dt>
                    <dd>
                      {shownSummary.talk.averageSeconds === null ? (
                        <span className="ah-metric-empty">{t('summary.noTalk')}</span>
                      ) : (
                        <span className="ah-metric-value">
                          {formatTalk(shownSummary.talk.averageSeconds)}
                        </span>
                      )}
                      <span className="ah-metric-note">
                        {t('summary.talkBasis', { count: shownSummary.talk.measuredCount })}
                      </span>
                    </dd>
                  </div>
                </dl>
                {shownSummary.byDisposition.length ? (
                  <>
                    <h3>{t('summary.byDisposition')}</h3>
                    <ul className="ah-breakdown">
                      {shownSummary.byDisposition.map((group) => (
                        <li key={group.disposition ?? ''}>
                          <button
                            type="button"
                            aria-pressed={disposition === group.disposition}
                            onClick={() =>
                              applyFilter(
                                period,
                                disposition === group.disposition ? undefined : group.disposition,
                              )
                            }
                          >
                            <span>{groupLabel(group.disposition)}</span>
                            <span className="ah-count">{group.count}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {shownSummary.byAgent.length ? (
                  <>
                    <h3>{t('summary.byAgent')}</h3>
                    <ul className="ah-breakdown">
                      {shownSummary.byAgent.map((row) => (
                        <li key={row.agent.id}>
                          <button
                            type="button"
                            aria-pressed={agentId === row.agent.id}
                            aria-label={
                              row.talk.averageSeconds === null
                                ? t('summary.agentCountNoTalk', {
                                    agent: agentName(row.agent),
                                    count: row.completed,
                                  })
                                : t('summary.agentCount', {
                                    agent: agentName(row.agent),
                                    count: row.completed,
                                    talk: formatTalk(row.talk.averageSeconds),
                                  })
                            }
                            onClick={() =>
                              applyScope(
                                teamId,
                                agentId === row.agent.id ? undefined : row.agent.id,
                              )
                            }
                          >
                            <span>{agentName(row.agent)}</span>
                            <span className="ah-count">{row.completed}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            ) : summaryState.phase === 'loading' ? (
              <div className="ah-metrics ah-placeholder" aria-hidden="true">
                <div className="ah-metric" />
                <div className="ah-metric" />
              </div>
            ) : null}
          </section>
        </>
      )}
      {loading ? <p role="status">{t('loading')}</p> : null}
      {failure ? (
        <section role="alert">
          <p>{t(errorKey)}</p>
          {failure === 401 && onSignIn ? <Button onPress={onSignIn}>{t('signIn')}</Button> : null}
          <Button onPress={() => setRevision((current) => current + 1)}>{t('retry')}</Button>
        </section>
      ) : null}
      {!selected && shownSummary && !failure ? (
        <h2 className="ah-list-title">
          {t('summary.listTitle', {
            period: periodLabel(period),
            agent: selectedAgent ? agentName(selectedAgent.agent) : t('allAgents'),
            disposition:
              disposition === undefined ? t('summary.allDispositions') : groupLabel(disposition),
            count: filterCount ?? items.length,
          })}
        </h2>
      ) : null}
      {!selected && !failure && !loading && summary && items.length === 0 ? (
        <p>
          {disposition !== undefined || agentId !== undefined
            ? t('summary.emptyFiltered')
            : period === 'all'
              ? t('empty')
              : t('summary.emptyPeriod')}
        </p>
      ) : null}
      {!selected && items.length > 0 ? (
        <div className="ah-scroll">
          <Table aria-label={t('list')}>
            <TableHeader>
              <Column isRowHeader>{t('agent')}</Column>
              {teams?.allTeams && !teamId ? <Column>{t('team')}</Column> : null}
              <Column>{t('started')}</Column>
              <Column>{t('talk')}</Column>
              <Column>{t('disposition')}</Column>
              <Column>{t('recorded')}</Column>
              <Column>{t('open')}</Column>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <Row key={item.interactionId} id={item.interactionId}>
                  <Cell>{agentName(item.agent)}</Cell>
                  {teams?.allTeams && !teamId ? (
                    <Cell>{item.team.name ?? t('unavailable')}</Cell>
                  ) : null}
                  <Cell>{format(item.startedAt)}</Cell>
                  <Cell>
                    {item.talkSeconds === null ? t('unavailable') : formatTalk(item.talkSeconds)}
                  </Cell>
                  <Cell>{dispositionLabel(item.disposition)}</Cell>
                  <Cell>{format(item.recordedAt)}</Cell>
                  <Cell>
                    <Button
                      aria-label={t('openItem', {
                        interactionId: item.interactionId,
                        agent: agentName(item.agent),
                      })}
                      onPress={() => open(item.interactionId)}
                    >
                      {t('open')}
                    </Button>
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {!selected && cursor && !failure ? (
        <Button isDisabled={loading} onPress={() => setPageCursor(cursor)}>
          {t('more')}
        </Button>
      ) : null}
      {selected && detail && !error ? (
        <article>
          <h2>{t('detail')}</h2>
          <p>{detail.interactionId}</p>
          <p>
            {t('agent')}: {agentName(detail.agent)} · {t('team')}:{' '}
            {detail.team.name ?? t('unavailable')}
          </p>
          <p>{dispositionLabel(detail.disposition)}</p>
          <time dateTime={detail.recordedAt}>{format(detail.recordedAt)}</time>
          {detail.legacy ? <p>{t('legacy')}</p> : null}
          <h3>{t('note')}</h3>
          <p className="ah-note">{detail.note ?? t('noNote')}</p>
        </article>
      ) : null}
    </main>
  );
}
