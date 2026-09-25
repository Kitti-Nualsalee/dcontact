/**
 * J5.6 (#344): หน้า Journey authoring ของ Console (Phase Spec #337 §8)
 *
 * - desktop ≥960px แก้ได้เต็ม: outline + canvas + properties; ต่ำกว่า 960px อ่านอย่างเดียวพร้อมเหตุผล
 *   และไม่มีปุ่มที่ส่ง mutation เลย
 * - สิทธิ์, review, publish และ rollout มาจาก server — ถ้า server ปฏิเสธจะเห็น code ที่ได้จริง
 * - `409` ตอนบันทึกเปิดทางเลือกให้ผู้ใช้: ดูความต่าง, โหลดฉบับล่าสุด หรือเก็บการแก้ของตัวเองไปต่อ
 * - D1.14 (#453): ข้อความทั้งหมดอยู่ใน catalog `journeys`, ปุ่มจาก `@d-contact/ui-react`, CSS ใช้ token;
 *   อยู่ใน AppShell (flag `ui.shell.v2`) แล้วไม่วาด chrome เดิมของตัวเอง — เนื้อหาไม่ถือ layout/shell เอง
 */
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import { useLocale, useTranslation } from '@d-contact/i18n/react';
import { Button, useInShell } from '@d-contact/ui-react';
import { useShellTokens } from '../shell/tokens.js';
import {
  JourneyAuthoringApiError,
  type JourneyAuthoringApi,
  type JourneySnapshot,
  type JourneySummary,
  type JourneyAuditEntry,
  type PendingReview,
} from './api.js';
import { Canvas, nodeDomId } from './canvas.js';
import { Diagnostics, diagnosticCounts } from './diagnostics.js';
import {
  blankDocument,
  changedNodeIds,
  errorMessage,
  nodeTitle,
  type AuthoringCommand,
} from './model.js';
import { Outline } from './outline.js';
import { JourneySettings, NodeProperties } from './properties.js';
import { Dialog, PublishPanel, reasonField } from './publish.js';
import { ReviewPanel } from './review.js';
import {
  clearRecovery,
  editorDocument,
  editorReducer,
  initialEditorState,
  isDirty,
  loadRecovery,
  recoveryKey,
  saveRecovery,
  type EditorAction,
  type EditorState,
} from './state.js';
import { serverTime } from './server-time.js';
import { TemplateCatalog, TemplateUpgrade } from './templates.js';
import './journey-authoring.css';

export const DESKTOP_QUERY = '(min-width: 960px)';

function useDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = () => setDesktop(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}

function codeOf(error: unknown) {
  return error instanceof JourneyAuthoringApiError ? error.code : undefined;
}

type Loaded = { state: EditorState | null };
type RootAction = EditorAction | { type: 'INIT'; snapshot: JourneySnapshot };

function rootReducer(current: Loaded, action: RootAction): Loaded {
  if (action.type === 'INIT') return { state: initialEditorState(action.snapshot) };
  return current.state ? { state: editorReducer(current.state, action) } : current;
}

// ── Editor ──────────────────────────────────────────────────────────────────

