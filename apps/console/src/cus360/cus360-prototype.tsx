/** Prototype #762: เปรียบเทียบ 3 layout ของ Console/Workspace ผ่าน ?variant=; ข้อมูลสมมติใน memory เท่านั้น */
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, ShellFrame, SubNav } from '@d-contact/ui-react';
import { appI18n } from '../i18n/index.js';
import '@d-contact/ui/tokens.css';
import './cus360-prototype.css';

type Customer = {
  id: string;
  name: string;
  company: string;
  phones: string[];
  emails: string[];
  tags: string;
  vip: boolean;
  pending?: boolean;
};
const seed: Customer[] = [
  {
    id: 'demo-01',
    name: 'ลูกค้าตัวอย่าง 01',
    company: 'บริษัท ตัวอย่าง จำกัด',
    phones: ['080-000-0101', '02-000-0101'],
    emails: ['customer01@example.test'],
    tags: 'ลูกค้าเดิม, บริการหลังการขาย',
    vip: true,
  },
  {
    id: 'demo-02',
    name: 'ลูกค้าตัวอย่าง 02',
    company: 'ตัวอย่าง สตูดิโอ',
    phones: ['080-000-0102'],
    emails: ['customer02@example.test'],
    tags: 'ติดตามงาน',
    vip: false,
  },
  {
    id: 'demo-03',
    name: 'ลูกค้าสร้างใหม่',
    company: '',
    phones: ['080-000-0103'],
    emails: [],
    tags: '',
    vip: false,
    pending: true,
  },
];
const blank: Customer = {
  id: '',
  name: '',
  company: '',
  phones: [''],
  emails: [''],
  tags: '',
  vip: false,
};
const scenarios = [
  'normal',
  'loading',
  'empty',
  'forbidden',
  'not-found',
  'ambiguous',
  'partial',
  'conflict',
  'unknown',
  'session',
  'scope',
  'assignment',
] as const;
const labels = {
  normal: ['ปกติ', 'Normal'],
  loading: ['กำลังโหลด', 'Loading'],
  empty: ['ไม่มีผลลัพธ์', 'Empty'],
  forbidden: ['ไม่มีสิทธิ์', 'Forbidden'],
  'not-found': ['ไม่พบรายการ', 'Not found'],
  ambiguous: ['พบหลายคน', 'Ambiguous'],
  partial: ['Governance ไม่พร้อม', 'Governance unavailable'],
  conflict: ['มีคนแก้พร้อมกัน', 'Revision conflict'],
  unknown: ['ไม่ทราบผลบันทึก', 'Unknown result'],
  session: ['session หมดอายุ', 'Session expired'],
  scope: ['สิทธิ์ทีมยังไม่พร้อม', 'Scope pending'],
  assignment: ['งานเปลี่ยนผู้รับผิดชอบ', 'Assignment changed'],
} as const;
const names = {
  A: ['รายการ → โปรไฟล์เต็มหน้า', 'Directory → full profile'],
  B: ['รายการคู่แผงรายละเอียด', 'List and detail workspace'],
  C: ['โปรไฟล์เป็นศูนย์กลาง', 'Profile-first overview'],
} as const;
type Variant = keyof typeof names;

