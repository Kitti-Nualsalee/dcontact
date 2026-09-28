/**
 * E1.11 (#485): Integrations › dphone embedding (E1.5 #461 ข้อ 4)
 *
 * - `ADMIN` เพิ่ม/เปลี่ยนชื่อ/ปิด/เปิด/ลบ origin; `SUPERVISOR` ดูได้อย่างเดียว
 * - ไม่มี entitlement `modules.api.cti` = หน้าล็อกพร้อมข้อความเรื่อง plan
 * - ตรวจรูปแบบ origin ทันทีที่กรอก (กติกาเดียวกับ API) และยืนยันก่อนปิด/ลบพร้อมจำนวน session ที่ฝังอยู่
 * - สิทธิ์จริงอยู่ที่ API ทุก request — role ที่นี่ใช้แค่ซ่อนปุ่ม
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, Dialog, Select, TextField, toastQueue } from '@d-contact/ui-react';
import {
  EmbedOriginApiError,
  type EmbedOrigin,
  type EmbedOriginApi,
  type EmbedOriginList,
  type ScreenPopLevel,
} from './api.js';
import {
  apiErrorKey,
  checkOriginInput,
  hostSnippet,
  SCREEN_POP_OPTIONS,
  SCREEN_POP_REASON_MIN,
} from './model.js';
import { useShellTokens } from '../shell/tokens.js';
import './dphone-embedding.css';

type Confirming = { kind: 'disable' | 'delete'; origin: EmbedOrigin } | null;

export function DphoneEmbedding({
  api,
  canEdit,
  tenantAlias,
  embedBaseUrl,
  dev,
}: {
  api: EmbedOriginApi;
  canEdit: boolean;
  tenantAlias: string;
  embedBaseUrl: string;
  dev: boolean;
}) {
  const { t: translate } = useTranslation('integrations');
  const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
  const headingId = useId();
  const [data, setData] = useState<EmbedOriginList>();
  const [loadError, setLoadError] = useState<string>();
  const [origin, setOrigin] = useState('');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // E1.14: เปลี่ยนระดับ screen-pop ต้องยืนยันพร้อมเหตุผล (audit ที่ API)
  const [screenPop, setScreenPop] = useState<{
    origin: EmbedOrigin;
    level: ScreenPopLevel;
    reason: string;
  } | null>(null);
  // หน้าใหม่ใช้ token ของ D1 ทั้งเมื่อเปิดและปิด shell (แบบเดียวกับ Journeys)
  const tokensReady = useShellTokens();

  const reload = useCallback(async () => {
    try {
      setData(await api.list());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(
        t(
          error instanceof EmbedOriginApiError
            ? apiErrorKey(error)
            : 'dphoneEmbedding.errors.UNKNOWN',
        ),
      );
    }
  }, [api]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (work: () => Promise<unknown>, onError: (message: string) => void) => {
    setPending(true);
    try {
      await work();
      toastQueue.add({ title: t('dphoneEmbedding.saved'), tone: 'success' }, { timeout: 4000 });
      await reload();
      return true;
    } catch (error) {
      onError(
        t(
          error instanceof EmbedOriginApiError
            ? apiErrorKey(error)
            : 'dphoneEmbedding.errors.UNKNOWN',
        ),
      );
      if (error instanceof EmbedOriginApiError && error.code === 'REVISION_CONFLICT')
        await reload();
      return false;
    } finally {
      setPending(false);
    }
  };
  const failToast = (message: string) =>
    toastQueue.add({ title: message, tone: 'critical' }, { timeout: 6000 });

  if (!tokensReady || (!data && !loadError)) {
    return (
      <main className="dphone-embedding" aria-busy="true">
        <p>{t('dphoneEmbedding.loading')}</p>
      </main>
    );
  }

  const check = checkOriginInput(origin, { dev });
  const editable = canEdit && data?.entitled === true;
  const full = (data?.origins.length ?? 0) >= (data?.limit ?? 10);
  const confirmTarget = confirming?.origin;

  return (
    <main className="dphone-embedding" aria-labelledby={headingId}>
      <header className="dphone-embedding__header">
        <p className="dphone-embedding__eyebrow">{t('dphoneEmbedding.eyebrow')}</p>
        <h1 id={headingId}>{t('dphoneEmbedding.title')}</h1>
        <p>{t('dphoneEmbedding.description', { limit: data?.limit ?? 10 })}</p>
      </header>

      {loadError ? (
        <p role="alert" className="dphone-embedding__callout dphone-embedding__callout--critical">
          {loadError}
        </p>
      ) : null}

      {data && !data.entitled ? (
        <section
          className="dphone-embedding__callout dphone-embedding__callout--locked"
          role="status"
        >
          <h2>{t('dphoneEmbedding.locked.title')}</h2>
          <p>{t('dphoneEmbedding.locked.body')}</p>
        </section>
      ) : null}

      {data?.entitled && !data.flagEnabled ? (
        <p className="dphone-embedding__callout" role="status">
          {t('dphoneEmbedding.flagOff')}
        </p>
      ) : null}

      {data?.entitled && !canEdit ? (
        <p className="dphone-embedding__callout" role="status">
          {t('dphoneEmbedding.readOnly')}
        </p>
      ) : null}

      {data?.entitled ? (
        <>
          <table className="dphone-embedding__table">
            <caption>{t('dphoneEmbedding.table.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dphoneEmbedding.table.origin')}</th>
                <th scope="col">{t('dphoneEmbedding.table.label')}</th>
                <th scope="col">{t('dphoneEmbedding.table.status')}</th>
                <th scope="col">{t('dphoneEmbedding.table.sessions')}</th>
                <th scope="col">{t('dphoneEmbedding.table.screenPop')}</th>
                {editable ? <th scope="col">{t('dphoneEmbedding.table.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.origins.length === 0 ? (
                <tr>
                  <td colSpan={editable ? 6 : 5}>{t('dphoneEmbedding.table.empty')}</td>
                </tr>
              ) : (
                data.origins.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.origin}</code>
                    </td>
                    <td>
                      {renaming?.id === row.id ? (
                        <TextField
                          aria-label={t('dphoneEmbedding.form.label')}
                          value={renaming.label}
                          onChange={(value) => setRenaming({ id: row.id, label: value })}
                          maxLength={80}
                        />
                      ) : (
                        row.label
                      )}
                    </td>
                    <td>
                      {row.enabled
                        ? t('dphoneEmbedding.table.enabled')
                        : t('dphoneEmbedding.table.disabled')}
                    </td>
                    <td>{row.activeSessions}</td>
                    <td>{t(`dphoneEmbedding.screenPop.levels.${row.screenPopLevel}.label`)}</td>
                    {editable ? (
                      <td className="dphone-embedding__actions">
                        {renaming?.id === row.id ? (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              isDisabled={pending || !renaming.label.trim()}
                              onPress={() =>
                                void run(
                                  () => api.update(row, { label: renaming.label }),
                                  failToast,
                                ).then((ok) => ok && setRenaming(null))
                              }
                            >
                              {t('dphoneEmbedding.actions.save')}
                            </Button>
                            <Button size="sm" variant="ghost" onPress={() => setRenaming(null)}>
                              {t('dphoneEmbedding.actions.cancel')}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`${t('dphoneEmbedding.actions.rename')} ${row.origin}`}
                              onPress={() => setRenaming({ id: row.id, label: row.label })}
                            >
                              {t('dphoneEmbedding.actions.rename')}
                            </Button>
                            {row.enabled ? (
                              <Button
                                size="sm"
                                aria-label={`${t('dphoneEmbedding.actions.disable')} ${row.origin}`}
                                onPress={() => setConfirming({ kind: 'disable', origin: row })}
                              >
                                {t('dphoneEmbedding.actions.disable')}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                aria-label={`${t('dphoneEmbedding.actions.enable')} ${row.origin}`}
                                isDisabled={pending}
                                onPress={() =>
                                  void run(() => api.update(row, { enabled: true }), failToast)
                                }
                              >
                                {t('dphoneEmbedding.actions.enable')}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`${t('dphoneEmbedding.actions.screenPop')} ${row.origin}`}
                              onPress={() =>
                                setScreenPop({ origin: row, level: row.screenPopLevel, reason: '' })
                              }
                            >
                              {t('dphoneEmbedding.actions.screenPop')}
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              aria-label={`${t('dphoneEmbedding.actions.delete')} ${row.origin}`}
                              onPress={() => setConfirming({ kind: 'delete', origin: row })}
                            >
                              {t('dphoneEmbedding.actions.delete')}
                            </Button>
                          </>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>

          {editable ? (
            <form
              className="dphone-embedding__form"
              aria-label={t('dphoneEmbedding.form.title')}
              onSubmit={(event) => {
                event.preventDefault();
                if (!check?.ok || !label.trim()) return;
                setFormError(undefined);
                void run(
                  () =>
                    api.create({
                      origin: check.origin,
                      label: label.trim(),
                      ...(reason.trim() ? { reason: reason.trim() } : {}),
                    }),
                  setFormError,
                ).then((ok) => {
                  if (!ok) return;
                  setOrigin('');
                  setLabel('');
                  setReason('');
                });
              }}
            >
              <h2>{t('dphoneEmbedding.form.title')}</h2>
              {full ? (
                <p role="status">{t('dphoneEmbedding.form.limitReached', { limit: data.limit })}</p>
              ) : (
                <>
                  <TextField
                    label={t('dphoneEmbedding.form.origin')}
                    value={origin}
                    onChange={setOrigin}
                    isRequired
                    description={
                      check?.ok
                        ? t('dphoneEmbedding.form.normalized', { origin: check.origin })
                        : t('dphoneEmbedding.form.originHint')
                    }
                    isInvalid={check?.ok === false}
                    errorMessage={check && !check.ok ? t(check.messageKey) : undefined}
                    inputMode="url"
                    autoComplete="off"
                  />
                  <TextField
                    label={t('dphoneEmbedding.form.label')}
                    value={label}
                    onChange={setLabel}
                    isRequired
                    maxLength={80}
                  />
                  <TextField
                    label={t('dphoneEmbedding.form.reason')}
                    value={reason}
                    onChange={setReason}
                    maxLength={500}
                  />
                  {formError ? (
                    <p role="alert" className="dphone-embedding__error">
                      {formError}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    variant="primary"
                    isDisabled={pending || !check?.ok || !label.trim()}
                  >
                    {t('dphoneEmbedding.form.submit')}
                  </Button>
                </>
              )}
            </form>
          ) : null}

          <section className="dphone-embedding__snippet" aria-labelledby={`${headingId}-snippet`}>
            <h2 id={`${headingId}-snippet`}>{t('dphoneEmbedding.snippet.title')}</h2>
            <p>{t('dphoneEmbedding.snippet.description')}</p>
            <pre>
              <code>{hostSnippet({ embedBaseUrl, tenantAlias })}</code>
            </pre>
            <Button
              size="sm"
              onPress={() =>
                void navigator.clipboard
                  ?.writeText(hostSnippet({ embedBaseUrl, tenantAlias }))
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
            >
              {copied ? t('dphoneEmbedding.snippet.copied') : t('dphoneEmbedding.snippet.copy')}
            </Button>
          </section>
        </>
      ) : null}

      <Dialog
        isOpen={screenPop !== null}
        onOpenChange={(open) => {
          if (!open) setScreenPop(null);
        }}
        title={t('dphoneEmbedding.screenPop.title', { origin: screenPop?.origin.origin })}
        footer={(close) => (
          <>
            <Button variant="ghost" onPress={close}>
              {t('dphoneEmbedding.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              isDisabled={
                pending ||
                !screenPop ||
                screenPop.level === screenPop.origin.screenPopLevel ||
                screenPop.reason.trim().length < SCREEN_POP_REASON_MIN
              }
              onPress={() => {
                if (!screenPop) return;
                void run(
                  () =>
                    api.update(screenPop.origin, {
                      screenPopLevel: screenPop.level,
                      reason: screenPop.reason.trim(),
                    }),
                  failToast,
                ).then((ok) => ok && close());
              }}
            >
              {t('dphoneEmbedding.screenPop.confirm')}
            </Button>
          </>
        )}
      >
        <p>{t('dphoneEmbedding.screenPop.description')}</p>
        <Select
          label={t('dphoneEmbedding.screenPop.level')}
          selectedKey={screenPop?.level ?? 'off'}
          onSelectionChange={(key) =>
            screenPop && setScreenPop({ ...screenPop, level: key as ScreenPopLevel })
          }
          options={SCREEN_POP_OPTIONS.map((level) => ({
            id: level,
            label: t(`dphoneEmbedding.screenPop.levels.${level}.label`),
            isDisabled: level === 'custom',
          }))}
          description={t(
            `dphoneEmbedding.screenPop.levels.${screenPop?.level ?? 'off'}.description`,
          )}
        />
        <p className="dphone-embedding__hint">{t('dphoneEmbedding.screenPop.governance')}</p>
        <TextField
          label={t('dphoneEmbedding.screenPop.reason')}
          value={screenPop?.reason ?? ''}
          onChange={(value) => screenPop && setScreenPop({ ...screenPop, reason: value })}
          isRequired
          maxLength={500}
          description={t('dphoneEmbedding.screenPop.reasonHint', { min: SCREEN_POP_REASON_MIN })}
        />
      </Dialog>

      <Dialog
        isOpen={confirmTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null);
            setConfirmReason('');
          }
        }}
        role="alertdialog"
        title={
          confirming?.kind === 'delete'
            ? t('dphoneEmbedding.confirm.deleteTitle', { origin: confirmTarget?.origin })
            : t('dphoneEmbedding.confirm.disableTitle', { origin: confirmTarget?.origin })
        }
        footer={(close) => (
          <>
            <Button variant="ghost" onPress={close}>
              {t('dphoneEmbedding.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              isDisabled={pending}
              onPress={() => {
                if (!confirming) return;
                const target = confirming.origin;
                const note = confirmReason.trim() || undefined;
                void run(
                  () =>
                    confirming.kind === 'delete'
                      ? api.remove(target, note)
                      : api.update(target, { enabled: false, ...(note ? { reason: note } : {}) }),
                  failToast,
                ).then(() => close());
              }}
            >
              {confirming?.kind === 'delete'
                ? t('dphoneEmbedding.confirm.confirmDelete')
                : t('dphoneEmbedding.confirm.confirmDisable')}
            </Button>
          </>
        )}
      >
        <p>
          {confirmTarget && confirmTarget.activeSessions > 0
            ? t('dphoneEmbedding.confirm.sessions', { count: confirmTarget.activeSessions })
            : t('dphoneEmbedding.confirm.noSessions')}
        </p>
        <TextField
          label={t('dphoneEmbedding.confirm.reason')}
          value={confirmReason}
          onChange={setConfirmReason}
          maxLength={500}
        />
      </Dialog>
    </main>
  );
}
