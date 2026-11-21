/**
 * #956 แท็บ "เคส" ในแผงงาน: เปิดเคสจากงานปัจจุบันแบบ non-modal
 * ร่างเก็บใน state ของ WorkspaceApp ต่อ workId (ไม่เขียน localStorage เพราะมี PII)
 * จึงไม่หายเมื่อสลับแท็บหรือปิดแผงงาน
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Select, StatusChip, TextField, toastQueue } from '@d-contact/ui-react';
import { useTranslation } from '@d-contact/i18n/react';
import { AgentApiError, type AgentWorkspaceApi, type CaseTeamAgent } from './agent-api.js';
import {
  CASE_NOTE_MAX,
  CASE_SUBJECT_MAX,
  caseTextValid,
  classifyOpenCaseError,
  emptyCaseDraft,
  normalizeCaseText,
  type CaseDraft,
} from './case-draft.js';
import type { LinkedCustomer } from './work-customer-panel.js';
import './case-panel.css';

export function useCaseDrafts() {
  const [drafts, setDrafts] = useState<Record<string, CaseDraft>>({});
  const get = useCallback((workId: string) => drafts[workId] ?? emptyCaseDraft(), [drafts]);
  const update = useCallback(
    (workId: string, change: (draft: CaseDraft) => CaseDraft) =>
      setDrafts((current) => ({
        ...current,
        [workId]: change(current[workId] ?? emptyCaseDraft()),
      })),
    [],
  );
  return { get, update, has: (workId: string) => workId in drafts };
}

interface Props {
  api: AgentWorkspaceApi;
  workId: string;
  /** undefined = ยังโหลดลูกค้าไม่เสร็จ, null = ยังไม่ผูกลูกค้า */
  customer: LinkedCustomer | null | undefined;
  /** บันทึกผลงานนี้แล้ว จึงเปิดเคสจากงานนี้ไม่ได้ */
  workClosed: boolean;
  self: { userId: string; displayName: string };
  draft: CaseDraft;
  onDraftChange(change: (draft: CaseDraft) => CaseDraft): void;
  consoleHref(caseId: string): string | undefined;
  onPickCustomer(): void;
  /** เปลี่ยนค่าเมื่อผู้ใช้กดปุ่ม "เปิดเคส" ในแถบบริบท เพื่อย้าย focus มาที่ช่องหัวข้อ */
  focusToken: number;
}

