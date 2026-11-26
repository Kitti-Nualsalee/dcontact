/**
 * #936 Not Ready reasons settings page in Core Settings (docs/agent-readiness-setup.md, owner decision item 4)
 * edit the whole list and save once (PUT not-ready-reasons) — the order in the table = the order Agents see
 * a reason that has been used cannot be deleted, only disabled, and at least one reason must stay enabled
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Badge, Button, Switch, TextField } from '@d-contact/ui-react';
import { ConsoleShell } from '../shell/console-shell.js';
import { useShellTokens } from '../shell/tokens.js';
import {
  CoreApiError,
  type CoreCapabilities,
  type NotReadyReason,
  type NotReadyReasonDraft,
  type NotReadyReasons,
} from './api.js';
import type { CoreSettingsProps } from './core-settings-page.js';
import { CorePageLinks } from './page-links.js';

interface Row extends NotReadyReasonDraft {
  /** React row key — a new reason has no code yet */
  key: string;
  inUse: boolean;
}
type Status =
  | 'LOADING'
  | 'READY'
  | 'SAVING'
  | 'SAVED'
  | 'NO_CHANGE'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'IN_USE'
  | 'ACCESS_DENIED'
  | 'FAILED';

const LABEL_MAX = 40;
const LIMIT = 30;

const toRows = (snapshot: NotReadyReasons): Row[] =>
  snapshot.reasons.map((reason: NotReadyReason) => ({
    key: reason.code,
    code: reason.code,
    labelTh: reason.labelTh,
    labelEn: reason.labelEn,
    isActive: reason.isActive,
    inUse: reason.inUse,
  }));
const toDraft = ({ code, labelTh, labelEn, isActive }: Row): NotReadyReasonDraft => ({
  ...(code ? { code } : {}),
  labelTh: labelTh.trim(),
  labelEn: labelEn.trim(),
  isActive,
});
const sameDrafts = (a: Row[], b: Row[]) =>
  JSON.stringify(a.map(toDraft)) === JSON.stringify(b.map(toDraft));

