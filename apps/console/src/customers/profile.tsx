import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Badge, Button, Select, TextField } from '@d-contact/ui-react';
import {
  type CustomerProfile,
  type CustomersApi,
  type GovernanceContext,
  type GovernanceSummary,
  type TimelinePage,
} from './api.js';
import {
  GOVERNANCE_CHANNELS,
  closesCustomerData,
  errorKind,
  validPurpose,
  type ErrorKind,
} from './model.js';

interface Props {
  api: CustomersApi;
  contactId: string | null;
  onBack(): void;
  onOpen(contactId: string): void;
  onSignIn?: () => void;
}

type Core =
  | { state: 'loading' }
  | { state: 'ready'; profile: CustomerProfile; stamp: number }
  | { state: 'error'; kind: ErrorKind };

type TimelineView =
  | { state: 'loading' }
  | { state: 'ready'; items: TimelinePage['items']; cursor: string | null; coverage: string }
  | { state: 'unavailable' }
  | { state: 'error'; kind: ErrorKind };

type GovernanceView =
  | { state: 'loading' }
  | { state: 'ready'; summary: GovernanceSummary }
  | { state: 'error'; kind: ErrorKind };

const isAbort = (failure: unknown) =>
  failure instanceof DOMException && failure.name === 'AbortError';

/**
 * โปรไฟล์เต็มหน้า (Console A) — อ่านอย่างเดียว ไม่มี control เขียนใด ๆ
 * - core profile โหลดก่อน; timeline/governance เป็น section แยก (ล้มแยกกัน และไม่โหลดถ้า core ล้ม)
 * - core ล้มด้วย session/สิทธิ์/scope = ปิดข้อมูลลูกค้าทั้งหน้าทันที ไม่ค้างข้อมูลเสริมจากสิทธิ์เก่า
 * - กลับมาที่แท็บแล้วตรวจสิทธิ์ใหม่แบบเงียบ ๆ; ถ้าไม่ผ่านจะปิดข้อมูลทันที
 */
