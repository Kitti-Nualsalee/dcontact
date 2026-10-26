/** Prototype #774: สำรวจเมนูบริหารใน Console A; ไม่เชื่อม API/CRM และไม่อ่านไฟล์ลูกค้าจริง */
import { useEffect, useState } from 'react';
import { Badge, Button } from '@d-contact/ui-react';

export const managementPages = [
  { id: 'overview', th: 'ภาพรวม', en: 'Overview', group: 0, icon: 'area-home' },
  { id: 'customers', th: 'ลูกค้า', en: 'Customers', group: 0, icon: 'area-people' },
  { id: 'quality', th: 'คุณภาพข้อมูล', en: 'Data quality', group: 0, icon: 'search' },
  { id: 'imports', th: 'งานนำเข้า', en: 'Imports', group: 1, icon: 'plus' },
  {
    id: 'integrations',
    th: 'การเชื่อมต่อ',
    en: 'Integrations',
    group: 1,
    icon: 'area-integrations',
  },
  {
    id: 'tags',
    th: 'แท็กและการจัดกลุ่ม',
    en: 'Tags & classification',
    group: 1,
    icon: 'area-cases',
  },
  { id: 'settings', th: 'ตั้งค่าข้อมูลลูกค้า', en: 'Data settings', group: 2, icon: 'settings' },
  { id: 'activity', th: 'ประวัติการเปลี่ยนแปลง', en: 'Activity', group: 2, icon: 'area-history' },
  { id: 'privacy', th: 'ความเป็นส่วนตัว', en: 'Privacy', group: 2, icon: 'contact-governance' },
] as const;
export type ManagementPage = (typeof managementPages)[number]['id'];
export type ManagementActivity = { action: string; resource: string; at: string };