export function CoreNotReadyReasonsPage({
  api,
  shell,
  signedIn,
  onPageSelect,
  registerLeaveGuard,
}: CoreSettingsProps) {
  const { t: translate } = useTranslation('coreSettings');
  const t = translate as (key: string, values?: Record<string, unknown>) => string;
  const tokens = useShellTokens();
  const [caps, setCaps] = useState<CoreCapabilities>();
  const [saved, setSaved] = useState<NotReadyReasons>();
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<Status>('LOADING');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [blocked, setBlocked] = useState<string[]>([]);
  const [failedOn, setFailedOn] = useState<'load' | 'save'>('load');
  // resend with the same commandId when the draft is unchanged (e.g. network dropped after pressing save) — the server answers with the original result without saving again
  const attempt = useRef<{ commandId: string; body: string } | undefined>(undefined);
  const statusRef = useRef<HTMLDivElement>(null);
  const nextKey = useRef(0);
  // each load or save bumps this; a read that answers after a newer one started must not replace the rows
  // (React StrictMode runs the load effect twice, and a late first reply would overwrite the draft typed since)
  const generation = useRef(0);

  const baseline = saved ? toRows(saved) : [];
  const dirty = saved !== undefined && !sameDrafts(rows, baseline);
  const writable = caps?.notReadyReasons?.write === true;

  const load = async () => {
    const run = (generation.current += 1);
    setStatus('LOADING');
    try {
      const [capabilities, snapshot] = await Promise.all([
        api.capabilities(),
        api.notReadyReasons.read(),
      ]);
      if (run !== generation.current) return;
      setCaps(capabilities);
      setSaved(snapshot);
      setRows(toRows(snapshot));
      setFieldErrors({});
      setBlocked([]);
      setStatus('READY');
    } catch (error) {
      if (run !== generation.current) return;
      setFailedOn('load');
      setStatus(error instanceof CoreApiError && error.status === 403 ? 'ACCESS_DENIED' : 'FAILED');
    }
  };
  useEffect(() => {
    void load();
    // reload only when the sign-in changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);
  useEffect(
    () => registerLeaveGuard?.(() => !dirty || window.confirm(t('discard'))),
    [registerLeaveGuard, dirty, t],
  );
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  useEffect(() => {
    if (status !== 'LOADING' && status !== 'READY' && status !== 'SAVING')
      statusRef.current?.focus();
  }, [status]);

  const update = (key: string, patch: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    if (status !== 'SAVING') setStatus('READY');
  };
  const move = (index: number, offset: -1 | 1) => {
    setRows((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    window.requestAnimationFrame(() =>
      document.getElementById(`nrr-move-${offset < 0 ? 'up' : 'down'}-${index + offset}`)?.focus(),
    );
  };
  const remove = (key: string) => setRows((current) => current.filter((row) => row.key !== key));
  const add = () => {
    const key = `new-${(nextKey.current += 1)}`;
    setRows((current) => [
      ...current,
      { key, labelTh: '', labelEn: '', isActive: true, inUse: false },
    ]);
    window.requestAnimationFrame(() => document.getElementById(`nrr-th-${key}`)?.focus());
  };

  const save = async () => {
    if (!saved) return;
    const reasons = rows.map(toDraft);
    const body = JSON.stringify({ expectedRevision: saved.revision, reasons });
    if (attempt.current?.body !== body) attempt.current = { commandId: crypto.randomUUID(), body };
    // a read still in flight is older than this save's result
    generation.current += 1;
    setStatus('SAVING');
    setFieldErrors({});
    setBlocked([]);
    try {
      const receipt = await api.notReadyReasons.save({
        commandId: attempt.current.commandId,
        expectedRevision: saved.revision,
        reasons,
      });
      attempt.current = undefined;
      const snapshot = receipt.command.resourceSnapshot ?? (await api.notReadyReasons.read());
      setSaved(snapshot);
      setRows(toRows(snapshot));
      setStatus(receipt.command.outcome === 'NO_OP' ? 'NO_CHANGE' : 'SAVED');
    } catch (error) {
      setFailedOn('save');
      if (!(error instanceof CoreApiError)) {
        setStatus('FAILED');
        return;
      }
      attempt.current = error.status >= 500 || error.status === 0 ? attempt.current : undefined;
      if (error.code === 'VALIDATION_FAILED') {
        setFieldErrors(error.fieldErrors ?? {});
        setStatus('VALIDATION');
      } else if (error.code === 'REVISION_CONFLICT') setStatus('CONFLICT');
      else if (error.code === 'NOT_READY_REASON_IN_USE') {
        setBlocked(error.receipt?.command.error?.blockers?.map((b) => b.kind) ?? []);
        setStatus('IN_USE');
      } else if (error.status === 403) setStatus('ACCESS_DENIED');
      else setStatus('FAILED');
    }
  };

  const errorFor = (index: number, field: 'labelTh' | 'labelEn') => {
    const key = fieldErrors[`reasons.${index}.${field}`];
    return key ? t(`notReadyReasons.validation.${key.split('.').pop()}`) : undefined;
  };
  const activeCount = rows.filter((row) => row.isActive).length;
  const labelOf = (code: string) => {
    const row = baseline.find((r) => r.code === code);
    return row ? `${row.labelTh} (${row.labelEn})` : code;
  };

  return (
    <ConsoleShell
      {...shell}
      appId="core-settings"
      pageId="not-ready-reasons"
      onPageSelect={onPageSelect}
    >
      {!tokens ? (
        <main aria-busy="true">{t('status.LOADING')}</main>
      ) : (
        <main className="core-settings">
          <CorePageLinks
            tenant={shell.tenantAlias}
            teams={!!caps?.teams?.read}
            notReadyReasons
            t={t}
            onSelect={onPageSelect}
          />
          <header>
            <p className="core-settings__eyebrow">{t('eyebrow')}</p>
            <h1 tabIndex={-1}>{t('notReadyReasons.title')}</h1>
            <p>{t('notReadyReasons.intro')}</p>
          </header>
          <div className="core-settings__layout">
            <section className="core-settings__panel nrr" aria-labelledby="nrr-heading">
              <h2 id="nrr-heading">{t('notReadyReasons.listTitle')}</h2>
              <div
                ref={statusRef}
                tabIndex={-1}
                role={
                  status === 'VALIDATION' || status === 'IN_USE' || status === 'CONFLICT'
                    ? 'alert'
                    : 'status'
                }
                aria-live="polite"
                aria-atomic="true"
                className="core-settings__status"
              >
                {status === 'IN_USE'
                  ? t('notReadyReasons.status.IN_USE', { reasons: blocked.map(labelOf).join(', ') })
                  : status === 'VALIDATION' && fieldErrors.reasons
                    ? t('notReadyReasons.validation.notReadyReasonActiveRequired')
                    : t(`notReadyReasons.status.${status}`)}
              </div>
              {status === 'CONFLICT' || status === 'FAILED' ? (
                <div className="core-settings__actions">
                  <Button
                    onPress={() =>
                      status === 'CONFLICT' || failedOn === 'load' ? void load() : void save()
                    }
                  >
                    {t(
                      status === 'CONFLICT'
                        ? 'loadLatest'
                        : failedOn === 'load'
                          ? 'retry'
                          : 'notReadyReasons.retrySave',
                    )}
                  </Button>
                </div>
              ) : null}
              {saved && caps && !writable ? <p>{t('readOnly')}</p> : null}
              {saved ? (
                <ol className="nrr-list" aria-label={t('notReadyReasons.listTitle')}>
                  {rows.map((row, index) => (
                    <li key={row.key} className={row.isActive ? 'nrr-row' : 'nrr-row nrr-row-off'}>
                      <span className="nrr-order" aria-hidden="true">
                        {index + 1}
                      </span>
                      {writable ? (
                        <>
                          <div className="nrr-fields">
                            <TextField
                              id={`nrr-th-${row.key}`}
                              label={t('notReadyReasons.labelTh')}
                              value={row.labelTh}
                              maxLength={LABEL_MAX}
                              isRequired
                              isInvalid={!!errorFor(index, 'labelTh')}
                              errorMessage={errorFor(index, 'labelTh')}
                              onChange={(value) => update(row.key, { labelTh: value })}
                            />
                            <TextField
                              label={t('notReadyReasons.labelEn')}
                              value={row.labelEn}
                              maxLength={LABEL_MAX}
                              isRequired
                              isInvalid={!!errorFor(index, 'labelEn')}
                              errorMessage={errorFor(index, 'labelEn')}
                              onChange={(value) => update(row.key, { labelEn: value })}
                            />
                          </div>
                          <div className="nrr-controls">
                            <Switch
                              isSelected={row.isActive}
                              onChange={(isActive) => update(row.key, { isActive })}
                              aria-label={t('notReadyReasons.activeFor', {
                                reason: row.labelTh || row.labelEn || index + 1,
                              })}
                            >
                              {t(
                                row.isActive
                                  ? 'notReadyReasons.active'
                                  : 'notReadyReasons.inactive',
                              )}
                            </Switch>
                            <Button
                              id={`nrr-move-up-${index}`}
                              variant="ghost"
                              size="sm"
                              isDisabled={index === 0}
                              aria-label={t('notReadyReasons.moveUp', {
                                reason: row.labelTh || index + 1,
                              })}
                              onPress={() => move(index, -1)}
                            >
                              ↑
                            </Button>
                            <Button
                              id={`nrr-move-down-${index}`}
                              variant="ghost"
                              size="sm"
                              isDisabled={index === rows.length - 1}
                              aria-label={t('notReadyReasons.moveDown', {
                                reason: row.labelTh || index + 1,
                              })}
                              onPress={() => move(index, 1)}
                            >
                              ↓
                            </Button>
                            {row.inUse ? (
                              <Badge tone="neutral">{t('notReadyReasons.inUse')}</Badge>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t('notReadyReasons.remove', {
                                  reason: row.labelTh || index + 1,
                                })}
                                onPress={() => remove(row.key)}
                              >
                                {t('notReadyReasons.removeShort')}
                              </Button>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="nrr-fields nrr-readonly">
                          <span>{row.labelTh}</span>
                          <span className="nrr-en">{row.labelEn}</span>
                          <Badge tone={row.isActive ? 'success' : 'neutral'}>
                            {t(
                              row.isActive ? 'notReadyReasons.active' : 'notReadyReasons.inactive',
                            )}
                          </Badge>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : null}
              {writable && saved ? (
                <div className="core-settings__actions">
                  <Button isDisabled={rows.length >= LIMIT || status === 'SAVING'} onPress={add}>
                    {t('notReadyReasons.add')}
                  </Button>
                  <Button
                    variant="primary"
                    isDisabled={!dirty || status === 'SAVING' || activeCount === 0}
                    onPress={() => void save()}
                  >
                    {t('save')}
                  </Button>
                  <Button
                    variant="ghost"
                    isDisabled={!dirty || status === 'SAVING'}
                    onPress={() => {
                      setRows(baseline);
                      setFieldErrors({});
                      setStatus('READY');
                    }}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              ) : null}
              {writable && saved && activeCount === 0 ? (
                <p className="nrr-hint" role="alert">
                  {t('notReadyReasons.validation.notReadyReasonActiveRequired')}
                </p>
              ) : null}
            </section>
            <aside className="core-settings__help">
              <h2>{t('notReadyReasons.helpTitle')}</h2>
              <ul>
                <li>{t('notReadyReasons.help.order')}</li>
                <li>{t('notReadyReasons.help.disable')}</li>
                <li>{t('notReadyReasons.help.inUse')}</li>
                <li>{t('notReadyReasons.help.atLeastOne')}</li>
              </ul>
            </aside>
          </div>
        </main>
      )}
    </ConsoleShell>
  );
}
