import { useEffect, useState } from 'react';
import {
  ConsoleApiError,
  type CallbackRequestInput,
  type ConsoleApi,
  type ContactChannel,
  type PreferenceDecision,
  type PreferenceHistory,
} from './console-api.js';

type Viewer = 'AGENT' | 'ADMIN' | 'COMPLIANCE';

const channels: ContactChannel[] = ['LINE', 'EMAIL', 'VOICE', 'WEBCHAT', 'FACEBOOK', 'WHATSAPP'];
const purposes = ['SERVICE_NOTIFICATION', 'MARKETING', 'ACCOUNT_SECURITY'];

export function PreferenceCenter({
  api,
  contactId,
  viewer,
}: {
  api: ConsoleApi;
  contactId: string;
  viewer: Viewer;
}) {
  const [history, setHistory] = useState<PreferenceHistory>();
  const [channel, setChannel] = useState<ContactChannel>('LINE');
  const [purpose, setPurpose] = useState('SERVICE_NOTIFICATION');
  const [decision, setDecision] = useState<PreferenceDecision>('DEFER');
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [windowStart, setWindowStart] = useState('09:00');
  const [windowEnd, setWindowEnd] = useState('18:00');
  const [evidenceRef, setEvidenceRef] = useState('customer-request');
  const [effective, setEffective] = useState<{
    decision?: PreferenceDecision;
    version: number;
    reason?: string;
  }>();
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [callbackAt, setCallbackAt] = useState('');

  const refresh = async () => {
    const [nextHistory, nextEffective] = await Promise.all([
      api.preferenceHistory(contactId),
      api.effectivePreference({ contactId, channel, purpose }),
    ]);
    setHistory(nextHistory);
    setEffective(nextEffective);
  };

  useEffect(() => {
    void refresh().catch(() => setError('โหลด canonical preference ไม่สำเร็จ โปรดลองใหม่'));
  }, [api, contactId, channel, purpose]);

  const version = history?.aggregateVersion ?? effective?.version ?? 0;
  const callbackVersion =
    history?.callbacks.find(
      (callback) => callback.channel === channel && callback.purpose === purpose,
    )?.version ?? 0;
  const cannotAllow = viewer === 'AGENT' && decision === 'ALLOW';
  const timezoneUnknown = timezone.trim().length === 0;

  async function savePreference() {
    if (cannotAllow) {
      setError('Agent ทำให้ข้อกำหนดเข้มขึ้นได้เท่านั้น จึงไม่สามารถตั้ง ALLOW ได้');
      return;
    }
    if (timezoneUnknown) {
      setError(
        'ยังไม่ทราบ Timezone: เลือกหรือยืนยัน Timezone ก่อน เพื่อให้ระบบ fail-closed ได้ถูกต้อง',
      );
      return;
    }
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api.setPreference({
        contactId,
        channel,
        purpose,
        decision,
        timezone,
        preferredWindows: [
          { daysOfWeek: [1, 2, 3, 4, 5], startLocal: windowStart, endLocal: windowEnd },
        ],
        evidenceRef,
        expectedVersion: callbackVersion,
        commandId: crypto.randomUUID(),
      });
      setNotice(
        `บันทึก canonical version ${result.aggregateVersion} แล้ว ระบบจะระงับ outbound ใหม่จน consumer ยืนยันการกระจายผล`,
      );
      await refresh();
    } catch (caught) {
      if (caught instanceof ConsoleApiError && caught.code === 'VERSION_CONFLICT') {
        setError(
          'ข้อมูลถูกเปลี่ยนจากที่อื่นแล้ว กรุณาโหลด canonical version ล่าสุดก่อนส่งอีกครั้ง',
        );
      } else if (
        caught instanceof ConsoleApiError &&
        caught.code === 'PREFERENCE_RELAXATION_NOT_AUTHORIZED'
      ) {
        setError('สิทธิ์ปัจจุบันไม่อนุญาตให้ผ่อนข้อกำหนดนี้');
      } else {
        setError('บันทึก preference ไม่สำเร็จ ข้อมูลเดิมยังไม่ถูกแทนที่');
      }
    } finally {
      setPending(false);
    }
  }

  async function requestCallback() {
    if (!callbackAt || timezoneUnknown) {
      setError('ระบุเวลาติดต่อกลับและ Timezone ก่อนส่งคำขอ');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const requestedAt = new Date(callbackAt).toISOString();
      const input: CallbackRequestInput = {
        contactId,
        channel,
        purpose,
        requestedAt,
        requestedTimezone: timezone,
        expiresAt: new Date(new Date(requestedAt).getTime() + 24 * 60 * 60 * 1000).toISOString(),
        evidenceRef,
        expectedVersion: version,
        commandId: crypto.randomUUID(),
      };
      await api.requestCallback(input);
      setNotice('สร้างคำขอติดต่อกลับแบบมีขอบเขตแล้ว ระบบยังคงตรวจ policy และเวลาเมื่อจะส่งจริง');
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ConsoleApiError && caught.code === 'VERSION_CONFLICT'
          ? 'ข้อมูลถูกเปลี่ยนแล้ว กรุณาโหลด version ล่าสุดก่อนส่งคำขออีกครั้ง'
          : 'สร้างคำขอติดต่อกลับไม่สำเร็จ',
      );
    } finally {
      setPending(false);
    }
  }

  const historyEntries = [
    ...(history?.preferences ?? []).map((record) => ({
      id: `preference-${record.id}`,
      decision: record.decision ?? 'DEFER',
      title:
        record.mutationKind === 'REVOKE'
          ? 'ยกเลิก preference'
          : `${record.channel ?? 'ทุกช่องทาง'} / ${record.purpose ?? 'ทุกวัตถุประสงค์'}`,
      at: record.occurredAt,
      version: record.version,
      actorClass: record.actorClass,
      outcome: record.mutationKind,
    })),
    ...(history?.callbacks ?? []).map((callback) => ({
      id: `callback-${callback.id}`,
      decision: 'DEFER' as PreferenceDecision,
      title: `ขอให้ติดต่อกลับ ${callback.channel} / ${callback.purpose}`,
      at: callback.requestedAt,
      version: callback.version,
      actorClass: callback.actorClass,
      outcome: callback.mutationKind,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at));
  const visibleHistory = expanded ? historyEntries : historyEntries.slice(0, 3);
  return (
    <div className="preference-shell">
      <header className="preference-header">
        <strong>D-CONTACT</strong>
        <span>Preference Center</span>
        <span className="preference-version">canonical v{version}</span>
      </header>
      <main className="preference-main">
        <div className="preference-heading">
          <div>
            <p className="eyebrow">CONTACT GOVERNANCE</p>
            <h1>ตั้งค่าการติดต่อ</h1>
            <p>การเปลี่ยนแปลงจะบันทึกเป็น version ใหม่ ไม่แก้ไขประวัติเดิม</p>
          </div>
          <span className="tenant-chip">{viewer}</span>
        </div>

        <section className="governance-status" aria-live="polite">
          <strong>ผลที่มีผลอยู่: {effective?.decision ?? 'กำลังตรวจสอบ'}</strong>
          <span>
            {effective?.reason ??
              'ALLOW หมายถึงผ่าน preference gate เท่านั้น ไม่ใช่ consent และไม่ลบล้าง hard restriction'}
          </span>
        </section>
        {notice ? (
          <p className="governance-notice" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="warning" role="alert">
            {error}
          </p>
        ) : null}

        <div className="preference-grid">
          <section className="panel preference-form" aria-labelledby="preference-form-title">
            <div className="panel-title">
              <h2 id="preference-form-title">การตั้งค่าที่ต้องการ</h2>
              <Decision decision={decision} />
            </div>
            <label>
              ช่องทาง
              <select
                value={channel}
                onChange={(event) => setChannel(event.target.value as ContactChannel)}
              >
                {channels.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              วัตถุประสงค์
              <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
                {purposes.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <fieldset>
              <legend>การตัดสินใจ</legend>
              <div className="decision-options">
                {(['BLOCK', 'DEFER', 'ALLOW'] as PreferenceDecision[]).map((item) => (
                  <label key={item} className={'decision-option ' + item.toLowerCase()}>
                    <input
                      type="radio"
                      name="decision"
                      checked={decision === item}
                      onChange={() => setDecision(item)}
                    />
                    {item}
                  </label>
                ))}
              </div>
            </fieldset>
            {viewer === 'AGENT' ? (
              <p className="field-note">
                Agent เลือก BLOCK หรือ DEFER ได้; การผ่อนเป็น ALLOW จะถูกปฏิเสธ
              </p>
            ) : (
              <p className="field-note">
                ALLOW ไม่ใช่ consent และยังอยู่ใต้ hard restriction, revocation และ policy เสมอ
              </p>
            )}
            <div className="form-row">
              <label>
                Timezone
                <input
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  aria-describedby="timezone-note"
                />
              </label>
              <label>
                เริ่มเวลา
                <input
                  type="time"
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                />
              </label>
              <label>
                สิ้นสุด
                <input
                  type="time"
                  value={windowEnd}
                  onChange={(event) => setWindowEnd(event.target.value)}
                />
              </label>
            </div>
            <p id="timezone-note" className="field-note">
              หากไม่ทราบ Timezone ระบบจะไม่ส่ง outbound และจะแสดงทางแก้ไขนี้
            </p>
            <label>
              หลักฐานอ้างอิง
              <input value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} />
            </label>
            <button
              className="primary"
              disabled={pending || cannotAllow}
              onClick={() => void savePreference()}
            >
              {pending ? 'กำลังบันทึก…' : 'บันทึก preference ใหม่'}
            </button>
          </section>

          <aside className="preference-side">
            <section className="panel" aria-labelledby="callback-title">
              <h2 id="callback-title">ขอให้ติดต่อกลับ</h2>
              <p className="field-note">
                เป็นคำขอแบบมีขอบเขต ไม่ข้าม consent หรือ hard restriction
              </p>
              <label>
                วันและเวลา
                <input
                  type="datetime-local"
                  value={callbackAt}
                  onChange={(event) => setCallbackAt(event.target.value)}
                />
              </label>
              <button
                className="secondary"
                disabled={pending}
                onClick={() => void requestCallback()}
              >
                ส่งคำขอติดต่อกลับ
              </button>
            </section>
            <section className="panel">
              <h2>สถานะการกระจายผล</h2>
              <p className="field-note">
                หลัง mutation ใหม่ Workspace จะบล็อก outbound ถัดไปจนได้ state ที่ยืนยันแล้ว
              </p>
              <button
                className="secondary"
                disabled={pending}
                onClick={() =>
                  void refresh().catch(() => setError('โหลด canonical version ไม่สำเร็จ'))
                }
              >
                โหลด version ล่าสุด
              </button>
            </section>
          </aside>
        </div>

        <section className="panel preference-history" aria-labelledby="preference-history-title">
          <div className="panel-title">
            <div>
              <p className="eyebrow">READ-ONLY</p>
              <h2 id="preference-history-title">ประวัติการเปลี่ยนแปลง</h2>
            </div>
            <span>{historyEntries.length} รายการ</span>
          </div>
          <ol>
            {visibleHistory.map((entry) => (
              <li key={entry.id}>
                <Decision decision={entry.decision} />
                <div>
                  <strong>{entry.title}</strong>
                  <span>
                    v{entry.version} ·{' '}
                    {new Intl.DateTimeFormat('th-TH', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(entry.at))}
                  </span>
                </div>
                <small>
                  ผู้ดำเนินการ: {actorLabel(entry.actorClass)} · ผล: {entry.outcome}
                </small>
              </li>
            ))}
          </ol>
          {historyEntries.length > 3 ? (
            <button
              className="secondary"
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'แสดง 3 รายการล่าสุด' : 'ขยายประวัติทั้งหมด'}
            </button>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function Decision({ decision }: { decision: PreferenceDecision }) {
  return <span className={'decision-badge ' + decision.toLowerCase()}>{decision}</span>;
}
function actorLabel(actor: string) {
  return actor === 'AGENT'
    ? 'เจ้าหน้าที่'
    : actor === 'ADMIN'
      ? 'ผู้ดูแล tenant'
      : actor === 'COMPLIANCE'
        ? 'Compliance'
        : 'ระบบ';
}
