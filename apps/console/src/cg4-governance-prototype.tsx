// PROTOTYPE ONLY: three CG4 governance Console variants, switchable via ?view=cg4-prototype&variant=A|B|C.
import { useEffect, useMemo, useState } from 'react';

type VariantKey = 'A' | 'B' | 'C';
type Viewer = 'SUPERVISOR' | 'TENANT_ADMIN' | 'COMPLIANCE';
type Scenario = 'READY' | 'STALE_APPROVAL' | 'VERSION_CONFLICT' | 'PARTIAL_FAILURE';
type Workflow = 'PENDING' | 'APPROVED' | 'SCHEDULED' | 'ACTIVE' | 'RECOVERY_REQUIRED';

interface PrototypeState {
  viewer: Viewer;
  scenario: Scenario;
  selectedItem: string;
  workflow: Workflow;
  quorum: string;
  lastAction: string;
  canonicalVersion: number;
}

const variants: Array<{ key: VariantKey; name: string }> = [
  { key: 'A', name: 'Approval workspace' },
  { key: 'B', name: 'Policy change studio' },
  { key: 'C', name: 'Evidence timeline' },
];

const initialState: PrototypeState = {
  viewer: 'COMPLIANCE',
  scenario: 'READY',
  selectedItem: 'EXC-2409',
  workflow: 'PENDING',
  quorum: '1 / 2',
  lastAction: 'เปิดรายการรอตรวจ',
  canonicalVersion: 18,
};

const scenarioNotices: Record<Scenario, string> = {
  READY: 'ต้นแบบใช้ข้อมูลสังเคราะห์และไม่ส่ง mutation จริง',
  STALE_APPROVAL: 'Approval stale: authorization epoch เปลี่ยน ต้องโหลด scope และอนุมัติใหม่',
  VERSION_CONFLICT: 'Version conflict: มี policy version ใหม่กว่า ระบบไม่รวมการแก้ไขให้อัตโนมัติ',
  PARTIAL_FAILURE: 'Acknowledgement ยังไม่ครบ: outbound scope ถูก hold จนกว่าจะ recover สำเร็จ',
};