function JourneyEditor({
  api,
  journeyId,
  scope,
  storage,
  readOnly,
  onBack,
}: {
  api: JourneyAuthoringApi;
  journeyId: string;
  scope: string;
  storage: Storage;
  readOnly: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation('journeys');
  const [{ state }, dispatch] = useReducer(rootReducer, { state: null });
  // error เก็บเป็น code แล้วแปลตอน render — สลับภาษาแล้วข้อความเปลี่ยนตาม
  const [loadError, setLoadError] = useState<{ code?: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ code?: string } | null>(null);
  const [recoveryOffer, setRecoveryOffer] = useState<AuthoringCommand[] | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const saveIntent = useRef<{ body: string; key: string } | null>(null);
  const headingId = useId();

  const fetchSnapshot = useCallback(async () => {
    try {
      return await api.journey(journeyId);
    } catch (error) {
      // มองไม่เห็นแล้ว (ลบสิทธิ์/ย้ายทีม): ล้าง recovery ของ resource นี้ทิ้งทันที
      if (error instanceof JourneyAuthoringApiError && [403, 404].includes(error.status))
        clearRecovery(storage, scope, journeyId);
      throw error;
    }
  }, [api, journeyId, scope, storage]);

  useEffect(() => {
    let cancelled = false;
    fetchSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({ type: 'INIT', snapshot });
        if (!readOnly) {
          const saved = loadRecovery(
            storage,
            recoveryKey(scope, journeyId, snapshot.draft.revision),
          );
          if (saved) setRecoveryOffer(saved);
        }
      })
      .catch((error: unknown) => !cancelled && setLoadError({ code: codeOf(error) }));
    return () => {
      cancelled = true;
    };
  }, [fetchSnapshot, journeyId, readOnly, scope, storage]);

  const baseRevision = state?.snapshot.draft.revision;
  const commands = state?.commands;
  useEffect(() => {
    if (readOnly || baseRevision === undefined || !commands || recoveryOffer) return;
    saveRecovery(storage, recoveryKey(scope, journeyId, baseRevision), commands);
  }, [baseRevision, commands, journeyId, readOnly, recoveryOffer, scope, storage]);

  useEffect(() => {
    if (state?.rejected) setAnnouncement(t('editor.rejected', { reason: state.rejected }));
  }, [state?.rejected, t]);

  const refresh = useCallback(async () => {
    const snapshot = await fetchSnapshot();
    dispatch({ type: 'SNAPSHOT', snapshot });
  }, [fetchSnapshot]);

  if (loadError) {
    return (
      <section className="j5-panel" role="alert">
        <h1>{t('editor.loadFailed')}</h1>
        <p>{errorMessage(loadError.code)}</p>
        <Button onPress={onBack}>{t('editor.backToList')}</Button>
      </section>
    );
  }
  if (!state) return <p role="status">{t('editor.loading')}</p>;

  const document = editorDocument(state);
  const dirty = isDirty(state);
  const { head, permissions } = state.snapshot;
  // U1.3 (#431): ผู้ที่ไม่มี journey.edit (เช่น reviewer) เห็นแบบอ่านอย่างเดียว — server ตรวจซ้ำอยู่แล้ว
  const editable = !readOnly && head.lifecycle !== 'DEPRECATED' && permissions.edit;
  const counts = diagnosticCounts(state.diagnostics);
  const command = (next: AuthoringCommand) => {
    if (editable) dispatch({ type: 'COMMAND', command: next });
  };
  const select = (nodeId: string) => dispatch({ type: 'SELECT', nodeId });
  const focusNode = (nodeId: string) => {
    select(nodeId);
    const target =
      window.document.getElementById(nodeDomId('canvas', nodeId)) ??
      window.document.getElementById(nodeDomId('outline', nodeId));
    target?.focus();
  };

  const save = async () => {
    const body = {
      expectedHeadVersion: head.version,
      expectedDraftRevision: head.currentDraftRevision,
      expectedDraftDigest: head.currentDraftDigest,
      document,
    };
    const serialized = JSON.stringify(body);
    if (saveIntent.current?.body !== serialized)
      saveIntent.current = { body: serialized, key: `draft-${crypto.randomUUID()}` };
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.saveDraft(journeyId, body, saveIntent.current.key);
      saveIntent.current = null;
      clearRecovery(storage, scope, journeyId);
      dispatch({ type: 'SNAPSHOT', snapshot: await fetchSnapshot() });
      dispatch({ type: 'DIAGNOSTICS', diagnostics: result.diagnostics });
      setAnnouncement(t('editor.saved', { revision: result.draftRevision }));
    } catch (error) {
      if (error instanceof JourneyAuthoringApiError && error.conflict) {
        saveIntent.current = null;
        dispatch({ type: 'CONFLICT', latest: await fetchSnapshot() });
        setAnnouncement(t('editor.conflictAnnounce'));
      } else {
        if (error instanceof JourneyAuthoringApiError) {
          saveIntent.current = null;
          dispatch({ type: 'DIAGNOSTICS', diagnostics: error.diagnostics });
        }
        setSaveError({ code: codeOf(error) });
      }
    } finally {
      setSaving(false);
    }
  };

  const validate = async () => {
    try {
      const result = await api.validate(journeyId, {
        draftRevision: head.currentDraftRevision,
        draftDigest: head.currentDraftDigest,
      });
      dispatch({ type: 'DIAGNOSTICS', diagnostics: result.diagnostics });
    } catch (error) {
      setSaveError({ code: codeOf(error) });
    }
  };

  const compile = async () => {
    const result = await api.compile(journeyId, {
      draftRevision: head.currentDraftRevision,
      draftDigest: head.currentDraftDigest,
      expectedHeadVersion: head.version,
    });
    dispatch({ type: 'COMPILED', compile: result });
  };

  const discard = async (reasonCode: string) => {
    setDiscarding(false);
    try {
      await api.discardDraft(
        journeyId,
        {
          expectedHeadVersion: head.version,
          expectedDraftRevision: head.currentDraftRevision,
          expectedDraftDigest: head.currentDraftDigest,
          reasonCode,
        },
        `discard-${crypto.randomUUID()}`,
      );
      clearRecovery(storage, scope, journeyId);
      await refresh();
      setAnnouncement(t('editor.discarded'));
    } catch (error) {
      setSaveError({ code: codeOf(error) });
    }
  };

  const conflict = state.conflict;
  const changed = conflict ? changedNodeIds(conflict.draft.document, document) : [];

  return (
    <div
      className="j5-editor"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (!editable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
          event.preventDefault();
          dispatch({ type: event.shiftKey ? 'REDO' : 'UNDO' });
        }
      }}
    >
      <div className="j5-title-row">
        <div>
          <button type="button" className="j5-link" onClick={onBack}>
            {t('editor.back')}
          </button>
          <h1 id={headingId}>{document.settings.name}</h1>
          <p className="j5-help">
            {t('editor.statusLine', {
              lifecycle: head.lifecycle,
              revision: head.currentDraftRevision,
            })}
            {dirty ? t('editor.unsaved', { count: state.commands.length }) : t('editor.savedState')}
          </p>
        </div>
        {editable ? (
          <div className="j5-button-row">
            <Button
              isDisabled={state.commands.length === 0}
              onPress={() => dispatch({ type: 'UNDO' })}
            >
              {t('editor.undo')}
            </Button>
            <Button
              isDisabled={state.undone.length === 0}
              onPress={() => dispatch({ type: 'REDO' })}
            >
              {t('editor.redo')}
            </Button>
            {head.activeVersion !== null ? (
              <Button onPress={() => setDiscarding(true)}>{t('editor.discardDraft')}</Button>
            ) : null}
            <Button
              variant="primary"
              isDisabled={!dirty || saving || conflict !== null}
              onPress={() => void save()}
            >
              {saving ? t('editor.saving') : t('editor.save')}
            </Button>
          </div>
        ) : null}
      </div>

      <p className="j5-live" role="status" aria-live="polite">
        {announcement}
      </p>
      {readOnly ? (
        <p className="j5-boundary" role="note">
          {t('editor.readOnlyNote')}
        </p>
      ) : head.lifecycle === 'DEPRECATED' ? (
        <p className="j5-boundary" role="note">
          {t('editor.deprecatedNote')}
        </p>
      ) : null}
      {saveError ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(saveError.code)}
        </p>
      ) : null}
      {state.dropped > 0 ? (
        <p className="j5-status-error" role="alert">
          {t('editor.dropped', { count: state.dropped })}
        </p>
      ) : null}
      {recoveryOffer ? (
        <div className="j5-recovery" role="alert">
          <p>{t('editor.recoveryFound', { count: recoveryOffer.length })}</p>
          <div className="j5-button-row">
            <Button
              variant="primary"
              onPress={() => {
                dispatch({ type: 'RESTORE', commands: recoveryOffer });
                setRecoveryOffer(null);
              }}
            >
              {t('editor.recoveryRestore')}
            </Button>
            <Button
              onPress={() => {
                clearRecovery(storage, scope, journeyId);
                setRecoveryOffer(null);
              }}
            >
              {t('editor.recoveryDiscard')}
            </Button>
          </div>
        </div>
      ) : null}
      {conflict ? (
        <section className="j5-recovery" role="alert" aria-labelledby="j5-conflict-heading">
          <h2 id="j5-conflict-heading">{t('editor.conflictTitle')}</h2>
          <p>
            {t('editor.conflictBody', {
              revision: conflict.head.currentDraftRevision,
              changes:
                changed.length > 0
                  ? changed.map((nodeId) => nodeTitle(document, nodeId)).join(', ')
                  : t('editor.conflictSettingsOnly'),
            })}
          </p>
          <div className="j5-button-row">
            <Button
              onPress={() => {
                clearRecovery(storage, scope, journeyId);
                dispatch({ type: 'SNAPSHOT', snapshot: conflict });
              }}
            >
              {t('editor.conflictReload')}
            </Button>
            <Button
              variant="primary"
              onPress={() => dispatch({ type: 'SNAPSHOT', snapshot: conflict, keepCommands: true })}
            >
              {t('editor.conflictKeep')}
            </Button>
          </div>
        </section>
      ) : null}

      <div className="j5-workspace">
        <section className="j5-panel j5-pane-outline" aria-labelledby="j5-outline-heading">
          <h2 id="j5-outline-heading">{t('editor.outline')}</h2>
          <Outline
            document={document}
            selectedNodeId={state.selectedNodeId}
            readOnly={!editable}
            diagnosticCounts={counts}
            onSelect={select}
            onCommand={command}
          />
        </section>
        <section className="j5-panel j5-pane-canvas" aria-labelledby="j5-canvas-heading">
          <h2 id="j5-canvas-heading">{t('editor.canvas')}</h2>
          <Canvas
            document={document}
            selectedNodeId={state.selectedNodeId}
            readOnly={!editable}
            diagnosticCounts={counts}
            onSelect={select}
            onCommand={command}
          />
        </section>
        <section className="j5-panel j5-pane-properties" aria-labelledby="j5-properties-heading">
          <h2 id="j5-properties-heading">
            {state.selectedNodeId
              ? nodeTitle(document, state.selectedNodeId)
              : t('editor.settings')}
          </h2>
          {state.selectedNodeId ? (
            <>
              <NodeProperties
                document={document}
                nodeId={state.selectedNodeId}
                readOnly={!editable}
                onCommand={command}
              />
              <button
                type="button"
                className="j5-link"
                onClick={() => dispatch({ type: 'SELECT', nodeId: null })}
              >
                {t('editor.backToSettings')}
              </button>
            </>
          ) : (
            <JourneySettings document={document} readOnly={!editable} onCommand={command} />
          )}
        </section>
      </div>

      <div className="j5-lower">
        <section className="j5-panel" aria-labelledby="j5-diagnostics-heading">
          <h2 id="j5-diagnostics-heading">{t('editor.diagnostics')}</h2>
          {readOnly ? null : (
            <Button isDisabled={dirty} onPress={() => void validate()}>
              {t('editor.validate')}
            </Button>
          )}
          <Diagnostics
            document={document}
            diagnostics={state.diagnostics}
            checked={!dirty && (state.diagnostics.length > 0 || state.compile !== null)}
            onFocusNode={focusNode}
          />
        </section>
        <section className="j5-panel" aria-labelledby="j5-review-heading">
          <h2 id="j5-review-heading">{t('editor.review')}</h2>
          {readOnly ? (
            <p>
              {state.snapshot.review
                ? t('editor.reviewState', { state: state.snapshot.review.state })
                : t('editor.notSubmitted')}
            </p>
          ) : (
            <ReviewPanel
              api={api}
              snapshot={state.snapshot}
              compile={state.compile}
              dirty={dirty}
              readOnly={!editable}
              onCompile={compile}
              onChanged={refresh}
            />
          )}
        </section>
        <section className="j5-panel" aria-labelledby="j5-publish-heading">
          <h2 id="j5-publish-heading">{t('editor.publish')}</h2>
          <PublishPanel
            api={api}
            snapshot={state.snapshot}
            compile={state.compile}
            dirty={dirty}
            readOnly={readOnly}
            onChanged={refresh}
          />
        </section>
        <AuditTimeline api={api} journeyId={state.snapshot.head.journeyId} />
        <TemplateUpgrade
          api={api}
          snapshot={state.snapshot}
          dirty={dirty}
          readOnly={!editable}
          onChanged={refresh}
        />
      </div>
      {discarding ? (
        <Dialog
          title={t('editor.discardTitle')}
          body={<p>{t('editor.discardBody', { version: head.activeVersion })}</p>}
          fields={[reasonField()]}
          confirmLabel={t('editor.discardTitle')}
          danger
          onCancel={() => setDiscarding(false)}
          onConfirm={(values) => void discard(values.reasonCode!)}
        />
      ) : null}
    </div>
  );
}