export function Cus360ManagementPrototype({
  page,
  lang,
  customerCount,
  onNavigate,
  onDirty,
  activity,
  onRecord,
}: {
  page: ManagementPage;
  lang: 'th' | 'en';
  customerCount: number;
  onNavigate: (page: ManagementPage) => void;
  onDirty: (dirty: boolean) => void;
  activity: ManagementActivity[];
  onRecord: (action: string, resource: string) => void;
}) {
  const t = (th: string, en: string) => (lang === 'th' ? th : en);
  const [step, setStep] = useState(0);
  const [mapping, setMapping] = useState('');
  const [includeInvalid, setIncludeInvalid] = useState(true);
  const [retryDone, setRetryDone] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [tag, setTag] = useState('');
  const [tags, setTags] = useState(['ลูกค้าเดิม', 'บริการหลังการขาย', 'ติดตามงาน']);
  const [requireCompany, setRequireCompany] = useState(false);
  const [savedCompany, setSavedCompany] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setTag('');
    setRequireCompany(savedCompany);
    setStep(0);
    setMapping('');
    setError('');
    setNotice('');
  }, [page]);
  const item = managementPages.find((p) => p.id === page)!;
  const descriptions: Record<ManagementPage, [string, string]> = {
    overview: [
      'สิ่งที่ควรจัดการวันนี้ พร้อมทางไปแก้ไข',
      'Tasks needing attention, with a route to resolution',
    ],
    customers: ['', ''],
    quality: [
      'ตรวจรายการที่ต้องทบทวน โดยไม่รวมลูกค้าอัตโนมัติ',
      'Review issues without automatically merging customers',
    ],
    imports: [
      'ทดลองด้วยไฟล์ตัวอย่างเท่านั้น ไม่ส่งไฟล์ลูกค้าจริง',
      'Use the sample only. No real customer file is uploaded',
    ],
    integrations: [
      'ดูสุขภาพการเชื่อมต่อและเจ้าของข้อมูลแต่ละฟิลด์',
      'Connection health and field ownership',
    ],
    tags: ['ชุดแท็กและความหมายที่ทีมใช้ร่วมกัน', 'Shared labels and classification definitions'],
    settings: [
      'กฎข้อมูลของ Cus360 แยกจากค่าทั่วไปขององค์กร',
      'Cus360 data rules, separate from organization settings',
    ],
    activity: [
      'ผลการทดลองในหน้านี้ ไม่ใช่ audit ระบบจริง',
      'Actions in this preview, not a production audit log',
    ],
    privacy: [
      'อ่านสถานะจากเจ้าของข้อมูล ก่อนส่งต่อไปจัดการ',
      'Read the source-owned status before continuing to the owner module',
    ],
  };
  const record = (action: string, resource: string) => {
    onRecord(action, resource);
    onDirty(false);
  };
  const csvLink = (text: string) => `data:text/csv;charset=utf-8,${encodeURIComponent(text)}`;
  const go = (next: ManagementPage, th: string, en: string) => (
    <Button size="sm" onPress={() => onNavigate(next)}>
      {t(th, en)} →
    </Button>
  );
  return (
    <>
      <div className="c360p-page-title">
        <div>
          <p className="c360p-eyebrow">CUSTOMER 360 · MANAGEMENT</p>
          <h1>{t(item.th, item.en)}</h1>
          <p>{t(...descriptions[page])}</p>
        </div>
        <Badge tone="attention">{t('ข้อเสนอเฟสต่อยอด', 'Proposed future slice')}</Badge>
      </div>
      <p className="c360p-muted">
        {t(
          'ตัวเลขและสถานะทั้งหมดเป็นข้อมูลสมมติ • ยังไม่อนุมัติเป็น production contract',
          'All counts and statuses are synthetic • not an approved production contract',
        )}
      </p>
      {notice && (
        <div className="c360p-notice" role="status">
          {notice}
        </div>
      )}
      {page === 'overview' && (
        <>
          <div className="c360m-metrics">
            {[
              [String(customerCount), t('ลูกค้าในชุดทดลอง', 'Customers in preview'), 'customers'],
              ['2', t('รายการรอตรวจ', 'Quality issues'), 'quality'],
              ['1', t('งานนำเข้ารอแก้', 'Import needs attention'), 'imports'],
              ['1', t('การเชื่อมต่อมีปัญหา', 'Connection needs attention'), 'integrations'],
            ].map(([value, label, next]) => (
              <button
                className="c360p-card c360m-metric"
                key={next}
                onClick={() => onNavigate(next as ManagementPage)}
              >
                <strong>{value}</strong>
                <span>{label} →</span>
              </button>
            ))}
          </div>
          <section className="c360p-card">
            <h2>{t('สิ่งที่ต้องจัดการ', 'Needs attention')}</h2>
            <div className="c360m-task">
              <div>
                <strong>{t('ตรวจข้อมูลก่อนนำเข้า', 'Review before import')}</strong>
                <p>
                  {t(
                    'ไฟล์ตัวอย่างมี 1 แถวรูปแบบอีเมลไม่ถูกต้อง',
                    'The sample contains one invalid email row',
                  )}
                </p>
              </div>
              {go('imports', 'ตรวจไฟล์ตัวอย่าง', 'Review sample')}
            </div>
            <div className="c360m-task">
              <div>
                <strong>
                  {t('เบอร์เดียวกันอาจเป็นคนละคน', 'A shared number may identify different people')}
                </strong>
                <p>
                  {t(
                    'ต้องตรวจหลักฐาน ไม่เลือกหรือรวมลูกค้าแทนผู้ใช้',
                    'Review the evidence; do not select or merge automatically',
                  )}
                </p>
              </div>
              {go('quality', 'ดูรายการ', 'Review issues')}
            </div>
            <div className="c360m-task">
              <div>
                <strong>CRM sandbox · timeout</strong>
                <p>
                  {t(
                    'ข้อมูลภายนอกไม่พร้อม ไม่ถือเป็นไม่มีข้อมูล',
                    'External data unavailable is not an empty result',
                  )}
                </p>
              </div>
              {go('integrations', 'ตรวจการเชื่อมต่อ', 'Inspect connection')}
            </div>
          </section>
          <section className="c360p-card">
            <h2>{t('ลำดับส่งมอบที่เสนอ', 'Proposed delivery order')}</h2>
            <ol className="c360m-roadmap">
              {[
                t(
                  'โปรไฟล์ลูกค้าและ Workspace ตามสเปกเดิม',
                  'Customer profiles and Workspace under the existing spec',
                ),
                t('ภาพรวม แท็ก ตั้งค่า และประวัติ', 'Overview, tags, settings and activity'),
                t('นำเข้าและคุณภาพข้อมูล', 'Imports and data quality'),
                t(
                  'Integrations ตาม owner/field contract',
                  'Integrations under source and field contracts',
                ),
                t(
                  'Segments / merge / DSAR แยกสเปกภายหลัง',
                  'Segments / merge / DSAR under later specifications',
                ),
              ].map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </section>
        </>
      )}
      {page === 'quality' && (
        <section className="c360p-card">
          <h2>{t('คิวตรวจคุณภาพข้อมูล', 'Quality review queue')}</h2>
          <div className="c360m-task">
            <div>
              <Badge tone="attention">{t('ต้องตรวจหลักฐาน', 'Evidence required')}</Badge>
              <h3>
                {t('ลูกค้าตัวอย่าง 01 / รายการนำเข้า 04', 'Sample customer 01 / import row 04')}
              </h3>
              <p>
                {t(
                  'เบอร์โทรตรงกัน แต่ชื่อไม่ตรง • ยังไม่ยืนยันว่าเป็นบุคคลเดียวกัน',
                  'Same phone, different names • identity is not confirmed',
                )}
              </p>
            </div>
            <Button onPress={() => setReviewed(!reviewed)}>
              {reviewed
                ? t('ซ่อนรายละเอียด', 'Hide details')
                : t('ตรวจรายละเอียด', 'Inspect details')}
            </Button>
          </div>
          {reviewed && (
            <div className="c360p-alert">
              <div>
                <strong>
                  {t('เก็บแถวนี้รอตรวจ ไม่ merge', 'Keep pending review, without merging')}
                </strong>
                <p>
                  {t(
                    'ที่มา: CSV ตัวอย่าง • หลักฐานการยืนยัน: ไม่มี • ก่อนนำเข้าจริงต้องกำหนดนโยบาย duplicate/shared-phone',
                    'Source: sample CSV • verification evidence: none • duplicate/shared-phone policy must be specified before real imports',
                  )}
                </p>
              </div>
              {go('customers', 'เปิดรายการลูกค้า', 'Open customers')}
            </div>
          )}
          <div className="c360m-task">
            <div>
              <strong>{t('อีเมลรูปแบบไม่ถูกต้อง', 'Invalid email format')}</strong>
              <p>
                import-sample · {t('แถว 3 รอแก้ในต้นทาง', 'Row 3 needs correction at the source')}
              </p>
            </div>
            {go('imports', 'ดูผลตรวจ', 'Inspect validation')}
          </div>
        </section>
      )}
      {page === 'imports' && (
        <>
          <section className="c360p-card">
            <h2>{t('นำเข้าลูกค้าใหม่จากตัวอย่าง', 'Import new customers from sample')}</h2>
            <ol className="c360m-steps" aria-label={t('ขั้นตอนนำเข้า', 'Import steps')}>
              {[
                t('เลือกตัวอย่าง', 'Sample'),
                t('จับคู่คอลัมน์', 'Map'),
                t('ตรวจและทบทวน', 'Validate'),
                t('ผลนำเข้า', 'Result'),
              ].map((s, i) => (
                <li key={s} aria-current={step === i ? 'step' : undefined}>
                  {i + 1}. {s}
                </li>
              ))}
            </ol>
            {step === 0 && (
              <>
                <p>
                  {t(
                    'ทดลอง workflow โดยไม่อ่านหรือเก็บไฟล์จริง • template นี้สำหรับสำรวจ UX เท่านั้น',
                    'Explore the workflow without reading or retaining real files • template is for UX exploration only',
                  )}
                </p>
                <p>
                  <a
                    href={csvLink(
                      'display_name,email\nSample 01,sample01@example.test\nSample 02,sample02@example.test\nSample 03,invalid-email\n',
                    )}
                    download="cus360-PROTOTYPE-template.csv"
                  >
                    {t('ดาวน์โหลด CSV ตัวอย่าง', 'Download sample CSV')}
                  </a>
                </p>
                <label className="c360p-checkbox">
                  <input
                    type="checkbox"
                    checked={includeInvalid}
                    onChange={(e) => setIncludeInvalid(e.target.checked)}
                  />
                  {t('รวมแถวผิดพลาดเพื่อทดลอง', 'Include an invalid row')}
                </label>
                <Button
                  variant="primary"
                  onPress={() => {
                    setStep(1);
                    onDirty(true);
                  }}
                >
                  {t('ใช้ไฟล์ตัวอย่าง', 'Use sample file')}
                </Button>
              </>
            )}
            {step === 1 && (
              <>
                <label>
                  {t('คอลัมน์ชื่อแสดงผล', 'Display name column')}
                  <select
                    value={mapping}
                    onChange={(e) => {
                      setMapping(e.target.value);
                      setError('');
                    }}
                  >
                    <option value="">{t('เลือกคอลัมน์', 'Select column')}</option>
                    <option value="display_name">display_name → Contact.displayName</option>
                    <option value="email">email → Contact.displayName</option>
                  </select>
                </label>
                <p>
                  Email → ContactIdentity ·{' '}
                  {t(
                    'สร้างใหม่เท่านั้น ไม่ทับลูกค้าเดิม',
                    'Create only; no overwrite of existing customers',
                  )}
                </p>
                {error && (
                  <p role="alert" className="c360p-error">
                    {error}
                  </p>
                )}
                <div className="c360p-actions">
                  <Button
                    onPress={() => {
                      setStep(0);
                      onDirty(false);
                    }}
                  >
                    {t('ย้อนกลับ', 'Back')}
                  </Button>
                  <Button
                    variant="primary"
                    onPress={() =>
                      mapping !== 'display_name'
                        ? setError(
                            t(
                              'เลือก display_name สำหรับชื่อแสดงผล',
                              'Select display_name for the customer name',
                            ),
                          )
                        : setStep(2)
                    }
                  >
                    {t('ตรวจข้อมูลตัวอย่าง', 'Validate sample')}
                  </Button>
                </div>
              </>
            )}
            {step >= 2 && (
              <>
                <div className="c360p-alert">
                  <strong>
                    {step === 3
                      ? t('จำลองเสร็จแล้ว: สำเร็จ 2 แถว', 'Simulation complete: 2 rows succeeded')
                      : t('พร้อมนำเข้า 2 แถว', '2 rows ready')}
                  </strong>
                  <span>
                    {includeInvalid
                      ? t('แยกแถวผิดพลาด 1 แถว ไม่นำเข้า', '1 invalid row excluded')
                      : t('ไม่พบแถวผิดพลาดในตัวอย่างนี้', 'No invalid rows in this sample')}
                  </span>
                </div>
                <div className="c360m-table-wrap">
                  <table>
                    <caption>{t('ผลตรวจไฟล์สมมติ', 'Synthetic file validation')}</caption>
                    <thead>
                      <tr>
                        <th>{t('แถว', 'Row')}</th>
                        <th>display_name</th>
                        <th>{t('ผลตรวจ', 'Validation')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>1</td>
                        <td>Sample 01</td>
                        <td>{t('ผ่าน', 'Valid')}</td>
                      </tr>
                      <tr>
                        <td>2</td>
                        <td>Sample 02</td>
                        <td>{t('ผ่าน', 'Valid')}</td>
                      </tr>
                      {includeInvalid && (
                        <tr>
                          <td>3</td>
                          <td>Sample 03</td>
                          <td>{t('อีเมลผิดรูปแบบ — แยกไว้', 'Invalid email — excluded')}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {includeInvalid && (
                  <p>
                    <a
                      href={csvLink('row,error\n3,INVALID_EMAIL\n')}
                      download="cus360-PROTOTYPE-errors.csv"
                    >
                      {t('ดาวน์โหลดข้อผิดพลาดตัวอย่าง', 'Download sample errors')}
                    </a>
                  </p>
                )}
                {step === 2 ? (
                  <div className="c360p-actions">
                    <Button onPress={() => setStep(1)}>{t('แก้ mapping', 'Edit mapping')}</Button>
                    <Button
                      variant="primary"
                      onPress={() => {
                        setStep(3);
                        record('IMPORT_SIMULATED', 'sample-job');
                      }}
                    >
                      {t('ยืนยันจำลองนำเข้าเฉพาะแถวที่ผ่าน', 'Confirm simulation for valid rows')}
                    </Button>
                  </div>
                ) : (
                  <>
                    <p>
                      {t(
                        'ไม่ได้เพิ่มลูกค้าใน directory หรือ DB จริง • ผลนี้แสดงการแยกแถวผิดพลาด',
                        'No directory or database was changed • this demonstrates excluding invalid rows',
                      )}
                    </p>
                    <Button
                      onPress={() => {
                        setStep(0);
                        setMapping('');
                      }}
                    >
                      {t('เริ่มตัวอย่างใหม่', 'Start another sample')}
                    </Button>
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
      {page === 'integrations' && (
        <>
          <section className="c360p-card">
            <div className="c360p-row">
              <h2>CRM sandbox</h2>
              <Badge tone={retryDone ? 'neutral' : 'attention'}>
                {retryDone ? t('จำลองอ่านสำเร็จ', 'Simulated response') : 'TIMEOUT'}
              </Badge>
            </div>
            <p>
              {t(
                'การเชื่อมต่อสมมติ • profile อ่านสดผ่าน Integration กลาง ไม่สร้างสำเนา CRM ถาวร',
                'Synthetic connector • profile read through the shared Integration platform; no durable CRM profile copy',
              )}
            </p>
            <dl className="c360m-definitions">
              <dt>{t('ข้อมูลที่อ่าน', 'Read fields')}</dt>
              <dd>CRM customer ID, {t('ระดับบริการ', 'service tier')}</dd>
              <dt>{t('เจ้าของข้อมูล', 'Source owner')}</dt>
              <dd>CRM · {t('อ่านอย่างเดียวใน Cus360', 'read-only in Cus360')}</dd>
              <dt>{t('ข้อมูลลับ', 'Credentials')}</dt>
              <dd>
                {t(
                  'จัดการใน Integration กลาง ไม่กรอกซ้ำที่นี่',
                  'Managed by Integration; not entered here',
                )}
              </dd>
              <dt>{t('การเขียนกลับ', 'Write-back')}</dt>
              <dd>{t('ยังไม่อยู่ในเฟสนี้', 'Outside this proposed slice')}</dd>
            </dl>
            <Button
              onPress={() => {
                setRetryDone(true);
                record('CONNECTION_CHECK_SIMULATED', 'crm-sandbox');
                setNotice(
                  t(
                    'จำลองตรวจผ่าน • ไม่ได้เรียก CRM หรือเปลี่ยน secret',
                    'Simulated check passed • no CRM request or secret mutation',
                  ),
                );
              }}
            >
              {t('จำลองตรวจการเชื่อมต่อ', 'Simulate connection check')}
            </Button>
          </section>
          <section className="c360p-card">
            <h2>{t('ก่อนเปิด connector จริง', 'Before enabling a real connector')}</h2>
            <p>
              {t(
                'เลือก connector ตัวแรก, ระบุ field owner/ทิศทางข้อมูล, scope, timeout และ recovery ในสเปกแยกก่อน',
                'Select the first connector and specify field ownership, direction, scopes, timeouts and recovery in a separate contract',
              )}
            </p>
          </section>
        </>
      )}
      {page === 'tags' && (
        <section className="c360p-card">
          <h2>{t('ชุดแท็กตัวอย่าง', 'Sample tag catalog')}</h2>
          <div className="c360p-tags">
            {tags.map((value) => (
              <Badge key={value} tone="neutral">
                {value}
              </Badge>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const value = tag.trim();
              if (!value || tags.includes(value)) {
                setError(t('กรอกชื่อแท็กใหม่ที่ไม่ซ้ำ', 'Enter a new, unique tag'));
                return;
              }
              setTags([...tags, value]);
              setTag('');
              setError('');
              record('TAG_CREATED_SIMULATED', 'tag-catalog');
              setNotice(
                t(
                  'เพิ่มแท็กในชุดทดลองแล้ว • ไม่เปลี่ยนโปรไฟล์ลูกค้า',
                  'Tag added to preview catalog • customer profiles unchanged',
                ),
              );
            }}
          >
            <label>
              {t('แท็กใหม่', 'New tag')}
              <input
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  onDirty(!!e.target.value);
                }}
              />
            </label>
            {error && (
              <p className="c360p-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary">
              {t('เพิ่มแท็กตัวอย่าง', 'Add sample tag')}
            </Button>
          </form>
          <p className="c360p-muted">
            {t(
              'สิทธิ์แก้แท็ก/VIP, การเลิกใช้ และผลต่อ routing/report ต้องตัดสินก่อนพัฒนาจริง',
              'Tag/VIP permissions, retirement and routing/report effects need contracts before implementation',
            )}
          </p>
        </section>
      )}
      {page === 'settings' && (
        <>
          <section className="c360p-card">
            <h2>{t('กฎฟิลด์ตัวอย่าง', 'Sample field rule')}</h2>
            <p>
              {t(
                'ทดลองการตั้งค่าเท่านั้น กติกา first slice ยังคงบริษัทไม่บังคับตามข้อตกลงเดิม',
                'Preview only. Company remains optional in the accepted first slice',
              )}
            </p>
            <label className="c360p-checkbox">
              <input
                type="checkbox"
                checked={requireCompany}
                onChange={(e) => {
                  setRequireCompany(e.target.checked);
                  onDirty(e.target.checked !== savedCompany);
                }}
              />
              {t('ทดลองบังคับกรอกบริษัท', 'Explore required company field')}
            </label>
            <Button
              variant="primary"
              isDisabled={requireCompany === savedCompany}
              onPress={() => {
                setSavedCompany(requireCompany);
                record('SETTING_SAVED_SIMULATED', 'company-rule');
                setNotice(
                  t(
                    'อ่านค่าที่จำลองบันทึกกลับแล้ว ไม่เปลี่ยนกฎฟอร์มจริง',
                    'Simulated readback completed; actual customer-form rules unchanged',
                  ),
                );
              }}
            >
              {t('จำลองบันทึกและอ่านกลับ', 'Simulate save and readback')}
            </Button>
            <p>
              {t('ค่าจำลองที่บันทึก', 'Saved preview value')}:{' '}
              {savedCompany ? t('บังคับ', 'Required') : t('ไม่บังคับ', 'Optional')}
            </p>
          </section>
          <section className="c360p-card">
            <h2>{t('ขอบเขตหน้าตั้งค่า', 'Settings boundaries')}</h2>
            <dl className="c360m-definitions">
              <dt>Cus360</dt>
              <dd>
                {t(
                  'กฎฟิลด์และคุณภาพข้อมูล; custom fields อยู่ภายหลัง',
                  'Field and quality rules; custom fields later',
                )}
              </dd>
              <dt>Core Settings / People</dt>
              <dd>
                {t(
                  'องค์กร ภาษา timezone ทีม และบัญชีผู้ใช้',
                  'Organization, language, timezone, teams and users',
                )}
              </dd>
              <dt>IAM</dt>
              <dd>VIEW / WORK / CONTACT scope</dd>
              <dt>Contact Governance</dt>
              <dd>Consent / DNC / restrictions</dd>
            </dl>
          </section>
        </>
      )}
      {page === 'activity' && (
        <section className="c360p-card">
          <h2>{t('กิจกรรมในรอบทดลองนี้', 'Actions in this preview session')}</h2>
          {activity.length ? (
            <div className="c360m-table-wrap">
              <table>
                <caption>
                  {t('ประวัติสมมติ — รีโหลดแล้วล้าง', 'Synthetic activity — cleared on reload')}
                </caption>
                <thead>
                  <tr>
                    <th>{t('เวลา', 'Time')}</th>
                    <th>{t('ผู้ทดลอง', 'Actor')}</th>
                    <th>{t('การทำงาน', 'Action')}</th>
                    <th>Resource</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((row, i) => (
                    <tr key={i}>
                      <td>{row.at}</td>
                      <td>Admin · preview</td>
                      <td>{row.action}</td>
                      <td>{row.resource}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>
              {t(
                'ยังไม่มีการทำงาน ลองเพิ่มแท็กหรือเดินขั้นตอนนำเข้าแล้วกลับมาดู',
                'No actions yet. Add a tag or simulate an import, then return here',
              )}
            </p>
          )}
          {go('tags', 'ทดลองเพิ่มแท็ก', 'Try adding a tag')}
          <p className="c360p-muted">
            {t(
              'Production ต้องมี audit จาก server และสิทธิ์อ่าน ไม่ใช่รายการจาก browser นี้',
              'Production requires server-side audit and read authorization, not this browser activity list',
            )}
          </p>
        </section>
      )}
      {page === 'privacy' && (
        <section className="c360p-card">
          <h2>{t('สถานะและเจ้าของข้อมูล', 'Status and ownership')}</h2>
          <div className="c360p-alert">
            <strong>
              {t(
                'ยังไม่ได้อ่านสถานะ Contact Governance',
                'Contact Governance status has not been read',
              )}
            </strong>
            <span>{t('ไม่ตีความว่าอนุญาตให้ติดต่อ', 'Contact permission remains unknown')}</span>
          </div>
          <p>
            {t(
              'หน้าจริงอ่าน summary ตามลูกค้าและสิทธิ์ แล้วเปิดหน้าจริงของ Contact Governance เมื่อพร้อม ไม่แก้ consent/DNC จาก Cus360 โดยตรง',
              'The real page will read an authorized customer summary and link to Contact Governance when available; Cus360 does not write consent/DNC directly',
            )}
          </p>
          <dl className="c360m-definitions">
            <dt>Consent / DNC</dt>
            <dd>Contact Governance</dd>
            <dt>{t('สิทธิ์ดูข้อมูลลูกค้า', 'Customer data access')}</dt>
            <dd>IAM · tenant / team / resource scope</dd>
            <dt>DSAR / export / delete</dt>
            <dd>
              {t(
                'เฟสหลัง ต้องมี workflow และสิทธิ์เฉพาะ',
                'Later slice with a dedicated workflow and permissions',
              )}
            </dd>
          </dl>
          {go('customers', 'กลับไปเลือกลูกค้า', 'Choose a customer')}
        </section>
      )}
      <p className="c360p-state">
        {t('สถานะส่วนบริหาร', 'Management preview state')}: {page} · step={step} ·{' '}
        {t('กิจกรรม', 'actions')}={activity.length} · memory only
      </p>
    </>
  );
}
