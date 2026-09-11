/**
 * PROTOTYPE, DO NOT SHIP.
 * Three variants of Preference center, switchable via ?variant=A|B|C on
 * /prototype/preference-center. All data and mutations are synthetic/in-memory.
 */
import { useEffect, useMemo, useState } from 'react';
import './preference-center-prototype.css';

type VariantKey = 'A' | 'B' | 'C';
type Role = 'CUSTOMER' | 'AGENT' | 'TENANT_ADMIN' | 'COMPLIANCE';
type Scenario =
  'NORMAL' | 'PROPAGATING' | 'TIMEZONE_UNKNOWN' | 'REVIEW_REQUIRED' | 'VERSION_CONFLICT' | 'KILLED';
type PreferenceDecision = 'ALLOW' | 'BLOCK' | 'DEFER';

interface PreferenceRow {
  id: string;
  channel: 'LINE' | 'EMAIL' | 'VOICE';
  purpose: 'SERVICE_NOTIFICATION' | 'MARKETING' | 'ACCOUNT_SECURITY';
  contactKind: 'SERVICE' | 'PROMOTIONAL' | 'SECURITY';
  decision: PreferenceDecision;
  source: string;
  version: number;
  effectiveLabel: string;
}

interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  outcome: string;
}

interface PrototypeState {
  role: Role;
  scenario: Scenario;
  aggregateVersion: number;
  expectedVersion: number;
  timezone: string | null;
  preferredWindow: string;
  callbackMode: 'NO_OVERRIDE' | 'SCOPED_OVERRIDE' | 'TIME_POLICY_OVERRIDE';
  callbackState: 'NONE' | 'ACTIVE' | 'REVIEW' | 'APPROVED' | 'CONSUMED';
  propagation: 'APPLIED' | 'PENDING' | 'STALE' | 'BLOCKED';
  killSwitch: boolean;
  preferences: PreferenceRow[];
  audit: AuditEntry[];
}

const variantNames: Record<VariantKey, string> = {
  A: 'Guided + history',
  B: 'Policy matrix',
  C: 'Evidence timeline',
};

const roleLabels: Record<Role, string> = {
  CUSTOMER: 'ลูกค้า',
  AGENT: 'Agent',
  TENANT_ADMIN: 'Tenant Admin',
  COMPLIANCE: 'Compliance',
};

const scenarioLabels: Record<Scenario, string> = {
  NORMAL: 'สถานะปกติ',
  PROPAGATING: 'กำลังมีผล',
  TIMEZONE_UNKNOWN: 'ไม่ทราบ Timezone',
  REVIEW_REQUIRED: 'รออนุมัติ',
  VERSION_CONFLICT: 'ข้อมูลเปลี่ยนแล้ว',
  KILLED: 'หยุดการส่ง',
};

const basePreferences: PreferenceRow[] = [
  {
    id: 'pref-line-service',
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    contactKind: 'SERVICE',
    decision: 'ALLOW',
    source: 'CUSTOMER_SELF_SERVICE',
    version: 7,
    effectiveLabel: 'มีผลอยู่ · เฉพาะ LINE',
  },
  {
    id: 'pref-line-marketing',
    channel: 'LINE',
    purpose: 'MARKETING',
    contactKind: 'PROMOTIONAL',
    decision: 'BLOCK',
    source: 'PROVIDER_OPT_OUT',
    version: 4,
    effectiveLabel: 'ปิดโดยลูกค้า · มีผลทันที',
  },
  {
    id: 'pref-email-service',
    channel: 'EMAIL',
    purpose: 'SERVICE_NOTIFICATION',
    contactKind: 'SERVICE',
    decision: 'DEFER',
    source: 'AGENT',
    version: 2,
    effectiveLabel: 'พักถึง 13 ก.ย. 09:00',
  },
  {
    id: 'pref-voice-security',
    channel: 'VOICE',
    purpose: 'ACCOUNT_SECURITY',
    contactKind: 'SECURITY',
    decision: 'ALLOW',
    source: 'TENANT_POLICY',
    version: 1,
    effectiveLabel: 'ค่าเริ่มต้นองค์กร',
  },
];

