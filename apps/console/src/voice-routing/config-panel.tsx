import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Select, TextField } from '@d-contact/ui-react';
import { CatalogApiError, type Capabilities, type CatalogItem } from './api.js';
import type {
  ConfigApi,
  Destination,
  Eligibility,
  ManagedRuntime,
  RosterUser,
  SkillSet,
} from './config-api.js';

type Mode = 'requirements' | 'agentSkills' | 'destinations';
interface Props {
  api: ConfigApi;
  identityKey: string;
  mode: Mode;
  queue?: CatalogItem;
  onQueueRead?(queue: CatalogItem): void;
}
interface Pending {
  commandId: string;
  target: string;
}
function restore(key: string): Pending | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (value && /^[0-9a-f-]{36}$/.test(value.commandId) && /^[0-9a-f-]{36}$/.test(value.target))
      return value;
  } catch {}
  return undefined;
}
async function allPages<Item>(
  load: (cursor?: string) => Promise<{ items: Item[]; nextCursor: string | null }>,
) {
  const items: Item[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    if (page.nextCursor && seen.has(page.nextCursor)) throw new CatalogApiError(502, 'FAILED');
    cursor = page.nextCursor ?? undefined;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}
export function ConfigPanel(props: Props) {
  return (
    <ConfigSession key={`${props.identityKey}:${props.mode}:${props.queue?.id ?? ''}`} {...props} />
  );
}
function ConfigSession({ api, identityKey, mode, queue, onQueueRead }: Props) {
  const { t: translate } = useTranslation('voiceRouting');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const key = `dc:voice-config:${identityKey}:${mode}:${queue?.id ?? ''}`;
  const [pending, setPending] = useState(() => restore(key));
  const [caps, setCaps] = useState<Capabilities>();
  const [skills, setSkills] = useState<CatalogItem[]>([]);
  const [queues, setQueues] = useState<CatalogItem[]>([]);
  const [users, setUsers] = useState<RosterUser[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [target, setTarget] = useState(() => restore(key)?.target ?? queue?.id ?? '');
  const [bindingQueue, setBindingQueue] = useState('');
  const [bindingActive, setBindingActive] = useState(false);
  const [currentQueue, setCurrentQueue] = useState(queue);
  const [runtime, setRuntime] = useState<ManagedRuntime>();
  const [set, setSet] = useState<SkillSet>();
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [eligibility, setEligibility] = useState<Eligibility>();
  const [agentQueues, setAgentQueues] = useState<{ name: string; result: Eligibility }[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const active = useRef(true);
  const locked = useRef(false);
  const generation = useRef(0);
  const kind = mode === 'requirements' ? 'queues' : 'people/users';
  function remember(value: Pending | undefined) {
    if (!active.current) return;
    setPending(value);
    try {
      if (value) sessionStorage.setItem(key, JSON.stringify(value));
      else sessionStorage.removeItem(key);
    } catch {}
  }
  function failure(value: unknown) {
    if (!active.current) return;
    setError(value instanceof CatalogApiError ? value.code : 'FAILED');
    if (value instanceof CatalogApiError && [401, 403].includes(value.status)) {
      setCaps(undefined);
      setSkills([]);
      setQueues([]);
      setUsers([]);
      setDestinations([]);
      setSet(undefined);
      setEligibility(undefined);
      setAgentQueues([]);
      setCurrentQueue(undefined);
      setRuntime(undefined);
    }
  }
  async function read(id: string) {
    if (mode === 'destinations') {
      const values = await allPages((cursor) => api.destinations(cursor));
      const value = values.find((item) => item.id === id);
      if (!value) throw new CatalogApiError(404, 'RESOURCE_NOT_FOUND');
      return { destinations: values, queueId: value.queueId ?? '', isActive: value.isActive };
    }
    const value = await api.skills(kind, id);
    const result = mode === 'requirements' ? await api.eligibility(id) : undefined;
    const queueValue = mode === 'requirements' ? await api.queue(id) : undefined;
    const runtimeValue =
      mode === 'requirements' ? await api.runtime(id).catch(() => undefined) : undefined;
    const agentResults =
      mode === 'agentSkills'
        ? await Promise.all(
            (await allPages((cursor) => api.catalog('queues', cursor)))
              .filter((item) => !item.legacy && item.voiceConfigVersion === 1)
              .map(async (item) => ({ name: item.name, result: await api.eligibility(item.id) })),
          )
        : [];
    return { value, result, agentResults, queueValue, runtimeValue };
  }
  function apply(result: Awaited<ReturnType<typeof read>>) {
    if (!active.current) return;
    if (result.destinations !== undefined) {
      setDestinations(result.destinations);
      setBindingQueue(result.queueId);
      setBindingActive(result.isActive);
    } else {
      setSet(result.value);
      setLevels(
        Object.fromEntries(
          result.value.items.map((item) => [item.skillId, item.minLevel ?? item.level ?? 0]),
        ),
      );
      setEligibility(result.result);
      setAgentQueues(result.agentResults);
      if (result.queueValue) {
        setCurrentQueue(result.queueValue);
        onQueueRead?.(result.queueValue);
        setRuntime(result.runtimeValue);
      }
    }
  }
  async function load() {
    const current = ++generation.current;
    setBusy(true);
    setError(undefined);
    setSet(undefined);
    setEligibility(undefined);
    setAgentQueues([]);
    setSaved(false);
    try {
      const [capabilities, catalog, queueItems, roster, destinationItems] = await Promise.all([
        api.capabilities(),
        mode !== 'destinations'
          ? allPages((cursor) => api.catalog('skills', cursor))
          : Promise.resolve([]),
        mode === 'destinations'
          ? allPages((cursor) => api.catalog('queues', cursor))
          : Promise.resolve([]),
        mode === 'agentSkills' ? allPages((cursor) => api.roster(cursor)) : Promise.resolve([]),
        mode === 'destinations'
          ? allPages((cursor) => api.destinations(cursor))
          : Promise.resolve([]),
      ]);
      const result = target ? await read(target) : undefined;
      if (!active.current || current !== generation.current) return;
      setCaps(capabilities);
      setSkills(catalog);
      setQueues(queueItems);
      setUsers(roster);
      setDestinations(destinationItems);
      if (result) apply(result);
    } catch (value) {
      if (current === generation.current) failure(value);
    } finally {
      if (active.current && current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      ++generation.current;
    };
  }, [api, target]);
  const destination = destinations.find((item) => item.id === target);
  const teamId =
    mode === 'requirements' ? queue?.teamId : users.find((item) => item.id === target)?.teamId;
  const revision = mode === 'destinations' ? destination?.configRevision : set?.configRevision;
  const disabled =
    busy || !!pending || !caps?.canWrite || !caps.configuration.ready || !revision || !!error;
  async function save(activation = false) {
    if (disabled || locked.current || !target) return;
    if (activation && !currentQueue?.isActive && !caps?.managedRouting.ready) return;
    if (mode === 'destinations' && bindingActive && !caps?.managedRouting.ready) return;
    if (!reason.trim() || reason.trim().length > 500 || /[\p{Cc}\p{Cf}]/u.test(reason)) {
      setError('VALIDATION_FAILED');
      return;
    }
    const intent = { commandId: crypto.randomUUID(), target };
    const envelope = {
      commandId: intent.commandId,
      expectedRevision: activation ? currentQueue!.configRevision! : revision!,
      reasonCode: 'ADMIN_CONFIGURATION',
      reason: reason.trim(),
    };
    locked.current = true;
    remember(intent);
    setBusy(true);
    setSaved(false);
    setError(undefined);
    let accepted = false;
    try {
      if (mode === 'destinations')
        await api.bind(target, { ...envelope, queueId: bindingQueue, isActive: bindingActive });
      else if (activation)
        await api.queue(target, { ...envelope, isActive: !currentQueue?.isActive });
      else
        await api.replace(kind, target, {
          ...envelope,
          items: Object.entries(levels)
            .filter(([, level]) => level > 0)
            .map(([skillId, level]) => ({
              skillId,
              ...(mode === 'requirements' ? { minLevel: level } : { level }),
            })),
        });
      accepted = true;
      const result = await read(target);
      if (!active.current) return;
      apply(result);
      remember(undefined);
      setSaved(true);
    } catch (value) {
      if (
        !accepted &&
        value instanceof CatalogApiError &&
        ([400, 403, 404, 409, 429].includes(value.status) ||
          (value.status === 503 &&
            ['RESOURCE_POLICY_NOT_READY', 'CAPABILITY_NOT_READY'].includes(value.code))) &&
        !['COMMAND_PAYLOAD_MISMATCH', 'COMMAND_ID_REUSED'].includes(value.code)
      )
        remember(undefined);
      failure(value);
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function recover() {
    if (!pending || busy || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api.command(pending.commandId);
      if (receipt.state !== 'SUCCEEDED') throw new CatalogApiError(502, 'FAILED');
      const result = await read(pending.target);
      if (!active.current) return;
      apply(result);
      remember(undefined);
      setSaved(true);
    } catch (value) {
      failure(value);
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="vr-form" aria-label={t(`config.${mode}`)} aria-busy={busy}>
      <h2>{t(`config.${mode}`)}</h2>
      {mode !== 'agentSkills' && caps ? (
        <section aria-label={t('activation.title')}>
          <h3>{t('activation.title')}</h3>
          <p>{t('activation.fixedPolicy')}</p>
          <p role="status">
            {t(caps.managedRouting.ready ? 'activation.ready' : 'activation.blocked')}
          </p>
          {caps.managedRouting.reasons.map((code) => (
            <p key={code}>{t(`errors.${code}`, { defaultValue: code })}</p>
          ))}
          {runtime ? (
            <>
              <p>{t(runtime.ready ? 'activation.ready' : 'activation.blocked')}</p>
              {runtime.reasons.map((code) => (
                <p key={code}>{t(`errors.${code}`, { defaultValue: code })}</p>
              ))}
              <p>
                {t('config.evaluated', {
                  revision: runtime.configRevision,
                  at: runtime.evaluatedAt,
                })}
              </p>
              <p>
                {t('activation.terminal')}:{' '}
                {runtime.terminal
                  ? `${t(`activation.terminalReasons.${runtime.terminal.reason}`, { defaultValue: t('activation.terminalReasons.UNKNOWN') })} · ${runtime.terminal.occurredAt}`
                  : t('activation.noTerminal')}
              </p>
              {runtime.terminal?.teardownState ? (
                <p>
                  {t(`activation.teardown.${runtime.terminal.teardownState}`, {
                    defaultValue: t('activation.teardown.PENDING'),
                  })}
                </p>
              ) : null}
            </>
          ) : mode === 'requirements' && !busy ? (
            <p>{t('activation.runtimeUnavailable')}</p>
          ) : null}
        </section>
      ) : null}
      {busy ? <p role="status">{t('loading')}</p> : null}
      {error ? (
        <p role="alert">{t(`errors.${error}`, { defaultValue: t('errors.FAILED') })}</p>
      ) : null}
      <Button onPress={() => void load()} isDisabled={busy}>
        {t('retry')}
      </Button>
      {caps && !caps.canWrite ? <p>{t('readOnly')}</p> : null}
      {pending ? (
        <>
          <p role="status">{t('unknown')}</p>
          <Button onPress={() => void recover()} isDisabled={busy}>
            {t('checkResult')}
          </Button>
        </>
      ) : null}
      {saved ? <p role="status">{t('saved')}</p> : null}
      {mode !== 'requirements' ? (
        <Select
          label={t(`config.${mode === 'agentSkills' ? 'agent' : 'destination'}`)}
          selectedKey={target || null}
          onSelectionChange={(value) => setTarget(String(value ?? ''))}
          isDisabled={busy || !!pending}
          options={
            mode === 'agentSkills'
              ? users
                  .filter((user) => user.role === 'AGENT')
                  .map((user) => ({ id: user.id, label: user.displayName }))
              : destinations.map((item) => ({ id: item.id, label: item.destination }))
          }
        />
      ) : null}
      {target && !busy && caps ? (
        <>
          <p>
            {t('revision')}: {revision ?? t('unavailable')}
          </p>
          {mode === 'agentSkills' ? <p>{t('config.pendingNotice')}</p> : null}
          {mode === 'destinations' ? (
            <>
              <p>{t(destination?.isActive ? 'active' : 'inactive')}</p>
              <Select
                label={t('queues')}
                selectedKey={bindingQueue || null}
                onSelectionChange={(value) => setBindingQueue(String(value ?? ''))}
                isDisabled={disabled}
                options={queues
                  .filter((item) => !item.legacy && item.voiceConfigVersion === 1)
                  .map((item) => ({ id: item.id, label: item.name }))}
              />
              <Select
                label={t('activation.bindingState')}
                selectedKey={String(bindingActive)}
                onSelectionChange={(value) => setBindingActive(value === 'true')}
                isDisabled={disabled}
                options={[
                  { id: 'false', label: t('inactive') },
                  ...(caps.managedRouting.ready || bindingActive
                    ? [{ id: 'true', label: t('active') }]
                    : []),
                ]}
              />
            </>
          ) : (
            skills
              .filter((skill) => skill.teamId === teamId && !skill.legacy)
              .map((skill) => (
                <Select
                  key={skill.id}
                  label={skill.name}
                  selectedKey={String(levels[skill.id] ?? 0)}
                  onSelectionChange={(value) =>
                    setLevels((old) => ({ ...old, [skill.id]: Number(value) }))
                  }
                  isDisabled={disabled}
                  options={[0, 1, 2, 3, 4, 5].map((level) => ({
                    id: String(level),
                    label: level === 0 ? t('config.unassigned') : t('config.level', { level }),
                  }))}
                />
              ))
          )}
          {caps.canWrite ? (
            <>
              <TextField
                label={t('config.reason')}
                value={reason}
                onChange={setReason}
                isDisabled={busy || !!pending}
              />
              <Button
                onPress={() => void save()}
                isDisabled={
                  disabled ||
                  !reason.trim() ||
                  (mode === 'destinations' &&
                    (!bindingQueue || (bindingActive && !caps.managedRouting.ready)))
                }
              >
                {t('config.save')}
              </Button>
              {mode === 'requirements' && currentQueue ? (
                <>
                  <p>{t(currentQueue.isActive ? 'active' : 'inactive')}</p>
                  {!currentQueue.isActive && !set?.items.length ? (
                    <p role="status">{t('activation.skillsRequired')}</p>
                  ) : null}
                  <Button
                    onPress={() => void save(true)}
                    isDisabled={
                      disabled ||
                      !reason.trim() ||
                      !currentQueue.configRevision ||
                      (!currentQueue.isActive && (!caps.managedRouting.ready || !set?.items.length))
                    }
                  >
                    {t(
                      currentQueue.isActive
                        ? 'activation.deactivateQueue'
                        : 'activation.activateQueue',
                    )}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          {eligibility ? (
            <section aria-label={t('config.eligibility')}>
              <h3>{t('config.eligibility')}</h3>
              <p>
                {t('config.evaluated', {
                  revision: eligibility.configRevision,
                  at: eligibility.evaluatedAt,
                })}
              </p>
              {eligibility.warnings.map((warning) => (
                <p role="status" key={warning}>
                  {t(`config.reasons.${warning}`, { defaultValue: t('unavailable') })}
                </p>
              ))}
              {eligibility.candidates.length === 0 ? (
                <p>{t('empty')}</p>
              ) : (
                eligibility.candidates.map((candidate) => (
                  <p key={candidate.userId}>
                    {candidate.displayName}:{' '}
                    {t(
                      candidate.eligible && candidate.available
                        ? 'config.eligible'
                        : 'config.notEligible',
                    )}{' '}
                    {candidate.reasons
                      .map((reason) =>
                        t(`config.reasons.${reason}`, { defaultValue: t('unavailable') }),
                      )
                      .join(' · ')}
                  </p>
                ))
              )}
            </section>
          ) : null}
          {mode === 'agentSkills' ? (
            <section aria-label={t('config.eligibility')}>
              <h3>{t('config.eligibility')}</h3>
              {agentQueues.length === 0 ? (
                <p>{t('empty')}</p>
              ) : (
                agentQueues.map(({ name, result }) => {
                  const candidate = result.candidates.find((item) => item.userId === target);
                  return (
                    <p key={name}>
                      {name}:{' '}
                      {t(
                        candidate?.eligible && candidate.available
                          ? 'config.eligible'
                          : 'config.notEligible',
                      )}{' '}
                      {candidate?.reasons
                        .map((reason) =>
                          t(`config.reasons.${reason}`, { defaultValue: t('unavailable') }),
                        )
                        .join(' · ')}{' '}
                      {t('config.evaluated', {
                        revision: result.configRevision,
                        at: result.evaluatedAt,
                      })}
                    </p>
                  );
                })
              )}
            </section>
          ) : null}
        </>
      ) : null}
      {!busy &&
      caps &&
      mode !== 'requirements' &&
      (mode === 'agentSkills'
        ? users.filter((user) => user.role === 'AGENT').length === 0
        : destinations.length === 0) ? (
        <p>{t('empty')}</p>
      ) : null}
    </section>
  );
}