export function Cg4GovernancePrototype() {
  const [variant, setVariantState] = useState<VariantKey>(() => variantFromUrl());
  const [state, setState] = useState<PrototypeState>(() => stateFromUrl());
  const [notice, setNotice] = useState(() => scenarioNotices[stateFromUrl().scenario]);

  const setVariant = (next: VariantKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'cg4-prototype');
    url.searchParams.set('variant', next);
    window.history.replaceState({}, '', url);
    setVariantState(next);
    setState((current) => ({ ...current, lastAction: `เปลี่ยนเป็น Variant ${next}` }));
  };

  const cycle = (direction: -1 | 1) => {
    const index = variants.findIndex((item) => item.key === variant);
    setVariant(variants[(index + direction + variants.length) % variants.length]!.key);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [variant]);

  const action = (kind: 'APPROVE' | 'REJECT' | 'PUBLISH' | 'ROLLBACK' | 'RETRY') => {
    if (state.viewer !== 'COMPLIANCE' && kind !== 'RETRY') {
      setNotice('สิทธิ์ปัจจุบันดูหลักฐานได้ แต่ทำ approval/publish ไม่ได้');
      setState((current) => ({ ...current, lastAction: `${kind}: FORBIDDEN` }));
      return;
    }
    if (state.scenario === 'STALE_APPROVAL' && kind === 'APPROVE') {
      setNotice('Approval stale: authorization epoch เปลี่ยน ต้องโหลด scope และอนุมัติใหม่');
      setState((current) => ({ ...current, lastAction: 'APPROVAL_STALE' }));
      return;
    }
    if (state.scenario === 'VERSION_CONFLICT' && kind !== 'RETRY') {
      setNotice('Version conflict: มี policy version ใหม่กว่า ระบบไม่รวมการแก้ไขให้อัตโนมัติ');
      setState((current) => ({ ...current, lastAction: 'VERSION_CONFLICT' }));
      return;
    }
    if (state.scenario === 'PARTIAL_FAILURE' && kind === 'PUBLISH') {
      setNotice('Publish commit แล้ว แต่ acknowledgement ยังไม่ครบ: outbound scope ถูก hold');
      setState((current) => ({
        ...current,
        workflow: 'RECOVERY_REQUIRED',
        lastAction: 'ACK_PENDING — HOLD',
      }));
      return;
    }
    const next = {
      APPROVE: {
        workflow: 'APPROVED' as Workflow,
        quorum: '2 / 2',
        message: 'บันทึก approval คนที่ 2 แล้ว พร้อม schedule activation',
      },
      REJECT: {
        workflow: 'PENDING' as Workflow,
        quorum: '0 / 2',
        message: 'ปฏิเสธรายการแล้ว ประวัติยังเป็น append-only',
      },
      PUBLISH: {
        workflow: 'SCHEDULED' as Workflow,
        quorum: state.quorum,
        message: 'ตั้ง activation 14:00 น. และ pin test artifact แล้ว',
      },
      ROLLBACK: {
        workflow: 'PENDING' as Workflow,
        quorum: '0 / 2',
        message: 'สร้าง rollback candidate v19 แล้ว ไม่สลับกลับไป row เก่า',
      },
      RETRY: {
        workflow: 'ACTIVE' as Workflow,
        quorum: state.quorum,
        message: 'โหลด canonical state และ acknowledgement ใหม่แล้ว',
      },
    }[kind];
    setNotice(next.message);
    setState((current) => ({
      ...current,
      workflow: next.workflow,
      quorum: next.quorum,
      canonicalVersion: kind === 'ROLLBACK' ? 19 : current.canonicalVersion,
      lastAction: kind,
    }));
  };

  const props = { state, notice, action };

  return (
    <div className={`cg4p-shell cg4p-variant-${variant.toLowerCase()}`}>
      <PrototypeHeader state={state} setState={setState} setNotice={setNotice} />
      {variant === 'A' ? <VariantA {...props} /> : null}
      {variant === 'B' ? <VariantB {...props} /> : null}
      {variant === 'C' ? <VariantC {...props} /> : null}
      <StateInspector variant={variant} state={state} notice={notice} />
      <PrototypeSwitcher current={variant} onPrevious={() => cycle(-1)} onNext={() => cycle(1)} />
    </div>
  );
}

function PrototypeHeader({
  state,
  setState,
  setNotice,
}: {
  state: PrototypeState;
  setState: React.Dispatch<React.SetStateAction<PrototypeState>>;
  setNotice: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <header className="cg4p-header">
      <div className="cg4p-brand">
        <b>D-CONTACT</b>
        <span>Contact Governance</span>
        <em>PROTOTYPE · THROWAWAY</em>
      </div>
      <nav aria-label="Contact Governance sections">
        <button>ภาพรวม</button>
        <button className="is-current">Policies & Exceptions</button>
        <button>Audit</button>
      </nav>
      <div className="cg4p-context">
        <label>
          มุมมอง
          <select
            value={state.viewer}
            onChange={(event) => {
              replaceUrlParam('viewer', event.target.value);
              setState((current) => ({
                ...current,
                viewer: event.target.value as Viewer,
                lastAction: 'เปลี่ยน viewer',
              }));
            }}
          >
            <option value="SUPERVISOR">Supervisor</option>
            <option value="TENANT_ADMIN">Tenant Admin</option>
            <option value="COMPLIANCE">Compliance</option>
          </select>
        </label>
        <label>
          สถานการณ์
          <select
            value={state.scenario}
            onChange={(event) => {
              const scenario = event.target.value as Scenario;
              replaceUrlParam('scenario', scenario);
              setNotice(scenarioNotices[scenario]);
              setState((current) => ({
                ...current,
                scenario,
                lastAction: 'เปลี่ยน scenario',
              }));
            }}
          >
            <option value="READY">พร้อมอนุมัติ</option>
            <option value="STALE_APPROVAL">สิทธิ์อนุมัติ stale</option>
            <option value="VERSION_CONFLICT">version conflict</option>
            <option value="PARTIAL_FAILURE">acknowledgement ค้าง</option>
          </select>
        </label>
      </div>
    </header>
  );
}

interface VariantProps {
  state: PrototypeState;
  notice: string;
  action: (kind: 'APPROVE' | 'REJECT' | 'PUBLISH' | 'ROLLBACK' | 'RETRY') => void;
}

