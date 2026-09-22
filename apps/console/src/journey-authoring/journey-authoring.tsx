/**
 * J5.6 (#344): หน้า Journey authoring ของ Console (Phase Spec #337 §8)
 *
 * - desktop ≥960px แก้ได้เต็ม: outline + canvas + properties; ต่ำกว่า 960px อ่านอย่างเดียวพร้อมเหตุผล
 *   และไม่มีปุ่มที่ส่ง mutation เลย
 * - สิทธิ์, review, publish และ rollout มาจาก server — ถ้า server ปฏิเสธจะเห็น code ที่ได้จริง
 * - `409` ตอนบันทึกเปิดทางเลือกให้ผู้ใช้: ดูความต่าง, โหลดฉบับล่าสุด หรือเก็บการแก้ของตัวเองไปต่อ
 */
import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import {
  JourneyAuthoringApiError,
  type JourneyAuthoringApi,
  type JourneySnapshot,
  type JourneySummary,
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
import { Dialog, PublishPanel, REASON_FIELD } from './publish.js';
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
  const [{ state }, dispatch] = useReducer(rootReducer, { state: null });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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
      .catch((error: unknown) => !cancelled && setLoadError(errorMessage(codeOf(error))));
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
    if (state?.rejected) setAnnouncement(`ทำคำสั่งไม่ได้: ${state.rejected}`);
  }, [state?.rejected]);

  const refresh = useCallback(async () => {
    const snapshot = await fetchSnapshot();
    dispatch({ type: 'SNAPSHOT', snapshot });
  }, [fetchSnapshot]);

  if (loadError) {
    return (
      <section className="gov-panel" role="alert">
        <h1>เปิด Journey ไม่ได้</h1>
        <p>{loadError}</p>
        <button type="button" className="gov-secondary" onClick={onBack}>
          กลับไปหน้ารายการ
        </button>
      </section>
    );
  }
  if (!state) return <p role="status">กำลังโหลด Journey…</p>;

  const document = editorDocument(state);
  const dirty = isDirty(state);
  const { head } = state.snapshot;
  const editable = !readOnly && head.lifecycle !== 'DEPRECATED';
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
      setAnnouncement(`บันทึกเป็น revision ${result.draftRevision} แล้ว`);
    } catch (error) {
      if (error instanceof JourneyAuthoringApiError && error.conflict) {
        saveIntent.current = null;
        dispatch({ type: 'CONFLICT', latest: await fetchSnapshot() });
        setAnnouncement('บันทึกไม่ได้ เพราะฉบับร่างถูกแก้โดยผู้อื่น');
      } else {
        if (error instanceof JourneyAuthoringApiError) {
          saveIntent.current = null;
          dispatch({ type: 'DIAGNOSTICS', diagnostics: error.diagnostics });
        }
        setSaveError(errorMessage(codeOf(error)));
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
      setSaveError(errorMessage(codeOf(error)));
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
      setAnnouncement('กลับไปใช้เนื้อหาของ version ที่ใช้งานอยู่แล้ว');
    } catch (error) {
      setSaveError(errorMessage(codeOf(error)));
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
      <div className="gov-title-row">
        <div>
          <button type="button" className="gov-link" onClick={onBack}>
            ← รายการ Journey
          </button>
          <h1 id={headingId}>{document.settings.name}</h1>
          <p className="j5-help">
            {head.lifecycle} · revision {head.currentDraftRevision}
            {dirty
              ? ` · มีการแก้ไขที่ยังไม่บันทึก ${state.commands.length} รายการ`
              : ' · บันทึกแล้ว'}
          </p>
        </div>
        {editable ? (
          <div className="j5-button-row">
            <button
              type="button"
              className="gov-secondary"
              disabled={state.commands.length === 0}
              onClick={() => dispatch({ type: 'UNDO' })}
            >
              เลิกทำ
            </button>
            <button
              type="button"
              className="gov-secondary"
              disabled={state.undone.length === 0}
              onClick={() => dispatch({ type: 'REDO' })}
            >
              ทำซ้ำ
            </button>
            {head.activeVersion !== null ? (
              <button type="button" className="gov-secondary" onClick={() => setDiscarding(true)}>
                ทิ้งฉบับร่าง
              </button>
            ) : null}
            <button
              type="button"
              className="gov-primary"
              disabled={!dirty || saving || conflict !== null}
              onClick={() => void save()}
            >
              {saving ? 'กำลังบันทึก…' : 'บันทึกฉบับร่าง'}
            </button>
          </div>
        ) : null}
      </div>

      <p className="gov-live" role="status" aria-live="polite">
        {announcement}
      </p>
      {readOnly ? (
        <p className="gov-boundary" role="note">
          หน้าจอกว้างน้อยกว่า 960px จึงเปิดแบบอ่านอย่างเดียว เพื่อไม่ให้แก้ graph
          บนพื้นที่ที่ตรวจสอบได้ไม่ครบ ใช้หน้าจอที่กว้างขึ้นเพื่อแก้ไข
        </p>
      ) : head.lifecycle === 'DEPRECATED' ? (
        <p className="gov-boundary" role="note">
          Journey นี้เลิกใช้แล้ว จึงแก้ไขไม่ได้
        </p>
      ) : null}
      {saveError ? (
        <p className="j5-status-error" role="alert">
          {saveError}
        </p>
      ) : null}
      {state.dropped > 0 ? (
        <p className="j5-status-error" role="alert">
          การแก้ไข {state.dropped} รายการใช้กับฉบับล่าสุดไม่ได้และถูกตัดออก
        </p>
      ) : null}
      {recoveryOffer ? (
        <div className="gov-recovery" role="alert">
          <p>พบการแก้ไขที่ยังไม่บันทึกจากแท็บนี้ {recoveryOffer.length} รายการ</p>
          <div className="j5-button-row">
            <button
              type="button"
              className="gov-primary"
              onClick={() => {
                dispatch({ type: 'RESTORE', commands: recoveryOffer });
                setRecoveryOffer(null);
              }}
            >
              กู้คืนการแก้ไข
            </button>
            <button
              type="button"
              className="gov-secondary"
              onClick={() => {
                clearRecovery(storage, scope, journeyId);
                setRecoveryOffer(null);
              }}
            >
              ทิ้งการแก้ไขที่ค้าง
            </button>
          </div>
        </div>
      ) : null}
      {conflict ? (
        <section className="gov-recovery" role="alert" aria-labelledby="j5-conflict-heading">
          <h2 id="j5-conflict-heading">ฉบับร่างถูกแก้โดยผู้อื่น</h2>
          <p>
            ฉบับล่าสุดคือ revision {conflict.head.currentDraftRevision} · ขั้นตอนที่ต่างจากของคุณ:{' '}
            {changed.length > 0
              ? changed.map((nodeId) => nodeTitle(document, nodeId)).join(', ')
              : 'ต่างเฉพาะ settings/layout'}
          </p>
          <div className="j5-button-row">
            <button
              type="button"
              className="gov-secondary"
              onClick={() => {
                clearRecovery(storage, scope, journeyId);
                dispatch({ type: 'SNAPSHOT', snapshot: conflict });
              }}
            >
              โหลดฉบับล่าสุด (ทิ้งการแก้ของฉัน)
            </button>
            <button
              type="button"
              className="gov-primary"
              onClick={() => dispatch({ type: 'SNAPSHOT', snapshot: conflict, keepCommands: true })}
            >
              ใช้การแก้ของฉันต่อบนฉบับล่าสุด
            </button>
          </div>
        </section>
      ) : null}

      <div className="j5-workspace">
        <section className="gov-panel j5-pane-outline" aria-labelledby="j5-outline-heading">
          <h2 id="j5-outline-heading">โครงสร้าง</h2>
          <Outline
            document={document}
            selectedNodeId={state.selectedNodeId}
            readOnly={!editable}
            diagnosticCounts={counts}
            onSelect={select}
            onCommand={command}
          />
        </section>
        <section className="gov-panel j5-pane-canvas" aria-labelledby="j5-canvas-heading">
          <h2 id="j5-canvas-heading">ผังการทำงาน</h2>
          <Canvas
            document={document}
            selectedNodeId={state.selectedNodeId}
            readOnly={!editable}
            diagnosticCounts={counts}
            onSelect={select}
            onCommand={command}
          />
        </section>
        <section className="gov-panel j5-pane-properties" aria-labelledby="j5-properties-heading">
          <h2 id="j5-properties-heading">
            {state.selectedNodeId ? nodeTitle(document, state.selectedNodeId) : 'ตั้งค่า Journey'}
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
                className="gov-link"
                onClick={() => dispatch({ type: 'SELECT', nodeId: null })}
              >
                กลับไปตั้งค่า Journey
              </button>
            </>
          ) : (
            <JourneySettings document={document} readOnly={!editable} onCommand={command} />
          )}
        </section>
      </div>

      <div className="j5-lower">
        <section className="gov-panel" aria-labelledby="j5-diagnostics-heading">
          <h2 id="j5-diagnostics-heading">ผลตรวจจาก server</h2>
          {readOnly ? null : (
            <button
              type="button"
              className="gov-secondary"
              disabled={dirty}
              onClick={() => void validate()}
            >
              ตรวจฉบับร่างที่บันทึกแล้ว
            </button>
          )}
          <Diagnostics
            document={document}
            diagnostics={state.diagnostics}
            checked={!dirty && (state.diagnostics.length > 0 || state.compile !== null)}
            onFocusNode={focusNode}
          />
        </section>
        <section className="gov-panel" aria-labelledby="j5-review-heading">
          <h2 id="j5-review-heading">Compile และการตรวจ</h2>
          {readOnly ? (
            <p>
              {state.snapshot.review
                ? `สถานะการตรวจ: ${state.snapshot.review.state}`
                : 'ยังไม่ได้ส่งตรวจ'}
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
        <section className="gov-panel" aria-labelledby="j5-publish-heading">
          <h2 id="j5-publish-heading">Publish</h2>
          <PublishPanel
            api={api}
            snapshot={state.snapshot}
            compile={state.compile}
            dirty={dirty}
            readOnly={readOnly}
            onChanged={refresh}
          />
        </section>
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
          title="ทิ้งฉบับร่าง"
          body={
            <p>
              ฉบับร่างจะกลับเป็นเนื้อหาของ version {head.activeVersion} เป็น revision ใหม่
              ประวัติเดิมยังอยู่
            </p>
          }
          fields={[REASON_FIELD]}
          confirmLabel="ทิ้งฉบับร่าง"
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
  const [error, setError] = useState<string | null>(null);
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
    <section className="gov-panel" aria-labelledby="j5-blank-heading">
      <h2 id="j5-blank-heading">สร้าง Journey เปล่า</h2>
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
              setError(errorMessage(codeOf(failure)));
            });
        }}
      >
        {field('name', 'ชื่อ Journey')}
        {field('team', 'ทีมเจ้าของ (team ID)')}
        {field('event', 'Event ที่เริ่ม Journey')}
        {field('sender', 'Sender identity')}
        {field('purpose', 'วัตถุประสงค์ (เช่น SERVICE)')}
        <button type="submit" className="gov-primary" disabled={!complete}>
          สร้างฉบับร่าง
        </button>
      </form>
      {error ? (
        <p className="j5-status-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
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
  const [items, setItems] = useState<JourneySummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (after?: string) =>
      api
        .listJourneys(after ? { cursor: after } : {})
        .then((page) => {
          setItems((current) => (after ? [...(current ?? []), ...page.items] : page.items));
          setCursor(page.nextCursor);
        })
        .catch((failure: unknown) => setError(errorMessage(codeOf(failure)))),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <>
      <h1>Journey authoring</h1>
      {readOnly ? (
        <p className="gov-boundary" role="note">
          หน้าจอกว้างน้อยกว่า 960px จึงดูได้อย่างเดียว การสร้างและแก้ไขต้องใช้หน้าจอที่กว้างขึ้น
        </p>
      ) : null}
      <section className="gov-panel" aria-labelledby="j5-list-heading">
        <h2 id="j5-list-heading">Journey ที่คุณมองเห็น</h2>
        {error ? (
          <p className="j5-status-error" role="alert">
            {error}
          </p>
        ) : null}
        {items === null && !error ? <p role="status">กำลังโหลด…</p> : null}
        {items?.length === 0 ? <p>ยังไม่มี Journey ที่คุณมองเห็น</p> : null}
        {items && items.length > 0 ? (
          <div className="j5-table-scroll">
            <table className="j5-table">
              <thead>
                <tr>
                  <th scope="col">ชื่อ</th>
                  <th scope="col">สถานะ</th>
                  <th scope="col">Version ที่ใช้งาน</th>
                  <th scope="col">ฉบับร่าง</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.journeyId}>
                    <td>
                      <button
                        type="button"
                        className="gov-link"
                        onClick={() => onOpen(item.journeyId)}
                      >
                        {item.name}
                      </button>
                    </td>
                    <td>{item.lifecycle}</td>
                    <td>{item.activeVersion ?? '—'}</td>
                    <td>revision {item.currentDraftRevision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {cursor ? (
          <button type="button" className="gov-secondary" onClick={() => void load(cursor)}>
            โหลดเพิ่ม
          </button>
        ) : null}
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
  const desktop = useDesktop();
  const [journeyId, setJourneyId] = useState<string | null>(initialJourneyId ?? null);
  const mainRef = useRef<HTMLElement>(null);
  const open = (next: string | null) => {
    setJourneyId(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('journey', next);
    else url.searchParams.delete('journey');
    window.history.replaceState(null, '', url);
    mainRef.current?.focus();
  };
  return (
    <div className="gov-shell j5-shell">
      <a className="gov-skip" href="#j5-main">
        ข้ามไปยังเนื้อหาหลัก
      </a>
      <header className="gov-header">
        <strong>D-CONTACT</strong>
        <span>Journey authoring</span>
        <span className="gov-viewer">{desktop ? 'โหมดแก้ไข' : 'โหมดอ่านอย่างเดียว'}</span>
      </header>
      <main id="j5-main" ref={mainRef} tabIndex={-1} className="gov-main">
        {journeyId ? (
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
        )}
      </main>
    </div>
  );
}
