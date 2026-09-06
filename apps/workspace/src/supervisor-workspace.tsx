import { useEffect, useMemo, useState } from 'react';
import type { SupervisorSnapshot, SupervisorWorkspaceApi } from './supervisor-api.js';

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
                    <span className={`agent-state ${agent.state.toLowerCase()}`}>
                      {agent.state}
                    </span>
                  </li>
                ))}
              </ul>
            </article>
          </section>
        </main>
      </section>
    </div>
  );
}

function navigate(view: 'agent' | 'supervisor'): void {
  const url = new URL(window.location.href);
  if (view === 'agent') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  window.location.assign(url);
}
