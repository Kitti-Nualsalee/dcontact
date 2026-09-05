import { useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserWorkspaceLeaderElection } from './leader-election.js';

type MediaReadiness = 'UNCHECKED' | 'CHECKING' | 'READY' | 'BLOCKED';
type Availability = 'OFFLINE' | 'AVAILABLE';

export function WorkspaceApp() {
  const leaderElection = useMemo(
    () => createBrowserWorkspaceLeaderElection(crypto.randomUUID()),
    [],
  );
  const [workingTab, setWorkingTab] = useState<boolean>();
  const [mediaReadiness, setMediaReadiness] = useState<MediaReadiness>('UNCHECKED');
  const [availability, setAvailability] = useState<Availability>('OFFLINE');
  const [mediaError, setMediaError] = useState<string>();
  const mediaStream = useRef<MediaStream | undefined>(undefined);

  useEffect(() => {
    setWorkingTab(leaderElection.start());
    const heartbeat = window.setInterval(() => setWorkingTab(leaderElection.heartbeat()), 1_000);
    return () => {
      window.clearInterval(heartbeat);
      leaderElection.stop();
    };
  }, [leaderElection]);

  useEffect(() => {
    if (workingTab !== false) return;
    for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
    mediaStream.current = undefined;
    setMediaReadiness('UNCHECKED');
    setAvailability('OFFLINE');
  }, [workingTab]);

  useEffect(
    () => () => {
      for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
    },
    [],
  );

  async function checkMediaReadiness() {
    if (!workingTab) return;
    setMediaReadiness('CHECKING');
    setMediaError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of mediaStream.current?.getTracks() ?? []) track.stop();
      mediaStream.current = stream;
      setMediaReadiness('READY');
    } catch {
      setAvailability('OFFLINE');
      setMediaReadiness('BLOCKED');
      setMediaError(
        'Workspace ใช้ไมโครโฟนไม่ได้ โปรดอนุญาตสิทธิ์หรือเชื่อมต่ออุปกรณ์เสียงแล้วลองใหม่',
      );
    }
  }

  function becomeAvailable() {
    if (!workingTab || mediaReadiness !== 'READY') return;
    setAvailability('AVAILABLE');
  }

  function moveWorkHere() {
    leaderElection.claim();
    setWorkingTab(true);
  }

  const readinessLabel = {
    UNCHECKED: 'ยังไม่ได้ตรวจอุปกรณ์',
    CHECKING: 'กำลังตรวจอุปกรณ์เสียง',
    READY: 'อุปกรณ์เสียงพร้อม',
    BLOCKED: 'อุปกรณ์เสียงไม่พร้อม',
  }[mediaReadiness];

  return (
    <div className="workspace-shell">
      <aside className="product-rail" aria-label="พื้นที่หลัก">
        <div className="product-mark" aria-label="D-Contact">
          D
        </div>
        <button type="button" aria-label="ภาพรวม">
          01
        </button>
        <button type="button" className="active" aria-label="Agent Workspace">
          02
        </button>
        <button type="button" aria-label="Supervisor">
          03
        </button>
      </aside>

      <aside className="navigation">
        <div className="brand">
          <span>D</span>
          D-Contact
        </div>
        <p className="navigation-label">AGENT WORKSPACE</p>
        <button type="button" className="navigation-item active">
          กล่องงานของฉัน
        </button>
        <button type="button" className="navigation-item">
          ประวัติการติดต่อ
        </button>
        <p className="pilot-note">INBOUND VOICE · PILOT</p>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <span className="tenant">acme.d-contact.io</span>
          <div className="status-strip" aria-label="สถานะ Workspace">
            <span
              className={'status-chip ' + (workingTab ? 'success' : 'neutral')}
              role="status"
              aria-label="เจ้าของ Workspace"
            >
              {workingTab === undefined
                ? 'กำลังตรวจแท็บ'
                : workingTab
                  ? 'แท็บทำงาน'
                  : 'แท็บดูอย่างเดียว'}
            </span>
            <span className={'status-chip ' + (mediaReadiness === 'READY' ? 'success' : 'warning')}>
              {readinessLabel}
            </span>
            <span
              className={'status-chip ' + (availability === 'AVAILABLE' ? 'success' : 'neutral')}
            >
              {availability}
            </span>
          </div>
        </header>

        <main>
          <div className="page-heading">
            <div>
              <p className="eyebrow">VOICE OPERATIONS</p>
              <h1>Agent Workspace</h1>
              <p>เตรียม browser และอุปกรณ์เสียงให้พร้อมก่อนเปิดรับสาย</p>
            </div>
            <span className="phase-badge">PHASE 2</span>
          </div>

          <section className="workspace-grid" aria-label="การเตรียมพร้อมรับสาย">
            <article className="panel readiness-panel">
              <div className="panel-heading">
                <div>
                  <p className="step">ขั้นตอนที่ 1</p>
                  <h2>เตรียมอุปกรณ์เสียง</h2>
                </div>
                <span
                  className={'readiness-indicator ' + mediaReadiness.toLowerCase()}
                  role="status"
                  aria-label="ความพร้อมของอุปกรณ์เสียง"
                >
                  {readinessLabel}
                </span>
              </div>

              <p className="panel-copy">
                ระบบจะขอใช้ไมโครโฟนและตรวจว่า browser เปิด media stream ได้ ก่อนอนุญาตให้รับ voice
                offer
              </p>

              <div className="device-row">
                <div className="device-icon" aria-hidden="true">
                  MIC
                </div>
                <div>
                  <strong>ไมโครโฟนหลัก</strong>
                  <span>ตรวจผ่าน Browser MediaDevices</span>
                </div>
              </div>

              {mediaError ? (
                <p className="error-message" role="alert">
                  {mediaError}
                </p>
              ) : null}

              <button
                type="button"
                className="secondary-action"
                disabled={!workingTab || mediaReadiness === 'CHECKING'}
                onClick={() => void checkMediaReadiness()}
              >
                {mediaReadiness === 'CHECKING' ? 'กำลังตรวจ…' : 'ตรวจอุปกรณ์เสียง'}
              </button>
            </article>

            <article className="panel availability-panel">
              <div className="panel-heading">
                <div>
                  <p className="step">ขั้นตอนที่ 2</p>
                  <h2>สถานะการรับสาย</h2>
                </div>
                <span
                  className={'availability-dot ' + availability.toLowerCase()}
                  aria-hidden="true"
                />
              </div>

              <div className="availability-state" aria-live="polite">
                <strong>
                  {availability === 'AVAILABLE' ? 'พร้อมรับสาย' : 'ยังไม่พร้อมรับสาย'}
                </strong>
                <span>
                  {availability === 'AVAILABLE'
                    ? 'Router สามารถส่ง voice offer มายัง working tab นี้ได้'
                    : 'ต้องตรวจอุปกรณ์เสียงให้ผ่านก่อนเปิดรับสาย'}
                </span>
              </div>

              <button
                type="button"
                className="primary-action"
                disabled={!workingTab || mediaReadiness !== 'READY' || availability === 'AVAILABLE'}
                onClick={becomeAvailable}
              >
                เปิดรับสาย
              </button>
            </article>

            <article className="panel authority-panel">
              <p className="step">ขอบเขต authority</p>
              <h2>สถานะที่เชื่อถือได้</h2>
              <dl>
                <div>
                  <dt>Interaction</dt>
                  <dd>Router / API</dd>
                </div>
                <div>
                  <dt>Browser media</dt>
                  <dd>{readinessLabel}</dd>
                </div>
                <div>
                  <dt>Presence</dt>
                  <dd>{availability}</dd>
                </div>
              </dl>
              <p className="authority-note">
                Browser แสดง projection และส่ง intent เท่านั้น ไม่สร้าง durable Interaction state
                เอง
              </p>
            </article>
          </section>
        </main>
      </section>

      {workingTab === false ? (
        <div className="passive-overlay">
          <section className="passive-card" aria-labelledby="passive-title">
            <p className="eyebrow">SINGLE WORKING TAB</p>
            <h2 id="passive-title">Workspace ทำงานอยู่ในแท็บอื่น</h2>
            <p>
              แท็บนี้ดูข้อมูลได้อย่างเดียวและจะไม่เปิด routing หรือ media session
              จนกว่าคุณจะย้ายงานมาที่นี่
            </p>
            <button type="button" className="primary-action" onClick={moveWorkHere}>
              ย้ายงานมาที่แท็บนี้
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