function makeState(role: Role, scenario: Scenario): PrototypeState {
  const state: PrototypeState = {
    role,
    scenario,
    aggregateVersion: 12,
    expectedVersion: 12,
    timezone: 'Asia/Bangkok',
    preferredWindow: 'จ.–ศ. 09:00–18:00',
    callbackMode: 'SCOPED_OVERRIDE',
    callbackState: 'NONE',
    propagation: 'APPLIED',
    killSwitch: false,
    preferences: structuredClone(basePreferences),
    audit: [
      {
        id: 'audit-003',
        at: '11 ก.ย. 10:42',
        actor: 'ลูกค้าทดสอบ',
        action: 'ปิด Marketing บน LINE',
        outcome: 'มีผลแล้ว · aggregate v12',
      },
      {
        id: 'audit-002',
        at: '10 ก.ย. 16:15',
        actor: 'Agent S-08',
        action: 'พัก Email service notification',
        outcome: 'DEFER · aggregate v11',
      },
      {
        id: 'audit-001',
        at: '9 ก.ย. 09:00',
        actor: 'ลูกค้าทดสอบ',
        action: 'ตั้งเวลาที่สะดวก',
        outcome: 'Asia/Bangkok · aggregate v10',
      },
    ],
  };

  if (scenario === 'PROPAGATING') {
    state.propagation = 'PENDING';
    state.aggregateVersion = 13;
    state.audit.unshift({
      id: 'audit-pending',
      at: 'เมื่อสักครู่',
      actor: 'ลูกค้าทดสอบ',
      action: 'ปิด Service notification บน LINE',
      outcome: 'กำลังกระจาย v13 · ส่งใหม่ถูกพักไว้',
    });
  }
  if (scenario === 'TIMEZONE_UNKNOWN') {
    state.timezone = null;
    state.propagation = 'BLOCKED';
    state.preferences[0] = { ...state.preferences[0], decision: 'DEFER' };
  }
  if (scenario === 'REVIEW_REQUIRED') {
    state.callbackMode = 'TIME_POLICY_OVERRIDE';
    state.callbackState = 'REVIEW';
  }
  if (scenario === 'VERSION_CONFLICT') {
    state.expectedVersion = 11;
    state.propagation = 'STALE';
  }
  if (scenario === 'KILLED') {
    state.killSwitch = true;
    state.propagation = 'BLOCKED';
  }
  return state;
}

function readVariant(): VariantKey {
  const value = new URL(window.location.href).searchParams.get('variant')?.toUpperCase();
  return value === 'B' || value === 'C' ? value : 'A';
}

function readRole(): Role {
  const value = new URL(window.location.href).searchParams.get('role')?.toUpperCase();
  return value === 'AGENT' || value === 'TENANT_ADMIN' || value === 'COMPLIANCE'
    ? value
    : 'CUSTOMER';
}

function statusText(state: PrototypeState): string {
  if (state.killSwitch) return 'การส่งออกถูกหยุด — อ่านและแก้ preference ได้ตามปกติ';
  if (state.propagation === 'PENDING') return 'กำลังกระจายการเปลี่ยนแปลง — งานส่งใหม่ถูกพักไว้';
  if (state.propagation === 'STALE') return 'ข้อมูลบนหน้าจอเก่ากว่า canonical version';
  if (!state.timezone) return 'ยังส่งไม่ได้จนกว่าจะยืนยัน Timezone';
  return 'การตั้งค่าล่าสุดมีผลครบทุกระบบแล้ว';
}