export function CasePanel({
  api,
  workId,
  customer,
  workClosed,
  self,
  draft,
  onDraftChange,
  consoleHref,
  onPickCustomer,
  focusToken,
}: Props) {
  const { t } = useTranslation('workspace');
  const [team, setTeam] = useState<{
    status: 'loading' | 'ready' | 'failed';
    items: CaseTeamAgent[];
  }>({ status: 'loading', items: [] });
  const [teamRevision, setTeamRevision] = useState(0);
  const subjectRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    if (!api.caseTeamAgents) {
      setTeam({ status: 'failed', items: [] });
      return;
    }
    setTeam((current) => ({ ...current, status: 'loading' }));
    api.caseTeamAgents().then(
      (items) => active && setTeam({ status: 'ready', items }),
      (error: unknown) => {
        if (!active) return;
        if (error instanceof AgentApiError && error.status === 403) {
          onDraftChange((current) => ({ ...current, error: 'noTeam' }));
        }
        setTeam({ status: 'failed', items: [] });
      },
    );
    return () => {
      active = false;
    };
    // โหลดรายชื่อใหม่เมื่อผู้ใช้กดลองอีกครั้ง หรือหลังผู้รับผิดชอบถูกปฏิเสธ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, teamRevision]);

  useEffect(() => {
    if (focusToken === 0) return;
    if (draft.phase === 'created') createdRef.current?.focus();
    else subjectRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    // focus เฉพาะตอนผู้ใช้กดปุ่มในแถบบริบท ไม่ใช่ทุกครั้งที่ร่างเปลี่ยน
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  const subjectValid = caseTextValid(draft.subject, CASE_SUBJECT_MAX);
  const noteValid = caseTextValid(draft.note, CASE_NOTE_MAX);
  const locked = draft.phase === 'pending' || draft.phase === 'unknown';
  const canSubmit = Boolean(customer) && !workClosed && !locked;

  async function submit() {
    if (!api.openCase || !canSubmit) return;
    if (!subjectValid || !noteValid) {
      onDraftChange((current) => ({ ...current, attempted: true }));
      document.getElementById(subjectValid ? 'case-note' : 'case-subject')?.focus();
      return;
    }
    await send(draft);
  }

  /** ส่งร่างตามที่เห็นอยู่ ใช้ commandId ของร่าง จึงใช้ได้ทั้งการส่งครั้งแรกและการส่งคำสั่งเดิมซ้ำ */
  async function send(current: CaseDraft) {
    if (!api.openCase) return;
    const intent = {
      interactionId: workId,
      subject: normalizeCaseText(current.subject),
      note: normalizeCaseText(current.note),
      ...(current.assigneeUserId ? { assigneeUserId: current.assigneeUserId } : {}),
      commandId: current.commandId,
    };
    onDraftChange((value) => ({ ...value, phase: 'pending', error: undefined, attempted: true }));
    try {
      const opened = await api.openCase(intent);
      onDraftChange((value) => ({
        ...value,
        phase: 'created',
        error: undefined,
        created: {
          caseId: opened.caseId,
          subject: intent.subject,
          assigneeUserId: intent.assigneeUserId ?? self.userId,
        },
      }));
      toastQueue.add(
        { title: t('case.createdToast', { subject: intent.subject }), tone: 'success' },
        { timeout: 6000 },
      );
      requestAnimationFrame(() => createdRef.current?.focus());
    } catch (error) {
      const outcome = classifyOpenCaseError(error);
      if (outcome.phase === 'unknown') {
        onDraftChange((value) => ({ ...value, phase: 'unknown' }));
        return;
      }
      if (outcome.error === 'assigneeRejected') setTeamRevision((value) => value + 1);
      onDraftChange((value) => ({
        ...value,
        phase: 'editing',
        error: outcome.error,
        ...(outcome.newCommand ? { commandId: crypto.randomUUID() } : {}),
        ...(outcome.error === 'assigneeRejected' ? { assigneeUserId: '' } : {}),
      }));
    }
  }

  if (draft.error === 'noTeam') {
    return (
      <section className="aw-case" aria-labelledby="case-title">
        <h3 id="case-title" className="aw-detail-title">
          {t('case.title')}
        </h3>
        <p className="aw-case-banner" data-tone="brand" role="status">
          {t('case.noTeam')}
        </p>
      </section>
    );
  }

  if (draft.phase === 'created' && draft.created) {
    const href = consoleHref(draft.created.caseId);
    const assignee =
      draft.created.assigneeUserId === self.userId
        ? t('case.assigneeSelf', { name: self.displayName })
        : (team.items.find((item) => item.userId === draft.created?.assigneeUserId)?.displayName ??
          '—');
    return (
      <section className="aw-case" aria-live="polite">
        <h3 ref={createdRef} tabIndex={-1} className="aw-detail-title">
          {t('case.created')}
        </h3>
        <p className="aw-copy">{t('case.createdCopy')}</p>
        <dl className="aw-case-summary">
          <div>
            <dt>{t('case.subject')}</dt>
            <dd>{draft.created.subject}</dd>
          </div>
          <div>
            <dt>{t('case.status')}</dt>
            <dd>
              <StatusChip status="info">{t('case.statusValue.OPEN')}</StatusChip>
            </dd>
          </div>
          <div>
            <dt>{t('case.assignee')}</dt>
            <dd>{assignee}</dd>
          </div>
          <div>
            <dt>{t('case.customer')}</dt>
            <dd>{customer?.displayName ?? t('case.customerMissing')}</dd>
          </div>
        </dl>
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {t('case.openInConsole')}
          </a>
        ) : null}
        <Button variant="ghost" size="sm" onPress={() => onDraftChange(() => emptyCaseDraft())}>
          {t('case.openAnother')}
        </Button>
      </section>
    );
  }

  const assigneeOptions = [
    { id: '', label: t('case.assigneeSelf', { name: self.displayName }) },
    ...team.items
      .filter((item) => item.userId !== self.userId)
      .map((item) => ({ id: item.userId, label: item.displayName })),
  ];

  return (
    <section className="aw-case" aria-labelledby="case-title">
      <h3 id="case-title" className="aw-detail-title">
        {t('case.title')}
      </h3>
      <p className="aw-copy">{t('case.copy')}</p>
      {workClosed ? (
        <p className="aw-case-banner" data-tone="brand" role="status">
          {t('case.workClosed')}
        </p>
      ) : customer === null ? (
        <div className="aw-case-banner" data-tone="attention" role="status" id="case-unlinked">
          <p>{t('case.unlinked')}</p>
          <Button size="sm" variant="secondary" onPress={onPickCustomer}>
            {t('case.pickCustomer')}
          </Button>
        </div>
      ) : null}
      <dl className="aw-case-summary">
        <div>
          <dt>{t('case.customer')}</dt>
          <dd>
            {customer === undefined
              ? '…'
              : customer === null
                ? t('case.customerMissing')
                : [customer.displayName, customer.company].filter(Boolean).join(' · ') ||
                  t('case.customerMissing')}
          </dd>
        </div>
        <div>
          <dt>{t('case.linkedWork')}</dt>
          <dd className="aw-v3-mono">{workId}</dd>
        </div>
      </dl>
      {draft.phase === 'unknown' ? (
        <p className="aw-case-banner" data-tone="attention" role="alert">
          {t('case.unknown')}
        </p>
      ) : null}
      {draft.error === 'failed' || draft.error === 'invalid' ? (
        <p className="aw-case-banner" data-tone="critical" role="alert">
          {t('case.failed')}
        </p>
      ) : null}
      <form
        className="aw-case-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div ref={subjectRef}>
          <TextField
            id="case-subject"
            label={t('case.subject')}
            isRequired
            isReadOnly={locked || workClosed}
            maxLength={CASE_SUBJECT_MAX}
            value={draft.subject}
            onChange={(subject) => onDraftChange((current) => ({ ...current, subject }))}
            description={`${t('case.subjectHelp')} · ${t('case.subjectCount', {
              count: [...normalizeCaseText(draft.subject)].length,
            })}`}
            isInvalid={draft.attempted && !subjectValid}
            errorMessage={t('case.subjectRequired')}
          />
        </div>
        <TextField
          id="case-note"
          multiline
          label={t('case.note')}
          isRequired
          isReadOnly={locked || workClosed}
          value={draft.note}
          onChange={(note) => onDraftChange((current) => ({ ...current, note }))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void submit();
          }}
          description={`${t('case.noteHelp')} · ${t('case.noteCount', {
            count: [...normalizeCaseText(draft.note)].length,
          })}`}
          isInvalid={draft.attempted && !noteValid}
          errorMessage={t('case.noteRequired')}
        />
        <Select
          label={t('case.assignee')}
          isDisabled={locked || workClosed}
          selectedKey={draft.assigneeUserId}
          onSelectionChange={(key) =>
            onDraftChange((current) => ({
              ...current,
              assigneeUserId: String(key ?? ''),
              ...(current.error === 'assigneeRejected' ? { error: undefined } : {}),
            }))
          }
          options={assigneeOptions}
          description={team.status === 'failed' ? t('case.teamFailed') : undefined}
          isInvalid={draft.error === 'assigneeRejected'}
          errorMessage={t('case.assigneeRejected')}
        />
        {team.status === 'failed' ? (
          <Button size="sm" variant="ghost" onPress={() => setTeamRevision((value) => value + 1)}>
            {t('case.teamRetry')}
          </Button>
        ) : null}
        <div className="aw-case-actions">
          <Button
            type="submit"
            variant="primary"
            isDisabled={!canSubmit && draft.phase !== 'unknown'}
            aria-describedby={customer === null ? 'case-unlinked' : undefined}
            onPress={draft.phase === 'unknown' ? () => void send(draft) : undefined}
          >
            {draft.phase === 'pending'
              ? t('case.pending')
              : draft.phase === 'unknown'
                ? t('case.retrySame')
                : t('case.submit')}
          </Button>
          <Button
            variant="ghost"
            isDisabled={locked}
            onPress={() => onDraftChange(() => emptyCaseDraft())}
          >
            {t('case.discard')}
          </Button>
        </div>
      </form>
    </section>
  );
}
