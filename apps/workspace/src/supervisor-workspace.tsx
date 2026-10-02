/**
 * #604: Supervisor Workspace บน component layer (ADR-028) และ i18n — parity กับ Agent Workspace (D1.15)
 *
 * - ใน shell ใหม่ (`ui.shell.v2`) ไม่วาด rail/แถบบนของตัวเอง — shell มี breadcrumb, ภาษา และเมนูผู้ใช้แล้ว
 * - flag ปิด: คง rail/แถบบน/ปุ่มออกจากระบบเดิม แต่เนื้อหาใช้ component และ token ชุดเดียวกัน
 * - จอแคบเป็น read-only (ADR-026 ข้อ 8, #48) และทุกคำสั่งต้องมีเหตุผลก่อนส่ง
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@d-contact/i18n/react';
import {
  Badge,
  Button,
  Dialog,
  Select,
  StatusChip,
  TextField,
  useInShell,
  type AgentStatus,
} from '@d-contact/ui-react';
import type { SupervisorSnapshot, SupervisorWorkspaceApi } from './supervisor-api.js';
import { useShellTokens } from './shell/tokens.js';
import './supervisor-workspace.css';

type AgentState = SupervisorSnapshot['agents'][number]['state'];
type ForcedState = 'OFFLINE' | 'AVAILABLE' | 'BREAK';
const FORCED_STATES: readonly ForcedState[] = ['OFFLINE', 'AVAILABLE', 'BREAK'];

type MutationDraft =
  | { kind: 'agent'; id: string; label: string; state: ForcedState; reason: string }
  | { kind: 'queue'; id: string; label: string; isActive: boolean; reason: string };

// สีของสถานะมาจาก token ของ agent status — ข้อความแปลแล้วอยู่ในชิปเสมอ (สีไม่ใช่ตัวบอกความหมายตัวเดียว)
const STATE_CHIP: Record<AgentState, AgentStatus> = {
  OFFLINE: 'offline',
  AVAILABLE: 'available',
  RESERVED: 'busy',
  BUSY: 'busy',
  ACW: 'acw',
  BREAK: 'break',
};

export interface SupervisorWorkspaceProps {
  api: SupervisorWorkspaceApi;
  tenantLabel?: string;
  onSignOut?: () => void;
}

/** token มาก่อนเนื้อหา (แบบเดียวกับ WorkspaceApp) — ทั้งสองสถานะของ flag ใช้ component ชุดใหม่ */
export function SupervisorWorkspace(props: SupervisorWorkspaceProps) {
  const tokensReady = useShellTokens();
  if (!tokensReady) return null;
  return <SupervisorLive {...props} />;
}