function VariantA({ state, notice, action }: VariantProps) {
  return (
    <main className="cg4p-main cg4p-workspace">
      <section className="cg4p-title-row">
        <div>
          <p className="cg4p-eyebrow">APPROVAL WORKSPACE</p>
          <h1>รายการรอตรวจ 3 รายการ</h1>
          <p>คัดกรองความเสี่ยงก่อน แล้วอ่านเหตุผลและหลักฐานในบริบทเดียว</p>
        </div>
        <StatusPill state={state.workflow} />
      </section>
      <Notice text={notice} scenario={state.scenario} />
      <div className="cg4p-three-pane">
        <aside className="cg4p-queue" aria-label="Approval queue">
          <h2>คิวของฉัน</h2>
          <button className="is-selected">
            <span>HIGH · 18 นาที</span>
            <b>EXC-2409</b>
            <small>ข้าม Attempt cap · LINE</small>
          </button>
          <button>
            <span>STANDARD · 41 นาที</span>
            <b>POL-19</b>
            <small>Quiet hours · Marketing</small>
          </button>
          <button>
            <span>EMERGENCY · 4 นาที</span>
            <b>EXC-2411</b>
            <small>Incident follow-up</small>
          </button>
        </aside>
        <section className="cg4p-case">
          <div className="cg4p-section-head">
            <div>
              <p className="cg4p-eyebrow">EXCEPTION EXC-2409</p>
              <h2>ขอข้ามเพดาน Attempt ชั่วคราว</h2>
            </div>
            <span className="cg4p-risk high">HIGH · 24h cap</span>
          </div>
          <GuardrailStrip />
          <dl className="cg4p-facts">
            <div>
              <dt>Scope</dt>
              <dd>Contact-wide · LINE · SERVICE · Journey JR-82</dd>
            </div>
            <div>
              <dt>Rule</dt>
              <dd>DAILY_ATTEMPT_CAP</dd>
            </div>
            <div>
              <dt>Policy binding</dt>
              <dd>POL-18 · digest …92af</dd>
            </div>
            <div>
              <dt>Effective</dt>
              <dd>13 ก.ย. 14:00–18:00 น.</dd>
            </div>
          </dl>
          <h3>เหตุผลและหลักฐาน</h3>
          <div className="cg4p-evidence">
            <b>INC-4821 · หลักฐานจำกัดสิทธิ์</b>
            <span>เนื้อหาถูกซ่อนในรายการรวม · เปิดได้เฉพาะ Compliance</span>
            <button>เปิด evidence drawer</button>
          </div>
          <h3>ผลทดสอบก่อนอนุมัติ</h3>
          <TestSummary />
        </section>
        <aside className="cg4p-action-rail">
          <h2>Maker–Checker</h2>
          <Timeline compact />
          <p className="cg4p-quorum">
            Quorum <b>{state.quorum}</b>
          </p>
          <button className="cg4p-primary" onClick={() => action('APPROVE')}>
            อนุมัติเป็น checker คนที่ 2
          </button>
          <button className="cg4p-danger" onClick={() => action('REJECT')}>
            ปฏิเสธพร้อมเหตุผล
          </button>
          <p className="cg4p-help">การอนุมัติไม่เท่ากับ ALLOW และไม่เปิด provider traffic</p>
        </aside>
      </div>
    </main>
  );
}

