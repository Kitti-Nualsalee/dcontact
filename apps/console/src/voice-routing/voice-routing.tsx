import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Button,
  TextField,
  Select,
  Table,
  TableHeader,
  Column,
  TableBody,
  Row,
  Cell,
} from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import {
  CatalogApiError,
  type CatalogApi,
  type CatalogItem,
  type CatalogKind,
  type Capabilities,
} from './api.js';
import './voice-routing.css';
interface Props {
  api: CatalogApi;
  identityKey: string;
  onSignIn?: () => void;
}
export function VoiceRouting(props: Props) {
  return <CatalogSession key={props.identityKey} {...props} />;
}
function CatalogSession({ api, onSignIn, identityKey }: Props) {
  const { t: translate } = useTranslation('voiceRouting');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const tokens = useShellTokens();
  const initial = new URL(window.location.href);
  const kind: CatalogKind = initial.searchParams.get('section') === 'skills' ? 'skills' : 'queues';
  const pendingKey = `dc:voice-catalog:pending:${identityKey}:${kind}`;
  const [detailId, setDetailId] = useState(initial.searchParams.get('resource'));
  const [items, setItems] = useState<CatalogItem[]>([]),
    [detail, setDetail] = useState<CatalogItem>();
  const [cursor, setCursor] = useState<string | null>(null),
    [caps, setCaps] = useState<Capabilities>(),
    [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string>(),
    [saving, setSaving] = useState(false),
    [saved, setSaved] = useState(false);
  const [name, setName] = useState(''),
    [teamId, setTeamId] = useState(''),
    [code, setCode] = useState('');
  const [pending, setPending] = useState<
    | {
        commandId: string;
        name: string;
        teamId: string;
        code?: string;
      }
    | undefined
  >(() => {
    try {
      const commandId = window.sessionStorage.getItem(pendingKey);
      if (commandId && /^[0-9a-f-]{36}$/.test(commandId))
        return { commandId, name: '', teamId: '' };
    } catch {
      /* storage ปิดอยู่: คง intent ใน memory ของหน้า */
    }
    return undefined;
  });
  function remember(commandId: string | undefined) {
    try {
      if (commandId) window.sessionStorage.setItem(pendingKey, commandId);
      else window.sessionStorage.removeItem(pendingKey);
    } catch {
      /* ไม่เก็บชื่อหรือ payload ลง storage */
    }
  }
  const active = useRef(true),
    generation = useRef(0);
  const message = (failure: unknown) =>
    failure instanceof CatalogApiError
      ? failure.status === 401
        ? 'UNAUTHORIZED'
        : failure.status === 403
          ? 'FORBIDDEN'
          : failure.code
      : 'FAILED';
  const load = useCallback(
    async (more?: string) => {
      const gen = ++generation.current;
      setLoading(true);
      setError(undefined);
      try {
        const [cap, ts, list, result] = await Promise.all([
          api.capabilities(),
          api.teams(),
          api.list(kind, more),
          detailId ? api.detail(kind, detailId) : Promise.resolve(undefined),
        ]);
        if (!active.current || gen !== generation.current) return;
        setCaps(cap);
        setTeams(ts.items);
        setItems((old) => (more ? [...old, ...list.items] : list.items));
        setCursor(list.nextCursor);
        setDetail(result);
      } catch (e) {
        if (active.current && gen === generation.current) {
          setError(message(e));
          if (e instanceof CatalogApiError && [401, 403].includes(e.status)) {
            setItems([]);
            setCaps(undefined);
            setTeams([]);
            setDetail(undefined);
            setCursor(null);
          }
        }
      } finally {
        if (active.current && gen === generation.current) setLoading(false);
      }
    },
    [api, kind, detailId],
  );
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      ++generation.current;
    };
  }, [load]);
  function open(id?: string) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('resource', id);
    else url.searchParams.delete('resource');
    window.history.replaceState(null, '', url);
    setDetailId(id ?? null);
    setDetail(undefined);
  }
  async function readback(item: CatalogItem) {
    if (!active.current) return;
    const result = await api.detail(kind, item.id);
    if (!active.current) return;
    setDetail(result);
    setDetailId(item.id);
    const url = new URL(window.location.href);
    url.searchParams.set('resource', item.id);
    window.history.replaceState(null, '', url);
    remember(undefined);
    setPending(undefined);
    setSaved(true);
    setName('');
    setCode('');
  }
  async function create() {
    if (saving || pending) return;
    const normalized = name.trim().replace(/\s+/gu, ' ');
    if (
      !teamId ||
      /[\p{Cc}\p{Cf}]/u.test(name) ||
      !normalized ||
      Array.from(normalized).length > 120 ||
      (kind === 'skills' && !/^[A-Z][A-Z0-9_]{1,39}$/.test(code))
    ) {
      setError('VALIDATION_FAILED');
      return;
    }
    const intent = {
      commandId: crypto.randomUUID(),
      name: normalized,
      teamId,
      ...(kind === 'skills' ? { code } : {}),
    };
    remember(intent.commandId);
    setSaving(true);
    setPending(intent);
    setError(undefined);
    setSaved(false);
    let accepted = false;
    try {
      const result = await api.create(kind, intent);
      accepted = true;
      await readback(result);
    } catch (e) {
      if (active.current) {
        const definite =
          !accepted &&
          e instanceof CatalogApiError &&
          ((e.status < 500 && e.status !== 401 && e.status !== 408) ||
            (e.status === 503 &&
              ['RESOURCE_POLICY_NOT_READY', 'CAPABILITY_NOT_READY'].includes(e.code)));
        setError(message(e));
        if (definite) {
          remember(undefined);
          setPending(undefined);
        }
      }
    } finally {
      if (active.current) setSaving(false);
    }
  }
  async function recover() {
    if (!pending || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const receipt = await api.command(pending.commandId);
      await readback(receipt.result);
    } catch (e) {
      if (active.current) setError(message(e));
    } finally {
      if (active.current) setSaving(false);
    }
  }
  if (!tokens) return null;
  const capKey = kind === 'queues' ? 'voiceQueues' : 'skills';
  const quota = caps?.limits?.[capKey];
  return (
    <section className="vr-root" aria-busy={loading || saving}>
      <h1>{t('title')}</h1>
      <h2>{t(kind)}</h2>
      <p>{t('inactiveNotice')}</p>
      {loading ? <p role="status">{t('loading')}</p> : null}
      {error ? (
        <section role="alert">
          <p>{t(`errors.${error}`, { defaultValue: t('errors.FAILED') })}</p>
          {error === 'UNAUTHORIZED' && onSignIn ? (
            <Button onPress={onSignIn}>{t('signIn')}</Button>
          ) : null}
          <Button onPress={() => void load()} isDisabled={saving}>
            {t('retry')}
          </Button>
        </section>
      ) : null}
      {caps ? (
        <p>
          {t('policy', {
            revision: caps.policyRevision ?? t('unavailable'),
            source: caps.sourceKind
              ? t(`sources.${caps.sourceKind}`, { defaultValue: t('unavailable') })
              : t('unavailable'),
          })}
        </p>
      ) : null}
      {quota ? <p>{t('quota', quota)}</p> : null}
      {caps && !caps.configuration.ready ? (
        <p role="status">
          {caps.configuration.reasons
            .map((r) => t(`errors.${r}`, { defaultValue: t('errors.FAILED') }))
            .join(' ')}
        </p>
      ) : null}
      {pending ? (
        <section role="status">
          <p>{saving ? t('saving') : t('unknown')}</p>
          <Button isDisabled={saving} onPress={() => void recover()}>
            {t('checkResult')}
          </Button>
        </section>
      ) : null}
      {saved ? <p role="status">{t('saved')}</p> : null}
      {detail ? (
        <article>
          <h3>{detail.name}</h3>
          <p>
            {t('resourceId')}: {detail.id}
          </p>
          <p>
            {t('team')}: {teams.find((team) => team.id === detail.teamId)?.name ?? t('unavailable')}
          </p>
          <p>
            {t('revision')}: {detail.configRevision ?? detail.revision}
          </p>
          {detail.code ? (
            <p>
              {t('code')}: {detail.code}
            </p>
          ) : null}
          <p>{detail.legacy ? t('legacy') : t('managed')}</p>
          {kind === 'queues' ? (
            <p>
              {t('queuePolicy')}: {detail.policy?.offerTimeoutSec ?? t('unavailable')} /{' '}
              {detail.policy?.maxTotalPreanswerSec ?? t('unavailable')} /{' '}
              {detail.policy?.terminalAction === 'HANGUP' ? t('hangup') : t('unavailable')} —{' '}
              {t(detail.isActive ? 'active' : 'inactive')}
            </p>
          ) : null}
          <Button onPress={() => open()}>{t('back')}</Button>
        </article>
      ) : null}
      {!detailId ? (
        <>
          {caps?.canWrite ? (
            <section aria-label={t('create')} className="vr-form">
              <TextField
                label={t('name')}
                value={name}
                onChange={setName}
                isDisabled={saving || !!pending}
              />
              {kind === 'skills' ? (
                <TextField
                  label={t('code')}
                  value={code}
                  onChange={setCode}
                  isDisabled={saving || !!pending}
                />
              ) : null}
              <Select
                label={t('team')}
                selectedKey={teamId || null}
                onSelectionChange={(key) => setTeamId(String(key ?? ''))}
                placeholder={t('chooseTeam')}
                options={teams.map((team) => ({ id: team.id, label: team.name }))}
                isDisabled={saving || !!pending}
              />
              <Button
                onPress={() => void create()}
                isDisabled={
                  saving ||
                  !!pending ||
                  loading ||
                  !caps.configuration.ready ||
                  (!!quota && quota.used >= quota.limit)
                }
              >
                {t('create')}
              </Button>
            </section>
          ) : caps ? (
            <p>{t('readOnly')}</p>
          ) : null}
          {!loading && items.length === 0 ? <p>{t('empty')}</p> : null}
          {items.length ? (
            <Table aria-label={t('catalog')}>
              <TableHeader>
                <Column isRowHeader>{t('name')}</Column>
                <Column>{t('team')}</Column>
                <Column>{t('state')}</Column>
                <Column>{t('open')}</Column>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <Row key={item.id} id={item.id}>
                    <Cell>{item.name}</Cell>
                    <Cell>
                      {teams.find((team) => team.id === item.teamId)?.name ?? t('unavailable')}
                    </Cell>
                    <Cell>{item.legacy ? t('legacy') : t('managed')}</Cell>
                    <Cell>
                      <Button onPress={() => open(item.id)}>
                        {t('openResource', { name: item.name })}
                      </Button>
                    </Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {cursor ? (
            <Button isDisabled={loading} onPress={() => void load(cursor)}>
              {t('more')}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