// ── List ────────────────────────────────────────────────────────────────────

function BlankJourneyForm({
  api,
  onCreated,
}: {
  api: JourneyAuthoringApi;
  onCreated: (journeyId: string) => void;
}) {
  const ids = {
    name: useId(),
    team: useId(),
    event: useId(),
    sender: useId(),
    purpose: useId(),
  };
  const [values, setValues] = useState({
    name: '',
    team: '',
    event: '',
    sender: '',
    purpose: 'SERVICE',
  });
  const { t } = useTranslation('journeys');
  const [error, setError] = useState<{ code?: string } | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const field = (name: keyof typeof values, label: string) => (
    <div className="j5-field">
      <label htmlFor={ids[name]}>{label}</label>
      <input
        id={ids[name]}
        value={values[name]}
        required
        onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
      />
    </div>
  );
  const complete = Object.values(values).every((value) => value.trim().length > 0);
  return (
    <section className="j5-panel" aria-labelledby="j5-blank-heading">
      <h2 id="j5-blank-heading">{t('blank.heading')}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const intent = key ?? `create-${crypto.randomUUID()}`;
          setKey(intent);
          setError(null);
          api
            .createJourney(
              {
                ownerTeamId: values.team.trim(),
                document: blankDocument({
                  name: values.name.trim(),
                  eventType: values.event.trim(),
                  senderIdentityId: values.sender.trim(),
                  purpose: values.purpose.trim(),
                }),
              },
              intent,
            )
            .then((result) => onCreated(result.journeyId))
            .catch((failure: unknown) => {
              if (failure instanceof JourneyAuthoringApiError) setKey(null);
              setError({ code: codeOf(failure) });
            });
        }}
      >
        {field('name', t('blank.name'))}
        {field('team', t('blank.team'))}
        {field('event', t('blank.event'))}
        {field('sender', t('blank.sender'))}
        {field('purpose', t('blank.purpose'))}
        <Button type="submit" variant="primary" isDisabled={!complete}>
          {t('blank.submit')}
        </Button>
      </form>
      {error ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(error.code)}
        </p>
      ) : null}
    </section>
  );
}