function VariantB({ state, notice, action }: VariantProps) {
  return (
    <main className="cg4p-main cg4p-studio">
      <section className="cg4p-title-row">
        <div>
          <p className="cg4p-eyebrow">POLICY CHANGE STUDIO</p>
          <h1>Policy v19 · Quiet hours</h1>
          <p>ตรวจ diff → tests → approvals → activation ใน flow เดียว</p>
        </div>
        <StatusPill state={state.workflow} />
      </section>
      <ol className="cg4p-stepper" aria-label="Policy workflow">
        <li className="done">1 Draft</li>
        <li className="done">2 Preview</li>
        <li className="current">3 Approvals</li>
        <li>4 Activation</li>
      </ol>
      <Notice text={notice} scenario={state.scenario} />
      <div className="cg4p-studio-grid">
        <section className="cg4p-diff">
          <div className="cg4p-section-head">
            <h2>Semantic diff จาก active v18</h2>
            <span className="cg4p-risk high">RELAXATION</span>
          </div>
          <div className="cg4p-diff-row removed">
            <span>−</span>
            <code>QUIET_HOURS 20:00–08:00</code>
          </div>
          <div className="cg4p-diff-row added">
            <span>+</span>
            <code>QUIET_HOURS 21:00–07:00</code>
          </div>
          <div className="cg4p-impact-grid">
            <article>
              <b>ขอบเขต</b>
              <span>LINE · SERVICE_NOTIFICATION</span>
            </article>
            <article>
              <b>เริ่มมีผล</b>
              <span>13 ก.ย. 14:00 น.</span>
            </article>
            <article>
              <b>Policy head</b>
              <span>expected v18 · …92af</span>
            </article>
          </div>
          <GuardrailStrip />
        </section>
        <aside className="cg4p-release-card">
          <h2>Release packet</h2>
          <TestSummary />
          <div className="cg4p-approval-row">
            <span>Maker</span>
            <b>Tenant Admin · verified</b>
          </div>
          <div className="cg4p-approval-row">
            <span>Checker 1</span>
            <b>Compliance · approved</b>
          </div>
          <div className="cg4p-approval-row">
            <span>Checker 2</span>
            <b>{state.quorum === '2 / 2' ? 'Compliance · approved' : 'รออนุมัติ'}</b>
          </div>
          <button className="cg4p-primary" onClick={() => action('APPROVE')}>
            บันทึก approval
          </button>
          <button className="cg4p-secondary" onClick={() => action('PUBLISH')}>
            ตั้งเวลา activation
          </button>
          <button className="cg4p-link" onClick={() => action('ROLLBACK')}>
            สร้าง rollback candidate
          </button>
        </aside>
      </div>
      <section className="cg4p-bottom-audit">
        <b>Audit preview</b>
        <span>
          จะบันทึก policy digest, test artifact, quorum, authorization epoch และ expected head
          โดยไม่เก็บ PII
        </span>
      </section>
    </main>
  );
}

function VariantC({ state, notice, action }: VariantProps) {
  return (
    <main className="cg4p-main cg4p-evidence-first">
      <section className="cg4p-title-row">
        <div>
          <p className="cg4p-eyebrow">EVIDENCE-FIRST TIMELINE</p>
          <h1>Trace: EXC-2409</h1>
          <p>เริ่มจากหลักฐานและผลกระทบ แล้วค่อยเปิด action ที่มีสิทธิ์</p>
        </div>
        <StatusPill state={state.workflow} />
      </section>
      <Notice text={notice} scenario={state.scenario} />
      <div className="cg4p-evidence-grid">
        <section className="cg4p-timeline-panel">
          <h2>Canonical timeline</h2>
          <Timeline />
          <button className="cg4p-secondary" onClick={() => action('RETRY')}>
            โหลด canonical state และ ack ใหม่
          </button>
        </section>
        <section className="cg4p-safety-board">
          <div className="cg4p-section-head">
            <h2>Safety case</h2>
            <span className="cg4p-risk high">HIGH</span>
          </div>
          <div className="cg4p-safety-row pass">
            <b>Hard restrictions</b>
            <span>ไม่ถูก override · 6/6 tests</span>
          </div>
          <div className="cg4p-safety-row pass">
            <b>Consent & preference</b>
            <span>ไม่ถูก override · 4/4 tests</span>
          </div>
          <div className="cg4p-safety-row warn">
            <b>Quorum</b>
            <span>{state.quorum} · ต้องการ direct Compliance</span>
          </div>
          <div className="cg4p-safety-row pass">
            <b>Expiry</b>
            <span>exclusive boundary · database UTC</span>
          </div>
          <div className="cg4p-redaction">
            <b>Evidence redaction</b>
            <p>
              {state.viewer === 'COMPLIANCE'
                ? 'INC-4821 · digest …a381 · เปิดรายละเอียดได้'
                : 'หลักฐานถูกปกปิด · ติดต่อ Compliance'}
            </p>
          </div>
        </section>
        <aside className="cg4p-command-dock">
          <h2>คำสั่งที่อนุญาต</h2>
          <button className="cg4p-primary" onClick={() => action('APPROVE')}>
            Approve
          </button>
          <button className="cg4p-danger" onClick={() => action('REJECT')}>
            Reject
          </button>
          <button className="cg4p-secondary" onClick={() => action('ROLLBACK')}>
            Draft rollback
          </button>
          <p className="cg4p-help">ทุกคำสั่ง re-authorize และ bind canonical version ก่อน commit</p>
        </aside>
      </div>
    </main>
  );
}

