import { useEffect, useMemo, useState } from 'react';
import type { SupervisorSnapshot, SupervisorWorkspaceApi } from './supervisor-api.js';

type MutationDraft =
  | {
      kind: 'agent';
      id: string;
      label: string;
      state: 'OFFLINE' | 'AVAILABLE' | 'BREAK';
      reason: string;
    }
  | { kind: 'queue'; id: string; label: string; isActive: boolean; reason: string };

export interface SupervisorWorkspaceProps {
  api: SupervisorWorkspaceApi;
  tenantLabel?: string;
  onSignOut?: () => void;
}

export function SupervisorWorkspace({
  api,
  tenantLabel = 'D-Contact',
  onSignOut,
}: SupervisorWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<SupervisorSnapshot>();
  const [error, setError] = useState<string>();
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
        setError(undefined);
      })
      .catch(() => {
        if (active) setError('โหลด Team pulse ไม่สำเร็จ หน้านี้จึงเป็น read-only');
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

  const risks = useMemo(() => {
    if (!snapshot) return [];
    return [
      ...snapshot.queues
        .filter((queue) => !queue.isActive)
        .map((queue) => ({
          key: `queue:${queue.id}`,
          title: 'Queue ปิดใช้งาน',
          detail: queue.name,
        })),
      ...snapshot.interactions
        .filter((interaction) => interaction.state === 'WRAPUP')
        .map((interaction) => ({
          key: `wrapup:${interaction.id}`,
          title: 'Interaction อยู่ใน WRAPUP',
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

  return (
    <div className="supervisor-shell">
      <aside className="product-rail" aria-label="พื้นที่หลัก">
        <div className="product-mark" aria-label="D-Contact">
          D
        </div>
        <button type="button" aria-label="Agent Workspace" onClick={() => navigate('agent')}>
          02
        </button>
        <button type="button" className="active" aria-label="Supervisor Workspace">
          03
        </button>
      </aside>

      <section className="supervisor-main">
        <header className="topbar">
          <div className="identity-strip">
            <span className="tenant">{tenantLabel}</span>
            <strong>Supervisor live control</strong>
          </div>
          <div className="status-strip">
            <span className="status-chip neutral">ลำดับข้อมูล {snapshot?.sequence ?? '—'}</span>
            <span className="narrow-readonly">โหมดจอแคบ: ดูข้อมูลอย่างเดียว</span>
            {onSignOut ? (
              <button type="button" className="signout-action" onClick={onSignOut}>
                ออกจากระบบ
              </button>
            ) : null}
          </div>
        </header>

        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">LIVE OPERATIONS</p>
              <h1>Supervisor Workspace</h1>
              <p>Team pulse เรียงเหตุการณ์เสี่ยงก่อน ภายใน scope ที่ server ยืนยัน</p>
            </div>
            <span className="phase-badge">PILOT · DESKTOP CONTROL</span>
          </div>

          {error ? (
            <p className="snapshot-warning" role="status">
              {error}
            </p>
          ) : null}

          <div className="mutation-status" aria-live="polite">
            {mutationState === 'pending' ? 'กำลังรอ server ยืนยัน' : null}
            {mutationState === 'confirmed' ? 'server ยืนยันสถานะล่าสุดแล้ว' : null}
            {mutationState === 'rejected'
              ? 'คำสั่งไม่สำเร็จ กรุณาตรวจสถานะล่าสุดก่อนลองใหม่'
              : null}
          </div>

          <section className="pulse-grid" aria-label="Team pulse">
            <article className="metric-card risk">
              <span>ต้องตรวจสอบ</span>
              <strong>{risks.length}</strong>
            </article>
            <article className="metric-card">
              <span>Live interactions</span>
              <strong>{snapshot?.interactions.length ?? 0}</strong>
            </article>
            <article className="metric-card">
              <span>Agents ใน scope</span>
              <strong>{snapshot?.agents.length ?? 0}</strong>
            </article>
          </section>

          <section className="supervisor-grid">
            <article className="panel risk-panel">
              <div className="panel-heading">
                <div>
                  <p className="step">RISK FIRST</p>
                  <h2>สิ่งที่ต้องจัดการก่อน</h2>
                </div>
              </div>
              <ul aria-label="ความเสี่ยงที่ต้องจัดการ" className="risk-list">
                {risks.length > 0 ? (
                  risks.map((risk) => (
                    <li key={risk.key}>
                      <strong>{risk.title}</strong>
                      <span>{risk.detail}</span>
                    </li>
                  ))
                ) : (
                  <li className="empty-row">ยังไม่พบความเสี่ยงจาก snapshot ล่าสุด</li>
                )}
              </ul>
            </article>

            <article className="panel">
              <p className="step">TEAM PRESENCE</p>
              <h2>Agents</h2>
              <ul className="agent-list">
                {(snapshot?.agents ?? []).map((agent) => (
                  <li key={agent.id}>
                    <span>
                      <strong>{agent.displayName}</strong>
                      <small>Ext. {agent.extension ?? '—'}</small>
                    </span>
                    <span className="row-actions">
                      <span className={`agent-state ${agent.state.toLowerCase()}`}>
                        {agent.state}
                      </span>
                      {desktopControls &&
                      ['OFFLINE', 'AVAILABLE', 'BREAK'].includes(agent.state) ? (
                        <button
                          type="button"
                          className="secondary-action compact-action"
                          disabled={mutationState === 'pending'}
                          aria-label={`เปลี่ยนสถานะ ${agent.displayName}`}
                          onClick={() => {
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
                          เปลี่ยนสถานะ
                        </button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="panel queue-control-panel">
              <p className="step">QUEUE CONTROL</p>
              <h2>Queues</h2>
              <ul className="agent-list">
                {(snapshot?.queues ?? []).map((queue) => (
                  <li key={queue.id}>
                    <span>
                      <strong>{queue.name}</strong>
                      <small>{queue.isActive ? 'เปิดรับงาน' : 'ปิดรับงาน'}</small>
                    </span>
                    {desktopControls ? (
                      <button
                        type="button"
                        className="secondary-action compact-action"
                        disabled={mutationState === 'pending'}
                        aria-label={`${queue.isActive ? 'ปิด' : 'เปิด'} Queue ${queue.name}`}
                        onClick={() => {
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
                        {queue.isActive ? 'ปิด Queue' : 'เปิด Queue'}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </article>
          </section>
        </main>
      </section>

      {mutation ? (
        <section className="confirmation-backdrop" role="dialog" aria-modal="true">
          <form
            className="confirmation-card"
            onSubmit={(event) => {
              event.preventDefault();
              void submitMutation();
            }}
          >
            <p className="step">CONFIRM REMOTE CONTROL</p>
            <h2>
              {mutation.kind === 'agent'
                ? `เปลี่ยนสถานะ ${mutation.label}`
                : `${mutation.isActive ? 'เปิด' : 'ปิด'} Queue ${mutation.label}`}
            </h2>
            {mutation.kind === 'agent' ? (
              <label>
                สถานะใหม่
                <select
                  value={mutation.state}
                  onChange={(event) =>
                    setMutation({
                      ...mutation,
                      state: event.target.value as 'OFFLINE' | 'AVAILABLE' | 'BREAK',
                    })
                  }
                >
                  <option value="OFFLINE">OFFLINE</option>
                  <option value="AVAILABLE">AVAILABLE</option>
                  <option value="BREAK">BREAK</option>
                </select>
              </label>
            ) : null}
            <label>
              เหตุผล
              <textarea
                required
                maxLength={240}
                value={mutation.reason}
                onChange={(event) => setMutation({ ...mutation, reason: event.target.value })}
              />
            </label>
            <p className="confirmation-impact">
              คำสั่งนี้มีผลกับ routing และจะถูกบันทึกใน audit log
            </p>
            <div className="confirmation-actions">
              <button
                type="button"
                className="secondary-action"
                onClick={() => setMutation(undefined)}
              >
                ยกเลิก
              </button>
              <button type="submit" className="primary-action" disabled={!mutation.reason.trim()}>
                {mutation.kind === 'agent'
                  ? 'ยืนยันเปลี่ยนสถานะ'
                  : `ยืนยัน${mutation.isActive ? 'เปิด' : 'ปิด'} Queue`}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </div>
  );
}

function navigate(view: 'agent' | 'supervisor'): void {
  const url = new URL(window.location.href);
  if (view === 'agent') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  window.location.assign(url);
}