export function CustomerProfileView({ api, contactId, onBack, onOpen, onSignIn }: Props) {
  const { t: translate } = useTranslation('customers');
  const t = translate as (key: string, options?: Record<string, unknown>) => string;
  const { locale } = useLocale();
  const [core, setCore] = useState<Core>({ state: 'loading' });
  const [timeline, setTimeline] = useState<TimelineView>({ state: 'loading' });
  const [governance, setGovernance] = useState<GovernanceView>({ state: 'loading' });
  const [context, setContext] = useState<GovernanceContext>();
  const [revision, setRevision] = useState(0);
  const [sectionRevision, setSectionRevision] = useState(0);
  const [moreTimeline, setMoreTimeline] = useState(false);
  const silent = useRef(false);
  const stamp = useRef(0);
  const coreRef = useRef<Core>(core);
  coreRef.current = core;

  const format = useCallback(
    (value: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      ),
    [locale],
  );

  // core profile
  useEffect(() => {
    if (contactId === null) {
      setCore({ state: 'error', kind: 'notFound' });
      return;
    }
    const controller = new AbortController();
    if (!silent.current) setCore({ state: 'loading' });
    const wasSilent = silent.current;
    silent.current = false;
    void api
      .profile(contactId, controller.signal)
      .then((profile) => {
        stamp.current += 1;
        setCore({ state: 'ready', profile, stamp: stamp.current });
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        const kind = errorKind(failure);
        // revalidate เงียบแล้วล้มชั่วคราว (network/5xx): คงที่แสดงอยู่ได้ แต่ถ้าสิทธิ์หาย/scope ไม่พร้อมต้องปิดทันที
        if (wasSilent && !closesCustomerData(kind) && coreRef.current.state === 'ready') return;
        setTimeline({ state: 'loading' });
        setGovernance({ state: 'loading' });
        setContext(undefined);
        setCore({ state: 'error', kind });
      });
    return () => controller.abort();
  }, [api, contactId, revision]);

  // กลับมาที่แท็บ → ตรวจสิทธิ์ใหม่ (ข้อมูลที่แสดงมาจากสิทธิ์ ณ ตอนก่อนหน้า)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && coreRef.current.state === 'ready') {
        silent.current = true;
        setRevision((value) => value + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const readyStamp = core.state === 'ready' ? core.stamp : 0;

  // timeline (section แยก)
  useEffect(() => {
    if (core.state !== 'ready' || !contactId) return;
    const controller = new AbortController();
    void api
      .timeline(contactId, undefined, controller.signal)
      .then((section) => {
        setTimeline(
          section.state === 'READY'
            ? {
                state: 'ready',
                items: section.data.items,
                cursor: section.data.nextCursor,
                coverage: section.data.coverage,
              }
            : { state: 'unavailable' },
        );
      })
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        setTimeline({ state: 'error', kind: errorKind(failure) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, contactId, readyStamp, sectionRevision]);

  // governance (section แยก)
  useEffect(() => {
    if (core.state !== 'ready' || !contactId) return;
    const controller = new AbortController();
    void api
      .governance(contactId, context, controller.signal)
      .then((summary) => setGovernance({ state: 'ready', summary }))
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        setGovernance({ state: 'error', kind: errorKind(failure) });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, contactId, readyStamp, sectionRevision, context]);

  function loadMoreTimeline() {
    if (timeline.state !== 'ready' || !timeline.cursor || !contactId || moreTimeline) return;
    setMoreTimeline(true);
    api
      .timeline(contactId, timeline.cursor)
      .then((section) => {
        if (section.state !== 'READY') return setTimeline({ state: 'unavailable' });
        setTimeline((current) =>
          current.state === 'ready'
            ? {
                state: 'ready',
                items: [...current.items, ...section.data.items],
                cursor: section.data.nextCursor,
                coverage: section.data.coverage,
              }
            : current,
        );
      })
      .catch((failure: unknown) => setTimeline({ state: 'error', kind: errorKind(failure) }))
      .finally(() => setMoreTimeline(false));
  }

  if (core.state === 'loading')
    return (
      <p role="status" aria-busy="true" className="cu-skeleton">
        {t('profile.loading')}
      </p>
    );

  if (core.state === 'error') {
    const message =
      core.kind === 'session'
        ? t('errors.unauthorized')
        : core.kind === 'forbidden'
          ? t('errors.forbidden')
          : core.kind === 'notFound'
            ? t('errors.notFound')
            : core.kind === 'scope'
              ? t('errors.scope')
              : t('errors.failed');
    return (
      <div role="alert" className="cu-alert">
        <p>{message}</p>
        {core.kind === 'session' && onSignIn ? (
          <Button onPress={onSignIn}>{t('signIn')}</Button>
        ) : core.kind === 'notFound' || core.kind === 'forbidden' ? null : (
          <Button onPress={() => setRevision((value) => value + 1)}>{t('retry')}</Button>
        )}
        <Button onPress={onBack}>{t('back')}</Button>
      </div>
    );
  }

  const { profile } = core;
  const name = profile.contact.displayName?.trim() || t('profile.noName');
  const identity = profile.identity;

  return (
    <article aria-labelledby="customer-name" className="cu-profile">
      <header className="cu-profile-head">
        <div>
          <div className="cu-title-row">
            <h2 id="customer-name">{name}</h2>
            {profile.contact.vip ? <Badge tone="attention">{t('badges.vip')}</Badge> : null}
            {identity.state === 'AMBIGUOUS' ? (
              <Badge tone="critical">{t('badges.review')}</Badge>
            ) : identity.state === 'MERGED' ? (
              <Badge tone="neutral">{t('badges.merged')}</Badge>
            ) : identity.state === 'LEGACY_MISSING_HEAD' ? (
              <Badge tone="neutral">{t('badges.legacy')}</Badge>
            ) : null}
          </div>
          <p className="cu-muted">
            {t('profile.company')}: {profile.contact.company?.trim() || t('profile.noCompany')}
          </p>
        </div>
        <Button onPress={onBack}>{t('back')}</Button>
      </header>

      {identity.state === 'MERGED' ? (
        <div role="note" className="cu-notice">
          <p>{t('profile.mergedNotice')}</p>
          {identity.canonicalContactId ? (
            <Button onPress={() => onOpen(identity.canonicalContactId!)}>
              {t('profile.openCanonical')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {identity.state === 'AMBIGUOUS' ? (
        <p role="note" className="cu-notice">
          {t('profile.reviewNotice')}
        </p>
      ) : null}
      {identity.state === 'LEGACY_MISSING_HEAD' ? (
        <p role="note" className="cu-notice">
          {t('profile.legacyNotice')}
        </p>
      ) : null}

      <GovernanceBlock
        view={governance}
        context={context}
        onContext={setContext}
        onRetry={() => setSectionRevision((value) => value + 1)}
        format={format}
        t={t}
      />

      <div className="cu-grid">
        <section aria-labelledby="timeline-title" className="cu-card">
          <h3 id="timeline-title">{t('timeline.title')}</h3>
          <p className="cu-muted">{t('timeline.scope')}</p>
          {timeline.state === 'loading' ? (
            <p role="status" aria-busy="true" className="cu-skeleton">
              {t('timeline.loading')}
            </p>
          ) : null}
          {timeline.state === 'unavailable' || timeline.state === 'error' ? (
            <div role="alert" className="cu-alert">
              <p>
                {timeline.state === 'error' && timeline.kind === 'rateLimited'
                  ? t('errors.rateLimitedNow')
                  : t('timeline.unavailable')}
              </p>
              <Button
                onPress={() => {
                  setTimeline({ state: 'loading' });
                  setSectionRevision((value) => value + 1);
                }}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          {timeline.state === 'ready' ? (
            <>
              {timeline.items.length === 0 ? (
                <p>
                  {timeline.coverage === 'LIMITED'
                    ? t('timeline.limitedEmpty')
                    : t('timeline.empty')}
                </p>
              ) : (
                <ol className="cu-timeline">
                  {timeline.items.map((item, index) => (
                    <li key={`${item.startedAt}-${index}`}>
                      <div>
                        <strong>
                          {t(`timeline.channels.${item.channel}`, { defaultValue: item.channel })}
                        </strong>
                        <p className="cu-muted">
                          {t('timeline.started')}:{' '}
                          <time dateTime={item.startedAt}>{format(item.startedAt)}</time>
                          {' · '}
                          {t('timeline.ended')}:{' '}
                          {item.endedAt ? (
                            <time dateTime={item.endedAt}>{format(item.endedAt)}</time>
                          ) : (
                            t('timeline.stillOpen')
                          )}
                        </p>
                      </div>
                      <Badge tone="neutral">
                        {t(`timeline.states.${item.state}`, { defaultValue: item.state })}
                      </Badge>
                    </li>
                  ))}
                </ol>
              )}
              {timeline.coverage === 'LIMITED' && timeline.items.length > 0 ? (
                <p role="note" className="cu-notice">
                  {t('timeline.limited')}
                </p>
              ) : null}
              {timeline.cursor ? (
                <Button isDisabled={moreTimeline} onPress={loadMoreTimeline}>
                  {moreTimeline ? t('loading') : t('timeline.more')}
                </Button>
              ) : null}
            </>
          ) : null}
        </section>

        <div>
          <section aria-labelledby="points-title" className="cu-card">
            <h3 id="points-title">{t('profile.points.title')}</h3>
            <p className="cu-muted">{t('profile.points.notVerified')}</p>
            {profile.contactPoints.length === 0 ? (
              <p>{t('profile.points.empty')}</p>
            ) : (
              <dl className="cu-points">
                {profile.contactPoints.map((point) => (
                  <div key={point.id}>
                    <dt>
                      {point.kind === 'PHONE'
                        ? t('profile.points.phone')
                        : t('profile.points.email')}
                    </dt>
                    <dd>
                      <bdi>{point.value}</bdi>
                      {point.state === 'REVIEW_REQUIRED' ? (
                        <Badge tone="attention">{t('profile.points.reviewRequired')}</Badge>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section aria-labelledby="tags-title" className="cu-card">
            <h3 id="tags-title">{t('profile.tags.title')}</h3>
            {profile.tags.length === 0 ? (
              <p>{t('profile.tags.empty')}</p>
            ) : (
              <ul className="cu-tags">
                {profile.tags.map((tag) => (
                  <li key={tag.id}>
                    <Badge tone="neutral">
                      {tag.name}
                      {tag.state === 'RETIRED' ? ` · ${t('profile.tags.retired')}` : ''}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="source-title" className="cu-card">
            <h3 id="source-title">{t('profile.source.title')}</h3>
            <p>{t('profile.source.body')}</p>
            <p className="cu-muted">{t('profile.source.crm')}</p>
          </section>
        </div>
      </div>
    </article>
  );
}

function GovernanceBlock({
  view,
  context,
  onContext,
  onRetry,
  format,
  t,
}: {
  view: GovernanceView;
  context: GovernanceContext | undefined;
  onContext(next: GovernanceContext | undefined): void;
  onRetry(): void;
  format(value: string): string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [channel, setChannel] = useState<string>(context?.channel ?? 'VOICE');
  const [purpose, setPurpose] = useState(context?.purpose ?? '');
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!validPurpose(purpose)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onContext({ channel, purpose: purpose.trim() });
  }

  const summary = view.state === 'ready' ? view.summary : undefined;
  return (
    <section aria-labelledby="governance-title" className="cu-governance">
      <h3 id="governance-title">{t('governance.title')}</h3>
      <p className="cu-muted">{t('governance.notPermission')}</p>
      {view.state === 'loading' ? (
        <p role="status" aria-busy="true" className="cu-skeleton">
          {t('governance.loading')}
        </p>
      ) : null}
      {view.state === 'error' ? (
        <div role="alert" className="cu-alert">
          <p>{t('governance.unavailable')}</p>
          <Button onPress={onRetry}>{t('retry')}</Button>
        </div>
      ) : null}
      {summary?.state === 'UNAVAILABLE' ? (
        <div role="alert" className="cu-alert">
          <p>
            {summary.reason === 'IDENTITY_NOT_CANONICAL'
              ? t('governance.notCanonical')
              : t('governance.unavailable')}
          </p>
          {summary.retryable ? <Button onPress={onRetry}>{t('retry')}</Button> : null}
        </div>
      ) : null}
      {summary?.state === 'CONTEXT_REQUIRED' ? (
        <form className="cu-context" onSubmit={submit} noValidate>
          <p>{t('governance.contextRequired')}</p>
          <Select
            label={t('governance.channel')}
            options={GOVERNANCE_CHANNELS.map((value) => ({ id: value, label: value }))}
            selectedKey={channel}
            onSelectionChange={(key) => setChannel(String(key))}
          />
          <TextField
            label={t('governance.purpose')}
            value={purpose}
            onChange={(value) => {
              setPurpose(value);
              setInvalid(false);
            }}
            isInvalid={invalid}
            errorMessage={invalid ? t('governance.purposeInvalid') : undefined}
            validationBehavior="aria"
            autoComplete="off"
          />
          <Button type="submit" variant="primary">
            {t('governance.submit')}
          </Button>
        </form>
      ) : null}
      {summary?.state === 'READY' ? (
        <div role="status" className="cu-gov-ready">
          <p>
            {t('governance.context', {
              channel: summary.context.channel,
              purpose: summary.context.purpose,
            })}
          </p>
          <ul>
            <li>
              <strong>
                {summary.preference
                  ? t(`governance.preference.${summary.preference.decision}`)
                  : t('governance.preference.none')}
              </strong>
            </li>
            <li>
              {summary.callbackPending
                ? t('governance.callbackPending')
                : t('governance.noCallback')}
            </li>
            <li>{t('governance.exceptions', { count: summary.activeExceptionCount })}</li>
            <li>{t('governance.restrictions', { count: summary.activeRestrictionCount })}</li>
          </ul>
          <p className="cu-muted">{t('governance.asOf', { time: format(summary.asOf) })}</p>
          <Button onPress={() => onContext(undefined)}>{t('governance.changeContext')}</Button>
        </div>
      ) : null}
    </section>
  );
}
