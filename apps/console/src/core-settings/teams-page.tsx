import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Button,
  TextField,
  Dialog,
  Table,
  TableHeader,
  TableBody,
  Row,
  Column,
  Cell,
} from '@d-contact/ui-react';
import { ConsoleShell } from '../shell/console-shell.js';
import { useShellTokens } from '../shell/tokens.js';
import type { CoreSettingsProps } from './core-settings-page.js';
import { CorePageLinks } from './page-links.js';
import { CoreTeamModel } from './team-model.js';
import { clearCoreCommandReferences } from './storage.js';
export function CoreTeamsPage({
  api,
  identityKey,
  shell,
  onSignIn,
  signedIn,
  onPageSelect,
  onResourceUrl,
  registerLeaveGuard,
}: CoreSettingsProps) {
  const { t: translate } = useTranslation('coreSettings');
  const t = translate as (key: string) => string;
  const selected = new URL(window.location.href).searchParams.get('team') ?? '';
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const resourceKey = creating ? 'new' : selected;
  const model = useMemo(
    () =>
      new CoreTeamModel(api, identityKey, resourceKey, window.sessionStorage, (id) => {
        onResourceUrl?.(id);
      }),
    [api, identityKey, resourceKey, onResourceUrl],
  );
  const [, render] = useReducer((x) => x + 1, 0);
  const tokens = useShellTokens();
  const allowUnload = useRef(false);
  const creationOrigin = useRef(window.location.href);
  const returnCreateFocus = useRef(false);
  const statusRef = useRef<HTMLDivElement>(null);
  useEffect(() => model.subscribe(render), [model]);
  useEffect(() => {
    // รักษา references ของ resource อื่นใน identity เดียวกันจนกว่าจะตรวจผลครบ
    clearCoreCommandReferences(undefined, `dc:core-settings:command:${identityKey}:`);
    model.narrow = window.matchMedia('(max-width:760px)').matches;
    void model.load();
  }, [model, signedIn, identityKey]);
  useEffect(() => {
    const media = window.matchMedia('(max-width:760px)');
    const resize = () => {
      void model.setNarrow(media.matches);
    };
    media.addEventListener('change', resize);
    const before = (e: BeforeUnloadEvent) => {
      if (!allowUnload.current && (model.dirty || model.pending)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      media.removeEventListener('change', resize);
      window.removeEventListener('beforeunload', before);
    };
  }, [model]);
  useEffect(() => {
    if (model.message) statusRef.current?.focus();
  }, [model.message, model.state]);
  useEffect(() => {
    if ((model.pending || model.state === 'SAVED') && creating) {
      onResourceUrl?.(model.current?.id ?? model.resourceId);
    }
  }, [model.state, model.current, model.pending, model.resourceId, creating, onResourceUrl]);
  useEffect(
    () =>
      registerLeaveGuard?.(() => !(model.dirty || model.pending) || window.confirm(t('discard'))),
    [registerLeaveGuard, model, t],
  );
  const close = () => {
    if ((model.dirty || model.pending) && !window.confirm(t('discard'))) return;
    setEditor(false);
    if (creating) {
      if (!model.current && !model.pending)
        onResourceUrl?.(new URL(creationOrigin.current).searchParams.get('team') ?? undefined);
      returnCreateFocus.current = true;
      setCreating(false);
    } else void model.loadLatest();
  };
  useEffect(() => {
    if (!editor && returnCreateFocus.current && model.caps?.teams?.create) {
      const frame = window.requestAnimationFrame(() => {
        document.getElementById('core-team-create')?.focus();
        returnCreateFocus.current = false;
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [editor, model.state, model.caps]);
  const account = shell.account
    ? {
        ...shell.account,
        onSignOut: async () => {
          if ((model.dirty || model.pending) && !window.confirm(t('discard'))) return;
          allowUnload.current = true;
          try {
            await shell.account!.onSignOut();
            model.clear();
          } catch (e) {
            allowUnload.current = false;
            throw e;
          }
        },
      }
    : undefined;
  const controls = (
    <>
      {model.state === 'UNKNOWN' ? (
        <Button onPress={() => void model.checkPending()}>{t('checkResult')}</Button>
      ) : null}
      {model.state === 'CONFLICT' ? (
        <Button
          onPress={() => {
            if (!model.dirty || window.confirm(t('discard'))) void model.loadLatest();
          }}
        >
          {t('loadLatest')}
        </Button>
      ) : null}
      {model.state === 'REAUTH' && onSignIn ? (
        <Button
          onPress={() =>
            void onSignIn()
              .then(() => model.load())
              .catch(() => undefined)
          }
        >
          {t('signIn')}
        </Button>
      ) : null}
    </>
  );
  const status = (
    <div
      ref={statusRef}
      tabIndex={-1}
      role={model.error ? 'alert' : 'status'}
      aria-live="polite"
      className="core-settings__status"
    >
      {t(`status.${model.message || model.state}`)}
      {model.message === 'SAVED_LATER' && model.committed && model.current ? (
        <section>
          <h3>{t('committed')}</h3>
          <p>{model.committed.name}</p>
          <h3>{t('current')}</h3>
          <p>{model.current.name}</p>
        </section>
      ) : null}
      {model.blockers.length ? (
        <ul>
          {model.blockers.map((b) => (
            <li key={b.kind}>
              {translate(`team.blockers.${b.kind}`, { defaultValue: t('team.blockers.OTHER') })}:{' '}
              {b.count}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
  return (
    <ConsoleShell
      {...shell}
      account={account}
      appId="core-settings"
      pageId="teams"
      onPageSelect={onPageSelect}
    >
      <main className="core-settings">
        <h1>{t('team.title')}</h1>
        <CorePageLinks
          tenant={shell.tenantAlias}
          teams={!!model.caps?.teams?.read}
          t={t}
          onSelect={onPageSelect}
        />
        {!tokens ? (
          <p aria-busy="true">{t('status.LOADING')}</p>
        ) : (
          <>
            <p>{t('team.intro')}</p>
            {!editor ? (
              <>
                {status}
                {controls}
              </>
            ) : null}
            {model.narrow ? (
              <p>{t(model.narrow ? 'narrow' : 'readOnly')}</p>
            ) : model.caps?.teams?.create ? (
              <Button
                id="core-team-create"
                isDisabled={!!model.pending}
                onPress={() => {
                  creationOrigin.current = window.location.href;
                  setCreating(true);
                  setEditor(true);
                }}
              >
                {t('team.create')}
              </Button>
            ) : null}
            <section className="core-settings__panel" aria-label={t('team.list')}>
              <Table aria-label={t('team.list')}>
                <TableHeader>
                  <Column isRowHeader>{t('team.name')}</Column>
                  <Column>{t('team.activeStatus')}</Column>
                </TableHeader>
                <TableBody>
                  {model.teams.map((team) => (
                    <Row key={team.id} id={team.id}>
                      <Cell>
                        <a href={teamLink(team.id)}>{team.name}</a>
                      </Cell>
                      <Cell>{t(team.isActive ? 'team.active' : 'team.inactive')}</Cell>
                    </Row>
                  ))}
                </TableBody>
              </Table>
              {model.cursor ? (
                <Button
                  onPress={() =>
                    void model.list(true).catch(() => {
                      void model.load();
                    })
                  }
                >
                  {t('team.more')}
                </Button>
              ) : null}
            </section>
            {model.current ? (
              <section className="core-settings__panel core-settings__detail">
                <h2>{model.current.name}</h2>
                <p>{t(model.current.isActive ? 'team.active' : 'team.inactive')}</p>
                <p>
                  {t('team.id')}: {model.current.id}
                </p>
                {model.narrow || !model.caps?.teams?.rename ? (
                  <p>{t('readOnly')}</p>
                ) : (
                  <div className="core-settings__actions">
                    <Button onPress={() => setEditor(true)} isDisabled={!model.editable}>
                      {t('team.rename')}
                    </Button>
                    {model.current.isActive && model.caps.teams.deactivate ? (
                      <Button
                        onPress={() => setConfirm(true)}
                        isDisabled={!model.editable || model.dirty}
                      >
                        {t('team.deactivate')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}
            {!model.current && !['LOADING', 'REAUTH'].includes(model.state) && model.message ? (
              <Button onPress={() => void model.load()}>{t('retry')}</Button>
            ) : null}
          </>
        )}
        <Dialog
          title={t(creating && !model.current ? 'team.create' : 'team.rename')}
          isOpen={editor}
          onOpenChange={(open) => {
            if (!open) close();
          }}
          isKeyboardDismissDisabled={!!model.pending}
          isDismissable={false}
        >
          {status}
          {model.narrow || !model.caps?.teams?.rename ? (
            <>
              <p>{t(model.narrow ? 'narrow' : 'readOnly')}</p>
              {model.dirty ? <p>{t('draftKept')}</p> : null}
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
                label={t('team.name')}
                value={model.name}
                onChange={(name) => model.edit(name)}
                isDisabled={!model.editable}
                isInvalid={model.error}
                errorMessage={t('team.validation')}
                description={t('team.hint')}
              />
              <div className="core-settings__actions">
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={!model.editable || !model.dirty}
                >
                  {t('save')}
                </Button>
                <Button onPress={close}>{t('team.close')}</Button>
              </div>
            </form>
          )}
          {controls}
        </Dialog>
        <Dialog
          role="alertdialog"
          title={t('team.confirmTitle')}
          isOpen={confirm}
          onOpenChange={setConfirm}
        >
          <p>{t('team.confirmHint')}</p>
          <p>{model.current?.name}</p>
          <div className="core-settings__actions">
            <Button onPress={() => setConfirm(false)}>{t('team.cancel')}</Button>
            <Button
              variant="primary"
              onPress={() => {
                setConfirm(false);
                void model.deactivate();
              }}
            >
              {t('team.confirm')}
            </Button>
          </div>
        </Dialog>
      </main>
    </ConsoleShell>
  );
}
function teamLink(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('team', id);
  return `${url.pathname}${url.search}`;
}