export function PreferenceCenterPrototype() {
  const [variant, setVariantState] = useState<VariantKey>(readVariant);
  const [state, setState] = useState<PrototypeState>(() => makeState(readRole(), 'NORMAL'));
  const [notice, setNotice] = useState('พร้อมทดลอง — ไม่มีข้อมูลจริงและไม่เชื่อมต่อระบบภายนอก');

  const setUrlValue = (name: string, value: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(name, value);
    window.history.replaceState({}, '', url);
  };

  const setVariant = (next: VariantKey) => {
    setVariantState(next);
    setUrlValue('variant', next);
  };

  const cycleVariant = (direction: -1 | 1) => {
    const variants: VariantKey[] = ['A', 'B', 'C'];
    const index = variants.indexOf(variant);
    setVariant(variants[(index + direction + variants.length) % variants.length]);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycleVariant(-1);
      if (event.key === 'ArrowRight') cycleVariant(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [variant]);

  const controller = useMemo(
    () => ({
      state,
      notice,
      setRole: (role: Role) => {
        setUrlValue('role', role.toLowerCase());
        setState((current) => ({ ...current, role }));
        setNotice(`กำลังดูสิทธิ์ในบทบาท ${roleLabels[role]}`);
      },
      setScenario: (scenario: Scenario) => {
        setState((current) => makeState(current.role, scenario));
        setNotice(`โหลด scenario: ${scenarioLabels[scenario]}`);
      },
      setDecision: (id: string, decision: PreferenceDecision) => {
        setState((current) => {
          const currentRow = current.preferences.find((row) => row.id === id);
          if (!currentRow) return current;
          const relaxing = currentRow.decision === 'BLOCK' && decision === 'ALLOW';
          if (relaxing && current.role === 'AGENT') {
            setNotice('Agent ทำให้กฎเข้มขึ้นได้ แต่เปิด ALLOW แทนลูกค้าไม่ได้');
            return current;
          }
          if (relaxing && current.role === 'TENANT_ADMIN') {
            setNotice('Tenant Admin ต้องส่งให้ Compliance ตรวจเมื่อเป็นการผ่อนกฎ');
            return { ...current, callbackState: 'REVIEW' };
          }
          const nextVersion = current.aggregateVersion + 1;
          return {
            ...current,
            aggregateVersion: nextVersion,
            expectedVersion: nextVersion,
            propagation: 'PENDING',
            preferences: current.preferences.map((row) =>
              row.id === id
                ? {
                    ...row,
                    decision,
                    version: row.version + 1,
                    source: current.role === 'CUSTOMER' ? 'CUSTOMER_SELF_SERVICE' : current.role,
                    effectiveLabel: 'กำลังกระจาย · ส่งใหม่ถูกพักไว้',
                  }
                : row,
            ),
            audit: [
              {
                id: `audit-${nextVersion}`,
                at: 'เมื่อสักครู่',
                actor: roleLabels[current.role],
                action: `เปลี่ยน ${currentRow.channel}/${currentRow.purpose}`,
                outcome: `${decision} · aggregate v${nextVersion}`,
              },
              ...current.audit,
            ],
          };
        });
        setNotice('รับคำสั่งแล้ว — outbound ใหม่ถูกพักจน propagation เสร็จ');
      },
      completePropagation: () => {
        setState((current) => ({ ...current, propagation: 'APPLIED' }));
        setNotice('ทุก consumer ยืนยัน version ล่าสุดแล้ว');
      },
      setTimezone: (timezone: string) => {
        setState((current) => ({
          ...current,
          timezone: timezone || null,
          aggregateVersion: current.aggregateVersion + 1,
          propagation: timezone ? 'PENDING' : 'BLOCKED',
        }));
        setNotice(
          timezone
            ? 'บันทึก Timezone แล้ว กำลังกระจาย'
            : 'ไม่มี Timezone — ระบบ DEFER แบบ fail-closed',
        );
      },
      requestCallback: () => {
        setState((current) => ({
          ...current,
          callbackState: current.callbackMode === 'TIME_POLICY_OVERRIDE' ? 'REVIEW' : 'ACTIVE',
          aggregateVersion: current.aggregateVersion + 1,
          propagation: 'PENDING',
          audit: [
            {
              id: `callback-${current.aggregateVersion + 1}`,
              at: 'เมื่อสักครู่',
              actor: roleLabels[current.role],
              action: 'ขอให้ติดต่อกลับ LINE เวลา 14:30',
              outcome:
                current.callbackMode === 'TIME_POLICY_OVERRIDE'
                  ? 'REVIEW · รอ Compliance'
                  : 'ACTIVE · one-use',
            },
            ...current.audit,
          ],
        }));
        setNotice(
          state.callbackMode === 'TIME_POLICY_OVERRIDE'
            ? 'คำขอต้องผ่าน Compliance ก่อน'
            : 'สร้าง callback แบบ one-use แล้ว',
        );
      },
      approveCallback: () => {
        if (state.role !== 'COMPLIANCE') {
          setNotice('เฉพาะ Compliance จึงอนุมัติ synthetic override fixture ได้');
          return;
        }
        setState((current) => ({ ...current, callbackState: 'APPROVED', propagation: 'PENDING' }));
        setNotice('อนุมัติ synthetic fixture แล้ว — ข้ามได้เฉพาะ temporal gate');
      },
      refreshVersion: () => {
        setState((current) => ({
          ...current,
          expectedVersion: current.aggregateVersion,
          propagation: 'APPLIED',
        }));
        setNotice('โหลด canonical version ล่าสุดแล้ว กรุณาตรวจและทำรายการอีกครั้ง');
      },
    }),
    [notice, state],
  );

  return (
    <div className={`pcp-root pcp-variant-${variant.toLowerCase()}`}>
      {variant === 'A' ? <VariantA controller={controller} /> : null}
      {variant === 'B' ? <VariantB controller={controller} /> : null}
      {variant === 'C' ? <VariantC controller={controller} /> : null}
      <StateInspector state={state} notice={notice} />
      <PrototypeSwitcher
        current={variant}
        onPrevious={() => cycleVariant(-1)}
        onNext={() => cycleVariant(1)}
      />
    </div>
  );
}

interface Controller {
  state: PrototypeState;
  notice: string;
  setRole(role: Role): void;
  setScenario(scenario: Scenario): void;
  setDecision(id: string, decision: PreferenceDecision): void;
  completePropagation(): void;
  setTimezone(timezone: string): void;
  requestCallback(): void;
  approveCallback(): void;
  refreshVersion(): void;
}

function PrototypeContextBar({ controller }: { controller: Controller }) {
  return (
    <div className="pcp-context-bar" aria-label="Prototype controls">
      <span className="pcp-synthetic">● SYNTHETIC DATA</span>
      <label>
        มุมมอง
        <select
          value={controller.state.role}
          onChange={(event) => controller.setRole(event.target.value as Role)}
        >
          {Object.entries(roleLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Scenario
        <select
          value={controller.state.scenario}
          onChange={(event) => controller.setScenario(event.target.value as Scenario)}
        >
          {Object.entries(scenarioLabels).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <span className="pcp-tenant">Siam Demo · tenant-s1-pilot</span>
    </div>
  );
}

function StatusBanner({ state }: { state: PrototypeState }) {
  const tone = state.killSwitch
    ? 'danger'
    : state.propagation === 'APPLIED'
      ? 'success'
      : state.propagation === 'PENDING'
        ? 'pending'
        : 'warning';
  return (
    <div className={`pcp-status pcp-status-${tone}`} role="status">
      <span className="pcp-status-dot" />
      <strong>{statusText(state)}</strong>
      <small>
        canonical v{state.aggregateVersion} · หน้านี้คาดไว้ v{state.expectedVersion}
      </small>
    </div>
  );
}

function VariantA({ controller }: { controller: Controller }) {
  const { state } = controller;
  return (
    <div className="pcp-a-shell">
      <header className="pcp-a-header">
        <a className="pcp-brand" href="#main-a" aria-label="D-Contact">
          <span>D</span> D-CONTACT
        </a>
        <span>ศูนย์การติดต่อของฉัน</span>
        <button className="pcp-avatar" aria-label="บัญชีลูกค้าทดสอบ">
          KT
        </button>
      </header>
      <PrototypeContextBar controller={controller} />
      <main id="main-a" className="pcp-a-main">
        <div className="pcp-a-title">
          <div>
            <p className="pcp-kicker">SELECTED HYBRID · GUIDED + HISTORY</p>
            <h1>คุณต้องการให้เราติดต่ออย่างไร</h1>
            <p>ตั้งค่าเป็นรายช่องทางและวัตถุประสงค์ การอนุญาตตรงนี้ไม่ใช่การให้ consent ใหม่</p>
          </div>
          <span className="pcp-version-pill">ตั้งค่ารุ่น {state.aggregateVersion}</span>
        </div>
        <StatusBanner state={state} />
        {state.propagation === 'PENDING' ? (
          <button className="pcp-inline-action" onClick={controller.completePropagation}>
            จำลอง consumer ทั้งหมดตอบรับ
          </button>
        ) : null}
        {state.propagation === 'STALE' ? (
          <button className="pcp-inline-action" onClick={controller.refreshVersion}>
            โหลดข้อมูลล่าสุดก่อนแก้ต่อ
          </button>
        ) : null}

        <section className="pcp-a-grid" aria-label="Preference summary">
          <div className="pcp-a-primary">
            <div className="pcp-section-heading">
              <div>
                <span>01</span>
                <h2>ช่องทางและเรื่องที่ติดต่อได้</h2>
              </div>
              <p>กฎที่เข้มกว่าจะชนะเสมอ</p>
            </div>
            <div className="pcp-channel-list">
              {state.preferences.map((preference) => (
                <article className="pcp-channel-row" key={preference.id}>
                  <div
                    className={`pcp-channel-icon pcp-channel-${preference.channel.toLowerCase()}`}
                  >
                    {preference.channel === 'LINE'
                      ? 'L'
                      : preference.channel === 'EMAIL'
                        ? '@'
                        : '☎'}
                  </div>
                  <div className="pcp-channel-copy">
                    <strong>{channelLabel(preference.channel)}</strong>
                    <span>{purposeLabel(preference.purpose)}</span>
                    <small>{preference.effectiveLabel}</small>
                  </div>
                  <DecisionBadge value={preference.decision} />
                  <div className="pcp-segmented" aria-label={`ตั้งค่า ${preference.channel}`}>
                    {(['ALLOW', 'DEFER', 'BLOCK'] as const).map((decision) => (
                      <button
                        key={decision}
                        aria-pressed={preference.decision === decision}
                        onClick={() => controller.setDecision(preference.id, decision)}
                      >
                        {decision === 'ALLOW' ? 'รับ' : decision === 'DEFER' ? 'พัก' : 'ปิด'}
                      </button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>

          <aside className="pcp-a-side">
            <section className="pcp-a-card">
              <span className="pcp-card-number">02</span>
              <h2>เวลาที่สะดวก</h2>
              <label>
                Timezone
                <select
                  value={state.timezone ?? ''}
                  onChange={(event) => controller.setTimezone(event.target.value)}
                >
                  <option value="">ยังไม่ทราบ</option>
                  <option value="Asia/Bangkok">Asia/Bangkok</option>
                  <option value="Asia/Singapore">Asia/Singapore</option>
                  <option value="Europe/London">Europe/London</option>
                </select>
              </label>
              <div className="pcp-window-preview">
                <span>เวลาที่เลือก</span>
                <strong>{state.preferredWindow}</strong>
                <small>รองรับช่วงข้ามเที่ยงคืนและ DST</small>
              </div>
              {!state.timezone ? (
                <p className="pcp-alert">TIMEZONE_UNKNOWN — ระบบจะพักการส่งไว้ก่อน</p>
              ) : null}
            </section>
            <section className="pcp-a-card pcp-callback-card">
              <span className="pcp-card-number">03</span>
              <h2>ให้ติดต่อกลับ</h2>
              <p>LINE · Service notification · วันนี้ 14:30</p>
              <button className="pcp-primary" onClick={controller.requestCallback}>
                ขอให้ติดต่อกลับ
              </button>
              <small>
                โหมด {state.callbackMode} · สถานะ {state.callbackState}
              </small>
            </section>
          </aside>
        </section>
        <PreferenceHistory state={state} />
        <p className="pcp-a-footnote">
          ข้อห้ามตามกฎหมาย การถอน consent และ DNC จะอยู่เหนือการตั้งค่าหน้านี้เสมอ
        </p>
      </main>
    </div>
  );
}

function PreferenceHistory({ state }: { state: PrototypeState }) {
  const canViewTechnicalEvidence = state.role !== 'CUSTOMER';

  return (
    <section className="pcp-a-history" id="history" aria-labelledby="preference-history-title">
      <div className="pcp-a-history-heading">
        <div>
          <span className="pcp-card-number">04</span>
          <h2 id="preference-history-title">ประวัติการตั้งค่า</h2>
          <p>ดูว่าใครเปลี่ยนอะไร เมื่อใด และการเปลี่ยนแปลงมีผลแล้วหรือยัง</p>
        </div>
        <span className="pcp-readonly-pill">อ่านอย่างเดียว · {state.audit.length} รายการ</span>
      </div>

      <div className="pcp-a-history-preview">
        {state.audit.slice(0, 3).map((entry, index) => (
          <article key={entry.id}>
            <span className="pcp-history-version">v{state.aggregateVersion - index}</span>
            <div>
              <time>{entry.at}</time>
              <h3>{entry.action}</h3>
              <p>{historyActorLabel(entry.actor, state.role)}</p>
            </div>
            <strong>{entry.outcome}</strong>
          </article>
        ))}
      </div>

      <details className="pcp-a-history-details">
        <summary>
          <span>ดูหลักฐานและประวัติทั้งหมด</span>
          <small>
            {canViewTechnicalEvidence ? 'รวม evidence reference' : 'แสดงภาษาที่เข้าใจง่าย'}
          </small>
        </summary>
        <div className="pcp-a-history-timeline">
          {state.audit.map((entry, index) => (
            <article key={entry.id}>
              <div className="pcp-a-history-rail">
                <span>{state.aggregateVersion - index}</span>
              </div>
              <div>
                <time>{entry.at}</time>
                <h3>{entry.action}</h3>
                <p>
                  {historyActorLabel(entry.actor, state.role)} · {entry.outcome}
                </p>
                {canViewTechnicalEvidence ? (
                  <code>
                    {entry.id} · digest {String(84012 + index).padStart(8, '0')} · tenant-s1-pilot
                  </code>
                ) : null}
              </div>
            </article>
          ))}
        </div>
        <p className="pcp-a-history-safety">
          {canViewTechnicalEvidence
            ? 'Evidence แสดง reference แบบ tenant-scoped และไม่มี raw identity'
            : 'รายละเอียดภายในและข้อมูลผู้ปฏิบัติงานถูกซ่อนไว้ในมุมมองลูกค้า'}
        </p>
      </details>
    </section>
  );
}

function VariantB({ controller }: { controller: Controller }) {
  const { state } = controller;
  const [selectedId, setSelectedId] = useState(state.preferences[0].id);
  const selected = state.preferences.find((row) => row.id === selectedId) ?? state.preferences[0];
  return (
    <div className="pcp-b-shell">
      <aside className="pcp-b-nav">
        <div className="pcp-b-logo">DC</div>
        <nav aria-label="Console sections">
          <a href="#matrix" className="active">
            PR
          </a>
          <a href="#schedule">TM</a>
          <a href="#history">AU</a>
        </nav>
        <span className="pcp-b-role">{roleLabels[state.role].slice(0, 2)}</span>
      </aside>
      <div className="pcp-b-workspace">
        <header className="pcp-b-header">
          <div>
            <span className="pcp-kicker">VARIANT B · POLICY MATRIX</span>
            <h1>Contact governance / Synthetic S-1042</h1>
          </div>
          <PrototypeContextBar controller={controller} />
        </header>
        <StatusBanner state={state} />
        <main className="pcp-b-main" id="matrix">
          <section className="pcp-b-matrix-panel">
            <div className="pcp-panel-title">
              <div>
                <h2>Effective preference matrix</h2>
                <p>เลือก cell เพื่อดู precedence, source และคำสั่งที่ทำได้</p>
              </div>
              <span>AGGREGATE v{state.aggregateVersion}</span>
            </div>
            <div className="pcp-matrix-wrap">
              <table className="pcp-matrix">
                <thead>
                  <tr>
                    <th>Purpose / kind</th>
                    <th>LINE</th>
                    <th>Email</th>
                    <th>Voice</th>
                  </tr>
                </thead>
                <tbody>
                  {(['SERVICE_NOTIFICATION', 'MARKETING', 'ACCOUNT_SECURITY'] as const).map(
                    (purpose) => (
                      <tr key={purpose}>
                        <th>{purposeLabel(purpose)}</th>
                        {(['LINE', 'EMAIL', 'VOICE'] as const).map((channel) => {
                          const preference = state.preferences.find(
                            (row) => row.channel === channel && row.purpose === purpose,
                          );
                          return (
                            <td key={channel}>
                              {preference ? (
                                <button
                                  className={selected.id === preference.id ? 'selected' : ''}
                                  onClick={() => setSelectedId(preference.id)}
                                >
                                  <DecisionBadge value={preference.decision} compact />
                                  <small>v{preference.version}</small>
                                </button>
                              ) : (
                                <span className="pcp-inherited">Inherited</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            <div className="pcp-b-bottom-grid">
              <section id="schedule">
                <h3>Temporal policy</h3>
                <dl>
                  <div>
                    <dt>Timezone</dt>
                    <dd>{state.timezone ?? 'TIMEZONE_UNKNOWN'}</dd>
                  </div>
                  <div>
                    <dt>Preferred</dt>
                    <dd>{state.preferredWindow}</dd>
                  </div>
                  <div>
                    <dt>Holiday</dt>
                    <dd>ปฏิทิน TH-BKK v3</dd>
                  </div>
                  <div>
                    <dt>Callback</dt>
                    <dd>{state.callbackMode}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3>Propagation</h3>
                <div className="pcp-watermarks">
                  {['Journey', 'Channels', 'Dialer', 'Workspace'].map((consumer, index) => (
                    <div key={consumer}>
                      <span>{consumer}</span>
                      <strong>
                        v
                        {state.propagation === 'PENDING' && index > 1
                          ? state.aggregateVersion - 1
                          : state.aggregateVersion}
                      </strong>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </section>
          <aside className="pcp-b-inspector">
            <span className="pcp-inspector-label">SELECTED RULE</span>
            <h2>
              {selected.channel} / {purposeLabel(selected.purpose)}
            </h2>
            <DecisionBadge value={selected.decision} />
            <dl>
              <div>
                <dt>Contact kind</dt>
                <dd>{selected.contactKind}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{selected.source}</dd>
              </div>
              <div>
                <dt>Record</dt>
                <dd>v{selected.version}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>identity + channel + purpose</dd>
              </div>
            </dl>
            <h3>Precedence trace</h3>
            <ol className="pcp-trace">
              <li className="pass">
                Hard restriction <b>PASS</b>
              </li>
              <li className="pass">
                Consent/lawful basis <b>PASS</b>
              </li>
              <li className={selected.decision === 'BLOCK' ? 'stop' : 'pass'}>
                Preference <b>{selected.decision}</b>
              </li>
              <li>
                Quiet hours <b>09:00–18:00</b>
              </li>
            </ol>
            <div className="pcp-b-actions">
              <button onClick={() => controller.setDecision(selected.id, 'BLOCK')}>
                Block ทันที
              </button>
              <button onClick={() => controller.setDecision(selected.id, 'DEFER')}>
                พักชั่วคราว
              </button>
              <button
                className="pcp-primary"
                onClick={() => controller.setDecision(selected.id, 'ALLOW')}
              >
                ขอเปิด Allow
              </button>
            </div>
            <p className="pcp-policy-note">
              ALLOW ผ่านเฉพาะ preference gate ไม่ได้สร้าง consent ใหม่
            </p>
          </aside>
        </main>
      </div>
    </div>
  );
}

function VariantC({ controller }: { controller: Controller }) {
  const { state } = controller;
  return (
    <div className="pcp-c-shell">
      <header className="pcp-c-header">
        <div className="pcp-c-brand">
          <span>DC</span>
          <div>
            <strong>Evidence desk</strong>
            <small>Contact Governance</small>
          </div>
        </div>
        <PrototypeContextBar controller={controller} />
      </header>
      <main className="pcp-c-main">
        <section className="pcp-c-command">
          <span className="pcp-kicker">VARIANT C · EVIDENCE TIMELINE</span>
          <div className="pcp-c-title-row">
            <div>
              <h1>ทำไมระบบจึงติดต่อรายนี้ได้หรือไม่ได้</h1>
              <p>Synthetic contact S-1042 · ใช้ version และหลักฐานที่เกิดขึ้นจริงในแต่ละคำสั่ง</p>
            </div>
            <DecisionBadge value={state.killSwitch ? 'BLOCK' : state.preferences[0].decision} />
          </div>
          <StatusBanner state={state} />
          <div className="pcp-c-actions">
            <button onClick={() => controller.setDecision('pref-line-service', 'BLOCK')}>
              บันทึก opt-out
            </button>
            <button onClick={controller.requestCallback}>สร้าง callback 14:30</button>
            <button onClick={controller.approveCallback}>อนุมัติ synthetic override</button>
            {state.propagation === 'PENDING' ? (
              <button className="pcp-primary" onClick={controller.completePropagation}>
                Apply acknowledgements
              </button>
            ) : null}
            {state.propagation === 'STALE' ? (
              <button className="pcp-primary" onClick={controller.refreshVersion}>
                Refresh canonical state
              </button>
            ) : null}
          </div>
        </section>
        <section className="pcp-c-layout">
          <div className="pcp-c-timeline" id="history">
            <div className="pcp-panel-title">
              <div>
                <h2>Versioned evidence</h2>
                <p>เหตุการณ์ใหม่อยู่บนสุด ประวัติเดิมไม่ถูกเขียนทับ</p>
              </div>
              <span>{state.audit.length} EVENTS</span>
            </div>
            {state.audit.map((entry, index) => (
              <article key={entry.id} className="pcp-evidence-row">
                <div className="pcp-evidence-rail">
                  <span>{state.aggregateVersion - index}</span>
                </div>
                <div>
                  <time>{entry.at}</time>
                  <h3>{entry.action}</h3>
                  <p>
                    {entry.actor} · {entry.outcome}
                  </p>
                  <code>
                    {entry.id} · digest {String(84012 + index).padStart(8, '0')}
                  </code>
                </div>
              </article>
            ))}
          </div>
          <aside className="pcp-c-side">
            <section>
              <span className="pcp-inspector-label">EFFECTIVE NOW</span>
              <h2>LINE service notification</h2>
              <div className="pcp-decision-stack">
                <div>
                  <span>Hard restriction</span>
                  <b className="pass">PASS</b>
                </div>
                <div>
                  <span>Consent</span>
                  <b className="pass">PASS</b>
                </div>
                <div>
                  <span>Preference</span>
                  <b>{state.preferences[0].decision}</b>
                </div>
                <div>
                  <span>Timezone</span>
                  <b>{state.timezone ?? 'UNKNOWN'}</b>
                </div>
                <div>
                  <span>Callback</span>
                  <b>{state.callbackState}</b>
                </div>
              </div>
              <p className="pcp-c-reason">
                Primary reason: {state.timezone ? 'POLICY_PASSED' : 'TIMEZONE_UNKNOWN'}
              </p>
            </section>
            <section>
              <span className="pcp-inspector-label">CONSUMER WATERMARKS</span>
              {['Journey', 'Channels', 'Dialer', 'Workspace'].map((consumer, index) => {
                const stale = state.propagation === 'PENDING' && index > 1;
                return (
                  <div className="pcp-consumer" key={consumer}>
                    <span>{consumer}</span>
                    <span className={stale ? 'lag' : 'ok'}>
                      {stale ? 'PENDING v12' : `APPLIED v${state.aggregateVersion}`}
                    </span>
                  </div>
                );
              })}
            </section>
            <section className="pcp-c-safety">
              <strong>{state.killSwitch ? 'OUTBOUND KILLED' : 'SIMULATION ONLY'}</strong>
              <p>actualProviderTraffic=false</p>
              <p>ไม่มี raw identity ใน evidence</p>
            </section>
          </aside>
        </section>
      </main>
    </div>
  );
}

function DecisionBadge({
  value,
  compact = false,
}: {
  value: PreferenceDecision;
  compact?: boolean;
}) {
  return (
    <span
      className={`pcp-decision pcp-decision-${value.toLowerCase()} ${compact ? 'compact' : ''}`}
    >
      {value === 'ALLOW' ? 'อนุญาต' : value === 'DEFER' ? 'พักไว้' : 'ปิด'}
    </span>
  );
}

function PrototypeSwitcher({
  current,
  onPrevious,
  onNext,
}: {
  current: VariantKey;
  onPrevious(): void;
  onNext(): void;
}) {
  return (
    <div className="pcp-switcher" aria-label="สลับ prototype variant">
      <button onClick={onPrevious} aria-label="variant ก่อนหน้า">
        ←
      </button>
      <span>
        <small>PROTOTYPE</small>
        <strong>
          {current} · {variantNames[current]}
        </strong>
      </span>
      <button onClick={onNext} aria-label="variant ถัดไป">
        →
      </button>
    </div>
  );
}

function StateInspector({ state, notice }: { state: PrototypeState; notice: string }) {
  return (
    <details className="pcp-state-inspector">
      <summary>
        <span>STATE</span>
        <strong>{notice}</strong>
      </summary>
      <pre>{JSON.stringify(state, null, 2)}</pre>
    </details>
  );
}

function channelLabel(channel: PreferenceRow['channel']): string {
  if (channel === 'LINE') return 'LINE';
  if (channel === 'EMAIL') return 'อีเมล';
  return 'โทรศัพท์';
}

function purposeLabel(purpose: PreferenceRow['purpose']): string {
  if (purpose === 'SERVICE_NOTIFICATION') return 'แจ้งเตือนบริการ';
  if (purpose === 'MARKETING') return 'ข่าวสารและข้อเสนอ';
  return 'ความปลอดภัยของบัญชี';
}

function historyActorLabel(actor: string, role: Role): string {
  if (role !== 'CUSTOMER') return actor;
  return actor.includes('ลูกค้า') ? 'คุณ' : 'เจ้าหน้าที่';
}