function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

type ListFilter = 'ALL' | 'PENDING_REVIEW';

/** U1.3 (#431): review ที่รอผู้ใช้คนนี้ตัดสิน — รายการกรองสิทธิ์ที่ server ทั้งหมด */
function PendingReviewList({
  api,
  onOpen,
}: {
  api: JourneyAuthoringApi;
  onOpen: (journeyId: string) => void;
}) {
  const { t } = useTranslation('journeys');
  // เวลาของ server แสดงตาม timezone/ภาษาของผู้ใช้ (formatter กลาง D1.11)
  const { formatters } = useLocale();
  const [items, setItems] = useState<PendingReview[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string } | null>(null);
  const load = useCallback(
    (after?: string) =>
      api
        .pendingReviews(after ? { cursor: after } : {})
        .then((page) => {
          setItems((current) => (after ? [...(current ?? []), ...page.items] : page.items));
          setCursor(page.nextCursor);
        })
        .catch((failure: unknown) => setError({ code: codeOf(failure) })),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      {error ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(error.code)}
        </p>
      ) : null}
      {items === null && !error ? <p role="status">{t('common.loading')}</p> : null}
      {items?.length === 0 ? <p>{t('pending.empty')}</p> : null}
      {items && items.length > 0 ? (
        <div className="j5-table-scroll">
          <table className="j5-table">
            <caption className="j5-sr">{t('pending.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('pending.col.journey')}</th>
                <th scope="col">{t('pending.col.draft')}</th>
                <th scope="col">{t('pending.col.compileDigest')}</th>
                <th scope="col">{t('pending.col.submittedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.reviewId}>
                  <td>
                    <button
                      type="button"
                      className="j5-link"
                      onClick={() => onOpen(item.journeyId)}
                    >
                      {item.journeyName}
                    </button>
                  </td>
                  <td>{t('common.revision', { revision: item.draftRevision })}</td>
                  <td>
                    <code>{shortDigest(item.compileDigest)}</code>
                  </td>
                  <td>
                    <time dateTime={item.submittedAt}>
                      {serverTime(formatters, item.submittedAt)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {cursor ? <Button onPress={() => void load(cursor)}>{t('common.loadMore')}</Button> : null}
    </>
  );
}

function JourneyList({
  api,
  readOnly,
  onOpen,
}: {
  api: JourneyAuthoringApi;
  readOnly: boolean;
  onOpen: (journeyId: string) => void;
}) {
  const { t } = useTranslation('journeys');
  const [filter, setFilter] = useState<ListFilter>('ALL');
  const [items, setItems] = useState<JourneySummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string } | null>(null);
  const load = useCallback(
    (after?: string) =>
      api
        .listJourneys(after ? { cursor: after } : {})
        .then((page) => {
          setItems((current) => (after ? [...(current ?? []), ...page.items] : page.items));
          setCursor(page.nextCursor);
        })
        .catch((failure: unknown) => setError({ code: codeOf(failure) })),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <h1>{t('list.title')}</h1>
      {readOnly ? (
        <p className="j5-boundary" role="note">
          {t('list.readOnlyNote')}
        </p>
      ) : null}
      <section className="j5-panel" aria-labelledby="j5-list-heading">
        <h2 id="j5-list-heading">
          {filter === 'ALL' ? t('list.headingAll') : t('list.headingPending')}
        </h2>
        <div className="j5-segmented" role="group" aria-label={t('list.filterLabel')}>
          <button type="button" aria-pressed={filter === 'ALL'} onClick={() => setFilter('ALL')}>
            {t('list.filterAll')}
          </button>
          <button
            type="button"
            aria-pressed={filter === 'PENDING_REVIEW'}
            onClick={() => setFilter('PENDING_REVIEW')}
          >
            {t('list.filterPending')}
          </button>
        </div>
        {filter === 'PENDING_REVIEW' ? (
          <PendingReviewList api={api} onOpen={onOpen} />
        ) : (
          <>
            {error ? (
              <p className="j5-status-error" role="alert">
                {errorMessage(error.code)}
              </p>
            ) : null}
            {items === null && !error ? <p role="status">{t('common.loading')}</p> : null}
            {items?.length === 0 ? <p>{t('list.empty')}</p> : null}
            {items && items.length > 0 ? (
              <div className="j5-table-scroll">
                <table className="j5-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('list.col.name')}</th>
                      <th scope="col">{t('list.col.status')}</th>
                      <th scope="col">{t('list.col.review')}</th>
                      <th scope="col">{t('list.col.activeVersion')}</th>
                      <th scope="col">{t('list.col.draft')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.journeyId}>
                        <td>
                          <button
                            type="button"
                            className="j5-link"
                            onClick={() => onOpen(item.journeyId)}
                          >
                            {item.name}
                          </button>
                        </td>
                        <td>{item.lifecycle}</td>
                        <td>
                          {item.reviewState
                            ? t(`list.reviewState.${item.reviewState}`)
                            : t('common.none')}
                        </td>
                        <td>{item.activeVersion ?? t('common.none')}</td>
                        <td>{t('common.revision', { revision: item.currentDraftRevision })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {cursor ? (
              <Button onPress={() => void load(cursor)}>{t('common.loadMore')}</Button>
            ) : null}
          </>
        )}
      </section>
      {readOnly ? null : (
        <div className="j5-lower">
          <BlankJourneyForm api={api} onCreated={onOpen} />
          <TemplateCatalog api={api} readOnly={readOnly} onInstantiated={onOpen} />
        </div>
      )}
    </>
  );
}

/**
 * U1.3 (#431): timeline ของ audit จาก server — actor เป็น opaque id, เวลาเป็นเวลา server
 * การอ่าน audit ถูกบันทึกเป็น audit เอง จึงโหลดเมื่อผู้ใช้กดเท่านั้น
 */
function AuditTimeline({ api, journeyId }: { api: JourneyAuthoringApi; journeyId: string }) {
  const { t } = useTranslation('journeys');
  const { formatters } = useLocale();
  const [items, setItems] = useState<JourneyAuditEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code?: string } | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setItems((await api.audit(journeyId)).items);
    } catch (failure) {
      setError({ code: codeOf(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="j5-panel" aria-labelledby="j5-audit-heading">
      <h2 id="j5-audit-heading">{t('audit.heading')}</h2>
      <Button isDisabled={busy} onPress={() => void load()}>
        {items === null ? t('audit.show') : t('audit.reload')}
      </Button>
      {error ? (
        <p className="j5-status-error" role="alert">
          {errorMessage(error.code)}
        </p>
      ) : null}
      {items?.length === 0 ? <p role="status">{t('audit.empty')}</p> : null}
      {items && items.length > 0 ? (
        <ol className="j5-audit" aria-label={t('audit.listLabel')}>
          {items.map((entry) => (
            <li key={entry.id}>
              <time dateTime={entry.occurredAt}>{serverTime(formatters, entry.occurredAt)}</time>{' '}
              <strong>{entry.action}</strong> · {t('audit.user')}{' '}
              <code>{entry.actorSubjectId.slice(0, 8)}</code> · {t('audit.reason')}{' '}
              {entry.reasonCode} · {t('audit.correlation')} <code>{entry.correlationId}</code>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

// ── Root ────────────────────────────────────────────────────────────────────

export function JourneyAuthoringConsole({
  api,
  scope,
  initialJourneyId,
  storage = window.sessionStorage,
}: {
  api: JourneyAuthoringApi;
  /** tenant alias/session — ผูก session recovery ไม่ให้ข้าม tenant */
  scope: string;
  initialJourneyId?: string;
  storage?: Storage;
}) {
  const { t } = useTranslation('journeys');
  const inShell = useInShell();
  const tokensReady = useShellTokens();
  const desktop = useDesktop();
  const [journeyId, setJourneyId] = useState<string | null>(initialJourneyId ?? null);
  const mainRef = useRef<HTMLDivElement>(null);
  const open = (next: string | null) => {
    setJourneyId(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('journey', next);
    else url.searchParams.delete('journey');
    window.history.replaceState(null, '', url);
    mainRef.current?.focus();
  };
  // token มาก่อนเนื้อหา — ไม่ให้เห็นหน้าที่ยังไม่มีสี (โหลดครั้งเดียวต่อหน้า)
  if (!tokensReady) return null;
  const content = journeyId ? (
    <JourneyEditor
      key={journeyId}
      api={api}
      journeyId={journeyId}
      scope={scope}
      storage={storage}
      readOnly={!desktop}
      onBack={() => open(null)}
    />
  ) : (
    <JourneyList api={api} readOnly={!desktop} onOpen={(next) => open(next)} />
  );
  // ใน AppShell: shell เป็นเจ้าของ skip link/header/main — เนื้อหาไม่วาด landmark ซ้ำ
  if (inShell) {
    return (
      <div ref={mainRef} tabIndex={-1} className="j5-root j5-in-shell">
        {content}
      </div>
    );
  }
  return (
    <div className="j5-root j5-legacy">
      <a className="j5-skip" href="#j5-main">
        {t('root.skip')}
      </a>
      <header className="j5-legacy-header">
        <strong>{t('root.brand')}</strong>
        <span>{t('root.title')}</span>
        <span className="j5-viewer">{desktop ? t('root.modeEdit') : t('root.modeRead')}</span>
      </header>
      <main id="j5-main" className="j5-legacy-main">
        <div ref={mainRef} tabIndex={-1}>
          {content}
        </div>
      </main>
    </div>
  );
}
