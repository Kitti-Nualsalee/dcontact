import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { serverTime } from '../journey-authoring/server-time.js';
import { Skeleton } from './skeleton.js';
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
  const { formatters } = useLocale();
  const [core, setCore] = useState<Core>({ state: 'loading' });
  const [timeline, setTimeline] = useState<TimelineView>({ state: 'loading' });
  const [governance, setGovernance] = useState<GovernanceView>({ state: 'loading' });
  const [context, setContext] = useState<GovernanceContext>();
  const [revision, setRevision] = useState(0);
  const [sectionRevision, setSectionRevision] = useState(0);
  const [moreTimeline, setMoreTimeline] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ displayName: '', company: '', vip: false });
  const [submitting, setSubmitting] = useState(false);
  const [addPointVisible, setAddPointVisible] = useState(false);
  const [newPointKind, setNewPointKind] = useState<'PHONE' | 'EMAIL'>('PHONE');
  const [newPointValue, setNewPointValue] = useState('');
  const [newPointCountry, setNewPointCountry] = useState('TH');
  const [addTagVisible, setAddTagVisible] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const silent = useRef(false);

  function startEdit(profile: CustomerProfile) {
    setEditForm({
      displayName: profile.contact.displayName ?? '',
      company: profile.contact.company ?? '',
      vip: profile.contact.vip,
    });
    setEditing(true);
  }

  async function submitEdit() {
    if (core.state !== 'ready' || !contactId || submitting) return;
    setSubmitting(true);
    try {
      if (editForm.displayName.trim() !== (core.profile.contact.displayName ?? '').trim()) {
        await api.submitCommand({
          command: {
            action: 'SET_NAME',
            contactId,
            displayName: editForm.displayName.trim(),
          },
        });
      }
      if (editForm.company.trim() !== (core.profile.contact.company ?? '').trim()) {
        await api.submitCommand({
          command: {
            action: 'SET_COMPANY',
            contactId,
            company: editForm.company.trim(),
          },
        });
      }
      setRevision((r) => r + 1);
      setEditing(false);
    } catch (err) {
      console.error('Failed to save profile', err);
    } finally {
      setSubmitting(false);
    }
  }

  function addPointForm() {
    setAddPointVisible(true);
    setNewPointValue('');
    setNewPointKind('PHONE');
    setNewPointCountry('TH');
  }

  async function submitAddPoint() {
    if (!contactId || submitting || !newPointValue.trim()) return;
    setSubmitting(true);
    try {
      await api.submitCommand({
        command: {
          action: 'ADD_POINT',
          contactId,
          kind: newPointKind,
          value: newPointValue.trim(),
          explicitCountry: newPointKind === 'PHONE' ? newPointCountry : undefined,
        },
      });
      setAddPointVisible(false);
      setRevision((r) => r + 1);
    } catch (err) {
      console.error('Failed to add point', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function retirePoint(pointId: string) {
    if (!contactId || submitting) return;
    setSubmitting(true);
    try {
      await api.submitCommand({
        command: {
          action: 'RETIRE_POINT',
          contactId,
          pointId,
        },
      });
      setRevision((r) => r + 1);
    } catch (err) {
      console.error('Failed to retire point', err);
    } finally {
      setSubmitting(false);
    }
  }

  function addTagForm() {
    setAddTagVisible(true);
    setNewTagName('');
  }

  async function submitAddTag() {
    if (!contactId || submitting || !newTagName.trim()) return;
    setSubmitting(true);
    try {
      await api.submitCommand({
        command: {
          action: 'ADD_TAG',
          contactId,
          value: newTagName.trim(),
        },
      });
      setAddTagVisible(false);
      setRevision((r) => r + 1);
    } catch (err) {
      console.error('Failed to add tag', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function removeTag(tagId: string) {
    if (!contactId || submitting) return;
    setSubmitting(true);
    try {
      await api.submitCommand({
        command: {
          action: 'REMOVE_TAG',
          contactId,
          tagId,
        },
      });
      setRevision((r) => r + 1);
    } catch (err) {
      console.error('Failed to remove tag', err);
    } finally {
      setSubmitting(false);
    }
  }
  const stamp = useRef(0);
  const coreRef = useRef<Core>(core);
  coreRef.current = core;

  const format = useCallback((value: string) => serverTime(formatters, value), [formatters]);

  // ปิดข้อมูลลูกค้าทั้งหน้า (core + section) เมื่อ section ได้ session/สิทธิ์/scope เปลี่ยน — เหมือนตอนโหลด core
  // generation + AbortController กัน response ของ core ที่ยิงค้างก่อนสิทธิ์ถูกถอน (200 มาทีหลัง) เปิด PII กลับ
  const generation = useRef(0);
  const coreAbort = useRef<AbortController | null>(null);
  const closeAll = useCallback((kind: ErrorKind) => {
    generation.current += 1;
    coreAbort.current?.abort();
    setTimeline({ state: 'loading' });
    setGovernance({ state: 'loading' });
    setContext(undefined);
    setCore({ state: 'error', kind });
  }, []);

  const nameRef = useRef<HTMLHeadingElement>(null);
  const timelineHeadRef = useRef<HTMLHeadingElement>(null);
  const governanceHeadRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const focusedCore = useRef(false);
  const pendingFocus = useRef<'timeline' | 'governance' | null>(null);

  // เปิดโปรไฟล์แล้ว focus ชื่อลูกค้า (ผู้ใช้คีย์บอร์ด/screen reader ไม่หลุดอยู่ที่ปุ่มที่หายไป)
  useEffect(() => {
    if (core.state === 'ready' && !focusedCore.current) {
      focusedCore.current = true;
      nameRef.current?.focus();
    }
  }, [core.state]);
  // ปิด PII (session/สิทธิ์/scope) แล้วย้าย focus ไปที่ข้อความของ state ใหม่ ไม่ปล่อยให้หลุดไป BODY
  useEffect(() => {
    if (core.state === 'error') alertRef.current?.focus();
  }, [core.state]);
  // retry/โหลดเพิ่มของ section สำเร็จแล้วย้าย focus มาที่หัว section นั้น
  useEffect(() => {
    if (pendingFocus.current === 'timeline' && timeline.state === 'ready') {
      pendingFocus.current = null;
      timelineHeadRef.current?.focus();
    }
    if (pendingFocus.current === 'governance' && governance.state === 'ready') {
      pendingFocus.current = null;
      governanceHeadRef.current?.focus();
    }
  }, [timeline, governance]);

  // core profile
  useEffect(() => {
    if (contactId === null) {
      setCore({ state: 'error', kind: 'notFound' });
      return;
    }
    const controller = new AbortController();
    coreAbort.current = controller;
    const myGeneration = generation.current;
    if (!silent.current) setCore({ state: 'loading' });
    const wasSilent = silent.current;
    silent.current = false;
    void api
      .profile(contactId, controller.signal)
      .then((profile) => {
        if (controller.signal.aborted || myGeneration !== generation.current) return;
        stamp.current += 1;
        setCore({ state: 'ready', profile, stamp: stamp.current });
      })
      .catch((failure: unknown) => {
        if (isAbort(failure) || myGeneration !== generation.current) return;
        const kind = errorKind(failure);
        // revalidate เงียบแล้วล้มชั่วคราว (network/5xx): คงที่แสดงอยู่ได้ แต่ถ้าสิทธิ์หาย/scope ไม่พร้อมต้องปิดทันที
        if (wasSilent && !closesCustomerData(kind) && coreRef.current.state === 'ready') return;
        closeAll(kind);
      });
    return () => controller.abort();
  }, [api, contactId, revision, closeAll]);

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
        const kind = errorKind(failure);
        if (closesCustomerData(kind)) return closeAll(kind);
        setTimeline({ state: 'error', kind });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, contactId, readyStamp, sectionRevision, closeAll]);

  // governance (section แยก)
  useEffect(() => {
    if (core.state !== 'ready' || !contactId) return;
    const controller = new AbortController();
    void api
      .governance(contactId, context, controller.signal)
      .then((summary) => setGovernance({ state: 'ready', summary }))
      .catch((failure: unknown) => {
        if (isAbort(failure)) return;
        const kind = errorKind(failure);
        if (closesCustomerData(kind)) return closeAll(kind);
        setGovernance({ state: 'error', kind });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, contactId, readyStamp, sectionRevision, context, closeAll]);

  function loadMoreTimeline() {
    if (timeline.state !== 'ready' || !timeline.cursor || !contactId || moreTimeline) return;
    setMoreTimeline(true);
    pendingFocus.current = 'timeline';
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
      .catch((failure: unknown) => {
        const kind = errorKind(failure);
        if (closesCustomerData(kind)) return closeAll(kind);
        setTimeline({ state: 'error', kind });
      })
      .finally(() => setMoreTimeline(false));
  }

  if (core.state === 'loading')
    return (
      <div className="cu-profile">
        <Skeleton label={t('profile.loading')} rows={2} kind="card" />
        <Skeleton label={t('governance.loading')} rows={4} kind="card" />
        <div className="cu-grid">
          <Skeleton label={t('timeline.loading')} rows={6} kind="card" />
          <div>
            <Skeleton label={t('profile.loading')} rows={3} kind="card" />
            <Skeleton label={t('profile.loading')} rows={2} kind="card" />
            <Skeleton label={t('profile.loading')} rows={2} kind="card" />
          </div>
        </div>
      </div>
    );

  if (core.state === 'error') {
    const message =
      core.kind === 'session'
        ? t('errors.unauthorized')
        : core.kind === 'forbidden'
          ? t('errors.profileForbidden')
          : core.kind === 'notFound'
            ? t('errors.notFound')
            : core.kind === 'scope'
              ? t('errors.scope')
              : t('errors.failed');
    return (
      <div role="alert" className="cu-alert" ref={alertRef} tabIndex={-1}>
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
            <h2 id="customer-name" ref={nameRef} tabIndex={-1}>
              {editing ? (
                <TextField
                  value={editForm.displayName}
                  onChange={(value) => setEditForm({ ...editForm, displayName: value })}
                  label={t('profile.displayName')}
                  aria-label={t('profile.displayName')}
                />
              ) : (
                name
              )}
            </h2>
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
            {t('profile.company')}:{' '}
            {editing ? (
              <TextField
                value={editForm.company}
                onChange={(value) => setEditForm({ ...editForm, company: value })}
                label={t('profile.company')}
                aria-label={t('profile.company')}
              />
            ) : (
              profile.contact.company?.trim() || t('profile.noCompany')
            )}
          </p>
        </div>
        <div>
          {editing ? (
            <>
              <Button variant="secondary" onPress={() => setEditing(false)}>{t('cancel')}</Button>
              <Button variant="primary" onPress={submitEdit}>{t('save')}</Button>
            </>
          ) : profile.capabilities.manage ? (
            <Button onPress={() => startEdit(profile)}>{t('edit')}</Button>
          ) : null}
          <Button onPress={onBack}>{t('back')}</Button>
        </div>
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
        onContext={(next) => {
          pendingFocus.current = 'governance';
          setContext(next);
        }}
        onRetry={() => {
          pendingFocus.current = 'governance';
          setSectionRevision((value) => value + 1);
        }}
        headingRef={governanceHeadRef}
        format={format}
        t={t}
      />

      <div className="cu-grid">
        <section aria-labelledby="timeline-title" className="cu-card">
          <h3 id="timeline-title" ref={timelineHeadRef} tabIndex={-1}>
            {t('timeline.title')}
          </h3>
          <p className="cu-muted">{t('timeline.scope')}</p>
          {timeline.state === 'loading' ? (
            <Skeleton label={t('timeline.loading')} rows={4} />
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
                  pendingFocus.current = 'timeline';
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
            <div className="cu-section-header">
              <h3 id="points-title">{t('profile.points.title')}</h3>
              {editing ? (
                <Button size="sm" onPress={addPointForm}>{t('profile.points.add')}</Button>
              ) : null}
            </div>
            <p className="cu-muted">{t('profile.points.notVerified')}</p>
            {addPointVisible ? (
              <div className="cu-point-form">
                <Select
                  label={t('profile.points.kind')}
                  selectedKey={newPointKind}
                  onSelectionChange={(key) => setNewPointKind(key as "PHONE" | "EMAIL")}
                  options={[
                    { id: 'PHONE', label: t('profile.points.phone') },
                    { id: 'EMAIL', label: t('profile.points.email') },
                  ]}
                />
                <TextField
                  label={t('profile.points.value')}
                  value={newPointValue}
                  onChange={setNewPointValue}
                  aria-label={t('profile.points.value')}
                />
                {newPointKind === 'PHONE' ? (
                  <Select
                    label={t('profile.points.country')}
                    selectedKey={newPointCountry}
                    onSelectionChange={(key) => setNewPointCountry(String(key))}
                    options={[
                      { id: 'TH', label: 'Thailand (+66)' },
                      { id: 'US', label: 'United States (+1)' },
                      { id: 'GB', label: 'United Kingdom (+44)' },
                    ]}
                  />
                ) : null}
                <div className="cu-form-actions">
                  <Button variant="secondary" size="sm" onPress={() => setAddPointVisible(false)}>{t('cancel')}</Button>
                  <Button variant="primary" size="sm" onPress={submitAddPoint}>{t('save')}</Button>
                </div>
              </div>
            ) : null}
            {profile.contactPoints.length === 0 && !addPointVisible ? (
              <p>{t('profile.points.empty')}</p>
            ) : !addPointVisible ? (
              <dl className="cu-points">
                {profile.contactPoints.map((point) => (
                  <div key={point.id} className="cu-point-row">
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
                    {editing ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={submitting}
                        onPress={() => retirePoint(point.id)}
                      >
                        {t('delete')}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
          <section aria-labelledby="tags-title" className="cu-card">
            <div className="cu-section-header">
              <h3 id="tags-title">{t('profile.tags.title')}</h3>
              {editing ? (
                <Button size="sm" onPress={addTagForm}>{t('profile.tags.add')}</Button>
              ) : null}
            </div>
            {addTagVisible ? (
              <div className="cu-tag-form">
                <TextField
                  label={t('profile.tags.name')}
                  value={newTagName}
                  onChange={setNewTagName}
                  aria-label={t('profile.tags.name')}
                />
                <div className="cu-form-actions">
                  <Button variant="secondary" size="sm" onPress={() => setAddTagVisible(false)}>{t('cancel')}</Button>
                  <Button variant="primary" size="sm" onPress={submitAddTag}>{t('save')}</Button>
                </div>
              </div>
            ) : null}
            {profile.tags.length === 0 && !addTagVisible ? (
              <p>{t('profile.tags.empty')}</p>
            ) : !addTagVisible ? (
              <ul className="cu-tags">
                {profile.tags.map((tag) => (
                  <li key={tag.id} className="cu-tag-row">
                    <Badge tone="neutral">
                      {tag.name}
                      {tag.state === 'RETIRED' ? ` · ${t('profile.tags.retired')}` : ''}
                    </Badge>
                    {editing && tag.state !== 'RETIRED' ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={submitting}
                        onPress={() => removeTag(tag.id)}
                      >
                        {t('delete')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
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
  headingRef,
  format,
  t,
}: {
  view: GovernanceView;
  context: GovernanceContext | undefined;
  onContext(next: GovernanceContext | undefined): void;
  onRetry(): void;
  headingRef: RefObject<HTMLHeadingElement | null>;
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
      <h3 id="governance-title" ref={headingRef} tabIndex={-1}>
        {t('governance.title')}
      </h3>
      <p className="cu-muted">{t('governance.notPermission')}</p>
      {view.state === 'loading' ? <Skeleton label={t('governance.loading')} rows={2} /> : null}
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
            options={GOVERNANCE_CHANNELS.map((value) => ({
              id: value,
              label: t(`governance.channels.${value}`),
            }))}
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
              channel: t(`governance.channels.${summary.context.channel}`, {
                defaultValue: summary.context.channel,
              }),
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