export function Cus360Prototype() {
  const initial = new URL(window.location.href).searchParams;
  const [variant, setVariant] = useState<Variant>(
    (['A', 'B', 'C'].includes(initial.get('variant') ?? '')
      ? initial.get('variant')
      : 'A') as Variant,
  );
  const [surface, setSurface] = useState(
    initial.get('surface') === 'workspace' ? 'workspace' : 'console',
  );
  const [lang, setLang] = useState<'th' | 'en'>(initial.get('lang') === 'en' ? 'en' : 'th');
  const t = (th: string, en: string) => (lang === 'th' ? th : en);
  const [role, setRole] = useState(initial.get('surface') === 'workspace' ? 'agent' : 'admin');
  const [scenario, setScenario] = useState<(typeof scenarios)[number]>('normal');
  const [customers, setCustomers] = useState(seed);
  const [selected, setSelected] = useState('demo-01');
  const customer = customers.find((c) => c.id === selected) ?? customers[0];
  const [page, setPage] = useState('list');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Customer | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [linked, setLinked] = useState<string | null>(null);
  const [work, setWork] = useState(1);
  const [phase, setPhase] = useState('ACTIVE');
  const [wrapup, setWrapup] = useState('');
  const [disposition, setDisposition] = useState('CUSTOMER_ASSISTED');
  const [candidate, setCandidate] = useState('demo-01');
  const [panelTab, setPanelTab] = useState('profile');
  useEffect(() => {
    void appI18n.changeLanguage(lang);
  }, []);
  const [pendingNav, setPendingNav] = useState<null | (() => void)>(null);
  const nav = (fn: () => void) => {
    const run = () => {
      setDraft(null);
      setDirty(false);
      setNotice('');
      setError('');
      fn();
    };
    if (dirty) setPendingNav(() => run);
    else run();
  };
  const url = (patch: Record<string, string>) => {
    const next = new URL(window.location.href);
    for (const [k, v] of Object.entries(patch)) next.searchParams.set(k, v);
    window.history.replaceState(null, '', next);
  };
  const changeVariant = (step: number) =>
    nav(() => {
      const v = (['A', 'B', 'C'] as Variant[])[(['A', 'B', 'C'].indexOf(variant) + step + 3) % 3];
      setVariant(v);
      url({ variant: v });
    });
  const changeSurface = (next: string) =>
    nav(() => {
      setSurface(next);
      setRole(next === 'workspace' ? 'agent' : 'admin');
      url({ surface: next });
    });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        changeVariant(e.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty || wrapup) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty, wrapup]);
  const language = (next: 'th' | 'en') => {
    setLang(next);
    url({ lang: next });
    void appI18n.changeLanguage(next);
  };
  const open = (c: Customer) =>
    nav(() => {
      setSelected(c.id);
      setPage('profile');
    });
  const edit = (create = false) => {
    setDraft(
      create
        ? { ...blank, phones: [''], emails: [''] }
        : { ...customer, phones: [...customer.phones], emails: [...customer.emails] },
    );
    setDirty(false);
    setError('');
    setNotice('');
  };
  const update = (patch: Partial<Customer>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
    setNotice('');
  };
  const save = () => {
    if (!draft?.name.trim()) {
      setError(t('กรุณากรอกชื่อแสดงผล', 'Enter a display name'));
      return;
    }
    if (scenario === 'conflict' || scenario === 'unknown' || scenario === 'session') {
      setError(
        t(
          'ร่างยังอยู่ กรุณาจัดการสถานะด้านล่างก่อน',
          'Your draft is retained. Resolve the status below first.',
        ),
      );
      return;
    }
    const value = {
      ...draft,
      name: draft.name.trim(),
      id: draft.id || `demo-new-${customers.length}`,
      pending: draft.id ? draft.pending : true,
    };
    setCustomers((cs) =>
      cs.some((c) => c.id === value.id)
        ? cs.map((c) => (c.id === value.id ? value : c))
        : [...cs, value],
    );
    value.phones = value.phones.filter((p) => p.trim());
    value.emails = value.emails.filter((e) => e.trim());
    setSelected(value.id);
    setDraft(null);
    setDirty(false);
    setPage('profile');
    setError('');
    setNotice(
      t(
        'จำลองบันทึกและอ่านค่ากลับแล้ว • ข้อมูลอยู่ในหน้านี้เท่านั้น',
        'Simulated save and readback • in-memory data only',
      ),
    );
  };
  const identity = (c: Customer, compact = false) => (
    <section className="c360p-card">
      <h2>{t('ช่องทางติดต่อ', 'Contact identities')}</h2>
      <p className="c360p-muted">
        {t('มีข้อมูลช่องทาง ≠ ยืนยันบุคคลแล้ว', 'Identity data is not verification')}
      </p>
      {c.phones.map((p, i) => (
        <div className="c360p-detail" key={p}>
          <span>
            {t('โทรศัพท์', 'Phone')} {i + 1}
          </span>
          <strong>{compact ? `${p.replace(/\D/g, '').slice(0, 3)}-XXX-${p.slice(-4)}` : p}</strong>
          <Badge tone="neutral">{t('ยังไม่ยืนยัน', 'Unverified')}</Badge>
        </div>
      ))}
      {c.emails.map((e) => (
        <div className="c360p-detail" key={e}>
          <span>Email</span>
          <strong>{e}</strong>
        </div>
      ))}
    </section>
  );
  const governance = () => (
    <div
      className={`c360p-governance ${scenario === 'partial' ? 'c360p-alert' : ''}`}
      role="status"
    >
      <strong>
        {scenario === 'partial'
          ? t('ยังอ่านสถานะการติดต่อไม่ได้', 'Contact status unavailable')
          : t('ห้ามโทรเพื่อการตลาด', 'No marketing calls')}
      </strong>
      <span>
        {scenario === 'partial'
          ? t(
              'Contact Governance ไม่พร้อม • ไม่ตีความว่าอนุญาตให้ติดต่อ',
              'Contact Governance is unavailable • permission is unknown',
            )
          : t(
              'สรุปจาก Contact Governance • ข้อมูลสมมติ 10:42 น.',
              'Contact Governance summary • synthetic snapshot 10:42',
            )}
      </span>
      {scenario === 'partial' && (
        <Button size="sm" onPress={() => setScenario('normal')}>
          {t('ลองอ่านใหม่', 'Retry')}
        </Button>
      )}
    </div>
  );
  const timeline = () => (
    <section className="c360p-card">
      <div className="c360p-row">
        <h2>{t('ประวัติการติดต่อ', 'Interaction timeline')}</h2>
        <Badge tone="neutral">{t('เฉพาะที่มีสิทธิ์', 'Authorized records')}</Badge>
      </div>
      <p className="c360p-muted">
        {t(
          'แสดงข้อมูลสรุป ไม่เปิดโน้ตของผู้อื่นหรือเสียงสนทนา',
          'Summary only; other agents’ notes and audio are not exposed',
        )}
      </p>
      <ol className="c360p-timeline">
        {[
          ['วันนี้ · 10:15', 'Voice', t('ปิดงานแล้ว', 'Completed')],
          ['เมื่อวาน · 14:30', 'LINE', t('ปิดงานแล้ว', 'Completed')],
          ['23 ต.ค. · 09:20', 'Email', t('รอติดตาม', 'Follow-up')],
        ].map(([at, channel, state]) => (
          <li key={at}>
            <span className="c360p-dot" />
            <div>
              <strong>{channel}</strong>
              <p>
                {t(
                  at,
                  at === 'วันนี้ · 10:15'
                    ? 'Today · 10:15'
                    : at === 'เมื่อวาน · 14:30'
                      ? 'Yesterday · 14:30'
                      : '23 Oct · 09:20',
                )}
              </p>
            </div>
            <Badge tone="neutral">{state}</Badge>
          </li>
        ))}
      </ol>
    </section>
  );
  const heading = (c: Customer) => (
    <header className="c360p-profile-heading">
      <div className="c360p-avatar">{c.name.slice(-2)}</div>
      <div>
        <div className="c360p-row">
          <h1>{c.name}</h1>
          {c.vip && <Badge tone="attention">VIP</Badge>}
        </div>
        <p>
          {c.company || t('ยังไม่ระบุบริษัท', 'Company not supplied')} · {c.id}
        </p>
        <div className="c360p-tags">
          {c.tags
            .split(',')
            .filter(Boolean)
            .map((tag) => (
              <Badge tone="neutral" key={tag}>
                {tag.trim()}
              </Badge>
            ))}
        </div>
      </div>
      {role !== 'supervisor' && (
        <Button onPress={() => edit()}>{t('แก้ข้อมูลพื้นฐาน', 'Edit basic details')}</Button>
      )}
    </header>
  );
  const profile = (c: Customer, compact = false) => (
    <div className="c360p-profile">
      {heading(c)}
      {c.pending ? (
        <div className="c360p-governance">
          {t(
            'ยังไม่มีสรุปจาก Contact Governance • ไม่สรุปว่าอนุญาตให้ติดต่อ',
            'Contact Governance summary is not available • permission is unknown',
          )}
        </div>
      ) : (
        governance()
      )}
      {c.pending && (
        <div className="c360p-alert">
          {t(
            'ลูกค้าใหม่ • รอสิทธิ์ทีมพร้อมก่อนให้ Supervisor/Agent เปิดใช้',
            'New customer • team access must be ready before Supervisor/Agent access',
          )}
        </div>
      )}
      <div className={compact ? 'c360p-stack' : 'c360p-profile-grid'}>
        <div>
          {c.pending ? (
            <section className="c360p-card">
              <h2>{t('ประวัติการติดต่อ', 'Interaction timeline')}</h2>
              <p>
                {t(
                  'ลูกค้าใหม่ยังไม่มีประวัติการติดต่อ',
                  'This new customer has no interaction history',
                )}
              </p>
            </section>
          ) : (
            timeline()
          )}
        </div>
        <div>
          {identity(c, compact)}
          <section className="c360p-card">
            <h2>{t('แหล่งข้อมูล', 'Data sources')}</h2>
            <p>D-Contact · {t('ข้อมูลตัวอย่างในหน่วยความจำ', 'Synthetic in-memory data')}</p>
            <p className="c360p-muted">
              {t('CRM ภายนอกยังอยู่นอกขอบเขตรอบแรก', 'External CRM is outside the first slice')}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
  const list = (compact = false) => (
    <section className="c360p-card c360p-directory">
      <label className="c360p-search">
        {t('ค้นหาลูกค้า', 'Find a customer')}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ชื่อ เบอร์โทร หรืออีเมล', 'Name, phone or email')}
        />
      </label>
      <p className="c360p-muted">
        {t(
          'ค้นหาภายในขอบเขตที่มีสิทธิ์ • ข้อมูลสมมติ',
          'Search within authorized scope • synthetic data',
        )}
      </p>
      {customers
        .filter((c) => role === 'admin' || !c.pending)
        .filter((c) =>
          `${c.name} ${c.company} ${c.phones} ${c.emails}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .map((c) => (
          <button
            key={c.id}
            type="button"
            className={`c360p-customer ${selected === c.id && compact ? 'is-selected' : ''}`}
            onClick={() => open(c)}
          >
            <span className="c360p-avatar small">{c.name.slice(-2)}</span>
            <span className="c360p-grow">
              <strong>{c.name}</strong>
              <span>{c.company || '—'}</span>
              {compact && <small>{c.phones[0]}</small>}
            </span>
            {!compact && (
              <span className="c360p-list-meta">
                {c.phones[0]}
                <small>
                  {c.phones.length + c.emails.length} {t('ช่องทาง', 'identities')}
                </small>
              </span>
            )}
            {c.pending ? (
              <Badge tone="attention">{t('รอสิทธิ์ทีม', 'Scope pending')}</Badge>
            ) : c.vip ? (
              <Badge tone="attention">VIP</Badge>
            ) : null}
            <span aria-hidden>›</span>
          </button>
        ))}
      {customers.filter((c) => `${c.name} ${c.phones} ${c.emails}`.includes(query)).length ===
        0 && <p>{t('ไม่มีผลลัพธ์ที่แสดงได้', 'No visible results')}</p>}
    </section>
  );
  const editor = () =>
    draft && (
      <section className="c360p-card c360p-editor">
        <div className="c360p-row">
          <h1>
            {draft.id ? t('แก้ข้อมูลลูกค้า', 'Edit customer') : t('สร้างลูกค้า', 'Create customer')}
          </h1>
          <Badge tone="neutral">{t('ข้อมูลสมมติ', 'Synthetic')}</Badge>
        </div>
        <p className="c360p-muted">
          {t(
            'ตัวอย่างฟอร์ม — กฎ validation และสิทธิ์ tags/VIP ยังรอ API contract',
            'Form preview — final validation and tags/VIP editing permissions await the API contract',
          )}
        </p>
        <div className="c360p-form-grid">
          <label>
            {t('ชื่อแสดงผล', 'Display name')}
            <input
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              aria-invalid={!!error && !draft.name.trim()}
            />
          </label>
          <label>
            {t('บริษัท (ไม่บังคับ)', 'Company (optional)')}
            <input value={draft.company} onChange={(e) => update({ company: e.target.value })} />
          </label>
        </div>
        {(['phones', 'emails'] as const).map((kind) => (
          <fieldset key={kind}>
            <legend>
              {kind === 'phones' ? t('เบอร์โทร', 'Phone numbers') : t('อีเมล', 'Email addresses')}
            </legend>
            {draft[kind].map((value, i) => (
              <label key={i} className="c360p-inline-field">
                {i + 1}
                <input
                  aria-label={`${kind} ${i + 1}`}
                  disabled={role !== 'admin'}
                  value={value}
                  onChange={(e) =>
                    update({ [kind]: draft[kind].map((v, n) => (n === i ? e.target.value : v)) })
                  }
                />
              </label>
            ))}
            {role === 'admin' && (
              <Button size="sm" onPress={() => update({ [kind]: [...draft[kind], ''] })}>
                {t('เพิ่มรายการ', 'Add another')}
              </Button>
            )}
          </fieldset>
        ))}
        <label>
          {t('แท็ก (คั่นด้วย comma)', 'Tags (comma separated)')}
          <input
            disabled={role !== 'admin'}
            value={draft.tags}
            onChange={(e) => update({ tags: e.target.value })}
          />
        </label>
        <label className="c360p-checkbox">
          <input
            type="checkbox"
            disabled={role !== 'admin'}
            checked={draft.vip}
            onChange={(e) => update({ vip: e.target.checked })}
          />
          VIP
        </label>
        {role === 'agent' && (
          <p>
            {t(
              'identity อ่านอย่างเดียว; tags/VIP รอข้อตกลงสิทธิ์ใน API contract',
              'Identities are read-only; tags/VIP editing awaits a permission decision',
            )}
          </p>
        )}
        {error && (
          <p className="c360p-error" role="alert">
            {error}
          </p>
        )}
        {status()}
        <div className="c360p-actions">
          <Button variant="primary" onPress={save}>
            {t('จำลองบันทึกและอ่านกลับ', 'Simulate save and readback')}
          </Button>
          <Button onPress={() => nav(() => setPage('profile'))}>{t('ยกเลิก', 'Cancel')}</Button>
          <span>
            {dirty ? t('มีร่างที่ยังไม่บันทึก', 'Unsaved draft') : t('ไม่มีการแก้ไข', 'No changes')}
          </span>
        </div>
      </section>
    );
  const status = () => {
    const messages: Partial<Record<typeof scenario, [string, string]>> = {
      loading: ['กำลังอ่านข้อมูลลูกค้า…', 'Loading customer data…'],
      empty: ['ยังไม่มีลูกค้าในผลค้นหานี้', 'No customers in this search'],
      forbidden: [
        'ไม่สามารถเปิดข้อมูลนี้ตามสิทธิ์ปัจจุบัน',
        'This data is unavailable within your current permissions',
      ],
      'not-found': ['ไม่พบรายการที่เปิดได้', 'No accessible record found'],
      ambiguous: [
        'พบหลายคนที่อาจตรงกัน • เลือกจากข้อมูลที่มีสิทธิ์ ไม่รวมลูกค้าอัตโนมัติ',
        'Multiple possible matches • choose within scope; no automatic merge',
      ],
      conflict: [
        'ข้อมูลถูกแก้โดยผู้อื่น ร่างยังอยู่ ต้องอ่านค่าล่าสุดและตรวจแก้ก่อนส่งใหม่',
        'Another user changed this record. Your draft is retained; review the latest version before submitting again',
      ],
      unknown: [
        'ยังไม่ทราบผลคำสั่งเดิม ร่างยังอยู่ ตรวจ receipt และอ่านข้อมูลกลับก่อนแจ้งสำเร็จ',
        'The original command result is unknown. Retain the draft and check its receipt/readback before reporting success',
      ],
      session: [
        'session หมดอายุ ร่างยังอยู่ในหน้านี้ เข้าสู่ระบบอีกครั้งก่อนตรวจคำสั่งเดิม',
        'Your session expired. This page retains the draft; sign in again before checking the original command',
      ],
      scope: [
        'สิทธิ์ทีมยังไม่พร้อม • ยังไม่เปิดโปรไฟล์ รอผู้ดูแลจัดสิทธิ์/ประเมินให้ครบ',
        'Team scope is not ready. The profile stays closed until access has been established',
      ],
      assignment: [
        'งานเปลี่ยนผู้รับผิดชอบแล้ว • ปิดข้อมูลลูกค้าเดิมและตรวจสิทธิ์ใหม่',
        'The assignment changed. Previous customer data is closed; re-check authorization',
      ],
    };
    const m = messages[scenario];
    if (!m) return null;
    return (
      <section className="c360p-alert" role="status">
        <strong>{t(...m)}</strong>
        {['conflict', 'unknown', 'session'].includes(scenario) ? (
          <Button
            size="sm"
            onPress={() => {
              setScenario('normal');
              setError('');
              setNotice(
                t(
                  'จำลองอ่านสถานะเดิมแล้ว • ร่างยังไม่ถูกส่งซ้ำ กรุณาตรวจข้อมูลต่อ',
                  'Simulated original-status check • draft was not resubmitted; review before continuing',
                ),
              );
            }}
          >
            {scenario === 'unknown'
              ? t('ตรวจคำสั่งเดิม', 'Check original command')
              : scenario === 'conflict'
                ? t('อ่านค่าล่าสุด', 'Read latest version')
                : t('จำลองกลับเข้าใช้', 'Simulate reauthentication')}
          </Button>
        ) : (
          <Button size="sm" onPress={() => setScenario('normal')}>
            {t('กลับสถานะปกติ', 'Return to normal')}
          </Button>
        )}
      </section>
    );
  };
  const blocked = [
    'loading',
    'empty',
    'forbidden',
    'not-found',
    'scope',
    'assignment',
    'session',
  ].includes(scenario);
  const consoleBody = () =>
    role === 'agent' ? (
      <section className="c360p-card">
        <h1>{t('เปิดลูกค้าผ่านงานที่รับผิดชอบ', 'Open customers through your assigned work')}</h1>
        <p>
          {t(
            'Agent ไม่มี directory สำหรับเปิดโปรไฟล์ลูกค้าทั้งหมด',
            'Agents do not have a general customer profile directory',
          )}
        </p>
        <Button onPress={() => changeSurface('workspace')}>
          {t('ดูแผงลูกค้าใน Workspace', 'Open Workspace preview')}
        </Button>
      </section>
    ) : scenario === 'session' ? (
      status()
    ) : draft ? (
      editor()
    ) : blocked ? (
      status()
    ) : (
      <>
        {['ambiguous', 'conflict', 'unknown', 'session'].includes(scenario) && status()}
        {variant === 'A' ? (
          page === 'list' ? (
            list()
          ) : (
            <>
              <Button onPress={() => nav(() => setPage('list'))}>
                ← {t('กลับรายการ', 'Back to directory')}
              </Button>
              {profile(customer)}
            </>
          )
        ) : variant === 'B' ? (
          <div className="c360p-split">
            {list(true)}
            {profile(customer, true)}
          </div>
        ) : (
          <>
            <div className="c360p-overview-search">{list(true)}</div>
            <div className="c360p-focus-profile">{profile(customer)}</div>
          </>
        )}
      </>
    );
  const link = () => {
    setLinked(candidate);
    setSelected(candidate);
    setNotice(
      t(
        'จำลองผูกลูกค้ากับงานแล้ว • identity ยังไม่ยืนยัน',
        'Simulated work linkage • identity remains unverified',
      ),
    );
  };
  const nextWork = () => {
    const run = () => {
      setWork((w) => w + 1);
      setLinked(null);
      setWrapup('');
      setDraft(null);
      setDirty(false);
      setNotice('');
      setScenario('normal');
      setPhase('ACTIVE');
    };
    if (wrapup || dirty) setPendingNav(() => run);
    else run();
  };
  const callCard = () => (
    <section className="c360p-card">
      <div className="c360p-row">
        <Badge tone={phase === 'ACTIVE' ? 'success' : 'neutral'}>{phase}</Badge>
        <strong>Voice · DEMO-{work.toString().padStart(3, '0')}</strong>
      </div>
      <p className="c360p-caller">080-XXX-010{work % 10}</p>
      <p>{t('SIP test caller • คิวบริการลูกค้า', 'SIP test caller • Service queue')}</p>
      <p className="c360p-muted">
        {t(
          'ตัวควบคุมนี้จำลอง UI เท่านั้น ไม่เชื่อมสายจริง',
          'These controls simulate the UI; no live call is connected',
        )}
      </p>
      <Button onPress={() => setPhase('WRAPUP')} isDisabled={phase !== 'ACTIVE'}>
        {t('จำลองจบสาย', 'Simulate call ended')}
      </Button>
    </section>
  );
  const customerPanel = () => (
    <section className="c360p-work-customer">
      <div className="c360p-row">
        <h2>{t('ลูกค้าของงานนี้', 'Customer for this work')}</h2>
        <Badge tone="neutral">{linked ? t('ผูกแล้ว', 'Linked') : t('ยังไม่ผูก', 'Unlinked')}</Badge>
      </div>
      {blocked ? (
        status()
      ) : draft ? (
        editor()
      ) : linked ? (
        <>
          {profile(customers.find((c) => c.id === linked) ?? customer, true)}
          <Button onPress={() => nav(() => setLinked(null))}>
            {t('ดูตัวอย่างสถานะยังไม่ผูก', 'Preview unlinked state')}
          </Button>
        </>
      ) : (
        <section className="c360p-card">
          <h3>{t('เลือกลูกค้าที่เกี่ยวข้องกับงาน', 'Choose the customer for this work')}</h3>
          <p>
            {t(
              'caller ID เป็นข้อมูลช่วยค้นหา • การเลือกไม่ยืนยันบุคคล',
              'Caller ID is a search hint • selection is not verification',
            )}
          </p>
          <p className="c360p-muted">
            {t(
              'แสดง candidate แบบจำกัดตามงาน/ทีม ในตัวอย่างสมมติเท่านั้น',
              'Restricted work/team candidates in this synthetic preview',
            )}
          </p>
          {(scenario === 'empty' ? [] : customers.filter((c) => !c.pending)).map((c) => (
            <label className="c360p-candidate" key={c.id}>
              <input
                type="radio"
                name="candidate"
                value={c.id}
                checked={candidate === c.id}
                onChange={() => setCandidate(c.id)}
              />
              <span>
                <strong>{c.name}</strong>
                <small>
                  {c.company} · 080-XXX-{c.phones[0].slice(-4)}
                </small>
              </span>
            </label>
          ))}
          <Button variant="primary" onPress={link}>
            {t('เลือกผูกกับงานนี้', 'Link to this work')}
          </Button>
          <p>
            {t(
              'ไม่พบ/เลือกไม่ได้ ยังทำสายและบันทึกผลต่อได้',
              'No match? Continue the call and save its outcome without linkage',
            )}
          </p>
        </section>
      )}
    </section>
  );
  const outcome = () => (
    <section className="c360p-card">
      <h2>{t('บันทึกผลของงานนี้', 'Current work outcome')}</h2>
      <label>
        {t('ผลการสนทนา', 'Disposition')}
        <select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          <option value="CUSTOMER_ASSISTED">CUSTOMER_ASSISTED</option>
          <option value="FOLLOW_UP_REQUIRED">FOLLOW_UP_REQUIRED</option>
        </select>
      </label>
      <label>
        {t('โน้ตงานตนเอง', 'Your work note')}
        <textarea value={wrapup} maxLength={2000} onChange={(e) => setWrapup(e.target.value)} />
      </label>
      <Button
        variant="primary"
        isDisabled={phase !== 'WRAPUP' || !wrapup.trim()}
        onPress={() => {
          setPhase('DONE');
          setWrapup('');
          setNotice(
            t(
              'จำลองบันทึกผลแล้ว แม้ไม่ได้ผูกลูกค้า • ไม่มี API call',
              'Outcome simulated successfully, even without a linked customer • no API call',
            ),
          );
        }}
      >
        {t('จำลองบันทึกผล', 'Simulate save outcome')}
      </Button>
    </section>
  );
  const workspace = () => (
    <>
      <div className="c360p-page-title">
        <div>
          <h1>{t('งานที่รับผิดชอบ', 'Assigned work')}</h1>
          <p>
            {t(
              'ตัวอย่างแผงลูกค้า • Agent ไม่มีปุ่มสร้างลูกค้าใหม่',
              'Customer-panel preview • Agents cannot create customers',
            )}
          </p>
        </div>
        <Button onPress={nextWork}>{t('จำลองงานถัดไป', 'Simulate next work')}</Button>
      </div>
      {variant === 'A' ? (
        <div className="c360p-work-a">
          <div>
            {callCard()}
            {outcome()}
          </div>
          {customerPanel()}
        </div>
      ) : variant === 'B' ? (
        <div className="c360p-work-b">
          <div className="c360p-tabs">
            <Button onPress={() => setPanelTab('profile')}>{t('ลูกค้า', 'Customer')}</Button>
            <Button onPress={() => setPanelTab('outcome')}>{t('ผลการสนทนา', 'Outcome')}</Button>
          </div>
          <div className="c360p-work-main">
            {panelTab === 'profile' ? customerPanel() : outcome()}
            {callCard()}
          </div>
        </div>
      ) : (
        <div className="c360p-work-c">
          {callCard()}
          <div>
            {customerPanel()}
            {outcome()}
          </div>
        </div>
      )}
    </>
  );
  const app = {
    id: 'cus360-prototype',
    label: 'Cus360',
    groupId: 'data',
    href: '?view=cus360-prototype',
    external: false,
  };
  return (
    <ShellFrame
      apps={[app]}
      groups={[{ id: 'data', label: t('ข้อมูลลูกค้า', 'Customer data') }]}
      pinnedIds={[app.id]}
      maxPins={15}
      onTogglePin={() =>
        setNotice(
          t(
            'การปักหมุดเป็นส่วนของ shell เดิม ไม่บันทึกใน prototype',
            'Pins belong to the existing shell and are not persisted here',
          ),
        )
      }
      currentAppId={app.id}
      onNavigate={() => true}
      brand={
        <span className="c360p-brand">
          <img src="/d-contact-icon-64.png" alt="" />
          D-Contact
        </span>
      }
      breadcrumb={
        surface === 'console' ? ['Cus360', t('ลูกค้า', 'Customers')] : ['Workspace', `DEMO-${work}`]
      }
      breadcrumbPlacement="content"
      language={lang}
      onLanguageChange={language}
      subNav={
        surface === 'console' ? (
          <SubNav
            title="Cus360"
            eyebrow={t('ข้อมูลลูกค้า', 'Customer data')}
            currentItemId="customers"
            sections={[
              {
                id: 'work',
                items: [
                  {
                    id: 'customers',
                    label: t('ลูกค้า', 'Customers'),
                    href: '?view=cus360-prototype',
                    onSelect: () => nav(() => setPage('list')),
                  },
                ],
              },
            ]}
          />
        ) : undefined
      }
      topBarActions={
        <Badge tone="attention">
          {t('ต้นแบบ • ไม่เชื่อมระบบจริง', 'Prototype • synthetic only')}
        </Badge>
      }
    >
      <div className={`c360p-root variant-${variant}`}>
        <div className="c360p-lab">
          <strong>PROTOTYPE</strong>
          <span>
            {t(
              'ใช้เลือก UX เท่านั้น • ข้อมูลสมมติ • รีโหลดแล้วเริ่มใหม่',
              'UX exploration only • synthetic data • reload resets all state',
            )}
          </span>
          <label>
            {t('มุมมอง', 'Surface')}
            <select
              aria-label={t('มุมมอง', 'Surface')}
              value={surface}
              onChange={(e) => changeSurface(e.target.value)}
            >
              <option value="console">Console</option>
              <option value="workspace">Agent Workspace</option>
            </select>
          </label>
          <label>
            {t('บทบาทจำลอง', 'Preview role')}
            <select
              value={role}
              onChange={(e) =>
                nav(() => {
                  setRole(e.target.value);
                  setSelected('demo-01');
                  setScenario('normal');
                })
              }
            >
              {(surface === 'workspace' ? ['agent'] : ['admin', 'supervisor', 'agent']).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('สถานะจำลอง', 'Scenario')}
            <select
              aria-label={t('สถานะจำลอง', 'Scenario')}
              value={scenario}
              onChange={(e) => {
                const s = e.target.value as typeof scenario;
                setScenario(s);
                setError('');
                if (s === 'assignment') {
                  setLinked(null);
                  setDraft(null);
                  setDirty(false);
                }
              }}
            >
              {scenarios.map((s) => (
                <option value={s} key={s}>
                  {t(labels[s][0], labels[s][1])}
                </option>
              ))}
            </select>
          </label>
        </div>
        {notice && (
          <div className="c360p-notice" role="status">
            {notice}
          </div>
        )}
        {surface === 'console' ? (
          <>
            <div className="c360p-page-title">
              <div>
                <p className="c360p-eyebrow">CUSTOMER 360</p>
                <h1>{t('รู้จักลูกค้าจากหน้าเดียว', 'Know your customer in one place')}</h1>
                <p>
                  {t(
                    'ค้นหา เปิดโปรไฟล์ และดูประวัติตามสิทธิ์',
                    'Find profiles and authorized interaction history',
                  )}
                </p>
              </div>
              {role === 'admin' && (
                <Button variant="primary" onPress={() => nav(() => edit(true))}>
                  + {t('สร้างลูกค้า', 'Create customer')}
                </Button>
              )}
            </div>
            {consoleBody()}
          </>
        ) : (
          workspace()
        )}
        <Dialog
          title={t('ทิ้งร่างก่อนออกหรือไม่?', 'Discard draft before leaving?')}
          role="alertdialog"
          isOpen={!!pendingNav}
          onOpenChange={(open) => {
            if (!open) setPendingNav(null);
          }}
          footer={() => (
            <>
              <Button onPress={() => setPendingNav(null)}>{t('อยู่หน้านี้', 'Stay here')}</Button>
              <Button
                variant="danger"
                onPress={() => {
                  const run = pendingNav;
                  setPendingNav(null);
                  run?.();
                }}
              >
                {t('ทิ้งร่างและไปต่อ', 'Discard and continue')}
              </Button>
            </>
          )}
        >
          <p>
            {t(
              'ร่างของงานเดิมจะไม่ถูกย้ายไปลูกค้าหรืองานถัดไป',
              'The draft is not copied to another customer or work item',
            )}
          </p>
        </Dialog>
        <footer className="c360p-state">
          {t('สถานะต้นแบบ', 'Prototype state')}: {variant} · {surface} ·{' '}
          {surface === 'workspace' ? 'agent' : role} · {scenario} · {draft ? 'editor' : page} ·{' '}
          {dirty ? 'dirty' : 'clean'}
          {surface === 'workspace' ? ` · DEMO-${work} · ${phase} · ${linked ?? 'unlinked'}` : ''}
        </footer>
      </div>
      {import.meta.env.DEV && (
        <div className="c360p-switcher" aria-label={t('เปรียบเทียบแบบ', 'Compare variants')}>
          <button
            onClick={() => changeVariant(-1)}
            aria-label={t('แบบก่อนหน้า', 'Previous variant')}
          >
            ←
          </button>
          <div>
            <strong>
              {variant} · {t(names[variant][0], names[variant][1])}
            </strong>
            <small>
              {t(
                'ใช้ ← → สลับแบบ • เปลี่ยนมุมมองด้านบนเพื่อดู Workspace',
                'Use ← → to compare • switch surface above for Workspace',
              )}
            </small>
          </div>
          <button onClick={() => changeVariant(1)} aria-label={t('แบบถัดไป', 'Next variant')}>
            →
          </button>
        </div>
      )}
    </ShellFrame>
  );
}
