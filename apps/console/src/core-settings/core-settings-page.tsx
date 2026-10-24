import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import { Button, TextField, Select } from '@d-contact/ui-react';
import { ConsoleShell, type ConsoleShellProps } from '../shell/console-shell.js';
import { useShellTokens } from '../shell/tokens.js';
import type { CoreApi, CoreTeamsApi } from './api.js';
import { CorePageLinks } from './page-links.js';
import { CoreTeamsPage } from './teams-page.js';
import { CoreOrganizationModel } from './model.js';
import './core-settings.css';
import { clearCoreCommandReferences } from './storage.js';
type ShellProps = Omit<ConsoleShellProps, 'appId' | 'pageId' | 'children'>;
export function CoreSettingsPage(props: CoreSettingsProps) {
  const [location, setLocation] = useState({ href: window.location.href, revision: 0 });
  const leave = useRef<() => boolean>(() => true);
  const previous = useRef(location.href);
  const registerLeaveGuard = useCallback((guard: () => boolean) => {
    leave.current = guard;
    return () => {
      leave.current = () => true;
    };
  }, []);
  const onResourceUrl = useCallback((id?: string) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('team', id);
    else url.searchParams.delete('team');
    window.history.replaceState(null, '', url);
    previous.current = url.href;
    setLocation((current) => ({ ...current, href: url.href }));
  }, []);
  const onPageSelect = (pageId: string) => {
    if (!['organization', 'teams'].includes(pageId) || !leave.current()) return;
    const url = new URL(window.location.href);
    url.searchParams.set('page', pageId);
    url.searchParams.delete('team');
    window.history.pushState(null, '', url);
    previous.current = url.href;
    setLocation((current) => ({ href: url.href, revision: current.revision + 1 }));
  };
  useEffect(() => {
    const pop = () => {
      if (!leave.current()) {
        window.history.pushState(null, '', previous.current);
        return;
      }
      previous.current = window.location.href;
      const href = window.location.href;
      setLocation((current) => ({ href, revision: current.revision + 1 }));
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const page = new URL(location.href).searchParams.get('page');
  const pageProps = { ...props, registerLeaveGuard, onPageSelect, onResourceUrl };
  return page === 'teams' ? (
    <CoreTeamsPage key={location.revision} {...pageProps} />
  ) : (
    <CoreOrganizationPage key={location.revision} {...pageProps} />
  );
}
export interface CoreSettingsProps {
  api: CoreApi & { teams: CoreTeamsApi };
  identityKey: string;
  shell: ShellProps;
  onSignIn?: () => Promise<void>;
  signedIn?: boolean;
  onPageSelect?: (pageId: string) => void;
  onResourceUrl?: (id?: string) => void;
  registerLeaveGuard?: (guard: () => boolean) => () => void;
}
function CoreOrganizationPage({
  api,
  identityKey,
  shell,
  onSignIn,
  signedIn = true,
  onPageSelect,
  registerLeaveGuard,
}: CoreSettingsProps) {
  const { t: translate } = useTranslation('coreSettings');
  const t = translate as (key: string) => string;
  const model = useMemo(
    () => new CoreOrganizationModel(api, identityKey, window.sessionStorage),
    [api, identityKey],
  );
  const [, render] = useReducer((x) => x + 1, 0);
  const statusRef = useRef<HTMLDivElement>(null);
  const allowUnload = useRef(false);
  useEffect(() => {
    if (['SAVED', 'CONFLICT', 'REAUTH'].includes(model.state) || Object.keys(model.errors).length)
      statusRef.current?.focus();
  }, [model.state, model.message, model.errors]);
  const tokens = useShellTokens();
  useEffect(() => model.subscribe(render), [model]);
  useEffect(() => {
    // คนละ identity ต้องไม่เห็นร่างหรือ command reference ของบัญชีก่อน
    clearCoreCommandReferences(model.storageKey, `dc:core-settings:command:${identityKey}:`);
    model.narrow = window.matchMedia('(max-width:760px)').matches;
    void model.load();
  }, [model, signedIn]);
  useEffect(() => {
    const media = window.matchMedia('(max-width:760px)');
    const resize = () => {
      void model.setNarrow(media.matches);
    };
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, [model]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!allowUnload.current && (model.dirty || model.pending)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('beforeunload', before);
    };
  }, [model, t]);
  useEffect(
    () =>
      registerLeaveGuard?.(() => !(model.dirty || model.pending) || window.confirm(t('discard'))),
    [registerLeaveGuard, model, t],
  );
  const account = shell.account
    ? {
        ...shell.account,
        onSignOut: async () => {
          if ((model.dirty || model.pending) && !window.confirm(t('discard'))) return;
          allowUnload.current = true;
          try {
            await shell.account!.onSignOut();
            model.clear();
          } catch (error) {
            allowUnload.current = false;
            throw error;
          }
        },
      }
    : undefined;
  const readonly = model.narrow || model.caps?.organization.write === false;
  const page = new URL(window.location.href).searchParams.get('page');
  const status = model.message || model.state;
  return (
    <ConsoleShell
      {...shell}
      account={account}
      appId="core-settings"
      pageId="organization"
      onPageSelect={onPageSelect}
    >
      {!tokens ? (
        <main aria-busy="true">{t('status.LOADING')}</main>
      ) : page && page !== 'organization' ? (
        <main className="core-settings">
          <h1>{t('unavailable')}</h1>
          <a href="?view=core-settings&page=organization">{t('title')}</a>
        </main>
      ) : (
        <main className="core-settings">
          <CorePageLinks
            tenant={shell.tenantAlias}
            teams={!!model.caps?.teams?.read}
            t={t}
            onSelect={onPageSelect}
          />
          <header>
            <p className="core-settings__eyebrow">{t('eyebrow')}</p>
            <h1 tabIndex={-1} id="core-organization-title">
              {t('title')}
            </h1>
            <p>{t('intro')}</p>
          </header>
          <div className="core-settings__layout">
            <section className="core-settings__panel" aria-labelledby="core-org-heading">
              <h2 id="core-org-heading">{t('profile')}</h2>
              <div
                ref={statusRef}
                tabIndex={-1}
                role={model.message === 'VALIDATION' ? 'alert' : 'status'}
                aria-live="polite"
                aria-atomic="true"
                className="core-settings__status"
              >
                {t(`status.${status}`)}
              </div>
              {model.state === 'LOADING' ? null : model.current ? (
                readonly ? (
                  <>
                    <p>{t(model.narrow ? 'narrow' : 'readOnly')}</p>
                    <dl>
                      <dt>{t('name')}</dt>
                      <dd>{model.current.displayName}</dd>
                      <dt>{t('locale')}</dt>
                      <dd>{model.current.defaults?.locale ?? t('unset')}</dd>
                      <dt>{t('timeZone')}</dt>
                      <dd>{model.current.defaults?.timeZone ?? t('unset')}</dd>
                    </dl>
                    {model.narrow && model.dirty ? <p>{t('draftKept')}</p> : null}
                  </>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void model.save();
                    }}
                    noValidate
                  >
                    <TextField
                      label={t('name')}
                      value={model.draft.displayName}
                      onChange={(value) => model.edit({ displayName: value })}
                      isDisabled={!model.editable}
                      isInvalid={!!model.errors.displayName}
                      errorMessage={t('validation.name')}
                      description={t('nameHint')}
                    />
                    <fieldset disabled={!model.editable}>
                      <legend>{t('defaults')}</legend>
                      {!model.current.defaults ? (
                        <label className="core-settings__check">
                          <input
                            type="checkbox"
                            checked={model.draft.setDefaults}
                            onChange={(e) =>
                              model.edit({
                                setDefaults: e.target.checked,
                                ...(!e.target.checked ? { locale: '', timeZone: '' } : {}),
                              })
                            }
                          />
                          {t('initializeDefaults')}
                        </label>
                      ) : null}
                      {model.draft.setDefaults ? (
                        <div className="core-settings__fields">
                          <Select
                            label={t('locale')}
                            selectedKey={model.draft.locale || null}
                            onSelectionChange={(value) =>
                              model.edit({ locale: String(value ?? '') })
                            }
                            options={[
                              { id: 'th', label: t('thai') },
                              { id: 'en', label: t('english') },
                              ...(!['', 'th', 'en'].includes(model.draft.locale)
                                ? [{ id: model.draft.locale, label: model.draft.locale }]
                                : []),
                            ]}
                            isDisabled={!model.editable}
                            isInvalid={!!model.errors.locale}
                            errorMessage={t('validation.locale')}
                          />
                          <TextField
                            label={t('timeZone')}
                            value={model.draft.timeZone}
                            onChange={(value) => model.edit({ timeZone: value })}
                            isDisabled={!model.editable}
                            isInvalid={!!model.errors.timeZone}
                            errorMessage={t('validation.timeZone')}
                            description={t('timeZoneHint')}
                          />
                        </div>
                      ) : (
                        <p>{t('unsetHint')}</p>
                      )}
                    </fieldset>
                    {model.editable ? (
                      <div className="core-settings__actions">
                        <Button type="submit" variant="primary" isDisabled={!model.dirty}>
                          {t('save')}
                        </Button>
                        <Button
                          onPress={() => {
                            if (window.confirm(t('discard'))) void model.loadLatest();
                          }}
                          isDisabled={!model.dirty}
                        >
                          {t('cancel')}
                        </Button>
                      </div>
                    ) : null}
                  </form>
                )
              ) : null}
              {model.state === 'UNKNOWN' ? (
                <Button onPress={() => void model.checkPending()}>{t('checkResult')}</Button>
              ) : null}
              {model.state === 'CONFLICT' ? (
                <Button
                  onPress={() => {
                    if (window.confirm(t('discard'))) void model.loadLatest();
                  }}
                >
                  {t('loadLatest')}
                </Button>
              ) : null}
              {model.state === 'REAUTH' && onSignIn ? (
                <Button
                  onPress={() => {
                    void onSignIn()
                      .then(() => model.load())
                      .catch(() => undefined);
                  }}
                >
                  {t('signIn')}
                </Button>
              ) : null}
              {!model.current && !['LOADING', 'REAUTH'].includes(model.state) ? (
                <Button onPress={() => void model.load()}>{t('retry')}</Button>
              ) : null}
            </section>
            <aside className="core-settings__help">
              <h2>{t('effectiveTitle')}</h2>
              <p>{t('effectiveHint')}</p>
              <p>{t('personalHint')}</p>
              {model.current?.defaults ? (
                <p>{t(`source.${model.current.defaults.initializationSource}`)}</p>
              ) : null}
              {model.message === 'SAVED_LATER' && model.committed ? (
                <section>
                  <h3>{t('committed')}</h3>
                  <p>{model.committed.displayName}</p>
                  <p>
                    {model.committed.defaults?.locale} {model.committed.defaults?.timeZone}
                  </p>
                  <h3>{t('current')}</h3>
                  <p>{model.current?.displayName}</p>
                </section>
              ) : null}
            </aside>
          </div>
        </main>
      )}
    </ConsoleShell>
  );
}
