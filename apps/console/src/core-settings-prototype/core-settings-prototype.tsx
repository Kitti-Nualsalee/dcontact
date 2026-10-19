/**
 * ต้นแบบทิ้งได้: 3 โครงสร้าง Core Settings ใน Console host เดิม
 * ?view=core-settings-prototype&variant=A|B|C — ข้อมูลสังเคราะห์ใน memory เท่านั้น
 * คำถาม: หน้าแยกหมวด / master-detail / hub+editor แบบใดค้นพบและแก้ค่าชัดที่สุด?
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createI18n } from '@d-contact/i18n';
import { LocaleProvider, useLocale } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Cell,
  Column,
  Dialog,
  Row,
  Select,
  ShellFrame,
  SubNav,
  Table,
  TableBody,
  TableHeader,
  TextField,
  uiResources,
  type ShellApp,
} from '@d-contact/ui-react';
import th from './th.json' with { type: 'json' };
import en from './en.json' with { type: 'json' };
import '@d-contact/ui/tokens.css';
import styles from './prototype.module.css';

type Message = keyof typeof th;
type Translate = (key: Message, options?: Record<string, string | number>) => string;
type Variant = 'A' | 'B' | 'C';
type Role = 'ADMIN' | 'SUPERVISOR' | 'AGENT' | 'COMPLIANCE';
type Team = {
  id: string;
  name: string;
  active: boolean;
  revision: number;
  users: number;
  queues: number;
  skills: number;
};
type Profile = { name: string; locale: string; timezone: string; revision: number };
type Location = { variant: Variant; page: 'org' | 'teams'; team: string };
const scenarios = [
  'ready',
  'legacy',
  'loading',
  'empty',
  'loadError',
  'proofMissing',
  'conflict',
  'busy',
  'unknown',
  'readbackFailed',
  'reauth',
] as const;
type Scenario = (typeof scenarios)[number];
const instance = createI18n({
  resources: { th: { prototype: th, ...uiResources.th }, en: { prototype: en, ...uiResources.en } },
  locale: 'th',
  defaultNamespace: 'prototype',
});

function readLocation(): Location {
  const q = new URL(window.location.href).searchParams;
  const v = q.get('variant');
  return {
    variant: v === 'B' || v === 'C' ? v : 'A',
    page: q.get('page') === 'teams' ? 'teams' : 'org',
    team: q.get('team') ?? 'team-care',
  };
}
function link(location: Location) {
  const u = new URL(window.location.href);
  u.searchParams.set('view', 'core-settings-prototype');
  for (const [k, v] of Object.entries(location)) u.searchParams.set(k, v);
  return `${u.pathname}${u.search}`;
}

export function VariantA({
  page,
  org,
  teams,
  note,
}: {
  page: string;
  org: ReactNode;
  teams: ReactNode;
  note: ReactNode;
}) {
  return (
    <div className={styles.sections}>
      <section>{page === 'org' ? org : teams}</section>
      <aside className={styles.help}>{note}</aside>
    </div>
  );
}
export function VariantB({ navigation, detail }: { navigation: ReactNode; detail: ReactNode }) {
  return (
    <div className={styles.masterDetail}>
      <section className={styles.master}>{navigation}</section>
      <section className={styles.detail}>{detail}</section>
    </div>
  );
}
export function VariantC({ hub, workspace }: { hub: ReactNode; workspace: ReactNode }) {
  return (
    <>
      <section className={styles.hub}>{hub}</section>
      <section className={styles.hubWorkspace}>{workspace}</section>
    </>
  );
}

function Prototype() {
  const { locale, setLocale } = useLocale();
  // namespace ชั่วคราวแยกจาก production catalogs; จำกัด key ด้วย Message ของสอง catalog นี้
  const t = instance.getFixedT(locale, 'prototype' as never) as unknown as Translate;
  const [location, setLocation] = useState(readLocation);
  const [role, setRole] = useState<Role>('ADMIN');
  const [scenario, setScenario] = useState<Scenario>('ready');
  const [lookupFound, setLookupFound] = useState(true);
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 760px)').matches);
  const initialProfile = (): Profile => ({
    name: t('fixtureOrg'),
    locale: 'th',
    timezone: 'Asia/Bangkok',
    revision: 4,
  });
  const initialTeams = (): Team[] => [
    {
      id: 'team-care',
      name: t('fixtureTeam1'),
      active: true,
      revision: 2,
      users: 2,
      queues: 1,
      skills: 1,
    },
    {
      id: 'team-test',
      name: t('fixtureTeam2'),
      active: true,
      revision: 1,
      users: 0,
      queues: 0,
      skills: 0,
    },
    {
      id: 'team-archive',
      name: t('fixtureTeam3'),
      active: false,
      revision: 3,
      users: 0,
      queues: 0,
      skills: 0,
    },
  ];
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [draft, setDraft] = useState<Profile>(initialProfile);
  const [teams, setTeams] = useState<Team[]>(initialTeams);
  const [teamDraft, setTeamDraft] = useState('');
  const [editor, setEditor] = useState<'org' | 'team' | 'new' | null>(null);
  const [review, setReview] = useState(false);
  const [status, setStatus] = useState<Message | 'idle'>('idle');
  const [command, setCommand] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ commandId: string; result: string } | null>(null);
  const [deactivate, setDeactivate] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<Location | null>(null);
  const pending = useRef<{ commit: () => void; noop: boolean; commandId: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const visibleTeams = role === 'SUPERVISOR' ? teams.filter((x) => x.id === 'team-care') : teams;
  const selected = visibleTeams.find((x) => x.id === location.team) ?? visibleTeams[0];
  const canView = role === 'ADMIN' || role === 'SUPERVISOR';
  const canEdit =
    role === 'ADMIN' && !narrow && scenario !== 'proofMissing' && scenario !== 'reauth';
  const waiting = status === 'saving' || status === 'readback';
  const unresolved = status === 'unknown' || status === 'notFound' || status === 'readbackFailed';
  const orgDirty =
    draft.name !== profile.name ||
    draft.locale !== profile.locale ||
    draft.timezone !== profile.timezone;
  const teamDirty =
    editor === 'new' ? !!teamDraft : !!editor && editor === 'team' && teamDraft !== selected?.name;
  const dirty = orgDirty || teamDirty;
  const isOrg =
    editor === 'org' || (editor !== 'team' && editor !== 'new' && location.page === 'org');
  const invalidName = (v: string, min: number, max: number) =>
    v.trim().length < min || v.trim().length > max || /\p{Cc}/u.test(v);
  const defaultChange = draft.locale !== profile.locale || draft.timezone !== profile.timezone;
  const orgInvalid =
    invalidName(draft.name, 2, 120) || (defaultChange && (!draft.locale || !draft.timezone));

  useEffect(() => {
    const pop = () => {
      setLocation(readLocation());
      setEditor(null);
      setStatus('idle');
    };
    const media = matchMedia('(max-width: 760px)');
    const change = () => {
      setNarrow(media.matches);
    };
    window.addEventListener('popstate', pop);
    media.addEventListener('change', change);
    return () => {
      window.removeEventListener('popstate', pop);
      media.removeEventListener('change', change);
    };
  }, []);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (dirty || unresolved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty, unresolved]);

  function navigate(next: Location, force = false) {
    if (!force && (dirty || unresolved)) {
      setPendingNavigation(next);
      return;
    }
    history.pushState(null, '', link(next));
    setLocation(next);
    setEditor(null);
    setReview(false);
    setDraft(profile);
    setTeamDraft('');
    setStatus('idle');
    requestAnimationFrame(() => heading.current?.focus());
  }
  function switchVariant(offset: number) {
    const all: Variant[] = ['A', 'B', 'C'];
    const variant = all[(all.indexOf(location.variant) + offset + 3) % 3]!;
    const next = { ...location, variant };
    history.replaceState(null, '', link(next));
    setLocation(next);
    setReview(false);
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement;
      if (
        el.closest(
          'input,textarea,select,[contenteditable], [role="dialog"], [role="listbox"], [role="menu"], [role="grid"], [role="tablist"]',
        ) ||
        el.getAttribute('role') === 'combobox'
      )
        return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        switchVariant(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [location]);

  function reset(next: Scenario = scenario, nextRole: Role = role) {
    const data = initialProfile();
    if (next === 'legacy') {
      data.locale = '';
      data.timezone = '';
    }
    setProfile(data);
    setDraft(data);
    setTeams(next === 'empty' ? [] : initialTeams());
    setEditor(null);
    setTeamDraft('');
    setReview(false);
    setDeactivate(false);
    setCommand(null);
    setReceipt(null);
    pending.current = null;
    setScenario(next);
    setRole(nextRole);
    setStatus(next === 'reauth' ? 'reauth' : 'idle');
  }
  function finish(item: NonNullable<typeof pending.current>, shouldCommit = true) {
    if (shouldCommit) item.commit();
    setStatus('readback');
    window.setTimeout(() => {
      setReceipt({ commandId: item.commandId, result: item.noop ? 'NOOP' : 'APPLIED' });
      setStatus(item.noop ? 'noop' : 'saved');
      pending.current = null;
    }, 400);
  }
  function submit(commit: () => void, noop = false) {
    if (!canEdit || waiting || unresolved) return;
    const commandId = crypto.randomUUID();
    const item = { commit, noop, commandId };
    pending.current = item;
    setCommand(commandId);
    setReceipt(null);
    setStatus('saving');
    window.setTimeout(() => {
      if (scenario === 'conflict') {
        pending.current = null;
        setStatus('conflict');
        return;
      }
      if (scenario === 'busy') {
        setStatus('busy');
        return;
      }
      if (scenario === 'unknown') {
        setStatus('unknown');
        return;
      }
      if (scenario === 'readbackFailed') {
        item.commit();
        setReceipt({ commandId, result: noop ? 'NOOP' : 'APPLIED' });
        setStatus('readbackFailed');
        return;
      }
      finish(item);
    }, 500);
  }
  function saveOrg() {
    if (orgInvalid) {
      setStatus('validation');
      return;
    }
    const next = { ...draft, name: draft.name.trim(), revision: profile.revision };
    const noop =
      next.name === profile.name &&
      next.locale === profile.locale &&
      next.timezone === profile.timezone;
    submit(() => {
      const committed = { ...next, revision: profile.revision + (noop ? 0 : 1) };
      setProfile(committed);
      setDraft(committed);
    }, noop);
  }
  function openTeam(team?: Team) {
    if (dirty || unresolved) {
      setPendingNavigation({ ...location, page: 'teams', team: team?.id ?? 'new' });
      return;
    }
    if (team) {
      const next = { ...location, page: 'teams' as const, team: team.id };
      history.pushState(null, '', link(next));
      setLocation(next);
    }
    setTeamDraft(team?.name ?? '');
    setEditor(team ? 'team' : 'new');
    setReview(false);
    setStatus('idle');
  }
  function saveTeam() {
    const name = teamDraft.trim();
    if (invalidName(name, 1, 80)) {
      setStatus('validation');
      return;
    }
    if (teams.some((x) => x.name === name && (editor === 'new' || x.id !== selected?.id))) {
      setStatus('duplicate');
      return;
    }
    if (editor === 'new') {
      const newTeam = {
        id: `team-${crypto.randomUUID()}`,
        name,
        active: true,
        revision: 1,
        users: 0,
        queues: 0,
        skills: 0,
      };
      submit(() => {
        setTeams((old) => [...old, newTeam]);
        setLocation((old) => {
          const n = { ...old, page: 'teams' as const, team: newTeam.id };
          history.replaceState(null, '', link(n));
          return n;
        });
        setEditor(null);
        setTeamDraft('');
      });
    } else if (selected) {
      const id = selected.id;
      const noop = selected.name === name;
      submit(() => {
        setTeams((old) =>
          old.map((x) => (x.id === id ? { ...x, name, revision: x.revision + (noop ? 0 : 1) } : x)),
        );
        setTeamDraft(name);
      }, noop);
    }
  }
  function checkCommand() {
    if (!lookupFound || !pending.current) {
      setStatus('notFound');
      return;
    }
    finish(pending.current, status !== 'readbackFailed');
  }
  function latest() {
    if (isOrg) {
      const v = { ...profile, name: `${profile.name} · server`, revision: profile.revision + 1 };
      setProfile(v);
      setDraft((d) => ({ ...d, revision: v.revision }));
    } else if (selected)
      setTeams((old) =>
        old.map((x) => (x.id === selected.id ? { ...x, revision: x.revision + 1 } : x)),
      );
    setScenario('ready');
    setStatus('compare');
  }
  function discard() {
    setDraft(profile);
    setTeamDraft(selected?.name ?? '');
    setEditor(null);
    setStatus('idle');
    setReview(false);
  }
  const referenceText = (team: Team) =>
    t('syntheticRef', { users: team.users, queues: team.queues, skills: team.skills });
  const readOnlyNote = narrow ? t('narrow') : role === 'SUPERVISOR' ? t('readonly') : '';
  const notice = (
    <>
      {status !== 'idle' && (
        <div
          className={styles.notice}
          role={
            ['validation', 'duplicate', 'conflict', 'unknown', 'readbackFailed', 'reauth'].includes(
              status,
            )
              ? 'alert'
              : 'status'
          }
        >
          <strong>{t(status)}</strong>
          {command && (
            <small>
              {t('command')}: {command}
            </small>
          )}
          {status === 'conflict' && <Button onPress={latest}>{t('loadLatest')}</Button>}
          {status === 'compare' && (
            <p>
              {t('serverValue')}: {isOrg ? profile.name : selected?.name}
            </p>
          )}
          {status === 'busy' && (
            <Button
              onPress={() => {
                setScenario('ready');
                if (pending.current) finish(pending.current);
              }}
            >
              {t('retry')}
            </Button>
          )}
          {unresolved && <Button onPress={checkCommand}>{t('check')}</Button>}
          {status === 'reauth' && (
            <Button
              onPress={() => {
                setScenario('ready');
                setStatus('idle');
              }}
            >
              {t('signin')}
            </Button>
          )}
        </div>
      )}
    </>
  );
  const actions = (save: () => void) =>
    canEdit && (
      <div className={styles.actions}>
        <Button variant="primary" isDisabled={waiting || unresolved} onPress={save}>
          {t('save')}
        </Button>
        <Button isDisabled={waiting || unresolved} onPress={discard}>
          {t('cancel')}
        </Button>
        <span>{dirty ? t('dirty') : t('clean')}</span>
      </div>
    );
  const orgFields = (
    <div className={styles.form}>
      <TextField
        label={t('name')}
        description={t('nameHint')}
        value={draft.name}
        onChange={(name) => setDraft((d) => ({ ...d, name }))}
        isDisabled={waiting || unresolved}
        isInvalid={status === 'validation' && invalidName(draft.name, 2, 120)}
        errorMessage={t('validation')}
      />
      <div className={styles.twoFields}>
        <Select
          label={t('locale')}
          placeholder={t('choose')}
          selectedKey={draft.locale || null}
          onSelectionChange={(value) => setDraft((d) => ({ ...d, locale: String(value ?? '') }))}
          options={[
            { id: 'th', label: 'ไทย (TH)' },
            { id: 'en', label: 'English (EN)' },
          ]}
          isDisabled={waiting || unresolved}
        />
        <Select
          label={t('timezone')}
          placeholder={t('choose')}
          selectedKey={draft.timezone || null}
          onSelectionChange={(value) => setDraft((d) => ({ ...d, timezone: String(value ?? '') }))}
          options={['Asia/Bangkok', 'Asia/Singapore', 'UTC'].map((x) => ({ id: x, label: x }))}
          isDisabled={waiting || unresolved}
        />
      </div>
      <p className={styles.muted}>{t('effective')}</p>
    </div>
  );
  const orgRead = (
    <dl className={styles.readValues}>
      <dt>{t('name')}</dt>
      <dd>{profile.name}</dd>
      <dt>{t('locale')}</dt>
      <dd>{profile.locale || t('unset')}</dd>
      <dt>{t('timezone')}</dt>
      <dd>{profile.timezone || t('unset')}</dd>
    </dl>
  );
  const orgPanel = (
    <div className={styles.panel}>
      <div className={styles.panelHeading}>
        <div>
          <h2>{t('org')}</h2>
          <p>{t('orgDesc')}</p>
        </div>
        <Badge>
          {t('rev')} {profile.revision}
        </Badge>
      </div>
      {!profile.locale && <p className={styles.info}>{t('missing')}</p>}
      {readOnlyNote && <p className={styles.info}>{readOnlyNote}</p>}
      {canEdit ? orgFields : orgRead}
      {notice}
      {actions(saveOrg)}
    </div>
  );
  const teamEditor = (
    <div className={styles.form}>
      <h2>{editor === 'new' ? t('newTeam') : selected?.name}</h2>
      {canEdit ? (
        <TextField
          label={t('teamName')}
          value={teamDraft}
          onChange={setTeamDraft}
          description={t('teamHint')}
          isDisabled={waiting || unresolved}
          isInvalid={status === 'validation' || status === 'duplicate'}
          errorMessage={t(status === 'duplicate' ? 'duplicate' : 'validation')}
        />
      ) : (
        <p>{selected?.name}</p>
      )}
      {editor !== 'new' && selected && (
        <>
          <p>{referenceText(selected)}</p>
          <Badge tone={selected.active ? 'success' : 'neutral'}>
            {t(selected.active ? 'active' : 'inactive')}
          </Badge>
          <p className={styles.muted}>
            UUID: {selected.id} · {t('rev')} {selected.revision}
          </p>
        </>
      )}
      <p className={styles.muted}>{t('guard')}</p>
      {notice}
      {location.variant !== 'C' && actions(saveTeam)}
    </div>
  );
  const teamDetails = selected ? (
    <div className={styles.panel}>
      <div className={styles.panelHeading}>
        <div>
          <h2>{selected.name}</h2>
          <p>{referenceText(selected)}</p>
        </div>
        <Badge tone={selected.active ? 'success' : 'neutral'}>
          {t(selected.active ? 'active' : 'inactive')}
        </Badge>
      </div>
      <dl className={styles.readValues}>
        <dt>UUID</dt>
        <dd>{selected.id}</dd>
        <dt>{t('rev')}</dt>
        <dd>{selected.revision}</dd>
      </dl>
      {readOnlyNote && <p className={styles.info}>{readOnlyNote}</p>}
      <p className={styles.muted}>{selected.active ? t('guard') : t('kept')}</p>
      {canEdit && (
        <div className={styles.actions}>
          <Button onPress={() => openTeam(selected)}>{t('rename')}</Button>
          {selected.active && (
            <Button
              variant="danger"
              onPress={() => {
                if (selected.users + selected.queues + selected.skills > 0) setStatus('blocked');
                else {
                  setDeactivate(true);
                  setStatus('idle');
                }
              }}
            >
              {t('deactivate')}
            </Button>
          )}
        </div>
      )}
      {notice}
    </div>
  ) : (
    <div className={styles.panel}>
      <h2>{t('empty')}</h2>
      <p>{t('emptyDesc')}</p>
    </div>
  );
  const teamTable = (
    <div className={styles.panel}>
      <div className={styles.panelHeading}>
        <div>
          <h2>{t('teams')}</h2>
          <p>{role === 'SUPERVISOR' ? t('readonly') : t('allTeams')}</p>
        </div>
        {canEdit && (
          <Button variant="primary" onPress={() => openTeam()}>
            {t('newTeam')}
          </Button>
        )}
      </div>
      {narrow && <p>{t('narrow')}</p>}
      {visibleTeams.length ? (
        <div className={styles.tableWrap}>
          <Table aria-label={t('list')}>
            <TableHeader>
              <Column isRowHeader>{t('teamName')}</Column>
              <Column>{t('status')}</Column>
              <Column>{t('references')}</Column>
              <Column>{t('detail')}</Column>
            </TableHeader>
            <TableBody>
              {visibleTeams.map((team) => (
                <Row key={team.id} id={team.id}>
                  <Cell>{team.name}</Cell>
                  <Cell>
                    <Badge tone={team.active ? 'success' : 'neutral'}>
                      {t(team.active ? 'active' : 'inactive')}
                    </Badge>
                  </Cell>
                  <Cell>{referenceText(team)}</Cell>
                  <Cell>
                    <Button
                      size="sm"
                      onPress={() => navigate({ ...location, page: 'teams', team: team.id })}
                    >
                      {t('view')}
                    </Button>
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <>
          <h3>{t('empty')}</h3>
          <p>{t('emptyDesc')}</p>
        </>
      )}
      {location.variant !== 'B' && selected && (
        <div className={styles.inlineDetail}>{teamDetails}</div>
      )}
    </div>
  );
  const note = (
    <>
      <h3>{t('savedDefaults')}</h3>
      <p>
        {profile.locale || t('unset')} · {profile.timezone || t('unset')}
      </p>
      <p>{t('currentDefaults')}</p>
      <hr />
      <p>{t('auditBoundary')}</p>
      <p>{t('calendarLater')}</p>
    </>
  );
  const related = [
    { id: 'account', label: t('account'), href: '/?view=account' },
    ...(role === 'ADMIN'
      ? [{ id: 'account-policy', label: t('accountPolicy'), href: '/?view=account-policy' }]
      : []),
    ...(canView ? [{ id: 'voice-routing', label: t('voice'), href: '/?view=voice-routing' }] : []),
  ];
  const coreApp: ShellApp = {
    id: 'core-settings-prototype',
    groupId: 'settings',
    label: t('settings'),
    href: link(location),
    external: false,
  };
  const coreItems =
    location.variant === 'A'
      ? [
          {
            id: 'org',
            label: t('org'),
            href: link({ ...location, page: 'org' }),
            icon: 'account-policy',
            onSelect: () => navigate({ ...location, page: 'org' }),
          },
          {
            id: 'teams',
            label: t('teams'),
            href: link({ ...location, page: 'teams' }),
            icon: 'account',
            onSelect: () => navigate({ ...location, page: 'teams' }),
          },
        ]
      : [
          {
            id: 'overview',
            label: t('settings'),
            href: link({ ...location, page: 'org' }),
            icon: 'account-policy',
            onSelect: () => navigate({ ...location, page: 'org' }),
          },
        ];
  const subNav = (
    <SubNav
      title={t('settings')}
      eyebrow="D-Contact Console"
      currentItemId={location.variant === 'A' ? location.page : 'overview'}
      sections={[
        ...(canView && scenario !== 'proofMissing'
          ? [{ id: 'core', label: t('groupCore'), items: coreItems }]
          : []),
        { id: 'related', label: t('related'), items: related.map((x) => ({ ...x, icon: x.id })) },
      ]}
    />
  );
  const content =
    !canView || scenario === 'proofMissing' ? (
      <div className={styles.panel} role="alert">
        <h2>{t('forbidden')}</h2>
        <p>{t('forbiddenDesc')}</p>
        <a href="/?view=account">{t('account')}</a>
      </div>
    ) : scenario === 'loading' ? (
      <div className={styles.panel} aria-busy="true">
        <h2>{t('loading')}</h2>
      </div>
    ) : scenario === 'loadError' ? (
      <div className={styles.panel} role="alert">
        <h2>{t('failed')}</h2>
        <Button onPress={() => setScenario('ready')}>{t('reload')}</Button>
      </div>
    ) : location.variant === 'A' ? (
      <VariantA page={location.page} org={orgPanel} teams={teamTable} note={note} />
    ) : location.variant === 'B' ? (
      <VariantB
        navigation={
          <>
            <h2>{t('groupCore')}</h2>
            <button
              className={styles.listItem}
              aria-current={location.page === 'org' ? 'page' : undefined}
              onClick={() => navigate({ ...location, page: 'org' })}
            >
              <strong>{t('org')}</strong>
              <span>{profile.name}</span>
            </button>
            <div className={styles.panelHeading}>
              <h3>{t('teams')}</h3>
              {canEdit && (
                <Button size="sm" onPress={() => openTeam()}>
                  {t('newTeam')}
                </Button>
              )}
            </div>
            {visibleTeams.map((team) => (
              <button
                key={team.id}
                className={styles.listItem}
                aria-current={
                  location.page === 'teams' && selected?.id === team.id ? 'page' : undefined
                }
                onClick={() => navigate({ ...location, page: 'teams', team: team.id })}
              >
                <strong>{team.name}</strong>
                <span>
                  {t(team.active ? 'active' : 'inactive')} · {t('rev')} {team.revision}
                </span>
              </button>
            ))}
            {!visibleTeams.length && <p>{t('empty')}</p>}
          </>
        }
        detail={
          editor === 'team' || editor === 'new' ? (
            <div className={styles.panel}>{teamEditor}</div>
          ) : location.page === 'org' ? (
            orgPanel
          ) : (
            teamDetails
          )
        }
      />
    ) : (
      <VariantC
        hub={
          <>
            <button
              className={styles.hubItem}
              onClick={() => navigate({ ...location, page: 'org' })}
            >
              <span>01</span>
              <h2>{t('org')}</h2>
              <p>{t('orgSummary')}</p>
              <strong>{profile.name}</strong>
            </button>
            <button
              className={styles.hubItem}
              onClick={() => navigate({ ...location, page: 'teams' })}
            >
              <span>02</span>
              <h2>{t('teams')}</h2>
              <p>{t('teamsSummary')}</p>
              <strong>
                {visibleTeams.length} · {t('teams')}
              </strong>
            </button>
          </>
        }
        workspace={
          location.page === 'org' ? (
            <div className={styles.panel}>
              <div className={styles.panelHeading}>
                <h2>{t('org')}</h2>
                {canEdit && (
                  <Button
                    variant="primary"
                    onPress={() => {
                      setEditor('org');
                      setReview(false);
                    }}
                  >
                    {t('editOrg')}
                  </Button>
                )}
              </div>
              {orgRead}
              {readOnlyNote && <p>{readOnlyNote}</p>}
              <p>{t('effective')}</p>
              {notice}
            </div>
          ) : (
            teamTable
          )
        }
      />
    );

  return (
    <>
      <ShellFrame
        apps={canView ? [coreApp] : []}
        groups={[{ id: 'settings', label: t('settings') }]}
        pinnedIds={[]}
        maxPins={15}
        onTogglePin={() => {}}
        currentAppId={coreApp.id}
        areas={
          canView
            ? [
                {
                  id: 'settings',
                  label: t('settings'),
                  href: coreApp.href,
                  external: false,
                  sections: [
                    {
                      id: 'core',
                      label: t('groupCore'),
                      items: [
                        {
                          id: coreApp.id,
                          label: coreApp.label,
                          href: coreApp.href,
                          external: false,
                        },
                      ],
                    },
                  ],
                },
              ]
            : []
        }
        brand="D-Contact"
        breadcrumb={narrow ? [] : [t('settings'), t(location.page)]}
        language={locale}
        onLanguageChange={(value) => void setLocale(value)}
        subNav={narrow ? undefined : subNav}
      >
        <div className={styles.page}>
          <div className={styles.prototypeBanner}>
            <Badge tone="attention">{t('prototype')}</Badge>
            <span>{t('disclaimer')}</span>
          </div>
          <header className={styles.heading}>
            <p className={styles.kicker}>TENANT CONSOLE</p>
            <h1 ref={heading} tabIndex={-1}>
              {t('settings')}
            </h1>
            <p>{t('intro')}</p>
          </header>
          {canView && scenario !== 'proofMissing' && (
            <nav className={styles.mobileNav} aria-label={t('settings')}>
              <Button onPress={() => navigate({ ...location, page: 'org' })}>{t('org')}</Button>
              <Button onPress={() => navigate({ ...location, page: 'teams' })}>{t('teams')}</Button>
            </nav>
          )}
          {content}
          <section className={styles.related}>
            <h3>{t('related')}</h3>
            <p>{t('existing')}</p>
            {related.map((x) => (
              <a key={x.id} href={x.href} target="_blank" rel="noopener noreferrer">
                {x.label} ↗
              </a>
            ))}
            <p>{t('noNewRights')}</p>
          </section>
        </div>
      </ShellFrame>
      {canEdit &&
        ((location.variant === 'A' && (editor === 'team' || editor === 'new')) ||
          (location.variant === 'C' && editor)) && (
          <Dialog
            isOpen
            onOpenChange={(open) => {
              if (!open && !waiting && !unresolved) {
                if (dirty) setPendingNavigation(location);
                else setEditor(null);
              }
            }}
            isDismissable={!waiting && !unresolved}
            title={
              review
                ? t('review')
                : editor === 'org'
                  ? t('editOrg')
                  : editor === 'new'
                    ? t('newTeam')
                    : t('rename')
            }
            footer={() => (
              <div className={styles.actions}>
                {location.variant === 'C' && !review ? (
                  <Button
                    variant="primary"
                    onPress={() => {
                      if (editor === 'org' ? orgInvalid : invalidName(teamDraft, 1, 80))
                        setStatus('validation');
                      else {
                        setReview(true);
                        setStatus('idle');
                      }
                    }}
                  >
                    {t('next')}
                  </Button>
                ) : location.variant === 'C' ? (
                  <>
                    <Button onPress={() => setReview(false)}>{t('back')}</Button>
                    <Button
                      variant="primary"
                      isDisabled={waiting || unresolved}
                      onPress={editor === 'org' ? saveOrg : saveTeam}
                    >
                      {t('save')}
                    </Button>
                  </>
                ) : null}
              </div>
            )}
          >
            {review ? (
              <>
                <p>{t('reviewDesc')}</p>
                <dl className={styles.readValues}>
                  <dt>{t('before')}</dt>
                  <dd>
                    {editor === 'org'
                      ? `${profile.name} · ${profile.locale || t('unset')} · ${profile.timezone || t('unset')}`
                      : (selected?.name ?? '—')}
                  </dd>
                  <dt>{t('after')}</dt>
                  <dd>
                    {editor === 'org'
                      ? `${draft.name} · ${draft.locale || t('unset')} · ${draft.timezone || t('unset')}`
                      : teamDraft}
                  </dd>
                </dl>
                {notice}
              </>
            ) : editor === 'org' ? (
              <>
                {!profile.locale && <p className={styles.info}>{t('missing')}</p>}
                {orgFields}
                {notice}
              </>
            ) : (
              teamEditor
            )}
          </Dialog>
        )}
      {canEdit && deactivate && selected && (
        <Dialog
          isOpen
          title={t('confirmTeam')}
          role="alertdialog"
          onOpenChange={setDeactivate}
          footer={() => (
            <>
              <Button onPress={() => setDeactivate(false)}>{t('cancel')}</Button>
              <Button
                variant="danger"
                onPress={() => {
                  const id = selected.id;
                  setDeactivate(false);
                  submit(() =>
                    setTeams((old) =>
                      old.map((x) =>
                        x.id === id ? { ...x, active: false, revision: x.revision + 1 } : x,
                      ),
                    ),
                  );
                }}
              >
                {t('deactivate')}
              </Button>
            </>
          )}
        >
          <p>{selected.name}</p>
          <p>{t('confirmTeamBody')}</p>
        </Dialog>
      )}
      {pendingNavigation && (
        <Dialog
          isOpen
          title={t('unsavedTitle')}
          role="alertdialog"
          onOpenChange={(open) => !open && setPendingNavigation(null)}
          footer={() => (
            <>
              <Button onPress={() => setPendingNavigation(null)}>{t('stay')}</Button>
              <Button
                variant="danger"
                isDisabled={unresolved}
                onPress={() => {
                  const target = pendingNavigation;
                  setPendingNavigation(null);
                  navigate(target, true);
                }}
              >
                {t('leave')}
              </Button>
            </>
          )}
        >
          <p>{unresolved ? t('unknown') : t('unsavedBody')}</p>
        </Dialog>
      )}
      {import.meta.env.DEV && (
        <div className={styles.switcher}>
          <div className={styles.switcherRow}>
            <Button aria-label={t('previous')} onPress={() => switchVariant(-1)}>
              ←
            </Button>
            <strong>{t(location.variant)}</strong>
            <Button aria-label={t('nextVariant')} onPress={() => switchVariant(1)}>
              →
            </Button>
            <details className={styles.controls}>
              <summary>{t('harness')}</summary>
              <div className={styles.controlsPanel}>
                <label>
                  {t('role')}
                  <select value={role} onChange={(e) => reset(scenario, e.target.value as Role)}>
                    {['ADMIN', 'SUPERVISOR', 'AGENT', 'COMPLIANCE'].map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('scenario')}
                  <select value={scenario} onChange={(e) => reset(e.target.value as Scenario)}>
                    {scenarios.map((s) => (
                      <option key={s} value={s}>
                        {t(s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('result')}
                  <select
                    value={String(lookupFound)}
                    onChange={(e) => setLookupFound(e.target.value === 'true')}
                  >
                    <option value="true">{t('found')}</option>
                    <option value="false">{t('unfound')}</option>
                  </select>
                </label>
                <Button onPress={() => reset('ready')}>{t('reset')}</Button>
                <details>
                  <summary>{t('fullState')}</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        variant: location.variant,
                        location,
                        role,
                        scenario,
                        narrow,
                        canEdit,
                        profile,
                        draft,
                        teams: visibleTeams,
                        teamDraft,
                        editor,
                        status,
                        commandId: command,
                        receipt,
                        dirty,
                        unresolved,
                        sessionDefaults: { locale: 'th', timezone: 'Asia/Bangkok' },
                        persistence: 'memory-only; reload resets fixture',
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            </details>
          </div>
        </div>
      )}
    </>
  );
}

export function mountPrototype(element: HTMLElement) {
  if (!import.meta.env.DEV || import.meta.env.MODE !== 'prototype')
    throw new Error('prototype mode only');
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'core-settings-prototype');
  url.searchParams.set('variant', readLocation().variant);
  history.replaceState(null, '', url);
  createRoot(element).render(
    <LocaleProvider i18n={instance} locale="th" timeZone="Asia/Bangkok">
      <Prototype />
    </LocaleProvider>,
  );
}