function GuardrailStrip() {
  return (
    <div className="cg4p-guardrail">
      <b>Guardrails</b>
      <span>DNC / objection / consent / explicit preference ยังข้ามไม่ได้</span>
    </div>
  );
}

function TestSummary() {
  return (
    <div className="cg4p-tests" aria-label="Synthetic policy tests">
      <span className="pass">18 ผ่าน</span>
      <span>0 ล้มเหลว</span>
      <span>artifact …a381</span>
      <button>ดู test trace</button>
    </div>
  );
}

function Timeline({ compact = false }: { compact?: boolean }) {
  const items = compact
    ? ['Maker ส่ง revision …92af', 'Checker 1 อนุมัติ', 'รอ checker 2']
    : [
        '13:02 สร้าง request v1',
        '13:06 Preview/test 18/18',
        '13:11 Checker 1 อนุมัติ',
        '13:18 IAM scope revalidated',
        'ตอนนี้ รอ checker 2',
      ];
  return (
    <ol className="cg4p-timeline">
      {items.map((item, index) => (
        <li key={item}>
          <span>{index + 1}</span>
          {item}
        </li>
      ))}
    </ol>
  );
}

function Notice({ text, scenario }: { text: string; scenario: Scenario }) {
  const danger = scenario !== 'READY';
  return (
    <p className={`cg4p-notice ${danger ? 'is-warning' : ''}`} role="status" aria-live="polite">
      {text}
    </p>
  );
}

function StatusPill({ state }: { state: Workflow }) {
  return (
    <span className={`cg4p-status state-${state.toLowerCase()}`}>{state.replaceAll('_', ' ')}</span>
  );
}

function StateInspector({
  variant,
  state,
  notice,
}: {
  variant: VariantKey;
  state: PrototypeState;
  notice: string;
}) {
  const visibleState = useMemo(
    () => ({
      variant,
      ...state,
      notice,
      persistence: 'IN_MEMORY_ONLY',
      actualProviderTraffic: false,
    }),
    [variant, state, notice],
  );
  return (
    <details className="cg4p-state" open>
      <summary>Prototype state · ไม่มี mutation จริง</summary>
      <pre>{JSON.stringify(visibleState, null, 2)}</pre>
    </details>
  );
}

function PrototypeSwitcher({
  current,
  onPrevious,
  onNext,
}: {
  current: VariantKey;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const selected = variants.find((item) => item.key === current)!;
  return (
    <div className="cg4p-switcher" aria-label="Prototype variant switcher">
      <button onClick={onPrevious} aria-label="Variant ก่อนหน้า">
        ←
      </button>
      <b>
        {selected.key} · {selected.name}
      </b>
      <button onClick={onNext} aria-label="Variant ถัดไป">
        →
      </button>
    </div>
  );
}

function variantFromUrl(): VariantKey {
  const value = new URL(window.location.href).searchParams.get('variant');
  return value === 'B' || value === 'C' ? value : 'A';
}

function stateFromUrl(): PrototypeState {
  const params = new URL(window.location.href).searchParams;
  const viewer = params.get('viewer')?.toUpperCase();
  const scenario = params.get('scenario')?.toUpperCase();
  return {
    ...initialState,
    viewer:
      viewer === 'SUPERVISOR' || viewer === 'TENANT_ADMIN' || viewer === 'COMPLIANCE'
        ? viewer
        : initialState.viewer,
    scenario:
      scenario === 'STALE_APPROVAL' ||
      scenario === 'VERSION_CONFLICT' ||
      scenario === 'PARTIAL_FAILURE'
        ? scenario
        : initialState.scenario,
  };
}

function replaceUrlParam(key: 'viewer' | 'scenario', value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  window.history.replaceState({}, '', url);
}