function SupervisorLive({ api, tenantLabel = 'D-Contact', onSignOut }: SupervisorWorkspaceProps) {
  const { t } = useTranslation('supervisor');
  const inShell = useInShell();
  const [snapshot, setSnapshot] = useState<SupervisorSnapshot>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [desktopControls, setDesktopControls] = useState(() => window.innerWidth >= 760);
  const [mutation, setMutation] = useState<MutationDraft>();
  const [mutationState, setMutationState] = useState<'idle' | 'pending' | 'confirmed' | 'rejected'>(
    'idle',
  );

  useEffect(() => {
    let active = true;
    void api
      .snapshot()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setLoadFailed(false);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 760px)');
    const update = () => setDesktopControls(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // เก็บเป็น key แล้วแปลตอน render — สลับภาษาแล้วรายการเปลี่ยนตามโดยไม่คำนวณใหม่
  const risks = useMemo(() => {
    if (!snapshot) return [];
    return [
      ...snapshot.queues
        .filter((queue) => !queue.isActive)
        .map((queue) => ({
          key: `queue:${queue.id}`,
          title: 'risk.queueInactive' as const,
          detail: queue.name,
        })),
      ...snapshot.interactions
        .filter((interaction) => interaction.state === 'WRAPUP')
        .map((interaction) => ({
          key: `wrapup:${interaction.id}`,
          title: 'risk.wrapup' as const,
          detail: interaction.id,
        })),
    ];
  }, [snapshot]);

  const submitMutation = async () => {
    if (!mutation || !mutation.reason.trim()) return;
    setMutationState('pending');
    setMutation(undefined);
    const commandId = crypto.randomUUID();
    try {
      if (mutation.kind === 'agent') {
        await api.forceAgentState({
          agentId: mutation.id,
          state: mutation.state,
          reason: mutation.reason.trim(),
          commandId,
        });
      } else {
        await api.setQueueAvailability({
          queueId: mutation.id,
          isActive: mutation.isActive,
          reason: mutation.reason.trim(),
          commandId,
        });
      }
      const authoritative = await api.snapshot();
      setSnapshot(authoritative);
      setMutationState('confirmed');
    } catch {
      setMutationState('rejected');
    }
  };

  const statusChips = (
    <div className="sv-status" aria-label={t('status.label')}>
      <StatusChip status="neutral">
        {t('status.sequence', { sequence: snapshot?.sequence ?? '—' })}
      </StatusChip>
      <span className="sv-narrow-readonly">
        <StatusChip status="info">{t('status.narrowReadonly')}</StatusChip>
      </span>
      {onSignOut && !inShell ? (
        <Button size="sm" variant="ghost" onPress={onSignOut}>
          {t('status.signOut')}
        </Button>
      ) : null}
    </div>
  );

  const content = (
    <>
      <header className="sv-heading">
        <div>
          <p className="sv-eyebrow">{t('heading.eyebrow')}</p>
          <h1>{t('heading.title')}</h1>
          <p className="sv-lede">{t('heading.lede')}</p>
        </div>
        <div className="sv-heading-side">
          <Badge tone="accent">{t('heading.phase')}</Badge>
          {inShell ? statusChips : null}
        </div>
      </header>

      {loadFailed ? (
        <p className="sv-warning" role="status">
          {t('snapshot.loadFailed')}
        </p>
      ) : null}

      <div className="sv-mutation-status" aria-live="polite">
        {mutationState === 'pending' ? t('mutation.pending') : null}
        {mutationState === 'confirmed' ? t('mutation.confirmed') : null}
        {mutationState === 'rejected' ? t('mutation.rejected') : null}
      </div>

      <section className="sv-pulse" aria-label={t('pulse.label')}>
        <article className="sv-metric sv-metric-risk">
          <span>{t('pulse.risks')}</span>
          <strong>{risks.length}</strong>
        </article>
        <article className="sv-metric">
          <span>{t('pulse.interactions')}</span>
          <strong>{snapshot?.interactions.length ?? 0}</strong>
        </article>
        <article className="sv-metric">
          <span>{t('pulse.agents')}</span>
          <strong>{snapshot?.agents.length ?? 0}</strong>
        </article>
      </section>

      <section className="sv-grid">
        <article className="sv-panel sv-panel-risk">
          <p className="sv-step">{t('risk.step')}</p>
          <h2>{t('risk.title')}</h2>
          <ul aria-label={t('risk.listLabel')} className="sv-list">
            {risks.length > 0 ? (
              risks.map((risk) => (
                <li key={risk.key} className="sv-risk">
                  <strong>{t(risk.title)}</strong>
                  <span>{risk.detail}</span>
                </li>
              ))
            ) : (
              <li className="sv-empty">{t('risk.empty')}</li>
            )}
          </ul>
        </article>

        <article className="sv-panel">
          <p className="sv-step">{t('agents.step')}</p>
          <h2>{t('agents.title')}</h2>
          <ul className="sv-list">
            {(snapshot?.agents ?? []).map((agent) => (
              <li key={agent.id} className="sv-row">
                <span className="sv-row-main">
                  <strong>{agent.displayName}</strong>
                  <small>{t('agents.extension', { extension: agent.extension ?? '—' })}</small>
                </span>
                <span className="sv-row-actions">
                  <StatusChip status={STATE_CHIP[agent.state]}>
                    {t(`agentState.${agent.state}`)}
                  </StatusChip>
                  {desktopControls && (FORCED_STATES as readonly string[]).includes(agent.state) ? (
                    <Button
                      size="sm"
                      isDisabled={mutationState === 'pending'}
                      aria-label={t('agents.changeFor', { name: agent.displayName })}
                      onPress={() => {
                        setMutationState('idle');
                        setMutation({
                          kind: 'agent',
                          id: agent.id,
                          label: agent.displayName,
                          state: agent.state === 'BREAK' ? 'AVAILABLE' : 'BREAK',
                          reason: '',
                        });
                      }}
                    >
                      {t('agents.change')}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
            {snapshot && snapshot.agents.length === 0 ? (
              <li className="sv-empty">{t('agents.empty')}</li>
            ) : null}
          </ul>
        </article>

        <article className="sv-panel">
          <p className="sv-step">{t('queues.step')}</p>
          <h2>{t('queues.title')}</h2>
          <ul className="sv-list">
            {(snapshot?.queues ?? []).map((queue) => (
              <li key={queue.id} className="sv-row">
                <span className="sv-row-main">
                  <strong>{queue.name}</strong>
                  <small>{queue.isActive ? t('queues.active') : t('queues.inactive')}</small>
                </span>
                {desktopControls ? (
                  <Button
                    size="sm"
                    isDisabled={mutationState === 'pending'}
                    aria-label={
                      queue.isActive
                        ? t('queues.closeFor', { name: queue.name })
                        : t('queues.openFor', { name: queue.name })
                    }
                    onPress={() => {
                      setMutationState('idle');
                      setMutation({
                        kind: 'queue',
                        id: queue.id,
                        label: queue.name,
                        isActive: !queue.isActive,
                        reason: '',
                      });
                    }}
                  >
                    {queue.isActive ? t('queues.close') : t('queues.open')}
                  </Button>
                ) : null}
              </li>
            ))}
            {snapshot && snapshot.queues.length === 0 ? (
              <li className="sv-empty">{t('queues.empty')}</li>
            ) : null}
          </ul>
        </article>
      </section>

      <ConfirmMutation
        mutation={mutation}
        onChange={setMutation}
        onCancel={() => setMutation(undefined)}
        onSubmit={() => void submitMutation()}
      />
    </>
  );

  if (inShell) return <div className="sv-root sv-in-shell">{content}</div>;

  return (
    <div className="sv-root supervisor-shell">
      <aside className="product-rail" aria-label={t('legacy.railLabel')}>
        <img className="product-mark" src="/d-contact-icon-64.png" alt={t('legacy.logoAlt')} />
        <button
          type="button"
          aria-label={t('legacy.agentWorkspace')}
          onClick={() => navigate('agent')}
        >
          02
        </button>
        <button type="button" className="active" aria-label={t('legacy.supervisorWorkspace')}>
          03
        </button>
      </aside>
      <section className="supervisor-main">
        <header className="topbar">
          <div className="identity-strip">
            <span className="tenant">{tenantLabel}</span>
            <strong>{t('legacy.title')}</strong>
          </div>
          {statusChips}
        </header>
        <main className="sv-legacy-main">{content}</main>
      </section>
    </div>
  );
}

function ConfirmMutation({
  mutation,
  onChange,
  onCancel,
  onSubmit,
}: {
  mutation: MutationDraft | undefined;
  onChange: (next: MutationDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation('supervisor');
  // คงค่าล่าสุดไว้ระหว่าง animation ปิด — dialog ไม่กระพริบเป็นช่องว่าง
  const [shown, setShown] = useState(mutation);
  useEffect(() => {
    if (mutation) setShown(mutation);
  }, [mutation]);
  const draft = mutation ?? shown;
  if (!draft) return null;

  const title =
    draft.kind === 'agent'
      ? t('confirm.agentTitle', { name: draft.label })
      : draft.isActive
        ? t('confirm.openQueueTitle', { name: draft.label })
        : t('confirm.closeQueueTitle', { name: draft.label });
  const submitLabel =
    draft.kind === 'agent'
      ? t('confirm.agentSubmit')
      : draft.isActive
        ? t('confirm.openQueueSubmit')
        : t('confirm.closeQueueSubmit');

  return (
    <Dialog
      role="alertdialog"
      title={title}
      isOpen={mutation !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      footer={() => (
        <>
          <Button onPress={onCancel}>{t('confirm.cancel')}</Button>
          <Button variant="primary" isDisabled={!draft.reason.trim()} onPress={onSubmit}>
            {submitLabel}
          </Button>
        </>
      )}
    >
      <div className="sv-confirm">
        {draft.kind === 'agent' ? (
          <Select
            label={t('confirm.newState')}
            selectedKey={draft.state}
            onSelectionChange={(key) => onChange({ ...draft, state: key as ForcedState })}
            options={FORCED_STATES.map((state) => ({ id: state, label: t(`agentState.${state}`) }))}
          />
        ) : null}
        <TextField
          multiline
          isRequired
          label={t('confirm.reason')}
          maxLength={240}
          value={draft.reason}
          onChange={(reason) => onChange({ ...draft, reason })}
        />
        <p className="sv-impact">{t('confirm.impact')}</p>
      </div>
    </Dialog>
  );
}

function navigate(view: 'agent' | 'supervisor'): void {
  const url = new URL(window.location.href);
  if (view === 'agent') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  window.location.assign(url);
}
