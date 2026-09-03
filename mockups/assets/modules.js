/* ============================================================
   D-Contact mockup — โมดูลใหม่ (Tier 1 + Tier 2)
   outbound · cases · ai (bot/knowledge/assist) · analytics (ia/feedback/performance)
   integrations · customer-360 · self-service reporting

   ไฟล์นี้โหลด "หลัง" app.js — ใช้ helper ของ app.js (showView, toast, chBadge, currentLang)
   ทุก renderer self-guard: ไม่มี element ในหน้านั้นก็ข้ามไป
   ============================================================ */

/* ---------- helper ที่ใช้ร่วมกันทุกฟอร์ม ---------- */
function setVals(vals) {
  Object.keys(vals || {}).forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!vals[id]; else el.value = vals[id];
  });
}
function setHeading(id, th, en) {
  var el = document.getElementById(id); if (el) el.textContent = currentLang === 'th' ? th : en;
}
function openForm(view, headingId, th, en, vals) {
  setVals(vals); setHeading(headingId, th, en); showView(view);
}
function saveMock(view) { toast(currentLang === 'th' ? 'บันทึกแล้ว (mock)' : 'Saved (mock)'); showView(view); }
var mdots = '<i class="ti ti-dots"></i>';
function tag(cls, text) { return '<span class="tag ' + cls + '">' + text + '</span>'; }
function pbar(pct, cls) {
  return '<div class="prog"><div class="' + (cls || '') + '" style="width:' + Math.min(pct, 100) + '%"></div></div>';
}
function editCell(fn, i) {
  return '<td class="px-4 py-3 text-right whitespace-nowrap"><span class="icon-btn" onclick="' + fn + '(' + i + ')" title="Edit">' +
    '<i class="ti ti-pencil"></i></span><span class="icon-btn">' + mdots + '</span></td>';
}

/* ============================================================
   OUTBOUND — docs/outbound-campaign.md
   ============================================================ */
var OB_MODE = {
  PREVIEW: ['tag-info', 'Preview'], PROGRESSIVE: ['tag-ok', 'Progressive'],
  PREDICTIVE: ['tag-warn', 'Predictive'], MESSAGE: ['tag-ai', 'Message'],
};
var OB_STATUS = {
  RUNNING: ['tag-ok', 'Running'], PAUSED: ['tag-warn', 'Paused'], DRAFT: ['tag', 'Draft'],
  SCHEDULED: ['tag-info', 'Scheduled'], COMPLETED: ['tag', 'Completed'],
  STOPPED_COMPLIANCE: ['tag-bad', 'หยุด — compliance'],
};

var CAMPAIGNS = [
  { name: 'ทวงถามยอดค้าง ก.ค.', mode: 'PREVIEW', queue: 'Collections', status: 'RUNNING', total: 4820, done: 2914, rpc: 38, abandon: 0.0, agents: 9 },
  { name: 'ยืนยันนัดหมายพรุ่งนี้', mode: 'PROGRESSIVE', queue: 'General Support', status: 'RUNNING', total: 1240, done: 1102, rpc: 61, abandon: 0.4, agents: 4 },
  { name: 'เสนอแพ็กเกจต่ออายุ Q3', mode: 'PREDICTIVE', queue: 'Sales (TH)', status: 'PAUSED', total: 12400, done: 5231, rpc: 22, abandon: 2.8, agents: 15 },
  { name: 'สำรวจหลังติดตั้ง', mode: 'PROGRESSIVE', queue: 'Technical Support', status: 'SCHEDULED', total: 640, done: 0, rpc: 0, abandon: 0, agents: 3 },
  { name: 'แจ้งเตือนค่าบริการ (LINE)', mode: 'MESSAGE', queue: 'Billing Inquiries', status: 'COMPLETED', total: 18200, done: 18200, rpc: 0, abandon: 0, agents: 0 },
  { name: 'ทวงถามยอดค้าง มิ.ย.', mode: 'PREDICTIVE', queue: 'Collections', status: 'STOPPED_COMPLIANCE', total: 3900, done: 1877, rpc: 26, abandon: 3.4, agents: 0 },
];
function renderCampaigns() {
  var b = document.getElementById('ob-campaigns-body'); if (!b) return;
  b.innerHTML = CAMPAIGNS.map(function (c, i) {
    var m = OB_MODE[c.mode], s = OB_STATUS[c.status], pct = Math.round(c.done / c.total * 100);
    var ab = c.abandon >= 3 ? 'text-rose-600 font-semibold' : (c.abandon >= 2 ? 'text-amber-600' : 'text-slate-600');
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + c.name + '</td>' +
      '<td class="px-4 py-3">' + tag(m[0], m[1]) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.queue + '</td>' +
      '<td class="px-4 py-3 w-44">' + pbar(pct, pct === 100 ? '' : null) +
        '<span class="text-xs text-slate-400">' + c.done.toLocaleString() + ' / ' + c.total.toLocaleString() + '</span></td>' +
      '<td class="px-4 py-3 text-slate-600">' + (c.mode === 'MESSAGE' ? '—' : c.rpc + '%') + '</td>' +
      '<td class="px-4 py-3 ' + ab + '">' + (c.mode === 'MESSAGE' ? '—' : c.abandon.toFixed(1) + '%') + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + (c.agents || '—') + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      editCell('editCampaign', i) + '</tr>';
  }).join('');
}
function newCampaign() {
  openForm('campaign-form', 'cf-heading', 'สร้างแคมเปญใหม่', 'New campaign',
    { 'cf-name': '', 'cf-mode': 'PREVIEW', 'cf-queue': 'General Support', 'cf-overdial': '2.0',
      'cf-cap': '3.0', 'cf-from': '09:00', 'cf-to': '18:00', 'cf-retry': '3', 'cf-gap': '180' });
}
function editCampaign(i) {
  var c = CAMPAIGNS[i];
  openForm('campaign-form', 'cf-heading', 'แก้ไข: ' + c.name, 'Edit: ' + c.name,
    { 'cf-name': c.name, 'cf-mode': c.mode, 'cf-queue': c.queue, 'cf-overdial': '2.5',
      'cf-cap': '3.0', 'cf-from': '09:00', 'cf-to': '18:00', 'cf-retry': '3', 'cf-gap': '180' });
}

var OB_LISTS = [
  { name: 'overdue_july.csv', campaign: 'ทวงถามยอดค้าง ก.ค.', at: '01-08-2026 09:12', total: 5210, accepted: 4820, dnc: 214, bad: 98, dup: 78 },
  { name: 'appointments_0808.xlsx', campaign: 'ยืนยันนัดหมายพรุ่งนี้', at: '07-08-2026 17:40', total: 1264, accepted: 1240, dnc: 12, bad: 6, dup: 6 },
  { name: 'renewals_q3.csv', campaign: 'เสนอแพ็กเกจต่ออายุ Q3', at: '20-07-2026 11:03', total: 13980, accepted: 12400, dnc: 1102, bad: 301, dup: 177 },
  { name: 'billing_line_aug.csv', campaign: 'แจ้งเตือนค่าบริการ (LINE)', at: '02-08-2026 08:00', total: 18944, accepted: 18200, dnc: 604, bad: 90, dup: 50 },
];
function renderObLists() {
  var b = document.getElementById('ob-lists-body'); if (!b) return;
  b.innerHTML = OB_LISTS.map(function (l, i) {
    var rej = l.dnc + l.bad + l.dup;
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + l.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + l.campaign + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + l.at + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + l.total.toLocaleString() + '</td>' +
      '<td class="px-4 py-3 text-emerald-700 font-medium">' + l.accepted.toLocaleString() + '</td>' +
      '<td class="px-4 py-3"><span class="text-rose-600 font-medium">' + rej.toLocaleString() + '</span> ' +
        '<span class="text-xs text-slate-400">(DNC ' + l.dnc + ' · เบอร์ผิด ' + l.bad + ' · ซ้ำ ' + l.dup + ')</span></td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="toast(\'ดาวน์โหลดรายการที่ถูกตัด (mock)\')"><i class="ti ti-download"></i></span></td></tr>';
  }).join('');
}
function newObList() {
  openForm('list-form', 'lf-heading', 'นำเข้ารายชื่อ', 'Import list',
    { 'lf-name': '', 'lf-campaign': 'ทวงถามยอดค้าง ก.ค.', 'lf-tz': 'Asia/Bangkok' });
}

var OB_CALLBACKS = [
  { contact: 'คุณนภา จันทร์เพ็ญ', phone: '+66 81 234 5678', at: '08-08-2026 14:00', queue: 'General Support', agent: 'สมชาย ว.', src: 'IVR_OFFER', st: 'ok' },
  { contact: 'David Kim', phone: '+66 89 555 1200', at: '08-08-2026 14:30', queue: 'VIP Customers', agent: 'Maria G.', src: 'AGENT', st: 'ok' },
  { contact: 'คุณวิชัย ต.', phone: '+66 86 777 3456', at: '08-08-2026 11:15', queue: 'Sales (TH)', agent: '—', src: 'IVR_OFFER', st: 'late' },
  { contact: 'คุณเมษา ส.', phone: '+66 82 000 9911', at: '08-08-2026 16:00', queue: 'Billing Inquiries', agent: '—', src: 'WEB', st: 'ok' },
  { contact: 'Guest #8890', phone: '+66 84 242 9351', at: '08-08-2026 10:45', queue: 'General Support', agent: 'สมหญิง ใ.', src: 'IVR_OFFER', st: 'done' },
  { contact: 'คุณกิตติ ร.', phone: '+66 81 900 4455', at: '08-08-2026 17:30', queue: 'Technical Support', agent: '—', src: 'AGENT', st: 'ok' },
];
function renderObCallbacks() {
  var b = document.getElementById('ob-callbacks-body'); if (!b) return;
  var st = { ok: ['tag-info', 'รอโทร'], late: ['tag-bad', 'เลยเวลานัด'], done: ['tag-ok', 'โทรแล้ว'] };
  b.innerHTML = OB_CALLBACKS.map(function (c) {
    var s = st[c.st];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + c.contact + '</td>' +
      '<td class="px-4 py-3 text-slate-600 tabular-nums">' + c.phone + '</td>' +
      '<td class="px-4 py-3 ' + (c.st === 'late' ? 'due-late' : 'text-slate-600') + '">' + c.at + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.queue + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.agent + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-xs">' + c.src + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-right"><button class="qbtn" onclick="toast(\'โทรกลับเดี๋ยวนี้ (mock)\')"><i class="ti ti-phone"></i>โทรเลย</button></td></tr>';
  }).join('');
}

var OB_DNC = [
  { phone: '+66 81 111 2222', scope: 'TENANT', reason: 'ลูกค้าขอไม่ให้ติดต่อ', src: 'agent · สมชาย ว.', at: '02-08-2026' },
  { phone: '+66 82 333 4444', scope: 'PLATFORM', reason: 'อยู่ในบัญชีห้ามโทรระดับแพลตฟอร์ม', src: 'system', at: '15-05-2026' },
  { phone: '+66 83 555 6666', scope: 'TENANT', reason: 'ถอนความยินยอมผ่านลิงก์ opt-out', src: 'opt-out link', at: '05-08-2026' },
  { phone: '+66 84 777 8888', scope: 'CAMPAIGN', reason: 'ร้องเรียนเรื่องแคมเปญนี้', src: 'supervisor · สมพร', at: '28-07-2026' },
  { phone: '+66 85 999 0000', scope: 'TENANT', reason: 'เบอร์เสีย/ไม่มีผู้รับ 5 ครั้ง', src: 'system', at: '30-07-2026' },
];
function renderObDnc() {
  var b = document.getElementById('ob-dnc-body'); if (!b) return;
  var sc = { TENANT: ['tag-info', 'ทั้ง tenant'], PLATFORM: ['tag-bad', 'ระดับแพลตฟอร์ม'], CAMPAIGN: ['tag', 'เฉพาะแคมเปญ'] };
  b.innerHTML = OB_DNC.map(function (d) {
    var s = sc[d.scope];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium tabular-nums">' + d.phone + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + d.reason + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-xs">' + d.src + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + d.at + '</td>' +
      '<td class="px-4 py-3 text-right">' + (d.scope === 'PLATFORM'
        ? '<span class="act act-off" title="ลบไม่ได้"><i class="ti ti-lock"></i></span>'
        : '<span class="icon-btn" onclick="toast(\'ต้องเป็น ADMIN + บันทึก audit (mock)\')"><i class="ti ti-trash"></i></span>') +
      '</td></tr>';
  }).join('');
}

var OB_PROACTIVE = [
  { name: 'แจ้งเตือนค่าบริการ ส.ค.', ch: 'line', audience: 'ลูกค้าที่มียอดค้าง (18,200)', when: '02-08-2026 08:00', sent: 18200, reply: 412, queue: 'Billing Inquiries', status: 'COMPLETED' },
  { name: 'แจ้งปิดปรับปรุงระบบ', ch: 'sms', audience: 'ลูกค้าทั้งหมด (42,000)', when: '10-08-2026 09:00', sent: 0, reply: 0, queue: 'General Support', status: 'SCHEDULED' },
  { name: 'โปรโมชันสมาชิกใหม่', ch: 'whatsapp', audience: 'สมัคร 30 วันล่าสุด (2,140)', when: '—', sent: 0, reply: 0, queue: 'Sales (TH)', status: 'DRAFT' },
];
function renderObProactive() {
  var b = document.getElementById('ob-proactive-body'); if (!b) return;
  b.innerHTML = OB_PROACTIVE.map(function (p, i) {
    var s = OB_STATUS[p.status];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + p.name + '</td>' +
      '<td class="px-4 py-3">' + (p.ch === 'sms' ? '<span class="ch ch-voice"><i class="ti ti-message"></i>sms</span>' : chBadge(p.ch)) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.audience + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + p.when + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + (p.sent ? p.sent.toLocaleString() : '—') + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + (p.reply ? p.reply.toLocaleString() + ' (' + (p.reply / p.sent * 100).toFixed(1) + '%)' : '—') + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.queue + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      editCell('editProactive', i) + '</tr>';
  }).join('');
}
function newProactive() {
  openForm('proactive-form', 'pf-heading', 'สร้างการส่งข้อความ', 'New broadcast',
    { 'pf-name': '', 'pf-channel': 'line', 'pf-list': 'ลูกค้าที่มียอดค้าง', 'pf-queue': 'General Support', 'pf-rate': '20', 'pf-body': '' });
}
function editProactive(i) {
  var p = OB_PROACTIVE[i];
  openForm('proactive-form', 'pf-heading', 'แก้ไข: ' + p.name, 'Edit: ' + p.name,
    { 'pf-name': p.name, 'pf-channel': p.ch, 'pf-list': p.audience, 'pf-queue': p.queue, 'pf-rate': '20',
      'pf-body': 'เรียนคุณ {{ชื่อ}} ยอดค้างชำระของท่านคือ {{ยอด}} บาท ครบกำหนด {{วันที่}}' });
}

/* ============================================================
   CASES — docs/case-management.md
   ============================================================ */
var CS_STATUS = {
  NEW: ['tag-info', 'ใหม่'], OPEN: ['tag-warn', 'กำลังดำเนินการ'],
  PENDING_CUSTOMER: ['tag', 'รอลูกค้า'], PENDING_INTERNAL: ['tag', 'รอหน่วยงานอื่น'],
  RESOLVED: ['tag-ok', 'แก้จบแล้ว'], CLOSED: ['tag', 'ปิด'],
};
var CASES = [
  { no: 'CS-4821', subject: 'เคลมสินค้าชำรุด — รุ่น X200', type: 'Claim', contact: 'คุณนภา จันทร์เพ็ญ', status: 'OPEN', pri: 'สูง', owner: 'สมหญิง ใ.', left: -3, ints: 3 },
  { no: 'CS-4820', subject: 'ขอใบกำกับภาษีย้อนหลัง 3 เดือน', type: 'Billing', contact: 'Pacific Logistics', status: 'PENDING_INTERNAL', pri: 'ปกติ', owner: 'สมชาย ว.', left: 9, ints: 2 },
  { no: 'CS-4819', subject: 'อินเทอร์เน็ตช้าช่วงกลางคืน', type: 'Technical', contact: 'คุณวิชัย ต.', status: 'OPEN', pri: 'ปกติ', owner: 'ปกรณ์ ศ.', left: 22, ints: 5 },
  { no: 'CS-4818', subject: 'ขอยกเลิกบริการและคืนเงิน', type: 'Retention', contact: 'Bright Edu Group', status: 'NEW', pri: 'ด่วน', owner: '—', left: 2, ints: 1 },
  { no: 'CS-4817', subject: 'เปลี่ยนที่อยู่จัดส่ง', type: 'General', contact: 'David Kim', status: 'PENDING_CUSTOMER', pri: 'ต่ำ', owner: 'Maria G.', left: null, ints: 2 },
  { no: 'CS-4816', subject: 'ติดตามผลหลังคะแนน CSAT ต่ำ', type: 'Customer recovery', contact: 'คุณเมษา ส.', status: 'OPEN', pri: 'สูง', owner: 'สมพร (หัวหน้า)', left: 5, ints: 1 },
  { no: 'CS-4815', subject: 'ตั้งค่าอุปกรณ์ใหม่ไม่สำเร็จ', type: 'Technical', contact: 'คุณกิตติ ร.', status: 'RESOLVED', pri: 'ปกติ', owner: 'ปกรณ์ ศ.', left: null, ints: 4 },
];
function dueCell(h) {
  if (h === null) return '<span class="text-slate-400">— หยุดนาฬิกา</span>';
  if (h < 0) return '<span class="due-late">เกิน ' + Math.abs(h) + ' ชม.</span>';
  if (h <= 4) return '<span class="due-warn">เหลือ ' + h + ' ชม.</span>';
  return '<span class="due-ok">เหลือ ' + h + ' ชม.</span>';
}
function renderCases() {
  ['cs-cases-body', 'cs-mine-body'].forEach(function (id) {
    var b = document.getElementById(id); if (!b) return;
    var rows = id === 'cs-mine-body' ? CASES.filter(function (c) { return /สมหญิง|สมชาย/.test(c.owner); }) : CASES;
    b.innerHTML = rows.map(function (c) {
      var s = CS_STATUS[c.status];
      var pri = c.pri === 'ด่วน' ? 'tag-bad' : (c.pri === 'สูง' ? 'tag-warn' : 'tag');
      return '<tr class="border-b border-slate-100 rowlink" onclick="showView(\'case-detail\')">' +
        '<td class="px-4 py-3 font-medium text-teal-700">' + c.no + '</td>' +
        '<td class="px-4 py-3 font-medium text-slate-800">' + c.subject + '</td>' +
        '<td class="px-4 py-3 text-slate-600">' + c.type + '</td>' +
        '<td class="px-4 py-3 text-slate-600">' + c.contact + '</td>' +
        '<td class="px-4 py-3">' + tag(pri, c.pri) + '</td>' +
        '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
        '<td class="px-4 py-3 text-slate-600">' + c.owner + '</td>' +
        '<td class="px-4 py-3">' + dueCell(c.left) + '</td>' +
        '<td class="px-4 py-3 text-slate-500">' + c.ints + '</td></tr>';
    }).join('');
  });
}
function newCase() {
  openForm('case-form', 'csf-heading', 'เปิดเคสใหม่', 'New case',
    { 'csf-subject': '', 'csf-type': 'General', 'csf-contact': '', 'csf-pri': 'ปกติ', 'csf-owner': '— ยังไม่มอบหมาย —', 'csf-desc': '' });
}
function editCase() {
  var c = CASES[0];
  openForm('case-form', 'csf-heading', 'แก้ไข: ' + c.no, 'Edit: ' + c.no,
    { 'csf-subject': c.subject, 'csf-type': c.type, 'csf-contact': c.contact, 'csf-pri': c.pri, 'csf-owner': c.owner,
      'csf-desc': 'ลูกค้าแจ้งว่าสินค้ามีรอยแตกตั้งแต่แกะกล่อง ขอเปลี่ยนเครื่องใหม่' });
}

var CS_TYPES = [
  { name: 'Claim', prefix: 'CS', fields: 'หมายเลขสินค้า, วันที่ซื้อ, รูปถ่าย', statuses: 6, sla: 'มาตรฐาน 3 วัน', cases: 42 },
  { name: 'Billing', prefix: 'CS', fields: 'เลขที่ใบแจ้งหนี้, ยอดเงิน', statuses: 5, sla: 'มาตรฐาน 3 วัน', cases: 118 },
  { name: 'Technical', prefix: 'CS', fields: 'รุ่นอุปกรณ์, อาการ, เวลาที่เกิด', statuses: 7, sla: 'เทคนิค 8 ชม.', cases: 205 },
  { name: 'Retention', prefix: 'CS', fields: 'เหตุผลที่จะยกเลิก, ข้อเสนอที่ให้', statuses: 5, sla: 'ด่วน 4 ชม.', cases: 27 },
  { name: 'Customer recovery', prefix: 'CS', fields: 'คะแนนที่ได้, สายต้นเรื่อง', statuses: 4, sla: 'ด่วน 24 ชม.', cases: 15 },
];
function renderCsTypes() {
  var b = document.getElementById('cs-types-body'); if (!b) return;
  b.innerHTML = CS_TYPES.map(function (t, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + t.name + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + t.prefix + '-####</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + t.fields + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.statuses + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.sla + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + t.cases + '</td>' +
      editCell('editCsType', i) + '</tr>';
  }).join('');
}
function newCsType() {
  openForm('case-type-form', 'ctf-heading', 'สร้างประเภทเคส', 'New case type',
    { 'ctf-name': '', 'ctf-prefix': 'CS', 'ctf-sla': 'มาตรฐาน 3 วัน', 'ctf-fields': '' });
}
function editCsType(i) {
  var t = CS_TYPES[i];
  openForm('case-type-form', 'ctf-heading', 'แก้ไข: ' + t.name, 'Edit: ' + t.name,
    { 'ctf-name': t.name, 'ctf-prefix': t.prefix, 'ctf-sla': t.sla, 'ctf-fields': t.fields });
}

var CS_SLAS = [
  { name: 'มาตรฐาน 3 วัน', first: '4 ชม.', resolve: '3 วันทำการ', hours: 'Bangkok office', esc: '80% → หัวหน้าทีม', used: 3 },
  { name: 'เทคนิค 8 ชม.', first: '1 ชม.', resolve: '8 ชม.ทำการ', hours: 'Bangkok office', esc: '80% → หัวหน้า · 100% → ผจก.', used: 1 },
  { name: 'ด่วน 4 ชม.', first: '30 นาที', resolve: '4 ชม.', hours: '24/7', esc: '50% → หัวหน้า · 80% → ผจก.', used: 1 },
  { name: 'ด่วน 24 ชม.', first: '2 ชม.', resolve: '24 ชม.', hours: '24/7', esc: '80% → หัวหน้าทีม', used: 1 },
];
function renderCsSla() {
  var b = document.getElementById('cs-sla-body'); if (!b) return;
  b.innerHTML = CS_SLAS.map(function (s, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + s.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.first + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.resolve + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.hours + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + s.esc + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + s.used + ' ประเภท</td>' +
      editCell('editCsSla', i) + '</tr>';
  }).join('');
}
function newCsSla() {
  openForm('case-sla-form', 'slf-heading', 'สร้างนโยบาย SLA', 'New SLA policy',
    { 'slf-name': '', 'slf-first': '240', 'slf-resolve': '2160', 'slf-hours': 'Bangkok office (Mon–Fri 08:30–17:30)' });
}
function editCsSla(i) {
  var s = CS_SLAS[i];
  openForm('case-sla-form', 'slf-heading', 'แก้ไข: ' + s.name, 'Edit: ' + s.name,
    { 'slf-name': s.name, 'slf-first': '240', 'slf-resolve': '2160', 'slf-hours': s.hours });
}

/* ============================================================
   AI — bots / knowledge / assist
   ============================================================ */
var BOTS = [
  { name: 'Support TH — FAQ', level: 'L1', ch: ['webchat', 'line'], sessions: 8420, contain: 46, csat: 78, ver: 4, status: 'PUBLISHED' },
  { name: 'Order status (RAG)', level: 'L2', ch: ['webchat', 'line', 'facebook'], sessions: 3110, contain: 62, csat: 81, ver: 2, status: 'PUBLISHED' },
  { name: 'Billing helper', level: 'L2', ch: ['webchat'], sessions: 940, contain: 38, csat: 66, ver: 1, status: 'DRAFT' },
  { name: 'Appointment bot (task)', level: 'L3', ch: ['line'], sessions: 0, contain: 0, csat: 0, ver: 1, status: 'DRAFT' },
];
function renderBots() {
  var b = document.getElementById('ai-bots-body'); if (!b) return;
  var lv = { L1: ['tag', 'L1 · เมนู/FAQ'], L2: ['tag-info', 'L2 · RAG'], L3: ['tag-ai', 'L3 · ทำงานจริง'] };
  b.innerHTML = BOTS.map(function (x, i) {
    var l = lv[x.level];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + x.name + '</td>' +
      '<td class="px-4 py-3">' + tag(l[0], l[1]) + '</td>' +
      '<td class="px-4 py-3"><div class="flex gap-1">' + x.ch.map(chBadge).join('') + '</div></td>' +
      '<td class="px-4 py-3 text-slate-600">' + (x.sessions ? x.sessions.toLocaleString() : '—') + '</td>' +
      '<td class="px-4 py-3 w-32">' + (x.sessions ? pbar(x.contain, x.contain < 40 ? 'p-warn' : '') +
        '<span class="text-xs text-slate-400">' + x.contain + '%</span>' : '<span class="text-slate-400">—</span>') + '</td>' +
      '<td class="px-4 py-3 ' + (x.csat && x.csat < 70 ? 'text-rose-600 font-semibold' : 'text-slate-600') + '">' + (x.csat || '—') + '</td>' +
      '<td class="px-4 py-3 text-slate-500">v' + x.ver + '</td>' +
      '<td class="px-4 py-3">' + (x.status === 'PUBLISHED' ? tag('tag-ok', 'เผยแพร่แล้ว') : tag('tag-warn', 'ฉบับร่าง')) + '</td>' +
      editCell('editBot', i) + '</tr>';
  }).join('');
}
function newBot() {
  openForm('bot-form', 'bf-heading', 'สร้างบอตใหม่', 'New virtual agent',
    { 'bf-name': '', 'bf-level': 'L1', 'bf-conf': '0.62', 'bf-turns': '6', 'bf-queue': 'General Support', 'bf-persona': '' });
}
function editBot(i) {
  var x = BOTS[i];
  openForm('bot-form', 'bf-heading', 'แก้ไข: ' + x.name, 'Edit: ' + x.name,
    { 'bf-name': x.name, 'bf-level': x.level, 'bf-conf': '0.62', 'bf-turns': '6', 'bf-queue': 'General Support',
      'bf-persona': 'สุภาพ กระชับ ไม่เกิน 3 ประโยค · ห้ามสัญญาเรื่องเงินคืน · ไม่ทราบให้ส่งต่อทันที' });
}

var BOT_TESTS = [
  { q: 'ของถึงเมื่อไหร่ครับ สั่งไปเมื่อวาน', expect: 'ตอบจากบทความติดตามพัสดุ', res: 'pass' },
  { q: 'ขอเลขพัสดุหน่อย', expect: 'ถามเลขออเดอร์ก่อน', res: 'pass' },
  { q: 'จะยกเลิกออเดอร์ได้ไหม', expect: 'ส่งต่อเอเจนต์ (ไม่มีในคลัง)', res: 'pass' },
  { q: 'ทำไมแพงกว่าเจ้าอื่น', expect: 'ส่งต่อเอเจนต์', res: 'fail' },
  { q: 'เปลี่ยนที่อยู่จัดส่งยังไง', expect: 'ตอบจากบทความเปลี่ยนที่อยู่', res: 'pass' },
];
function renderBotTests() {
  var b = document.getElementById('ai-tests-body'); if (!b) return;
  b.innerHTML = BOT_TESTS.map(function (t) {
    return '<tr class="border-b border-slate-100">' +
      '<td class="px-4 py-3 font-medium">' + t.q + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.expect + '</td>' +
      '<td class="px-4 py-3">' + (t.res === 'pass' ? tag('tag-ok', 'ผ่าน') : tag('tag-bad', 'ไม่ผ่าน')) + '</td>' +
      '<td class="px-4 py-3 text-right"><button class="qbtn" onclick="toast(\'รันทดสอบใหม่ (mock)\')"><i class="ti ti-player-play"></i>ทดสอบ</button></td></tr>';
  }).join('');
}

var KB = [
  { title: 'การติดตามพัสดุและระยะเวลาจัดส่ง', col: 'สาธารณะ', owner: 'ทีมบริการ', updated: '20-07-2026', review: 45, used: 1820, handoff: 6, status: 'PUBLISHED' },
  { title: 'วิธีเปลี่ยนที่อยู่จัดส่ง', col: 'สาธารณะ', owner: 'ทีมบริการ', updated: '02-06-2026', review: -12, used: 640, handoff: 11, status: 'PUBLISHED' },
  { title: 'เงื่อนไขการคืนเงินและการเคลม', col: 'สาธารณะ', owner: 'ฝ่ายกฎหมาย', updated: '15-07-2026', review: 88, used: 412, handoff: 28, status: 'PUBLISHED' },
  { title: 'ขั้นตอนยืนยันตัวตนลูกค้า (ภายใน)', col: 'ภายใน', owner: 'ฝ่ายกำกับ', updated: '01-08-2026', review: 120, used: 2210, handoff: 2, status: 'PUBLISHED' },
  { title: 'แพ็กเกจและราคา ปี 2026', col: 'สาธารณะ', owner: 'ฝ่ายขาย', updated: '10-03-2026', review: -60, used: 980, handoff: 41, status: 'STALE' },
  { title: 'การตั้งค่าอุปกรณ์รุ่น X200', col: 'สาธารณะ', owner: 'ทีมเทคนิค', updated: '05-08-2026', review: 150, used: 0, handoff: 0, status: 'DRAFT' },
];
function renderKb() {
  var b = document.getElementById('ai-kb-body'); if (!b) return;
  b.innerHTML = KB.map(function (a, i) {
    var rev = a.review < 0
      ? '<span class="due-late">เลยกำหนด ' + Math.abs(a.review) + ' วัน</span>'
      : (a.review < 60 ? '<span class="due-warn">อีก ' + a.review + ' วัน</span>' : '<span class="text-slate-500">อีก ' + a.review + ' วัน</span>');
    var st = a.status === 'PUBLISHED' ? tag('tag-ok', 'เผยแพร่') : (a.status === 'STALE' ? tag('tag-bad', 'ข้อมูลเก่า') : tag('tag-warn', 'ร่าง'));
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + a.title + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.col + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.owner + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + a.updated + '</td>' +
      '<td class="px-4 py-3">' + rev + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.used.toLocaleString() + '</td>' +
      '<td class="px-4 py-3 ' + (a.handoff > 20 ? 'text-rose-600 font-semibold' : 'text-slate-600') + '">' + a.handoff + '%</td>' +
      '<td class="px-4 py-3">' + st + '</td>' +
      editCell('editKb', i) + '</tr>';
  }).join('');
}
function newKb() {
  openForm('kb-form', 'kbf-heading', 'เขียนบทความใหม่', 'New article',
    { 'kbf-title': '', 'kbf-col': 'สาธารณะ', 'kbf-owner': 'ทีมบริการ', 'kbf-review': '180', 'kbf-tags': '', 'kbf-body': '' });
}
function editKb(i) {
  var a = KB[i];
  openForm('kb-form', 'kbf-heading', 'แก้ไข: ' + a.title, 'Edit: ' + a.title,
    { 'kbf-title': a.title, 'kbf-col': a.col, 'kbf-owner': a.owner, 'kbf-review': '180', 'kbf-tags': 'จัดส่ง, พัสดุ',
      'kbf-body': 'ลูกค้าสามารถติดตามพัสดุได้จากลิงก์ในอีเมลยืนยันคำสั่งซื้อ โดยปกติใช้เวลา 2–3 วันทำการ…' });
}

var KB_GAPS = [
  { q: 'ผ่อน 0% กี่เดือน', hits: 87, since: '01-08-2026', who: '— ยังไม่มอบหมาย —', st: 'OPEN' },
  { q: 'ส่งต่างประเทศได้ไหม', hits: 54, since: '28-07-2026', who: 'ฝ่ายขาย', st: 'WRITING' },
  { q: 'เปลี่ยนชื่อผู้ถือบริการ', hits: 41, since: '30-07-2026', who: '— ยังไม่มอบหมาย —', st: 'OPEN' },
  { q: 'ใบกำกับภาษีแบบอิเล็กทรอนิกส์', hits: 33, since: '02-08-2026', who: 'ฝ่ายบัญชี', st: 'WRITING' },
  { q: 'ประกันสินค้าครอบคลุมอะไร', hits: 28, since: '25-07-2026', who: 'ฝ่ายกฎหมาย', st: 'DONE' },
];
function renderKbGaps() {
  var b = document.getElementById('ai-gaps-body'); if (!b) return;
  var st = { OPEN: ['tag-bad', 'ยังไม่มีคำตอบ'], WRITING: ['tag-warn', 'กำลังเขียน'], DONE: ['tag-ok', 'เขียนแล้ว'] };
  b.innerHTML = KB_GAPS.map(function (g) {
    var s = st[g.st];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + g.q + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + g.hits + ' ครั้ง</td>' +
      '<td class="px-4 py-3 text-slate-500">' + g.since + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + g.who + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-right"><button class="qbtn" onclick="newKb()"><i class="ti ti-pencil-plus"></i>เขียนบทความ</button></td></tr>';
  }).join('');
}

var ASSIST_PROMPTS = [
  { name: 'สรุปหลังจบสาย (ไทย)', kind: 'SUMMARY', ver: 7, model: 'claude-sonnet-5', accept: 82, status: 'ACTIVE' },
  { name: 'เสนอ disposition', kind: 'SUMMARY', ver: 3, model: 'claude-haiku-4-5', accept: 74, status: 'ACTIVE' },
  { name: 'แนะนำบทความระหว่างแชท', kind: 'SUGGEST', ver: 5, model: 'claude-sonnet-5', accept: 41, status: 'ACTIVE' },
  { name: 'แนะนำประโยคปิดการขาย', kind: 'SUGGEST', ver: 2, model: 'claude-sonnet-5', accept: 19, status: 'DISABLED' },
];
function renderAssistPrompts() {
  var b = document.getElementById('ai-prompts-body'); if (!b) return;
  b.innerHTML = ASSIST_PROMPTS.map(function (p, i) {
    var acc = p.accept < 30 ? 'text-rose-600 font-semibold' : (p.accept < 50 ? 'text-amber-600' : 'text-emerald-700 font-medium');
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + p.name + '</td>' +
      '<td class="px-4 py-3">' + tag('tag-info', p.kind) + '</td>' +
      '<td class="px-4 py-3 text-slate-500">v' + p.ver + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + p.model + '</td>' +
      '<td class="px-4 py-3 ' + acc + '">' + p.accept + '%</td>' +
      '<td class="px-4 py-3">' + (p.status === 'ACTIVE' ? tag('tag-ok', 'ใช้งาน') : tag('tag', 'ปิดแล้ว — acceptance ต่ำกว่า 30%')) + '</td>' +
      editCell('editPrompt', i) + '</tr>';
  }).join('');
}
function newPrompt() {
  openForm('prompt-form', 'apf-heading', 'สร้าง prompt ใหม่', 'New prompt',
    { 'apf-name': '', 'apf-kind': 'SUMMARY', 'apf-model': 'claude-sonnet-5', 'apf-body': '' });
}
function editPrompt(i) {
  var p = ASSIST_PROMPTS[i];
  openForm('prompt-form', 'apf-heading', 'แก้ไข: ' + p.name + ' (จะกลายเป็น v' + (p.ver + 1) + ')', 'Edit: ' + p.name,
    { 'apf-name': p.name, 'apf-kind': p.kind, 'apf-model': p.model,
      'apf-body': 'สรุปบทสนทนาเป็น 3 ส่วน: ลูกค้าติดต่อเรื่องอะไร / ทำอะไรไปแล้ว / ต้องทำอะไรต่อ\nใช้ภาษาไทยกระชับ ห้ามเดาข้อมูลที่ไม่มีในบทสนทนา' });
}

var PLAYBOOKS = [
  { name: 'ยังไม่ยืนยันตัวตนใน 45 วินาที', when: 'ไม่พบวลี "ยืนยันตัวตน" หลัง 45 วิ', level: 'warn', hits: 128, accept: 71 },
  { name: 'ลูกค้าพูดถึงการยกเลิกบริการ', when: 'พบวลี "ยกเลิก", "ย้ายค่าย"', level: 'info', hits: 96, accept: 64 },
  { name: 'พูดทับกันเกิน 8%', when: 'talk-over > 8% ของสาย', level: 'info', hits: 44, accept: 22 },
  { name: 'สัญญาเกินจริง', when: 'พบวลี "รับประกันว่า", "แน่นอน 100%"', level: 'warn', hits: 12, accept: 88 },
];
function renderPlaybooks() {
  var b = document.getElementById('ai-playbooks-body'); if (!b) return;
  b.innerHTML = PLAYBOOKS.map(function (p, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + p.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + p.when + '</td>' +
      '<td class="px-4 py-3">' + (p.level === 'warn' ? tag('tag-warn', 'เตือน') : tag('tag-info', 'ข้อมูล')) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.hits + '</td>' +
      '<td class="px-4 py-3 ' + (p.accept < 30 ? 'text-rose-600 font-semibold' : 'text-slate-600') + '">' + p.accept + '%</td>' +
      editCell('editPlaybook', i) + '</tr>';
  }).join('');
}
function newPlaybook() {
  openForm('playbook-form', 'pbf-heading', 'สร้างกฎการเตือน', 'New playbook rule',
    { 'pbf-name': '', 'pbf-level': 'warn', 'pbf-when': '', 'pbf-text': '' });
}
function editPlaybook(i) {
  var p = PLAYBOOKS[i];
  openForm('playbook-form', 'pbf-heading', 'แก้ไข: ' + p.name, 'Edit: ' + p.name,
    { 'pbf-name': p.name, 'pbf-level': p.level, 'pbf-when': p.when, 'pbf-text': 'ยังไม่ได้ยืนยันตัวตนลูกค้า' });
}

/* ---------- guided scripts (A6) — เนื้อหาที่คนเขียน ไม่ผ่านโมเดล ----------
   drop คือขั้นที่เอเจนต์เลิกเดินบ่อยที่สุด — ตัวเลขนี้ตัดสิน "สคริปต์" ไม่ใช่ "คน" */
var SCRIPT_LIST = [
  { name: 'ติดตามค่างวดที่ชำระไม่ผ่าน', purpose: 'COLLECTION', bind: 'แคมเปญ: ทวงถามยอดค้าง ส.ค.', steps: 7, req: 3,
    ver: 11, done: 84, drop: 'ขั้น 4 · นัดวันที่จะชำระ', owner: 'ฝ่ายกำกับ', status: 'PUBLISHED' },
  { name: 'ขายที่นั่งเพิ่ม — ลูกค้าถามส่วนลด', purpose: 'SALES', bind: 'คิว: Sales (TH)', steps: 6, req: 2,
    ver: 6, done: 61, drop: 'ขั้น 5 · เทียบกับเจ้าอื่น', owner: 'ฝ่ายขาย', status: 'PUBLISHED' },
  { name: 'ยืนยันตัวตนก่อนเปิดเผยข้อมูล', purpose: 'VERIFY', bind: 'คิว: VIP Customers', steps: 4, req: 4,
    ver: 3, done: 97, drop: '— ไม่มีขั้นที่ถูกข้ามเกิน 5% —', owner: 'ฝ่ายกำกับ', status: 'PUBLISHED' },
  { name: 'รั้งลูกค้าที่แจ้งยกเลิกบริการ', purpose: 'RETENTION', bind: 'คิว: VIP Customers', steps: 9, req: 1,
    ver: 2, done: 38, drop: 'ขั้น 3 · เสนอส่วนลดรักษาลูกค้า', owner: 'ฝ่ายขาย', status: 'PUBLISHED' },
  { name: 'รับเรื่องร้องเรียนตามระเบียบใหม่', purpose: 'SUPPORT', bind: 'ประเภทเคส: โต้แย้งยอด', steps: 5, req: 2,
    ver: 1, done: 0, drop: '— ยังไม่เผยแพร่ —', owner: 'ฝ่ายกฎหมาย', status: 'DRAFT' },
];
var SCRIPT_PURPOSE = { SALES: ['tag-info', 'ขาย'], COLLECTION: ['tag-warn', 'ติดตามหนี้'], VERIFY: ['tag', 'ยืนยันตัวตน'],
  RETENTION: ['tag-ai', 'รักษาลูกค้า'], SUPPORT: ['tag', 'บริการ'] };
function renderScripts() {
  var b = document.getElementById('ai-scripts-body'); if (!b) return;
  var filter = window.SCRIPT_FILTER || 'ALL';
  var visible = SCRIPT_LIST.filter(function (s) { return filter === 'ALL' || s.purpose === filter; });
  b.innerHTML = visible.map(function (s) {
    var i = SCRIPT_LIST.indexOf(s);
    var p = SCRIPT_PURPOSE[s.purpose];
    var done = s.status === 'DRAFT' ? '<span class="text-slate-400">—</span>'
      : pbar(s.done, s.done < 50 ? 'p-warn' : '') + '<span class="text-xs ' + (s.done < 50 ? 'text-rose-600 font-semibold' : 'text-slate-400') + '">' + s.done + '%</span>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + s.name + ' <span class="text-xs font-normal text-slate-400">v' + s.ver + '</span></td>' +
      '<td class="px-4 py-3">' + tag(p[0], p[1]) + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + s.bind + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.steps + ' <span class="text-xs text-slate-400">(บังคับ ' + s.req + ')</span></td>' +
      '<td class="px-4 py-3 w-32">' + done + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + s.drop + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.owner + '</td>' +
      '<td class="px-4 py-3">' + (s.status === 'PUBLISHED' ? tag('tag-ok', 'เผยแพร่แล้ว') : tag('tag-warn', 'ฉบับร่าง')) + '</td>' +
      editCell('editScript', i) + '</tr>';
  }).join('') || '<tr><td colspan="9" class="px-4 py-10 text-center text-sm text-slate-400">ยังไม่มี script ในหมวดนี้ · <button class="underline text-teal-700" onclick="newScript()">สร้าง script ใหม่</button></td></tr>';
}
function filterScripts(purpose) {
  window.SCRIPT_FILTER = purpose || 'ALL';
  var select = document.getElementById('script-purpose-filter');
  if (select) select.value = window.SCRIPT_FILTER;
  renderScripts();
}
var SCRIPT_STEPS_DEMO = [
  { k: 'SAY', t: 'แจ้งบันทึกเสียง + ยืนยันตัวตนผู้รับสาย', req: true },
  { k: 'SAY', t: 'แจ้งวัตถุประสงค์การติดต่อให้ชัด', req: true },
  { k: 'BRANCH', t: 'ลูกค้าตอบว่าอย่างไร (3 ทาง)', req: false },
  { k: 'ASK', t: 'นัดวันที่จะชำระ → ob_record.attrs.promiseDate', req: false },
  { k: 'ACTION', t: 'เปิดเคสโต้แย้งยอด', req: false },
  { k: 'KB', t: 'อ้างบทความ: เงื่อนไขการผ่อนผัน (ภายใน)', req: false },
  { k: 'ACTION', t: 'บันทึกผลการติดต่อก่อนปิดงาน', req: true },
];
var SCRIPT_KIND = { SAY: ['tag', 'พูด'], ASK: ['tag-info', 'ถาม + เก็บคำตอบ'], BRANCH: ['tag-ai', 'ทางแยก'],
  KB: ['tag', 'บทความ'], ACTION: ['tag-warn', 'ลงมือทำ'] };
function renderScriptSteps() {
  var b = document.getElementById('scf-steps'); if (!b) return;
  b.innerHTML = SCRIPT_STEPS_DEMO.map(function (s, i) {
    var k = SCRIPT_KIND[s.k];
    return '<tr class="border-b border-slate-100">' +
      '<td class="px-3 py-2 text-slate-400">' + (i + 1) + '</td>' +
      '<td class="px-3 py-2">' + tag(k[0], k[1]) + '</td>' +
      '<td class="px-3 py-2 text-slate-700">' + s.t + '</td>' +
      '<td class="px-3 py-2">' + (s.req ? tag('tag-warn', 'บังคับ') : '<span class="text-slate-400 text-xs">—</span>') + '</td>' +
      '<td class="px-3 py-2 text-right"><span class="icon-btn" onclick="toast(\'แก้ขั้นตอน (mock)\')"><i class="ti ti-pencil"></i></span></td></tr>';
  }).join('');
}
function newScript() {
  openForm('script-form', 'scf-heading', 'สร้างสคริปต์ใหม่', 'New script',
    { 'scf-name': '', 'scf-purpose': 'SALES', 'scf-locale': 'ไทย', 'scf-bind': 'คิว: Sales (TH)',
      'scf-owner': 'ฝ่ายขาย', 'scf-review': '180' });
}
function editScript(i) {
  var s = SCRIPT_LIST[i];
  openForm('script-form', 'scf-heading', 'แก้ไข: ' + s.name + ' (publish แล้วจะเป็น v' + (s.ver + 1) + ')', 'Edit: ' + s.name,
    { 'scf-name': s.name, 'scf-purpose': s.purpose, 'scf-locale': 'ไทย', 'scf-bind': s.bind,
      'scf-owner': s.owner, 'scf-review': '180' });
}

/* ============================================================
   ANALYTICS — interaction analytics / feedback / performance
   ============================================================ */
var IA_TOPICS = [
  { label: 'ค่าบริการไม่ตรงกับที่แจ้ง', st: 'PROMOTED', n: 1284, growth: 18, aht: 412, csat: 61, repeat: 22 },
  { label: 'พัสดุล่าช้า', st: 'PROMOTED', n: 980, growth: -6, aht: 248, csat: 74, repeat: 14 },
  { label: 'ตั้งค่าอุปกรณ์ไม่ได้', st: 'CONFIRMED', n: 742, growth: 41, aht: 605, csat: 68, repeat: 31 },
  { label: 'ขอใบกำกับภาษี', st: 'CONFIRMED', n: 511, growth: 3, aht: 190, csat: 82, repeat: 8 },
  { label: 'สอบถามโปรโมชันคู่แข่ง', st: 'DISCOVERED', n: 288, growth: 96, aht: 355, csat: 70, repeat: 19 },
  { label: 'แอปล็อกอินไม่ได้หลังอัปเดต', st: 'DISCOVERED', n: 174, growth: 214, aht: 470, csat: 55, repeat: 44 },
];
function renderIaTopics() {
  var b = document.getElementById('ia-topics-body'); if (!b) return;
  var st = { PROMOTED: ['tag-ok', 'เป็นกฎแล้ว'], CONFIRMED: ['tag-info', 'ยืนยันแล้ว'], DISCOVERED: ['tag-ai', 'เพิ่งค้นพบ'] };
  b.innerHTML = IA_TOPICS.map(function (t) {
    var s = st[t.st];
    var g = t.growth > 50 ? '<span class="text-rose-600 font-semibold">+' + t.growth + '%</span>'
      : (t.growth > 0 ? '<span class="kpi-delta-up">+' + t.growth + '%</span>' : '<span class="text-slate-500">' + t.growth + '%</span>');
    return '<tr class="border-b border-slate-100 rowlink" onclick="showView(\'ia-topic-detail\')">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + t.label + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.n.toLocaleString() + '</td>' +
      '<td class="px-4 py-3">' + g + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + Math.floor(t.aht / 60) + ':' + ('0' + (t.aht % 60)).slice(-2) + '</td>' +
      '<td class="px-4 py-3 ' + (t.csat < 65 ? 'text-rose-600 font-semibold' : 'text-slate-600') + '">' + t.csat + '</td>' +
      '<td class="px-4 py-3 ' + (t.repeat > 30 ? 'text-amber-600 font-semibold' : 'text-slate-600') + '">' + t.repeat + '%</td>' +
      '<td class="px-4 py-3 text-right">' + (t.st === 'PROMOTED' ? '<span class="text-xs text-slate-400">—</span>' :
        '<button class="qbtn" onclick="event.stopPropagation();toast(\'เลื่อนขั้นเป็นหมวดอัตโนมัติ (mock)\')"><i class="ti ti-arrow-up-circle"></i>เลื่อนขั้น</button>') +
      '</td></tr>';
  }).join('');
}

var IA_SAVED = [
  { name: 'พูดถึงการฟ้องร้อง', q: 'phrase:"ฟ้อง" OR "ผู้บริโภค"', owner: 'ฝ่ายกำกับ', alert: '> 5 สาย/วัน', hits: 3 },
  { name: 'ลูกค้าเอ่ยชื่อคู่แข่ง', q: 'phrase:"เจ้าอื่น" OR ชื่อคู่แข่ง', owner: 'ฝ่ายขาย', alert: '—', hits: 61 },
  { name: 'สัญญาเกินจริงโดยเอเจนต์', q: 'category:สัญญาเกินจริง', owner: 'QM', alert: '> 3 สาย/สัปดาห์', hits: 4 },
];
function renderIaSaved() {
  var b = document.getElementById('ia-saved-body'); if (!b) return;
  b.innerHTML = IA_SAVED.map(function (s, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + s.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600 font-mono text-xs">' + s.q + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.owner + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.alert + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.hits + '</td>' +
      editCell('editSaved', i) + '</tr>';
  }).join('');
}
function newSaved() {
  openForm('saved-form', 'sf-heading', 'บันทึกการค้นหา', 'New saved search',
    { 'sf-name': '', 'sf-query': '', 'sf-alert': '—' });
}
function editSaved(i) {
  var s = IA_SAVED[i];
  openForm('saved-form', 'sf-heading', 'แก้ไข: ' + s.name, 'Edit: ' + s.name,
    { 'sf-name': s.name, 'sf-query': s.q, 'sf-alert': s.alert });
}

var FB_SURVEYS = [
  { name: 'CSAT หลังจบงาน (ไทย)', type: 'CSAT', ver: 3, ch: ['webchat', 'line', 'voice'], resp: 4820, rate: 31, status: 'PUBLISHED' },
  { name: 'NPS รายไตรมาส', type: 'NPS', ver: 2, ch: ['email', 'line'], resp: 1240, rate: 12, status: 'PUBLISHED' },
  { name: 'CES หลังใช้บอต', type: 'CES', ver: 1, ch: ['webchat'], resp: 610, rate: 22, status: 'PUBLISHED' },
  { name: 'CSAT ฉบับใหม่ (ทดลอง)', type: 'CSAT', ver: 1, ch: ['webchat'], resp: 0, rate: 0, status: 'DRAFT' },
];
function renderFbSurveys() {
  var b = document.getElementById('fb-surveys-body'); if (!b) return;
  b.innerHTML = FB_SURVEYS.map(function (s, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + s.name + '</td>' +
      '<td class="px-4 py-3">' + tag('tag-info', s.type) + '</td>' +
      '<td class="px-4 py-3 text-slate-500">v' + s.ver + (s.resp ? ' <span class="text-xs text-slate-400">(แช่แข็ง)</span>' : '') + '</td>' +
      '<td class="px-4 py-3"><div class="flex gap-1">' + s.ch.map(chBadge).join('') + '</div></td>' +
      '<td class="px-4 py-3 text-slate-600">' + (s.resp ? s.resp.toLocaleString() : '—') + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + (s.rate ? s.rate + '%' : '—') + '</td>' +
      '<td class="px-4 py-3">' + (s.status === 'PUBLISHED' ? tag('tag-ok', 'ใช้งาน') : tag('tag-warn', 'ร่าง')) + '</td>' +
      editCell('editSurvey', i) + '</tr>';
  }).join('');
}
function newSurvey() {
  openForm('survey-form', 'svf-heading', 'สร้างแบบสำรวจ', 'New survey',
    { 'svf-name': '', 'svf-type': 'CSAT', 'svf-q1': 'คุณพอใจกับการบริการครั้งนี้แค่ไหน', 'svf-q2': 'เรื่องนี้จบในครั้งเดียวหรือไม่', 'svf-q3': '' });
}
function editSurvey(i) {
  var s = FB_SURVEYS[i];
  openForm('survey-form', 'svf-heading', 'แก้ไข: ' + s.name, 'Edit: ' + s.name,
    { 'svf-name': s.name, 'svf-type': s.type, 'svf-q1': 'คุณพอใจกับการบริการครั้งนี้แค่ไหน (1–5)',
      'svf-q2': 'เรื่องนี้จบในครั้งเดียวหรือไม่', 'svf-q3': 'มีอะไรอยากบอกเราเพิ่มเติมไหม' });
}

var FB_PLANS = [
  { name: 'ทุกงานบริการ (ยกเว้น VIP)', match: 'คิว: General, Technical · ทุกช่องทาง', pct: 40, sup: 30, deliver: 'ในห้องแชทเดิม / IVR', on: true },
  { name: 'VIP ทุกสาย', match: 'คิว: VIP Customers · voice', pct: 100, sup: 14, deliver: 'SMS หลังวางสาย', on: true },
  { name: 'หลังใช้บอต', match: 'session ที่บอตจบเอง', pct: 25, sup: 30, deliver: 'ในห้องแชทเดิม', on: true },
  { name: 'NPS รายไตรมาส', match: 'ลูกค้าที่ติดต่อใน 90 วัน', pct: 15, sup: 90, deliver: 'อีเมล', on: false },
];
function renderFbPlans() {
  var b = document.getElementById('fb-plans-body'); if (!b) return;
  b.innerHTML = FB_PLANS.map(function (p, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + p.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + p.match + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.pct + '%</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.sup + ' วัน</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.deliver + '</td>' +
      '<td class="px-4 py-3">' + (p.on ? tag('tag-ok', 'เปิด') : tag('tag', 'ปิด')) + '</td>' +
      editCell('editFbPlan', i) + '</tr>';
  }).join('');
}
function newFbPlan() {
  openForm('fb-plan-form', 'fpf-heading', 'สร้างแผนการถาม', 'New survey plan',
    { 'fpf-name': '', 'fpf-survey': 'CSAT หลังจบงาน (ไทย)', 'fpf-pct': '40', 'fpf-sup': '30', 'fpf-deliver': 'ในห้องแชทเดิม' });
}
function editFbPlan(i) {
  var p = FB_PLANS[i];
  openForm('fb-plan-form', 'fpf-heading', 'แก้ไข: ' + p.name, 'Edit: ' + p.name,
    { 'fpf-name': p.name, 'fpf-survey': 'CSAT หลังจบงาน (ไทย)', 'fpf-pct': p.pct, 'fpf-sup': p.sup, 'fpf-deliver': p.deliver });
}

var FB_RESP = [
  { at: '08-08 09:41', contact: 'คุณนภา จันทร์เพ็ญ', survey: 'CSAT', score: 2, comment: 'รอสายนานมาก และต้องเล่าเรื่องใหม่ทุกครั้ง', agent: 'สมชาย ว.', follow: 'OPEN' },
  { at: '08-08 09:12', contact: 'David Kim', survey: 'CSAT', score: 5, comment: 'Fast and clear, thanks', agent: 'Maria G.', follow: '—' },
  { at: '08-08 08:55', contact: 'คุณวิชัย ต.', survey: 'NPS', score: 4, comment: 'ราคาสูงกว่าเจ้าอื่นมาก', agent: 'อรทัย พ.', follow: 'OPEN' },
  { at: '07-08 17:30', contact: 'คุณเมษา ส.', survey: 'CSAT', score: 1, comment: 'แก้ปัญหาไม่ได้เลย โอนสาย 3 รอบ', agent: 'ปกรณ์ ศ.', follow: 'DONE' },
  { at: '07-08 16:02', contact: 'Guest #8812', survey: 'CES', score: 6, comment: '', agent: 'บอต', follow: '—' },
];
function renderFbResp() {
  var b = document.getElementById('fb-resp-body'); if (!b) return;
  b.innerHTML = FB_RESP.map(function (r) {
    var bad = (r.survey === 'CSAT' && r.score <= 2) || (r.survey === 'NPS' && r.score <= 6);
    var f = r.follow === 'OPEN' ? tag('tag-bad', 'รอติดต่อกลับ') : (r.follow === 'DONE' ? tag('tag-ok', 'ติดต่อกลับแล้ว') : '<span class="text-slate-400">—</span>');
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 text-slate-500">' + r.at + '</td>' +
      '<td class="px-4 py-3 font-medium">' + r.contact + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.survey + '</td>' +
      '<td class="px-4 py-3 ' + (bad ? 'text-rose-600 font-bold' : 'text-emerald-700 font-semibold') + '">' + r.score + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + (r.comment || '<span class="text-slate-300">— ไม่มีความเห็น —</span>') + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.agent + '</td>' +
      '<td class="px-4 py-3">' + f + '</td></tr>';
  }).join('');
}

var PM_TEAM = [
  { agent: 'สมชาย วงศ์ประเสริฐ', qm: 88, csat: 82, aht: 271, adh: 94, total: 87, n: 6 },
  { agent: 'สมหญิง ใจดี', qm: 91, csat: 88, aht: 244, adh: 97, total: 92, n: 5 },
  { agent: 'John Anderson', qm: 76, csat: 71, aht: 198, adh: 88, total: 74, n: 4 },
  { agent: 'อรทัย พูลสวัสดิ์', qm: 84, csat: 79, aht: 312, adh: 91, total: 82, n: 5 },
  { agent: 'ปกรณ์ ศรีสุข', qm: null, csat: 68, aht: 402, adh: 86, total: null, n: 1 },
  { agent: 'Maria Garcia', qm: 93, csat: 90, aht: 258, adh: 96, total: 94, n: 7 },
];
function renderPmTeam() {
  var b = document.getElementById('pm-team-body'); if (!b) return;
  b.innerHTML = PM_TEAM.map(function (p) {
    function cell(v, good, bad, suffix) {
      if (v === null) return '<td class="px-4 py-3 text-slate-300">— ตัวอย่างไม่พอ</td>';
      var cls = v >= good ? 'text-emerald-700 font-medium' : (v <= bad ? 'text-rose-600 font-semibold' : 'text-slate-600');
      return '<td class="px-4 py-3 ' + cls + '">' + v + (suffix || '') + '</td>';
    }
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + p.agent + '</td>' +
      cell(p.qm, 85, 75) + cell(p.csat, 85, 70) +
      '<td class="px-4 py-3 text-slate-600">' + Math.floor(p.aht / 60) + ':' + ('0' + (p.aht % 60)).slice(-2) + '</td>' +
      cell(p.adh, 93, 88, '%') +
      '<td class="px-4 py-3">' + (p.total === null ? '<span class="text-slate-300">—</span>' :
        '<div class="w-28">' + pbar(p.total, p.total < 80 ? 'p-warn' : '') + '<span class="text-xs text-slate-500">' + p.total + '</span></div>') + '</td>' +
      '<td class="px-4 py-3 text-slate-400 text-xs">n=' + p.n + '</td>' +
      '<td class="px-4 py-3 text-right"><button class="qbtn" onclick="toast(\'เปิดการโค้ช — จองเวลาใน WFM (mock)\')"><i class="ti ti-school"></i>เปิดการโค้ช</button></td></tr>';
  }).join('');
}

var PM_CARDS = [
  { name: 'Service (มาตรฐาน)', applies: 'ทีม Support A, Support B', metrics: 'QM 40% · CSAT 30% · Adherence 20% · AHT 10%', period: 'รายเดือน', ver: 4, status: 'ACTIVE' },
  { name: 'Sales', applies: 'ทีม Sales', metrics: 'Conversion 40% · QM 30% · CSAT 20% · AHT 10%', period: 'รายเดือน', ver: 2, status: 'ACTIVE' },
  { name: 'Collections', applies: 'ทีม Collections', metrics: 'RPC 35% · PTP 35% · QM 30%', period: 'รายสัปดาห์', ver: 1, status: 'DRAFT' },
];
function renderPmCards() {
  var b = document.getElementById('pm-cards-body'); if (!b) return;
  b.innerHTML = PM_CARDS.map(function (c, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + c.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.applies + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + c.metrics + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.period + '</td>' +
      '<td class="px-4 py-3 text-slate-500">v' + c.ver + '</td>' +
      '<td class="px-4 py-3">' + (c.status === 'ACTIVE' ? tag('tag-ok', 'ใช้งาน') : tag('tag-warn', 'ร่าง')) + '</td>' +
      editCell('editPmCard', i) + '</tr>';
  }).join('');
}
function newPmCard() {
  openForm('pm-card-form', 'pcf-heading', 'สร้างชุดตัวชี้วัด', 'New scorecard',
    { 'pcf-name': '', 'pcf-applies': 'ทุกทีม', 'pcf-period': 'รายเดือน',
      'pcf-w-qm': '40', 'pcf-w-csat': '30', 'pcf-w-adh': '20', 'pcf-w-aht': '10' });
}
function editPmCard(i) {
  var c = PM_CARDS[i];
  openForm('pm-card-form', 'pcf-heading', 'แก้ไข: ' + c.name, 'Edit: ' + c.name,
    { 'pcf-name': c.name, 'pcf-applies': c.applies, 'pcf-period': c.period,
      'pcf-w-qm': '40', 'pcf-w-csat': '30', 'pcf-w-adh': '20', 'pcf-w-aht': '10' });
}

/* ============================================================
   INTEGRATIONS — integrations.html (เดิม channels.html)
   ============================================================ */
var INT_APPS = [
  { name: 'Salesforce — Acme Production', kind: 'SALESFORCE', status: 'OK', last: '08-08-2026 09:58', note: 'screen pop + บันทึก activity · ขึ้นในแท็บ "แอป" ของเอเจนต์' },
  { name: 'LINE OA CRM', kind: 'LINE_CRM', status: 'OK', last: '08-08-2026 09:59', note: 'ผูก LINE userId กับลูกค้า' },
  { name: 'Zendesk (ทดสอบ)', kind: 'ZENDESK', status: 'WARN', last: '07-08-2026 22:14', note: 'token หมดอายุใน 6 วัน' },
  { name: 'ระบบคลังสินค้า (custom)', kind: 'CUSTOM', status: 'FAIL', last: '06-08-2026 03:12', note: 'เชื่อมต่อไม่สำเร็จ 14 ครั้ง' },
];
function renderIntApps() {
  var b = document.getElementById('int-apps-body'); if (!b) return;
  var st = { OK: ['tag-ok', 'ปกติ'], WARN: ['tag-warn', 'ต้องดู'], FAIL: ['tag-bad', 'ล้มเหลว'] };
  b.innerHTML = INT_APPS.map(function (a, i) {
    var s = st[a.status];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + a.name + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-xs">' + a.kind + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + a.last + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + a.note + '</td>' +
      editCell('editIntApp', i) + '</tr>';
  }).join('');
}
function newIntApp() {
  openForm('integration-form', 'itf-heading', 'ติดตั้งแอปใหม่', 'Install app',
    { 'itf-name': '', 'itf-kind': 'SALESFORCE', 'itf-url': '', 'itf-user': '', 'itf-secret': '' });
}
function editIntApp(i) {
  var a = INT_APPS[i];
  openForm('integration-form', 'itf-heading', 'แก้ไข: ' + a.name, 'Edit: ' + a.name,
    { 'itf-name': a.name, 'itf-kind': a.kind, 'itf-url': 'https://acme.my.salesforce.com', 'itf-user': 'integration@acme.co.th', 'itf-secret': '' });
}

var API_CLIENTS = [
  { name: 'CRM sync (production)', scopes: 'interactions:read, contacts:*', rps: 20, created: '12-05-2026', status: 'ACTIVE' },
  { name: 'Dialer feeder (SI พาร์ตเนอร์)', scopes: 'campaigns:write', rps: 5, created: '01-07-2026', status: 'ACTIVE' },
  { name: 'BI extractor', scopes: 'reports:read', rps: 2, created: '20-03-2026', status: 'ACTIVE' },
  { name: 'ทดสอบเก่า (เลิกใช้)', scopes: 'interactions:read', rps: 5, created: '02-01-2026', status: 'REVOKED' },
];
function renderApiClients() {
  var b = document.getElementById('api-clients-body'); if (!b) return;
  b.innerHTML = API_CLIENTS.map(function (c) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + c.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600 font-mono text-xs">' + c.scopes + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.rps + ' req/s</td>' +
      '<td class="px-4 py-3 text-slate-500">' + c.created + '</td>' +
      '<td class="px-4 py-3">' + (c.status === 'ACTIVE' ? tag('tag-ok', 'ใช้งาน') : tag('tag', 'เพิกถอนแล้ว')) + '</td>' +
      '<td class="px-4 py-3 text-right">' + (c.status === 'ACTIVE'
        ? '<button class="qbtn" onclick="toast(\'เพิกถอน client (mock)\')"><i class="ti ti-ban"></i>เพิกถอน</button>' : '') + '</td></tr>';
  }).join('');
}
function newApiClient() {
  openForm('api-client-form', 'acf-heading', 'สร้าง API client', 'New API client',
    { 'acf-name': '', 'acf-rps': '10' });
}

var WEBHOOKS = [
  { url: 'https://crm.acme.co.th/hooks/dcontact', events: 'interaction.*, case.*', ok: 99.8, last: '08-08-2026 10:01', status: 'ACTIVE' },
  { url: 'https://ops.acme.co.th/api/csat', events: 'feedback.response.*', ok: 100, last: '08-08-2026 09:44', status: 'ACTIVE' },
  { url: 'https://legacy.acme.co.th/notify', events: 'interaction.ended', ok: 41.2, last: '06-08-2026 02:55', status: 'PAUSED' },
];
function renderWebhooks() {
  var b = document.getElementById('webhooks-body'); if (!b) return;
  b.innerHTML = WEBHOOKS.map(function (w, i) {
    var ok = w.ok < 95 ? 'text-rose-600 font-semibold' : 'text-slate-600';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-mono text-[13px]">' + w.url + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + w.events + '</td>' +
      '<td class="px-4 py-3 ' + ok + '">' + w.ok + '%</td>' +
      '<td class="px-4 py-3 text-slate-500">' + w.last + '</td>' +
      '<td class="px-4 py-3">' + (w.status === 'ACTIVE' ? tag('tag-ok', 'ส่งอยู่') : tag('tag-bad', 'พักอัตโนมัติ')) + '</td>' +
      editCell('editWebhook', i) + '</tr>';
  }).join('');
}
/* ---------- ภาพรวมการเชื่อมต่อ (หน้าแรกของ area) ---------- */
// รวมทั้ง "ช่องทางที่รับงาน" และ "ระบบภายนอก" ไว้ตารางเดียว — คำถามแรกของแอดมินคือ "ตอนนี้อะไรพัง"
var INT_OVERVIEW = [
  { group: 'SOURCE', name: '+66 2 123 4500 (Main hotline)', kind: 'เบอร์โทรศัพท์', st: 'OK', last: 'มีสายเมื่อ 2 นาทีที่แล้ว', view: 'numbers' },
  { group: 'SOURCE', name: 'acme.co.th — Support', kind: 'เว็บแชท', st: 'OK', last: 'มีแชทเมื่อ 1 นาทีที่แล้ว', view: 'webchat' },
  { group: 'SOURCE', name: '@acme-support (LINE OA)', kind: 'โซเชียล', st: 'OK', last: 'มีข้อความเมื่อ 4 นาทีที่แล้ว', view: 'social' },
  { group: 'SOURCE', name: 'WhatsApp Business', kind: 'โซเชียล', st: 'WARN', last: 'template รออนุมัติ 2 ฉบับ', view: 'social' },
  { group: 'SOURCE', name: 'support@acme.co.th', kind: 'อีเมล', st: 'OK', last: 'ซิงก์เมื่อ 3 นาทีที่แล้ว', view: 'email' },
  { group: 'SYSTEM', name: 'Salesforce — Acme Production', kind: 'แอปที่เชื่อมต่อ', st: 'OK', last: '08-08-2026 09:58', view: 'apps' },
  { group: 'SYSTEM', name: 'LINE OA CRM', kind: 'แอปที่เชื่อมต่อ', st: 'OK', last: '08-08-2026 09:59', view: 'apps' },
  { group: 'SYSTEM', name: 'Zendesk (ทดสอบ)', kind: 'แอปที่เชื่อมต่อ', st: 'WARN', last: 'token หมดอายุใน 6 วัน', view: 'apps' },
  { group: 'SYSTEM', name: 'ระบบคลังสินค้า (custom)', kind: 'ตัวเชื่อม', st: 'FAIL', last: 'ล้มเหลว 14 ครั้งตั้งแต่ 06-08', view: 'connectors' },
  { group: 'SYSTEM', name: 'ASR: whisper-th (on-prem)', kind: 'ผู้ให้บริการ AI', st: 'OK', last: 'ใช้ไป 18,904 / 20,000 นาที', view: 'ai-providers' },
  { group: 'DEV', name: 'crm.acme.co.th/hooks/dcontact', kind: 'Webhook', st: 'OK', last: 'สำเร็จ 99.8% (7 วัน)', view: 'webhooks' },
  { group: 'DEV', name: 'legacy.acme.co.th/notify', kind: 'Webhook', st: 'FAIL', last: 'พักอัตโนมัติ 06-08 02:55', view: 'webhooks' },
  { group: 'DEV', name: 'CRM sync (production)', kind: 'API client', st: 'OK', last: '4.2 req/s จากเพดาน 20', view: 'api-clients' },
  { group: 'DEV', name: 'Order panel (visual app)', kind: 'แอปฝังในหน้าเอเจนต์', st: 'OK', last: 'โหลด p95 0.9 วินาที', view: 'visual-apps' },
];
function renderIntOverview() {
  var b = document.getElementById('int-overview-body'); if (!b) return;
  var st = { OK: ['tag-ok', 'ปกติ'], WARN: ['tag-warn', 'ต้องดู'], FAIL: ['tag-bad', 'ล้มเหลว'] };
  var grp = { SOURCE: 'ช่องทางที่รับงาน', SYSTEM: 'ระบบภายนอก', DEV: 'นักพัฒนา' };
  b.innerHTML = INT_OVERVIEW.map(function (r) {
    var s = st[r.st];
    return '<tr class="border-b border-slate-100 rowlink" onclick="showView(\'' + r.view + '\')">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + r.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.kind + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-xs">' + grp[r.group] + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-[13px]">' + r.last + '</td>' +
      '<td class="px-4 py-3 text-right"><i class="ti ti-chevron-right text-slate-300"></i></td></tr>';
  }).join('');
  var c = { OK: 0, WARN: 0, FAIL: 0 };
  INT_OVERVIEW.forEach(function (r) { c[r.st]++; });
  ['ok', 'warn', 'fail', 'total'].forEach(function (k) {
    var e = document.getElementById('int-count-' + k);
    if (e) e.textContent = k === 'total' ? INT_OVERVIEW.length : c[k.toUpperCase()];
  });
}

/* ---------- Connectors — ปลายทางที่ใช้ซ้ำได้ (flow node API call ใช้ตัวเดียวกัน) ---------- */
var CONNECTORS = [
  { name: 'Order API (production)', url: 'https://api.acme.co.th/orders', auth: 'OAuth2', timeout: 3000, used: 'flow 4 · บอต 2 · visual app 1', st: 'OK' },
  { name: 'Billing API', url: 'https://billing.acme.co.th/v2', auth: 'API key', timeout: 2500, used: 'flow 2', st: 'OK' },
  { name: 'ระบบคลังสินค้า (custom)', url: 'https://wms.acme.local/api', auth: 'Basic', timeout: 5000, used: 'เคส 1 ประเภท', st: 'FAIL' },
  { name: 'ตรวจสอบเลขบัตร (KYC)', url: 'https://kyc.partner.co.th/verify', auth: 'OAuth2', timeout: 1500, used: 'flow 1', st: 'OK' },
];
function renderConnectors() {
  var b = document.getElementById('connectors-body'); if (!b) return;
  b.innerHTML = CONNECTORS.map(function (c, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + c.name + '</td>' +
      '<td class="px-4 py-3 font-mono text-[13px] text-slate-600">' + c.url + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.auth + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.timeout.toLocaleString() + ' ms</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + c.used + '</td>' +
      '<td class="px-4 py-3">' + (c.st === 'OK' ? tag('tag-ok', 'ปกติ') : tag('tag-bad', 'ล้มเหลว')) + '</td>' +
      editCell('editConnector', i) + '</tr>';
  }).join('');
}
function newConnector() {
  openForm('connector-form', 'cnf-heading', 'สร้างตัวเชื่อมใหม่', 'New connector',
    { 'cnf-name': '', 'cnf-url': '', 'cnf-auth': 'OAuth2', 'cnf-timeout': '3000', 'cnf-retry': '2' });
}
function editConnector(i) {
  var c = CONNECTORS[i];
  openForm('connector-form', 'cnf-heading', 'แก้ไข: ' + c.name, 'Edit: ' + c.name,
    { 'cnf-name': c.name, 'cnf-url': c.url, 'cnf-auth': c.auth, 'cnf-timeout': c.timeout, 'cnf-retry': '2' });
}

/* ---------- Visual apps — UI ของลูกค้าที่ฝังในพื้นที่ทำงานเอเจนต์ ---------- */
var VISUAL_APPS = [
  { name: 'Order panel', slot: 'แท็บ "แอป" ในแผงบริบท', url: 'https://crm.acme.co.th/embed/order', ctx: 'contactId, interactionId, orderNo', open: 'เมื่อรับงาน', st: 'ACTIVE' },
  { name: 'ตรวจสอบสิทธิ์ประกัน', slot: 'แท็บในแผงลูกค้า', url: 'https://ins.acme.co.th/embed/policy', ctx: 'contactId', open: 'เมื่อกดแท็บ', st: 'ACTIVE' },
  { name: 'ฟอร์มบันทึกการขาย', slot: 'หน้าจอสรุปงาน (wrap-up)', url: 'https://sales.acme.co.th/embed/wrap', ctx: 'interactionId, disposition', open: 'เมื่อจบงาน', st: 'DRAFT' },
];
function renderVisualApps() {
  var b = document.getElementById('visual-apps-body'); if (!b) return;
  b.innerHTML = VISUAL_APPS.map(function (a, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + a.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.slot + '</td>' +
      '<td class="px-4 py-3 font-mono text-[13px] text-slate-600">' + a.url + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + a.ctx + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.open + '</td>' +
      '<td class="px-4 py-3">' + (a.st === 'ACTIVE' ? tag('tag-ok', 'ใช้งาน') : tag('tag-warn', 'ร่าง')) + '</td>' +
      editCell('editVisualApp', i) + '</tr>';
  }).join('');
}
function newVisualApp() {
  openForm('visual-app-form', 'vaf-heading', 'เพิ่มแอปฝังในหน้าเอเจนต์', 'New visual app',
    { 'vaf-name': '', 'vaf-url': '', 'vaf-slot': 'แท็บ "แอป" ในแผงบริบท', 'vaf-open': 'เมื่อรับงาน', 'vaf-ctx': 'contactId, interactionId' });
}
function editVisualApp(i) {
  var a = VISUAL_APPS[i];
  openForm('visual-app-form', 'vaf-heading', 'แก้ไข: ' + a.name, 'Edit: ' + a.name,
    { 'vaf-name': a.name, 'vaf-url': a.url, 'vaf-slot': a.slot, 'vaf-open': a.open, 'vaf-ctx': a.ctx });
}

function newWebhook() {
  openForm('webhook-form', 'whf-heading', 'สร้าง webhook', 'New webhook',
    { 'whf-url': '', 'whf-secret': 'whsec_' + Math.random().toString(36).slice(2, 12) });
}
function editWebhook(i) {
  var w = WEBHOOKS[i];
  openForm('webhook-form', 'whf-heading', 'แก้ไข endpoint', 'Edit endpoint',
    { 'whf-url': w.url, 'whf-secret': 'whsec_••••••••••' });
}

/* ============================================================
   CUSTOMER 360 — people.html
   ============================================================ */
var IDENTITIES = [
  { a: 'คุณนภา จันทร์เพ็ญ (โทรศัพท์)', b: '@napha.c (LINE)', why: 'ชื่อที่แสดงตรงกัน + ติดต่อเรื่องเดียวกันภายใน 24 ชม.', conf: 'LIKELY' },
  { a: 'David Kim (อีเมล)', b: '+66 89 555 1200 (โทรศัพท์)', why: 'อีเมลลงท้ายโดเมนเดียวกับที่ระบุในสาย', conf: 'LIKELY' },
  { a: 'คุณวิชัย ตั้งตรงจิตร', b: 'วิชัย ต. (Facebook)', why: 'ชื่อคล้ายกัน', conf: 'GUESS' },
  { a: 'Guest #8812 (เว็บแชท)', b: 'maysa@brightedu.ac.th', why: 'ระบุอีเมลเดียวกันระหว่างแชท', conf: 'LIKELY' },
];
function renderIdentities() {
  var b = document.getElementById('identities-body'); if (!b) return;
  b.innerHTML = IDENTITIES.map(function (x) {
    var c = x.conf === 'LIKELY' ? tag('tag-warn', 'น่าจะใช่') : tag('tag', 'เดา — ไม่เสนอให้รวม');
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + x.a + '</td>' +
      '<td class="px-4 py-3 font-medium">' + x.b + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + x.why + '</td>' +
      '<td class="px-4 py-3">' + c + '</td>' +
      '<td class="px-4 py-3 text-right whitespace-nowrap">' + (x.conf === 'LIKELY'
        ? '<button class="qbtn on" onclick="toast(\'รวมแล้ว — ย้อนกลับได้ 90 วัน (mock)\')"><i class="ti ti-git-merge"></i>รวมเป็นคนเดียว</button> ' +
          '<button class="qbtn" onclick="toast(\'ทำเครื่องหมายว่าคนละคน (mock)\')">คนละคน</button>'
        : '<span class="text-xs text-slate-400">แสดงเป็นข้อมูลประกอบเท่านั้น</span>') + '</td></tr>';
  }).join('');
}

/* ============================================================
   REPORTING — reports.html
   ============================================================ */
/* สร้างจาก docs/reporting-data-platform.md §7 — อย่าแก้มือ ถ้า catalog เปลี่ยนให้ generate ใหม่ */
var RPT_CATALOG = [
  { k:'queue.sla', n:'SLA / abandon รายชั่วโมง', m:'แกนกลาง', d:'queues · hour', t:'ปก.', e:'—', p:'R1' },
  { k:'queue.volume', n:'ปริมาณและผลลัพธ์รายคิว', m:'แกนกลาง', d:'queues · day', t:'ปก.', e:'—', p:'R1' },
  { k:'queue.wait', n:'การกระจายเวลารอ + เวลารอสูงสุด', m:'แกนกลาง', d:'queues · hour', t:'ปก.', e:'—', p:'R1' },
  { k:'queue.overflow', n:'overflow / requeue / โอนต่อเป็นลูกโซ่', m:'แกนกลาง', d:'interactions · day', t:'ปก.', e:'—', p:'R2' },
  { k:'queue.nomatch', n:'งานที่ไม่มีสกิลรองรับ หรือรอเพราะไม่มีคนพร้อม', m:'แกนกลาง', d:'queues · hour', t:'ปก.', e:'—', p:'R2' },
  { k:'agent.productivity', n:'ปริมาณ · AHT · occupancy ต่อคน (+ CSAT/FCR ตามข้อ 4)', m:'แกนกลาง', d:'agents · day', t:'บค.', e:'—', p:'R1' },
  { k:'agent.state.time', n:'เวลาในแต่ละสถานะ + จำนวนครั้งที่เปลี่ยน', m:'แกนกลาง', d:'agents · 15m→day', t:'บค.', e:'—', p:'R1' },
  { k:'agent.handling.detail', n:'hold · ACW · consult · โอนออก ต่อคน', m:'แกนกลาง', d:'agents · day', t:'บค.', e:'—', p:'R2' },
  { k:'channel.volume', n:'ปริมาณต่อช่องทาง (ดิจิทัลนับเป็น conversation)', m:'แกนกลาง', d:'conversations · day', t:'ปก.', e:'—', p:'R1' },
  { k:'channel.response', n:'เวลาตอบครั้งแรก / ครั้งถัดไป ของช่องทางดิจิทัล', m:'แกนกลาง', d:'conversations · day', t:'ปก.', e:'—', p:'R1' },
  { k:'channel.delivery', n:'ส่งสำเร็จ / ล้มเหลว / คืนโควตา ต่อ provider + template', m:'แกนกลาง', d:'messages · day', t:'กก.', e:'—', p:'R2' },
  { k:'channel.media.failure', n:'สื่อที่ล้มเหลวเพราะขนาดหรือชนิด (ADR-024)', m:'แกนกลาง', d:'messages · day', t:'ปก.', e:'—', p:'R3' },
  { k:'flow.funnel', n:'เข้า → จบใน self-service → ออกไปคิว ต่อเวอร์ชันผัง', m:'Flow', d:'flows · day', t:'ปก.', e:'flows', p:'R5 · FL2' },
  { k:'flow.node.dropoff', n:'node ที่ลูกค้าวางสายมากที่สุด', m:'Flow', d:'flows · day', t:'ปก.', e:'flows', p:'R5 · FL2' },
  { k:'flow.node.exit', n:'ทางออกของผัง (คิว / บอต / เคส / วางสาย)', m:'Flow', d:'flows · day', t:'ปก.', e:'flows', p:'R5 · FL2' },
  { k:'flow.error', n:'onError · timeout · integration ล้ม ต่อ node', m:'Flow', d:'flows · hour', t:'กก.', e:'flows', p:'R5 · FL1' },
  { k:'flow.duration', n:'เวลาที่ใช้ในผังก่อนเข้าคิว', m:'Flow', d:'flows · day', t:'ปก.', e:'flows', p:'R5 · FL2' },
  { k:'bot.containment', n:'containment / handoff / ละทิ้ง ต่อบอต × ช่องทาง', m:'Bot & KB', d:'bots · day', t:'ปก.', e:'bot.faqDeflection', p:'R5 · B2' },
  { k:'bot.handoff.reason', n:'สัดส่วนเหตุผลที่ส่งต่อคน', m:'Bot & KB', d:'bots · day', t:'ปก.', e:'bot.faqDeflection', p:'R5 · B2' },
  { k:'bot.fallback', n:'no-intent + confidence ต่ำกว่าเกณฑ์ ต่อ intent', m:'Bot & KB', d:'bots · day', t:'ปก.', e:'bot.faqDeflection', p:'R5 · B2' },
  { k:'bot.cost.session', n:'ต้นทุนต่อ session เทียบโควตา botSessionsPerMonth', m:'Bot & KB', d:'bots · day', t:'ปก.', e:'bot.ragAnswer', p:'R5 · B4' },
  { k:'bot.test.results', n:'ผลชุดทดสอบต่อเวอร์ชัน (หลักฐานของ publish gate)', m:'Bot & KB', d:'bots · ต่อการรัน', t:'กก.', e:'bot.faqDeflection', p:'R5 · B4' },
  { k:'kb.gaps', n:'คำถามที่ยังไม่มีคำตอบ + จำนวนครั้ง + ผู้รับผิดชอบ', m:'Bot & KB', d:'knowledge · day', t:'ปก.', e:'knowledge', p:'R5 · B3' },
  { k:'kb.usage', n:'บทความที่ถูกใช้ / ไม่เคยถูกใช้เลย', m:'Bot & KB', d:'knowledge · day', t:'ปก.', e:'knowledge', p:'R5 · B1' },
  { k:'kb.staleness', n:'บทความเลยรอบทบทวน แยกตามเจ้าของ', m:'Bot & KB', d:'knowledge · snapshot', t:'กก.', e:'knowledge', p:'R5 · B1' },
  { k:'kb.retrieval', n:'hit rate ของการค้น + คำค้นที่ไม่เจออะไรเลย', m:'Bot & KB', d:'knowledge · day', t:'ปก.', e:'knowledge', p:'R5 · B3' },
  { k:'assist.acceptance', n:'acceptance rate ต่อฟีเจอร์ — KPI ของโมดูล, ระดับทีมเท่านั้น', m:'Agent assist', d:'assist · day', t:'ปก.', e:'assist.autoSummary', p:'R5 · A1' },
  { k:'assist.latency', n:'latency p95 ต่อฟีเจอร์ + จำนวนที่เกิน budget', m:'Agent assist', d:'assist · hour', t:'ปก.', e:'assist.autoSummary', p:'R5 · A1' },
  { k:'assist.acw.delta', n:'ACW ก่อน/หลังเปิดใช้ (ต่อทีม)', m:'Agent assist', d:'assist · day', t:'ปก.', e:'assist.autoSummary', p:'R5 · A1' },
  { k:'assist.summary.edit', n:'สัดส่วนสรุปที่ถูกแก้ + ปริมาณที่แก้', m:'Agent assist', d:'assist · day', t:'ปก.', e:'assist.autoSummary', p:'R5 · A1' },
  { k:'assist.script.completion', n:'completion rate ต่อสคริปต์/เวอร์ชัน + conversion', m:'Agent assist', d:'assist · day', t:'ปก.', e:'assist.guidedScript', p:'R5 · A6' },
  { k:'assist.script.dropoff', n:'ขั้นที่เอเจนต์เลิกเดินกลางทาง + เวลาเฉลี่ยต่อขั้น', m:'Agent assist', d:'assist · day', t:'ปก.', e:'assist.guidedScript', p:'R5 · A6' },
  { k:'assist.script.required', n:'ขั้นบังคับที่ถูกข้าม + เหตุผลที่ใช้บ่อย', m:'Agent assist', d:'assist · day', t:'กก.', e:'assist.guidedScript', p:'R5 · A6' },
  { k:'qm.score', n:'คะแนนและแนวโน้ม — บังคับเลือก formVersion ก่อนแสดงผล', m:'QM', d:'quality · day', t:'บค.', e:'qm.evaluation', p:'R1 · Q2' },
  { k:'qm.coverage', n:'ตรวจไปกี่ % ของงาน ต่อ quality plan', m:'QM', d:'quality · day', t:'ปก.', e:'qm.evaluation', p:'R1 · Q2' },
  { k:'qm.autofail', n:'อัตรา auto-fail + raw_score ของสายที่ตก', m:'QM', d:'quality · day', t:'บค.', e:'qm.evaluation', p:'R2 · Q2' },
  { k:'qm.calibration', n:'ความต่างของคะแนนระหว่างผู้ตรวจในรอบเดียวกัน', m:'QM', d:'quality · ต่อรอบ', t:'บค.', e:'qm.evaluation', p:'R2 · Q2' },
  { k:'qm.appeal', n:'จำนวนและผลของการอุทธรณ์ + เวลาที่ใช้', m:'QM', d:'quality · day', t:'บค.', e:'qm.evaluation', p:'R2 · Q2' },
  { k:'qm.coaching.effect', n:'คะแนนก่อน/หลังโค้ช + การรับทราบของ agent', m:'QM', d:'quality · day', t:'บค.', e:'qm.evaluation', p:'R5 · Q5' },
  { k:'qm.ai.delta', n:'คะแนนที่ AI ร่าง เทียบกับที่คนตัดสินสุดท้าย', m:'QM', d:'quality · day', t:'บค.', e:'qm.autoQm', p:'R5 · Q5' },
  { k:'qm.media.metrics', n:'silence · talk ratio · monologue · crosstalk', m:'QM', d:'quality · day', t:'ปก.', e:'qm.transcription', p:'R2 · Q3' },
  { k:'qm.category.trend', n:'category hit + แนวโน้ม (ฐานของ compliance nudge)', m:'QM', d:'quality · day', t:'ปก.', e:'qm.analytics', p:'R2 · Q4' },
  { k:'qm.access.log', n:'ใครเปิดฟังเสียง / อ่าน transcript เมื่อไหร่ จาก IP ไหน', m:'QM', d:'audit · day', t:'กก.', e:'—', p:'R1 · Q1' },
  { k:'fb.score', n:'CSAT / NPS / CES / FCR รายวัน–รายเดือน', m:'Feedback', d:'feedback · day', t:'ปก.', e:'feedback.csat', p:'R1 · F1' },
  { k:'fb.response.rate', n:'response rate คู่กับ expired / bounced rate เสมอ', m:'Feedback', d:'feedback · day', t:'ปก.', e:'feedback.csat', p:'R1 · F2' },
  { k:'fb.distribution', n:'การกระจายคะแนน ไม่ใช่ค่าเฉลี่ย', m:'Feedback', d:'feedback · day', t:'ปก.', e:'feedback.csat', p:'R1 · F1' },
  { k:'fb.recovery', n:'detractor recovery rate + time to first contact', m:'Feedback', d:'feedback · day', t:'ปก.', e:'feedback.closedLoop', p:'R3 · F4' },
  { k:'fb.comments.grouped', n:'คอมเมนต์ปลายเปิดจัดกลุ่มด้วย category ของ QM', m:'Feedback', d:'feedback · day', t:'ปก.', e:'feedback.nps', p:'R5 · F3' },
  { k:'ia.topic.volume', n:'ปริมาณต่อหัวข้อ + แนวโน้ม + % โตเทียบสัปดาห์ก่อน', m:'Analytics', d:'topics · day', t:'ปก.', e:'analytics.categories', p:'R2 · N1' },
  { k:'ia.cost.driver', n:'topic × AHT × ปริมาณ = เวลารวมที่หมดไป (แปลงเป็นเงินได้)', m:'Analytics', d:'topics · day', t:'ปก.', e:'analytics.categories', p:'R2 · N1' },
  { k:'ia.repeat.topic', n:'repeat contact rate ต่อหัวข้อ (input ของบอต/KB)', m:'Analytics', d:'topics · day', t:'ปก.', e:'analytics.categories', p:'R2 · N1' },
  { k:'ia.anomaly', n:'หัวข้อที่โตเกิน 3σ ของ baseline 4 สัปดาห์', m:'Analytics', d:'topics · day', t:'ปก.', e:'analytics.topicDiscovery', p:'R5 · N4' },
  { k:'ia.correlation', n:'topic ↔ CSAT ↔ คะแนน QM ↔ AHT', m:'Analytics', d:'topics · week', t:'ปก.', e:'analytics.correlation', p:'R5 · N4' },
  { k:'pm.scorecard.agent', n:'คะแนนรวมต่อคน + รายการ metric ที่ประกอบ', m:'Performance', d:'performance · day', t:'บค.', e:'performance.scorecards', p:'R2 · P1' },
  { k:'pm.scorecard.team', n:'เทียบทีม/ไซต์ + การกระจายในทีม', m:'Performance', d:'performance · week', t:'ปก.', e:'performance.scorecards', p:'R2 · P1' },
  { k:'pm.goal.attainment', n:'เป้าที่ตั้งไว้ เทียบผลจริง', m:'Performance', d:'performance · month', t:'บค.', e:'performance.goals', p:'R3 · P2' },
  { k:'pm.distribution', n:'การกระจายคะแนน + จำนวนที่ต่ำกว่า minSample', m:'Performance', d:'performance · month', t:'ปก.', e:'performance.scorecards', p:'R3 · P1' },
  { k:'gm.challenge', n:'การเข้าร่วมและผลของ challenge', m:'Performance', d:'performance · ต่อ challenge', t:'ปก.', e:'performance.gamification', p:'R5 · P4' },
  { k:'wfm.forecast.accuracy', n:'forecast เทียบ actual (MAPE/WAPE) ต่อ interval', m:'WFM', d:'wfm_intervals · 15m→day', t:'ปก.', e:'wfm.forecast', p:'R5 · W3' },
  { k:'wfm.coverage', n:'requirement เทียบ scheduled เทียบ actual', m:'WFM', d:'wfm_intervals · 15m→day', t:'ปก.', e:'wfm.schedule', p:'R5 · W3' },
  { k:'wfm.adherence', n:'adherence รายคน รายวัน', m:'WFM', d:'wfm_intervals · day', t:'บค.', e:'wfm.adherence', p:'R5 · W2' },
  { k:'wfm.conformance', n:'ชั่วโมงที่ทำงานจริง เทียบชั่วโมงที่ถูกจัด', m:'WFM', d:'wfm_intervals · day', t:'บค.', e:'wfm.adherence', p:'R5 · W2' },
  { k:'wfm.shrinkage', n:'shrinkage แยกตามเหตุ (ลา · ประชุม · โค้ช · ป่วย)', m:'WFM', d:'wfm_intervals · week', t:'ปก.', e:'wfm.schedule', p:'R5 · W2' },
  { k:'wfm.occupancy.plan', n:'occupancy จริงเทียบที่วางแผนไว้', m:'WFM', d:'wfm_intervals · day', t:'ปก.', e:'wfm.forecast', p:'R5 · W3' },
  { k:'wfm.timeoff.impact', n:'คำขอลาที่อนุมัติแล้ว เทียบ coverage ที่หายไป', m:'WFM', d:'wfm_intervals · day', t:'ปก.', e:'wfm.timeOff', p:'R5 · W2' },
  { k:'wfm.solver.jobs', n:'ผลการรัน solver: สำเร็จ / time-box หมด / infeasible', m:'WFM', d:'audit · ต่อ job', t:'กก.', e:'wfm.autoSchedule', p:'R5 · W4' },
  { k:'cs.backlog', n:'เคสค้างรายวัน — ใบบังคับมี (case §9)', m:'Cases', d:'cases · day', t:'ปก.', e:'cases', p:'R2 · C1' },
  { k:'cs.aging', n:'ช่วงอายุของเคสที่ยังไม่ปิด', m:'Cases', d:'cases · snapshot', t:'ปก.', e:'cases', p:'R2 · C1' },
  { k:'cs.sla', n:'SLA แยก first response / resolution + เวลาที่หยุดนาฬิกา', m:'Cases', d:'cases · day', t:'ปก.', e:'cases.slaPolicies', p:'R3 · C3' },
  { k:'cs.reopen', n:'reopen rate ต่อประเภทเคสและต่อสาเหตุ', m:'Cases', d:'cases · week', t:'ปก.', e:'cases', p:'R3 · C4' },
  { k:'cs.load', n:'ปริมาณเคสที่ถืออยู่ ต่อคน / ต่อทีม', m:'Cases', d:'cases · day', t:'บค.', e:'cases', p:'R3 · C1' },
  { k:'cs.task.completion', n:'งานย่อยที่เสร็จ / เลยกำหนด', m:'Cases', d:'cases · day', t:'ปก.', e:'cases', p:'R3 · C1' },
  { k:'cs.source.mix', n:'ที่มาของเคส (agent · อีเมล · API · detractor · flow)', m:'Cases', d:'cases · day', t:'ปก.', e:'cases', p:'R3 · C4' },
  { k:'ob.campaign', n:'attempts · contact rate · RPC · conversion ต่อแคมเปญ', m:'Outbound', d:'campaigns · day', t:'ปก.', e:'outbound.preview', p:'R2 · O1' },
  { k:'ob.abandon', n:'abandon rate ตามนิยามที่ใช้ตอบผู้กำกับ', m:'Outbound', d:'campaigns · day', t:'กก.', e:'outbound.predictive', p:'R2 · O3' },
  { k:'ob.screening', n:'ผลคัดกรองทุกเบอร์: DNC · consent · หน้าต่างเวลา (ต้องพิสูจน์ว่าเป็น 0)', m:'Outbound', d:'campaigns · day', t:'กก.', e:'outbound.preview', p:'R2 · O1' },
  { k:'ob.amd.falsepositive', n:'AMD ที่ตัดสายใส่คนจริง — รายสัปดาห์ บังคับมี (outbound §11)', m:'Outbound', d:'campaigns · week', t:'กก.', e:'outbound.predictive', p:'R2 · O3' },
  { k:'ob.retry', n:'ผลของการโทรซ้ำครั้งที่ N', m:'Outbound', d:'campaigns · day', t:'ปก.', e:'outbound.progressive', p:'R3 · O2' },
  { k:'ob.list.quality', n:'penetration ของ list + ที่ถูกตัดออกเพราะอะไร', m:'Outbound', d:'campaigns · ต่อ list', t:'ปก.', e:'outbound.preview', p:'R3 · O1' },
  { k:'ob.disposition.mix', n:'สัดส่วนผลการโทรตาม disposition', m:'Outbound', d:'campaigns · day', t:'ปก.', e:'outbound.progressive', p:'R3 · O2' },
  { k:'ob.callback.kept', n:'โทรกลับตรงเวลานัดกี่ %', m:'Outbound', d:'campaigns · day', t:'ปก.', e:'outbound.preview', p:'R3 · O4' },
  { k:'ob.cost.conversion', n:'ต้นทุนต่อ conversion (นาที + ข้อความ + เวลาเอเจนต์)', m:'Outbound', d:'campaigns · month', t:'ปก.', e:'outbound.preview', p:'R3 · O2' },
  { k:'jr.goal.conversion', n:'goal conversion ต่อ journey และต่อเวอร์ชัน', m:'Journey', d:'journeys · day', t:'ปก.', e:'journey.enabled', p:'R5 · J1' },
  { k:'jr.deflected', n:'สายที่ไม่เกิด — เทียบกลุ่ม holdout เท่านั้น', m:'Journey', d:'journeys · week', t:'ปก.', e:'journey.holdout', p:'R5 · J4' },
  { k:'jr.suppression', n:'suppression แยกกฎ Journey กับผลจาก Contact Governance', m:'Journey', d:'journeys · day', t:'ปก.', e:'journey.enabled', p:'R5 · J1' },
  { k:'jr.optout', n:'opt-out rate ต่อ journey และต่อช่องทาง', m:'Journey', d:'journeys · day', t:'กก.', e:'journey.enabled', p:'R5 · J1' },
  { k:'jr.time.to.goal', n:'เวลาจากเข้า journey ถึงบรรลุเป้า', m:'Journey', d:'journeys · week', t:'ปก.', e:'journey.enabled', p:'R5 · J1' },
  { k:'cg.frequency', n:'CIF ที่ชนเพดาน Attempt/Touch + โควตาที่เต็มต่อช่องทาง', m:'Contact Governance', d:'contact-governance · day', t:'กก.', e:'contactGovernance.frequency', p:'R3 · CG2' },
  { k:'cg.reservation', n:'RESERVED ที่หมดอายุ · RELEASED · REFUNDED (จับ worker ตาย)', m:'Contact Governance', d:'contact-governance · day', t:'กก.', e:'contactGovernance.frequency', p:'R3 · CG2' },
  { k:'c360.identity.coverage', n:'สัดส่วนงานที่ผูกกับลูกค้าได้ + identity ต่อคน', m:'Customer 360', d:'contacts · day', t:'ปก.', e:'customer360.identityResolution', p:'R3 · U1' },
  { k:'c360.merge.queue', n:'คิว LIKELY ที่รอยืนยัน + อายุคิว', m:'Customer 360', d:'contacts · snapshot', t:'ปก.', e:'customer360.identityResolution', p:'R3 · U3' },
  { k:'c360.merge.history', n:'การรวม / ย้อนการรวม + ใครทำ', m:'Customer 360', d:'contacts · day', t:'กก.', e:'customer360.identityResolution', p:'R3 · U3' },
  { k:'cg.consent', n:'ความครอบคลุมของ consent, preference และ restriction ต่อช่องทาง', m:'Contact Governance', d:'contact-governance · snapshot', t:'กก.', e:'contactGovernance.consent', p:'R3 · CG1' },
  { k:'c360.pdpa', n:'คำขอเข้าถึง/ลบ/ถอนความยินยอม + SLA + ผลลัพธ์', m:'Customer 360', d:'audit · ต่อคำขอ', t:'กก.', e:'customer360.dsar', p:'R5 · U5' },
  { k:'ic.consult.rate', n:'consult ต่อ 100 งาน แยกทีม/คิว', m:'Collaboration', d:'collaboration · day', t:'ปก.', e:'collab.consult', p:'R5 · CL2' },
  { k:'ic.expert.response', n:'เวลาตอบครั้งแรกของผู้เชี่ยวชาญ + ที่ไม่มีใครตอบ', m:'Collaboration', d:'collaboration · day', t:'ปก.', e:'collab.expertRouting', p:'R5 · CL2' },
  { k:'ic.consult.outcome', n:'สัดส่วนที่จบเป็น ANSWERED / TRANSFERRED / ESCALATED', m:'Collaboration', d:'collaboration · day', t:'ปก.', e:'collab.consult', p:'R5 · CL2' },
  { k:'ic.topics', n:'หัวข้อที่ถามซ้ำ (ป้อน kb_gap)', m:'Collaboration', d:'collaboration · week', t:'ปก.', e:'collab.consult', p:'R5 · CL2' },
  { k:'ic.expert.load', n:'ภาระต่อกลุ่มผู้เชี่ยวชาญและต่อคน', m:'Collaboration', d:'collaboration · day', t:'บค.', e:'collab.expertRouting', p:'R5 · CL2' },
  { k:'ic.access.log', n:'การค้น / export / legal hold ของห้องสนทนา', m:'Collaboration', d:'audit · day', t:'กก.', e:'collab.compliance', p:'R5 · CL4' },
  { k:'int.api.usage', n:'เรียก API ต่อ client + ที่ถูกปฏิเสธเพราะ rate limit', m:'Integration', d:'integrations · hour', t:'ปก.', e:'api.publicApi', p:'R3 · I1' },
  { k:'int.webhook.delivery', n:'สำเร็จ / retry / เข้า DLQ ต่อ endpoint', m:'Integration', d:'integrations · hour', t:'ปก.', e:'api.webhooks', p:'R3 · I2' },
  { k:'int.connector.health', n:'ความล้มเหลวของ connector + field mapping ที่พัง', m:'Integration', d:'integrations · day', t:'ปก.', e:'connectors.*', p:'R3 · I3' },
  { k:'int.cti.latency', n:'เวลาเปิด screen pop ของ CTI', m:'Integration', d:'integrations · day', t:'ปก.', e:'api.cti', p:'R5 · I3' },
  { k:'int.export.audit', n:'การส่งออกทุกครั้ง: ใคร ใบไหน ปลายทางไหน กี่แถว', m:'Integration', d:'audit · ต่อครั้ง', t:'กก.', e:'—', p:'R2' },
  { k:'lic.usage', n:'นาที · ข้อความ · พื้นที่ · session เทียบโควตา (licensing)', m:'Licensing', d:'usage · day', t:'ปก.', e:'—', p:'R1' },
  { k:'lic.seat', n:'seat ที่เปิดจริงเทียบที่ซื้อ ต่อโมดูล', m:'Licensing', d:'usage · snapshot', t:'ปก.', e:'—', p:'R1' },
  { k:'lic.entitlement.denied', n:'จำนวน ENTITLEMENT_REQUIRED ต่อฟีเจอร์ (สัญญาณขาย)', m:'Licensing', d:'usage · day', t:'ปก.', e:'—', p:'R3' },
  { k:'lic.override.expiring', n:'override ที่ใกล้หมดอายุ + เหตุผล + ใครอนุมัติ', m:'Licensing', d:'audit · snapshot', t:'กก.', e:'—', p:'R3' },
  { k:'lic.state', n:'สถานะ license: ACTIVE / EXPIRING / GRACE + last_seen_at', m:'Licensing', d:'usage · day', t:'กก.', e:'—', p:'R3' },
  { k:'iam.login.failures', n:'ล็อกอินล้มเหลว + ล็อกบัญชี + แหล่งที่มา', m:'IAM & Audit', d:'audit · hour', t:'กก.', e:'—', p:'R2' },
  { k:'iam.role.changes', n:'การเปลี่ยน role และสิทธิ์ ใครเปลี่ยนให้ใคร', m:'IAM & Audit', d:'audit · ต่อครั้ง', t:'กก.', e:'—', p:'R2' },
  { k:'iam.permission.denied', n:'การเข้าถึงที่ถูกปฏิเสธ (รวม RLS)', m:'IAM & Audit', d:'audit · day', t:'กก.', e:'—', p:'R3' },
  { k:'adm.retention.jobs', n:'งาน retention / ลบข้อมูลที่รันไปแล้ว + ที่ถูก legal hold ระงับ', m:'IAM & Audit', d:'audit · ต่อ job', t:'กก.', e:'—', p:'R2' },
  { k:'op.tenant.health', n:'ปริมาณ · ความผิดพลาด · lag ของ consumer ต่อ tenant', m:'Operator', d:'usage · day', t:'กก.', e:'—', p:'R3' },
  { k:'op.usage.bytenant', n:'การใช้งานเทียบโควตาและแพ็กเกจ ต่อ tenant', m:'Operator', d:'usage · day', t:'กก.', e:'—', p:'R3' },
  { k:'op.plan.mix', n:'การกระจายแพ็กเกจ + override ที่เปิดค้าง', m:'Operator', d:'usage · month', t:'กก.', e:'—', p:'R3' },
];

/* ใบที่ผู้ใช้สร้างเอง — key = custom.{id} ตาม §7.1 ข้อ 1 */
var RPT_CUSTOM = [
  { k: 'custom.a41', n: 'AHT ต่อหัวข้อ × คิว', m: 'Analytics', owner: 'สมพร (หัวหน้า)', shared: 'ทีม Support', updated: '05-08-2026' },
  { k: 'custom.b07', n: 'ต้นทุนต่อ conversion ของแคมเปญ', m: 'Outbound', owner: 'ฝ่ายขาย', shared: 'ส่วนตัว', updated: '02-08-2026' },
  { k: 'custom.c12', n: 'reopen ของเคสรายประเภท', m: 'Cases', owner: 'QM', shared: 'ทีม QM', updated: '31-07-2026' },
];

/* entitlement ที่ tenant สาธิตนี้ "ไม่มี" — ใบที่ต้องใช้จะถูกซ่อน ไม่ใช่ขึ้น error (§7.1 ข้อ 7) */
var RPT_NO_ENT = ['qm.autoQm', 'analytics.topicDiscovery', 'analytics.correlation',
  'journey.holdout', 'journey.segments', 'api.cti', 'customer360.dsar', 'collab.compliance',
  'performance.gamification', 'feedback.nps'];
var RPT_TIER = {
  'ปก.': ['tag', 'ปฏิบัติการ'], 'บค.': ['tag-warn', 'บุคคล'], 'กก.': ['tag-bad', 'กำกับ'],
};
var rptMod = 'ทั้งหมด';
function rptRows() {
  var canned = RPT_CATALOG.filter(function (r) {
    return r.m !== 'Operator' && RPT_NO_ENT.indexOf(r.e) < 0;
  }).map(function (r) {
    return { k: r.k, n: r.n, m: r.m, t: r.t, kind: 'CANNED', owner: 'ระบบ', shared: 'ตามสิทธิ์', updated: '—', p: r.p };
  });
  var custom = RPT_CUSTOM.map(function (r) {
    return { k: r.k, n: r.n, m: r.m, t: 'ปก.', kind: 'CUSTOM', owner: r.owner, shared: r.shared, updated: r.updated, p: '—' };
  });
  var all = canned.concat(custom);
  return rptMod === 'ทั้งหมด' ? all : all.filter(function (r) { return r.m === rptMod; });
}
function renderRptFilter() {
  var b = document.getElementById('rpt-lib-filter'); if (!b) return;
  var mods = ['ทั้งหมด'];
  RPT_CATALOG.forEach(function (r) { if (r.m !== 'Operator' && mods.indexOf(r.m) < 0) mods.push(r.m); });
  b.innerHTML = mods.map(function (m) {
    return '<button class="fchip' + (rptMod === m ? ' on' : '') + '" onclick="rptMod=\'' + m + '\';renderRptFilter();renderRptLib()">' + m + '</button>';
  }).join('');
}
function renderRptLib() {
  var b = document.getElementById('rpt-lib-body'); if (!b) return;
  var rows = rptRows();
  b.innerHTML = rows.map(function (r) {
    var t = RPT_TIER[r.t];
    return '<tr class="border-b border-slate-100 rowlink" onclick="showView(\'rpt-builder\')">' +
      '<td class="px-3 py-2.5"><div class="font-medium text-slate-800">' + r.n + '</div>' +
      '<div class="text-xs text-slate-400 font-mono">' + r.k + '</div></td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + r.m + '</td>' +
      '<td class="px-3 py-2.5">' + tag(t[0], t[1]) + '</td>' +
      '<td class="px-3 py-2.5">' + (r.kind === 'CANNED' ? tag('tag', 'สำเร็จรูป') : tag('tag-info', 'สร้างเอง')) + '</td>' +
      '<td class="px-3 py-2.5"><div class="text-slate-600">' + r.owner + '</div>' +
      '<div class="text-xs text-slate-400">' + r.shared + '</div></td>' +
      '<td class="px-3 py-2.5 text-slate-500">' + r.p + '</td>' +
      '<td class="px-3 py-2.5 text-right"><span class="icon-btn" onclick="event.stopPropagation();toast(\'ส่งออก XLSX (mock)\')"><i class="ti ti-download"></i></span></td></tr>';
  }).join('');
  var c = document.getElementById('rpt-lib-count');
  if (c) c.textContent = rows.length + ' ใบ' + (rptMod === 'ทั้งหมด' ? ' · ซ่อน ' + (RPT_CATALOG.filter(function (r) { return r.m !== 'Operator' && RPT_NO_ENT.indexOf(r.e) >= 0; }).length) + ' ใบที่แพ็กเกจนี้ไม่มีสิทธิ์' : '');
}

var RPT_SCHED = [
  { report: 'SLA รายคิว', cron: 'ทุกวันจันทร์ 08:00', fmt: 'PDF', dest: 'อีเมล 4 คน', owner: 'สมพร', exp: 45, last: 'สำเร็จ' },
  { report: 'AHT ต่อหัวข้อ × คิว', cron: 'ทุกวัน 07:00', fmt: 'XLSX', dest: 'SFTP acme-bi', owner: 'ฝ่าย BI', exp: 12, last: 'สำเร็จ' },
  { report: 'ปริมาณตามช่องทาง', cron: 'วันที่ 1 ของเดือน', fmt: 'PDF', dest: 'อีเมล 9 คน', owner: 'krit@acme.co.th', exp: -5, last: 'ล้มเหลว — อีเมลตีกลับ 2 ราย' },
];
function renderRptSched() {
  var b = document.getElementById('rpt-sched-body'); if (!b) return;
  b.innerHTML = RPT_SCHED.map(function (s, i) {
    var exp = s.exp < 0 ? '<span class="due-late">หมดอายุแล้ว ' + Math.abs(s.exp) + ' วัน</span>'
      : (s.exp < 30 ? '<span class="due-warn">อีก ' + s.exp + ' วัน</span>' : '<span class="text-slate-500">อีก ' + s.exp + ' วัน</span>');
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + s.report + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.cron + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.fmt + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.dest + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + s.owner + '</td>' +
      '<td class="px-4 py-3">' + exp + '</td>' +
      '<td class="px-4 py-3 ' + (/ล้มเหลว/.test(s.last) ? 'text-rose-600' : 'text-slate-600') + '">' + s.last + '</td>' +
      editCell('editSched', i) + '</tr>';
  }).join('');
}
function newSched() {
  openForm('rpt-sched-form', 'rsf-heading', 'ตั้งการส่งอัตโนมัติ', 'New schedule',
    { 'rsf-report': 'SLA รายคิว', 'rsf-cron': 'ทุกวันจันทร์ 08:00', 'rsf-fmt': 'PDF', 'rsf-dest': '', 'rsf-exp': '180' });
}
function editSched(i) {
  var s = RPT_SCHED[i];
  openForm('rpt-sched-form', 'rsf-heading', 'แก้ไขการส่ง: ' + s.report, 'Edit schedule',
    { 'rsf-report': s.report, 'rsf-cron': s.cron, 'rsf-fmt': s.fmt, 'rsf-dest': s.dest, 'rsf-exp': '180' });
}

/* ============================================================
   FLOW TRACE — docs/flow-engine.md §5.6 (history.html)
   ============================================================ */
var FT_CAT = {
  trigger: '#16a34a', play: '#2563eb', collect: '#2563eb', condition: '#d97706', setvar: '#d97706',
  expression: '#d97706', subflow: '#d97706', api: '#7c3aed', bot: '#7c3aed', case: '#4f46e5',
  survey: '#4f46e5', queue: '#0f766e', agent: '#0f766e', caseOwner: '#0f766e',
  voicemail: '#e11d48', callback: '#e11d48', transfer: '#475569', end: '#475569',
};
// สายตัวอย่าง: ลูกค้ากด 2 (Sales) แต่ CRM timeout → เดินเส้น error → เข้าคิว General แทน
var FLOW_TRACE = {
  interactionId: 'INT-88077', flow: 'Voice — Main menu', version: 3, channel: 'voice',
  contact: '+66 81 234 5678', at: '08-08-2026 09:41:12', outcome: 'HANDED_OFF', totalMs: 8498,
  steps: [
    { seq: 1, node: 'n_trigger', type: 'trigger', at: 0, took: 2, detail: 'DID +66 2 123 4500 · ANI +66 81 234 5678' },
    { seq: 2, node: 'n_hours', type: 'condition', at: 2, took: 1, branch: 'open', detail: 'ปฏิทิน Bangkok office · เวลา 09:41 อยู่ในเวลาทำการ' },
    { seq: 3, node: 'n_welcome', type: 'play', at: 3, took: 4100, detail: 'TTS: "สวัสดีค่ะ ขอบคุณที่ติดต่อ ACME"' },
    { seq: 4, node: 'n_menu', type: 'collect', at: 4103, took: 3980, branch: '2', detail: 'DTMF · ลูกค้ากด 2 (Sales)' },
    { seq: 5, node: 'n_crm', type: 'api', at: 8083, took: 412, branch: 'error', error: 'timeout หลัง 400 ms', detail: 'connector: Order API (production)' },
    { seq: 6, node: 'n_q_general', type: 'queue', at: 8495, took: 3, detail: 'เข้าคิว General Support (ปลายทางของเส้น error) · priority 1' },
  ],
  vars: [
    { k: 'lang', v: 'th' }, { k: 'isVip', v: 'false' },
    { k: 'menuChoice', v: '2' }, { k: 'crmId', v: '***', masked: true },
  ],
};
function renderFlowTrace() {
  var b = document.getElementById('ft-steps'); if (!b) return;
  var t = FLOW_TRACE;
  b.innerHTML = t.steps.map(function (s, i) {
    var color = FT_CAT[s.type] || '#64748b';
    var slow = s.took > 3000, bad = !!s.error;
    return '<div class="flex gap-3">' +
      '<div class="flex flex-col items-center">' +
        '<span class="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold" style="background:' + color + '">' + s.seq + '</span>' +
        (i < t.steps.length - 1 ? '<span class="w-px flex-1 bg-slate-200 my-1"></span>' : '') +
      '</div>' +
      '<div class="flex-1 pb-4">' +
        '<div class="flex flex-wrap items-center gap-2">' +
          '<b class="text-sm">' + s.node + '</b>' +
          '<span class="tag" style="background:' + color + '18;color:' + color + '">' + s.type + '</span>' +
          (s.branch ? '<span class="tag ' + (bad ? 'tag-bad' : 'tag-info') + '">เส้น: ' + s.branch + '</span>' : '') +
          '<span class="text-xs ' + (slow ? 'text-amber-600 font-semibold' : 'text-slate-400') + '">+' + s.at + ' ms · ใช้ ' + s.took + ' ms</span>' +
        '</div>' +
        '<p class="text-sm text-slate-600 mt-0.5">' + s.detail + '</p>' +
        (s.error ? '<p class="text-sm text-rose-600 mt-1"><i class="ti ti-alert-triangle mr-1"></i>' + s.error + '</p>' : '') +
      '</div></div>';
  }).join('');
  var v = document.getElementById('ft-vars');
  if (v) v.innerHTML = FLOW_TRACE.vars.map(function (x) {
    return '<div class="flex justify-between text-sm border-b border-slate-50 py-1.5">' +
      '<span class="text-slate-500">' + x.k + '</span>' +
      '<span class="font-medium ' + (x.masked ? 'text-slate-400' : 'text-slate-800') + '">' + x.v +
      (x.masked ? ' <span class="tag ml-1">mask</span>' : '') + '</span></div>';
  }).join('');
}

/* ============================================================
   INTERNAL COLLABORATION — admin.html (กลุ่มผู้เชี่ยวชาญ) · ADR-022
   ============================================================ */
var EXPERT_GROUPS = [
  { name: 'สินเชื่อ', skills: 'credit, promotion', members: 4, online: 3, sla: 60, p50: 38, open: 2, transferPct: 12 },
  { name: 'เทคนิค (อุปกรณ์)', skills: 'technical, device', members: 6, online: 2, sla: 90, p50: 74, open: 5, transferPct: 31 },
  { name: 'กฎหมาย/ข้อร้องเรียน', skills: 'legal', members: 2, online: 1, sla: 300, p50: 210, open: 0, transferPct: 8 },
  { name: 'บัญชี/ใบกำกับภาษี', skills: 'billing, tax', members: 3, online: 3, sla: 120, p50: 55, open: 1, transferPct: 6 },
];
function renderExpertGroups() {
  var b = document.getElementById('eg-body'); if (!b) return;
  b.innerHTML = EXPERT_GROUPS.map(function (g, i) {
    var late = g.p50 > g.sla;
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + g.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + g.skills + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + g.online + ' / ' + g.members + ' ออนไลน์</td>' +
      '<td class="px-4 py-3 text-slate-600">' + g.sla + ' วิ</td>' +
      '<td class="px-4 py-3 ' + (late ? 'text-rose-600 font-semibold' : 'text-emerald-700 font-medium') + '">' + g.p50 + ' วิ</td>' +
      '<td class="px-4 py-3 text-slate-600">' + g.open + '</td>' +
      '<td class="px-4 py-3 ' + (g.transferPct > 25 ? 'text-amber-600 font-semibold' : 'text-slate-600') + '">' + g.transferPct + '%</td>' +
      editCell('editExpertGroup', i) + '</tr>';
  }).join('');
}
function newExpertGroup() {
  openForm('expert-group-form', 'egf-heading', 'สร้างกลุ่มผู้เชี่ยวชาญ', 'New expert group',
    { 'egf-name': '', 'egf-skills': '', 'egf-sla': '60', 'egf-max': '2', 'egf-fallback': 'หัวหน้าทีมของผู้ถาม' });
}
function editExpertGroup(i) {
  var g = EXPERT_GROUPS[i];
  openForm('expert-group-form', 'egf-heading', 'แก้ไข: ' + g.name, 'Edit: ' + g.name,
    { 'egf-name': g.name, 'egf-skills': g.skills, 'egf-sla': g.sla, 'egf-max': '2', 'egf-fallback': 'หัวหน้าทีมของผู้ถาม' });
}

/* ============================================================
   CONTACT GOVERNANCE — docs/contact-governance.md · ADR-027
   ด่านกลางระดับ CIF: ALLOW / BLOCK / DEFER / REVIEW + reservation
   ============================================================ */
var CG_RECENT = [
  { at:'10:42:18', cif:'CIF-TH-0049281', name:'คุณนภา จันทร์เพ็ญ', ch:'voice', purpose:'COLLECTION', source:'Campaign', decision:'BLOCK', reason:'PURPOSE_OBJECTED' },
  { at:'10:41:55', cif:'CIF-TH-0081022', name:'David Kim', ch:'line', purpose:'SERVICE', source:'Journey', decision:'ALLOW', reason:'POLICY_PASSED' },
  { at:'10:41:31', cif:'CIF-TH-0011884', name:'คุณวิชัย ต.', ch:'sms', purpose:'MARKETING', source:'Broadcast', decision:'DEFER', reason:'DAILY_TOUCH_CAP' },
  { at:'10:40:09', cif:'CIF-TH-0077240', name:'คุณเมษา ส.', ch:'email', purpose:'SURVEY', source:'Survey', decision:'REVIEW', reason:'IDENTITY_AMBIGUOUS' },
  { at:'10:39:44', cif:'CIF-TH-0093155', name:'Nina S.', ch:'voice', purpose:'CALLBACK', source:'Agent', decision:'ALLOW', reason:'CUSTOMER_REQUESTED_CALLBACK' },
  { at:'10:38:27', cif:'CIF-TH-0064551', name:'Bright Edu Group', ch:'whatsapp', purpose:'SERVICE', source:'Journey', decision:'DEFER', reason:'QUIET_HOURS' },
];
var CG_DECISION_STYLE = {
  ALLOW:['tag-ok','ALLOW'], BLOCK:['tag-bad','BLOCK'], DEFER:['tag-warn','DEFER'], REVIEW:['tag-info','REVIEW']
};
function cgChannelBadge(ch) {
  if (ch === 'sms') return '<span class="tag tag-info"><i class="ti ti-message"></i>SMS</span>';
  if (ch === 'email') return '<span class="tag"><i class="ti ti-mail"></i>Email</span>';
  return chBadge(ch);
}
function renderCgRecent() {
  var b = document.getElementById('cg-recent-body'); if (!b) return;
  b.innerHTML = CG_RECENT.map(function (d) {
    var s = CG_DECISION_STYLE[d.decision];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onclick="showView(\'decisions\')">' +
      '<td class="px-4 py-3 text-slate-500 tabular-nums">' + d.at + '</td>' +
      '<td class="px-4 py-3"><p class="font-medium">' + d.name + '</p><p class="text-xs text-slate-400">' + d.cif + '</p></td>' +
      '<td class="px-4 py-3">' + cgChannelBadge(d.ch) + '</td>' +
      '<td class="px-4 py-3 text-xs font-mono">' + d.purpose + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + d.source + '</td>' +
      '<td class="px-4 py-3">' + tag(s[0], s[1]) + '</td>' +
      '<td class="px-4 py-3 text-xs font-mono text-slate-500">' + d.reason + '</td></tr>';
  }).join('');
}
function renderCgDecisions() {
  var b = document.getElementById('cg-decisions-body'); if (!b) return;
  b.innerHTML = CG_RECENT.map(function (d, i) {
    var s = CG_DECISION_STYLE[d.decision];
    return '<tr class="border-b border-slate-100 hover:bg-slate-50"><td class="px-4 py-3 text-slate-500 tabular-nums">' + d.at + '</td><td class="px-4 py-3"><p class="font-medium">' + d.name + '</p><p class="text-xs text-slate-400">' + d.cif + '</p></td><td class="px-4 py-3">' + cgChannelBadge(d.ch) + '</td><td class="px-4 py-3 text-xs font-mono">' + d.purpose + '</td><td class="px-4 py-3">' + tag(s[0],s[1]) + '</td><td class="px-4 py-3 text-xs font-mono text-slate-500">' + d.reason + '</td><td class="px-4 py-3 text-right"><button class="qbtn !py-1 !px-2" onclick="cgViewDecision(' + i + ')"><i class="ti ti-eye"></i>ดู</button></td></tr>';
  }).join('');
}
function cgViewDecision(i) { var d = CG_RECENT[i]; if (!d) return; cgShowRecord('decisions', d.cif + ' · ' + d.decision, 'Append-only decision log', [['ลูกค้า',d.name],['ช่องทาง',cgChannelBadge(d.ch)],['Purpose',d.purpose],['Source',d.source],['ผล',tag(CG_DECISION_STYLE[d.decision][0],d.decision)],['Reason code','<code>' + d.reason + '</code>'],['เวลา',d.at]], 'Decision log ใช้ตรวจสอบย้อนหลังเท่านั้น จึงไม่สามารถสร้าง แก้ไข หรือลบจากหน้านี้'); }

var CG_RESTRICTIONS = [
  { target:'คุณนภา จันทร์เพ็ญ', ref:'CIF-TH-0049281', type:'OBJECTION', scope:'Voice · Collection', reason:'ลูกค้าคัดค้านระหว่างสนทนา', source:'Agent · interaction-88921', until:'ถาวร', status:'ACTIVE', hard:true, enforcement:'ENFORCE' },
  { target:'David Kim', ref:'+66 89 555 1200', type:'DNC', scope:'Identity · Voice', reason:'ขอไม่ให้โทรเบอร์นี้', source:'Preference center', until:'ถาวร', status:'ACTIVE', hard:true, enforcement:'ENFORCE' },
  { target:'คุณวิชัย ต.', ref:'CIF-TH-0011884', type:'CONSENT_REVOKED', scope:'SMS · Marketing', reason:'SMS opt-out', source:'Provider callback', until:'ถาวร', status:'ACTIVE', hard:true, enforcement:'ENFORCE' },
  { target:'Guest #8890', ref:'+66 84 242 9351', type:'REGULATORY', scope:'Platform · ทุก purpose', reason:'รายการกำกับระดับแพลตฟอร์ม', source:'Platform sync', until:'31-12-2027', status:'ACTIVE', hard:true, enforcement:'ENFORCE' },
  { target:'คุณเมษา ส.', ref:'CIF-TH-0077240', type:'INBOUND_SAFETY', scope:'Inbound Voice', reason:'คำพูดคุกคาม — route คิวพิเศษ', source:'Supervisor', until:'30-09-2026', status:'ACTIVE', hard:false, enforcement:'MONITOR' },
  { target:'คุณกิตติ ร.', ref:'CIF-TH-0060911', type:'DNC', scope:'ทุกช่องทาง', reason:'รอยืนยัน identity ที่ซ้ำ', source:'Import review', until:'—', status:'REVIEW', hard:true, enforcement:'ENFORCE' },
];
function cgEnforcementBadge(mode, locked) { var m = { ENFORCE:['tag-bad','ENFORCE'], MONITOR:['tag-warn','MONITOR'], DISABLED:['tag','DISABLED'] }; var state = m[mode] || m.ENFORCE; return tag(state[0], state[1] + (locked ? ' <i class="ti ti-lock text-xs"></i>' : '')); }
function cgIsHardRestriction(type) { return ['DNC','OBJECTION','CONSENT_REVOKED','REGULATORY'].indexOf(type) !== -1; }
function cgRestrictionTypeChanged() { var type = document.getElementById('cgr-type').value; var mode = document.getElementById('cgr-enforcement'); var note = document.getElementById('cgr-enforcement-note'); var hard = cgIsHardRestriction(type); mode.disabled = hard; if (hard) mode.value = 'ENFORCE'; note.textContent = hard ? 'Hard Block ถูกล็อกเป็น ENFORCE และไม่สามารถปิดได้' : 'Operational rule ปรับเป็น ENFORCE, MONITOR หรือ DISABLED ได้'; }
function cgSetRestrictionEnforcement(i, mode) { var r = CG_RESTRICTIONS[i]; if (!r || r.hard) { toast('Hard Block ปิดหรือปรับโหมดไม่ได้ (mock)'); return; } r.enforcement = mode; renderCgRestrictions(); toast('เปลี่ยน Enforcement เป็น ' + mode + ' และบันทึก audit แล้ว (mock)'); }
function renderCgRestrictions() {
  var b = document.getElementById('cg-restrictions-body'); if (!b) return;
  b.innerHTML = CG_RESTRICTIONS.map(function (r, i) {
    var st = r.status === 'ACTIVE' ? ['tag-bad','Active'] : ['tag-info','Review'];
    var mode = r.enforcement || 'ENFORCE';
    var enforcement = r.hard ? cgEnforcementBadge(mode, true) : '<select class="inp !h-8 !py-0 text-xs" onchange="cgSetRestrictionEnforcement(' + i + ',this.value)"><option value="ENFORCE"' + (mode === 'ENFORCE' ? ' selected' : '') + '>ENFORCE</option><option value="MONITOR"' + (mode === 'MONITOR' ? ' selected' : '') + '>MONITOR</option><option value="DISABLED"' + (mode === 'DISABLED' ? ' selected' : '') + '>DISABLED</option></select>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><p class="font-medium">' + r.target + '</p><p class="text-xs text-slate-400 font-mono">' + r.ref + '</p></td>' +
      '<td class="px-4 py-3">' + tag(r.type === 'INBOUND_SAFETY' ? 'tag-warn' : 'tag-bad', r.type) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.scope + '</td>' +
      '<td class="px-4 py-3 text-slate-600 max-w-xs whitespace-normal">' + r.reason + '</td>' +
      '<td class="px-4 py-3 text-xs text-slate-500">' + r.source + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + r.until + '</td>' +
      '<td class="px-4 py-3">' + tag(st[0], st[1]) + '</td><td class="px-4 py-3">' + enforcement + '</td>' +
      '<td class="px-4 py-3 text-right whitespace-nowrap"><button class="qbtn !py-1 !px-2" onclick="cgViewRestriction(' + i + ')"><i class="ti ti-eye"></i>ดู</button><button class="icon-btn" onclick="toast(\'เปิดหลักฐานของข้อห้าม (mock)\')"><i class="ti ti-file-search"></i></button>' +
      '<button class="icon-btn" onclick="cgRequestUnblock(' + i + ')" title="ขอปลดข้อห้าม"><i class="ti ti-lock-open"></i></button></td></tr>';
  }).join('');
}
function cgNewRestriction() { showView('restriction-form'); cgRestrictionTypeChanged(); }
function cgSaveRestriction() {
  var contact = document.getElementById('cgr-contact').value.trim() || 'CIF-TH-NEW · ลูกค้าใหม่'; var parts = contact.split(' · '); var type = document.getElementById('cgr-type').value; var hard = cgIsHardRestriction(type); var mode = hard ? 'ENFORCE' : document.getElementById('cgr-enforcement').value;
  CG_RESTRICTIONS.unshift({ target:parts[1] || contact, ref:parts[0], type:type, scope:document.getElementById('cgr-scope').value,
    reason:'บันทึกจาก Contact Governance', source:'Agent · interaction-88921', until:'ถาวร', status:'ACTIVE', hard:hard, enforcement:mode });
  renderCgRestrictions(); toast(mode === 'ENFORCE' ? 'เพิ่มข้อห้ามแล้ว · งานรอส่งถูกหยุด (mock)' : 'บันทึกข้อห้ามในโหมด ' + mode + ' แล้ว (mock)'); showView('restrictions');
}
function cgRequestUnblock(i) {
  var r = CG_RESTRICTIONS[i];
  toast('ส่งคำขอปลด ' + r.type + ' ให้ Compliance แล้ว (mock)');
}
function cgViewRestriction(i) { var r = CG_RESTRICTIONS[i]; if (!r) return; cgShowRecord('restrictions', r.target + ' · ' + r.type, 'Restriction is append-only', [['CIF / Identity',r.ref],['ประเภท',tag(r.type === 'INBOUND_SAFETY' ? 'tag-warn' : 'tag-bad',r.type)],['ขอบเขต',r.scope],['Enforcement',cgEnforcementBadge(r.enforcement || 'ENFORCE', r.hard)],['เหตุผล',r.reason],['แหล่งที่มา',r.source],['มีผลถึง',r.until],['สถานะ',tag(r.status === 'ACTIVE' ? 'tag-bad' : 'tag-info',r.status)]], r.hard ? 'Hard Block ถูกล็อกเป็น ENFORCE; ใช้คำขอ unblock/revoke พร้อม audit และ maker-checker' : 'Operational restriction ปรับเป็น ENFORCE, MONITOR หรือ DISABLED ได้ พร้อม audit'); }

var cgRecordBack = 'overview';
function cgBackRecord() { showView(cgRecordBack); }
function cgShowRecord(back, title, subtitle, fields, note) {
  var el = document.getElementById('cg-record-detail'); if (!el) return;
  cgRecordBack = back;
  el.innerHTML = '<div class="mb-5"><h1 class="text-xl font-semibold">' + title + '</h1><p class="text-sm text-slate-500 mt-1">' + subtitle + '</p></div>' +
    '<div class="grid grid-cols-1 xl:grid-cols-3 gap-5"><div class="xl:col-span-2 bg-white border border-slate-200 rounded-xl p-5"><h2 class="text-sm font-semibold mb-4">รายละเอียด</h2><dl class="grid grid-cols-1 md:grid-cols-2 gap-5 text-sm">' + fields.map(function (f) { return '<div><dt class="text-xs text-slate-400 mb-1">' + f[0] + '</dt><dd>' + f[1] + '</dd></div>'; }).join('') + '</dl></div><div class="note note-info"><i class="ti ti-file-search text-lg"></i><p>' + note + '</p></div></div>';
  showView('cg-record-detail');
}
function cgNextRecordId(rows, prefix) { return prefix + '-' + String(rows.reduce(function (max, row) { return Math.max(max, Number((row.id || '').split('-').pop()) || 0); }, 0) + 1).padStart(3,'0'); }

var CG_EXCEPTIONS = [
  { id:'ex-001', cif:'CIF-TH-0081022', name:'David Kim', reason:'ลูกค้าขอให้โทรกลับ 20:30 วันนี้', rules:'QUIET_HOURS', window:'30 ส.ค. · 20:25–20:45', by:'สมพร · Supervisor', state:'PENDING' },
  { id:'ex-002', cif:'CIF-TH-0035110', name:'บริษัท เอเพ็กซ์ จำกัด', reason:'ติดตามเหตุบริการวิกฤต INC-9918', rules:'DAILY_TOUCH_CAP', window:'30–31 ส.ค.', by:'วิภา · Supervisor', state:'PENDING' },
  { id:'ex-003', cif:'CIF-TH-0093155', name:'Nina S.', reason:'Callback ที่ลูกค้านัดเอง', rules:'MIN_GAP', window:'30 ส.ค. · 14:00–14:30', by:'สมชาย · Agent', state:'APPROVED', approved:'อรุณี · Compliance' },
  { id:'ex-004', cif:'CIF-TH-0022004', name:'คุณภาคิน ว.', reason:'ติดตามการส่งอุปกรณ์ทดแทน', rules:'WEEKLY_TOUCH_CAP', window:'29–30 ส.ค.', by:'สมพร · Supervisor', state:'EXPIRED', approved:'อรุณี · Compliance' },
  { id:'ex-005', cif:'CIF-TH-0064551', name:'Bright Edu Group', reason:'ลูกค้าขอเลื่อนช่วงเวลาติดต่อหลังประชุม', rules:'QUIET_HOURS', window:'31 ส.ค. · 18:15–18:30', by:'มานี · Supervisor', state:'DRAFT' },
  { id:'ex-006', cif:'CIF-TH-0040779', name:'คุณอรุณ ศ.', reason:'ติดตามนัดชำระเงินที่ไม่ยืนยัน', rules:'MIN_GAP', window:'30 ส.ค. · 15:00–15:15', by:'วรรณา · Agent', state:'REJECTED', approved:'อรุณี · Compliance' },
];
var cgExceptionEditIndex = null;
function cgExceptionState(state) {
  var map = { PENDING:['tag-warn','รออนุมัติ'], APPROVED:['tag-ok','อนุมัติแล้ว'], REJECTED:['tag-bad','ปฏิเสธ'], EXPIRED:['tag','หมดอายุ'], DRAFT:['tag-info','Draft'], REVOKED:['tag-bad','เพิกถอน'] };
  return map[state] || ['tag',state];
}
function renderCgExceptions() {
  var b = document.getElementById('cg-exceptions-body'); if (!b) return;
  b.innerHTML = CG_EXCEPTIONS.map(function (e, i) {
    var st = cgExceptionState(e.state);
    var actions = '<button class="qbtn !py-1 !px-2" onclick="cgViewException(' + i + ')"><i class="ti ti-eye"></i>ดู</button>';
    if (e.state === 'PENDING') actions += '<button class="qbtn !py-1 !px-2" onclick="cgApproveException(' + i + ')"><i class="ti ti-check"></i>อนุมัติ</button><button class="icon-btn" onclick="cgRejectException(' + i + ')" title="ปฏิเสธ"><i class="ti ti-x"></i></button><button class="icon-btn" onclick="cgEditException(' + i + ')" title="แก้ไข"><i class="ti ti-pencil"></i></button><button class="icon-btn text-rose-700" onclick="cgDeleteException(' + i + ')" title="ลบ"><i class="ti ti-trash"></i></button>';
    if (e.state === 'DRAFT') actions += '<button class="icon-btn" onclick="cgEditException(' + i + ')" title="แก้ไข"><i class="ti ti-pencil"></i></button><button class="icon-btn text-rose-700" onclick="cgDeleteException(' + i + ')" title="ลบ"><i class="ti ti-trash"></i></button>';
    if (e.state === 'APPROVED') actions += '<button class="qbtn !py-1 !px-2 text-rose-700" onclick="cgRevokeException(' + i + ')"><i class="ti ti-ban"></i>เพิกถอน</button>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50"><td class="px-4 py-3"><p class="font-medium">' + e.name + '</p><p class="text-xs font-mono text-slate-400">' + e.cif + ' · ' + e.id + '</p></td>' +
      '<td class="px-4 py-3 text-slate-600 max-w-xs whitespace-normal">' + e.reason + '</td><td class="px-4 py-3">' + tag('tag-info', e.rules) + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + e.window + '</td><td class="px-4 py-3 text-slate-500"><p>' + e.by + '</p>' + (e.approved ? '<p class="text-xs text-emerald-700">อนุมัติโดย ' + e.approved + '</p>' : '') + '</td>' +
      '<td class="px-4 py-3">' + tag(st[0], st[1]) + '</td><td class="px-4 py-3 text-right whitespace-nowrap">' + actions + '</td></tr>';
  }).join('');
}
function cgViewException(i) { var e = CG_EXCEPTIONS[i]; if (!e) return; cgShowRecord('exceptions', e.name + ' · ' + e.id, 'Approved exception', [['CIF',e.cif],['Rule',tag('tag-info',e.rules)],['ช่วงเวลา',e.window],['สถานะ',tag(cgExceptionState(e.state)[0],cgExceptionState(e.state)[1])],['ผู้ขอ',e.by],['ผู้อนุมัติ',e.approved || '—'],['เหตุผล',e.reason]], 'Hard restriction และ revoked consent ไม่อยู่ใน allowed rules ของ exception'); }
function cgSetExceptionForm(e) { setVals({ 'cgexf-cif':e.cif, 'cgexf-name':e.name, 'cgexf-rule':e.rules, 'cgexf-state':e.state === 'DRAFT' ? 'DRAFT' : 'PENDING', 'cgexf-window':e.window, 'cgexf-reason':e.reason }); }
function cgNewException() { cgExceptionEditIndex = null; document.getElementById('cgexf-id').textContent = 'ใหม่'; setHeading('cgexf-heading','ขอข้อยกเว้น','New exception'); cgSetExceptionForm({ cif:'', name:'', rules:'QUIET_HOURS', state:'PENDING', window:'', reason:'' }); showView('exception-form'); }
function cgEditException(i) { var e = CG_EXCEPTIONS[i]; if (!e || (e.state !== 'PENDING' && e.state !== 'DRAFT')) return; cgExceptionEditIndex = i; document.getElementById('cgexf-id').textContent = e.id; setHeading('cgexf-heading','แก้ไขข้อยกเว้น','Edit exception'); cgSetExceptionForm(e); showView('exception-form'); }
function cgSaveException() { var existing = cgExceptionEditIndex === null ? null : CG_EXCEPTIONS[cgExceptionEditIndex]; var cif = document.getElementById('cgexf-cif').value.trim(); var name = document.getElementById('cgexf-name').value.trim(); var reason = document.getElementById('cgexf-reason').value.trim(); if (!cif || !name || !reason) { toast('กรอก CIF, ชื่อลูกค้า และเหตุผลก่อนบันทึก (mock)'); return; } var e = { id:existing ? existing.id : cgNextRecordId(CG_EXCEPTIONS,'ex'), cif:cif, name:name, reason:reason, rules:document.getElementById('cgexf-rule').value, window:document.getElementById('cgexf-window').value || 'ต้องระบุช่วงเวลา', by:'สมพร · Supervisor', state:document.getElementById('cgexf-state').value }; if (existing) CG_EXCEPTIONS[cgExceptionEditIndex] = e; else CG_EXCEPTIONS.unshift(e); cgExceptionEditIndex = null; renderCgExceptions(); toast(existing ? 'บันทึกข้อยกเว้นฉบับร่างแล้ว (mock)' : 'สร้างคำขอข้อยกเว้นแล้ว (mock)'); showView('exceptions'); }
function cgApproveException(i) { CG_EXCEPTIONS[i].state = 'APPROVED'; CG_EXCEPTIONS[i].approved = 'อรุณี · Compliance'; renderCgExceptions(); toast('อนุมัติข้อยกเว้นแล้ว · หมดอายุตามเวลาที่ขอ (mock)'); }
function cgRejectException(i) { CG_EXCEPTIONS[i].state = 'REJECTED'; CG_EXCEPTIONS[i].approved = 'อรุณี · Compliance'; renderCgExceptions(); toast('ปฏิเสธข้อยกเว้นแล้ว (mock)'); }
function cgRevokeException(i) { CG_EXCEPTIONS[i].state = 'REVOKED'; renderCgExceptions(); toast('เพิกถอนข้อยกเว้นและบันทึก audit แล้ว (mock)'); }
function cgDeleteException(i) { var e = CG_EXCEPTIONS[i]; if (!e || !window.confirm('ลบคำขอข้อยกเว้น ' + e.id + ' ใช่หรือไม่?')) return; CG_EXCEPTIONS.splice(i,1); renderCgExceptions(); toast('ลบ Draft/Pending exception แล้ว (mock)'); }

var CG_POLICIES = [
  { id:'policy-001', name:'Default Customer Contact', scope:'Tenant · ทุก channel', version:7, effective:'2026-08-28', status:'PUBLISHED', attempt:3, touch:1, quiet:'20:00–08:00', enforcement:'ENFORCE' },
  { id:'policy-002', name:'Collection — Voice', scope:'Business unit · Collection', version:3, effective:'2026-09-01', status:'SCHEDULED', attempt:4, touch:2, quiet:'19:00–08:00', enforcement:'MONITOR' },
  { id:'policy-003', name:'VIP requested callback', scope:'Purpose · Callback', version:2, effective:'', status:'DRAFT', attempt:1, touch:1, quiet:'ตามช่วงที่ลูกค้าขอ', enforcement:'MONITOR' },
  { id:'policy-004', name:'Marketing — Digital', scope:'Purpose · Marketing', version:4, effective:'2026-08-15', status:'PUBLISHED', attempt:2, touch:1, quiet:'20:00–09:00', enforcement:'ENFORCE' },
  { id:'policy-005', name:'Survey follow-up', scope:'Purpose · Survey', version:2, effective:'', status:'DRAFT', attempt:1, touch:1, quiet:'18:00–09:00', enforcement:'DISABLED' },
  { id:'policy-006', name:'Legacy collections v2', scope:'Business unit · Collection', version:2, effective:'2026-07-01', status:'RETIRED', attempt:5, touch:2, quiet:'19:00–08:00', enforcement:'DISABLED' },
];
var cgPolicyEditIndex = null;
function cgPolicyState(status) { var map = { PUBLISHED:['tag-ok','Published'], SCHEDULED:['tag-info','Scheduled'], DRAFT:['tag','Draft'], RETIRED:['tag-bad','Retired'] }; return map[status] || ['tag',status]; }
function renderCgPolicies() { var b = document.getElementById('cg-policies-body'); if (!b) return; b.innerHTML = CG_POLICIES.map(function (p,i) { var st = cgPolicyState(p.status); var actions = '<button class="qbtn !py-1 !px-2" onclick="cgViewPolicy(' + i + ')"><i class="ti ti-eye"></i>ดู</button>'; if (p.status === 'DRAFT' || p.status === 'SCHEDULED') actions += '<button class="icon-btn" onclick="cgEditPolicy(' + i + ')" title="แก้ไข"><i class="ti ti-pencil"></i></button>'; if (p.status === 'DRAFT') actions += '<button class="icon-btn text-rose-700" onclick="cgDeletePolicy(' + i + ')" title="ลบ"><i class="ti ti-trash"></i></button>'; return '<tr class="border-b border-slate-100 hover:bg-slate-50"><td class="px-4 py-3"><p class="font-medium">' + p.name + '</p><p class="text-xs font-mono text-slate-400">' + p.id + '</p></td><td class="px-4 py-3 text-slate-600">' + p.scope + '</td><td class="px-4 py-3">v' + p.version + '</td><td class="px-4 py-3 text-slate-500">' + (p.effective ? cgScopeDate(p.effective) : '—') + '</td><td class="px-4 py-3">' + tag(st[0],st[1]) + '</td><td class="px-4 py-3">' + cgEnforcementBadge(p.enforcement || 'ENFORCE', false) + '</td><td class="px-4 py-3 text-right whitespace-nowrap">' + actions + '</td></tr>'; }).join(''); }
function cgViewPolicy(i) { var p = CG_POLICIES[i]; if (!p) return; cgShowRecord('policies', p.name + ' · v' + p.version, 'Versioned Contact Governance policy', [['Scope',p.scope],['สถานะ',tag(cgPolicyState(p.status)[0],cgPolicyState(p.status)[1])],['Enforcement',cgEnforcementBadge(p.enforcement || 'ENFORCE', false)],['มีผล',p.effective ? cgScopeDate(p.effective) : '—'],['Attempt / วัน',p.attempt],['Touch / วัน',p.touch],['Quiet hours',p.quiet]], p.status === 'PUBLISHED' ? 'Published policy เป็น immutable; ต้องสร้าง Draft version ใหม่เพื่อแก้ไขหรือเปลี่ยน Enforcement' : 'Draft และ Scheduled policy แก้ไข Enforcement ได้ก่อน publish'); }
function cgSetPolicyForm(p) { setVals({ 'cgpf-name':p.name, 'cgpf-scope':p.scope, 'cgpf-version':p.version, 'cgpf-status':p.status === 'SCHEDULED' ? 'SCHEDULED' : 'DRAFT', 'cgpf-effective':p.effective || '', 'cgpf-enforcement':p.enforcement || 'MONITOR', 'cgpf-attempt':p.attempt, 'cgpf-touch':p.touch, 'cgpf-quiet':p.quiet }); }
function cgNewPolicy() { cgPolicyEditIndex = null; document.getElementById('cgpf-id').textContent = 'ใหม่'; setHeading('cgpf-heading','สร้าง Policy Draft','New policy draft'); cgSetPolicyForm({ name:'',scope:'Tenant · ทุก channel',version:1,status:'DRAFT',effective:'',enforcement:'MONITOR',attempt:3,touch:1,quiet:'20:00–08:00' }); showView('policy-form'); }
function cgEditPolicy(i) { var p = CG_POLICIES[i]; if (!p || (p.status !== 'DRAFT' && p.status !== 'SCHEDULED')) { toast('Published/Retired policy แก้ไม่ได้ ให้สร้าง Draft ใหม่ (mock)'); return; } cgPolicyEditIndex = i; document.getElementById('cgpf-id').textContent = p.id; setHeading('cgpf-heading','แก้ไข Policy Draft','Edit policy draft'); cgSetPolicyForm(p); showView('policy-form'); }
function cgSavePolicy() { var existing = cgPolicyEditIndex === null ? null : CG_POLICIES[cgPolicyEditIndex]; var name = document.getElementById('cgpf-name').value.trim(); var scope = document.getElementById('cgpf-scope').value.trim(); if (!name || !scope) { toast('ระบุชื่อและขอบเขต Policy ก่อนบันทึก (mock)'); return; } var p = { id:existing ? existing.id : cgNextRecordId(CG_POLICIES,'policy'), name:name, scope:scope, version:Number(document.getElementById('cgpf-version').value) || 1, status:document.getElementById('cgpf-status').value, effective:document.getElementById('cgpf-effective').value, enforcement:document.getElementById('cgpf-enforcement').value, attempt:Number(document.getElementById('cgpf-attempt').value) || 0, touch:Number(document.getElementById('cgpf-touch').value) || 0, quiet:document.getElementById('cgpf-quiet').value || '—' }; if (p.status === 'SCHEDULED' && !p.effective) { toast('Scheduled policy ต้องมีวันเริ่มมีผล (mock)'); return; } if (existing) CG_POLICIES[cgPolicyEditIndex] = p; else CG_POLICIES.unshift(p); cgPolicyEditIndex = null; renderCgPolicies(); toast((existing ? 'บันทึก Policy Draft แล้ว · ' : 'สร้าง Policy Draft แล้ว · ') + p.enforcement + ' (mock)'); showView('policies'); }
function cgDeletePolicy(i) { var p = CG_POLICIES[i]; if (!p || p.status !== 'DRAFT' || !window.confirm('ลบ Draft policy ' + p.name + ' ใช่หรือไม่?')) return; CG_POLICIES.splice(i,1); renderCgPolicies(); toast('ลบ Draft policy แล้ว (mock)'); }

var CG_SENDERS = [
  { id:'sender-001', value:'+66 2 123 4500', channel:'voice', scope:'ทุก Campaign', provider:'FreeSWITCH · SIP-A', verified:'วันนี้ 08:00', status:'APPROVED' },
  { id:'sender-002', value:'D-CONTACT', channel:'sms', scope:'Service notification', provider:'SMS Gateway TH', verified:'29 ส.ค.', status:'APPROVED' },
  { id:'sender-003', value:'@dcontact-service', channel:'line', scope:'Service · Survey', provider:'LINE', verified:'29 ส.ค.', status:'APPROVED' },
  { id:'sender-004', value:'+66 2 123 4599', channel:'voice', scope:'Collections', provider:'SIP-B', verified:'ล้มเหลว 2 ครั้ง', status:'SUSPENDED' },
  { id:'sender-005', value:'DContact Care', channel:'whatsapp', scope:'Callback · Service', provider:'Meta BSP', verified:'รอยืนยัน', status:'PENDING' },
  { id:'sender-006', value:'service@d-contact.co.th', channel:'email', scope:'Service update', provider:'SES TH', verified:'28 ส.ค.', status:'RETIRED' },
];
var cgSenderEditIndex = null;
function cgSenderState(status) { var map = { APPROVED:['tag-ok','Approved'], PENDING:['tag-warn','Pending'], SUSPENDED:['tag-bad','Suspended'], RETIRED:['tag','Retired'] }; return map[status] || ['tag',status]; }
function renderCgSenders() { var b = document.getElementById('cg-senders-body'); if (!b) return; b.innerHTML = CG_SENDERS.map(function (s,i) { var st=cgSenderState(s.status); var actions='<button class="qbtn !py-1 !px-2" onclick="cgViewSender(' + i + ')"><i class="ti ti-eye"></i>ดู</button><button class="icon-btn" onclick="cgEditSender(' + i + ')" title="แก้ไข"><i class="ti ti-pencil"></i></button>'; if (s.status === 'PENDING' || s.status === 'RETIRED') actions += '<button class="icon-btn text-rose-700" onclick="cgDeleteSender(' + i + ')" title="ลบ"><i class="ti ti-trash"></i></button>'; else actions += '<button class="icon-btn" onclick="cgRetireSender(' + i + ')" title="เลิกใช้"><i class="ti ti-archive"></i></button>'; return '<tr class="border-b border-slate-100 hover:bg-slate-50"><td class="px-4 py-3"><p class="font-medium">' + s.value + '</p><p class="text-xs font-mono text-slate-400">' + s.id + '</p></td><td class="px-4 py-3">' + cgChannelBadge(s.channel) + '</td><td class="px-4 py-3 text-slate-600">' + s.scope + '</td><td class="px-4 py-3 text-slate-500">' + s.provider + '</td><td class="px-4 py-3 text-slate-500">' + s.verified + '</td><td class="px-4 py-3">' + tag(st[0],st[1]) + '</td><td class="px-4 py-3 text-right whitespace-nowrap">' + actions + '</td></tr>'; }).join(''); }
function cgViewSender(i) { var s = CG_SENDERS[i]; if (!s) return; cgShowRecord('senders', s.value, 'Approved sender / caller identity', [['Channel',cgChannelBadge(s.channel)],['ใช้ได้กับ',s.scope],['Provider',s.provider],['ยืนยันล่าสุด',s.verified],['สถานะ',tag(cgSenderState(s.status)[0],cgSenderState(s.status)[1])]], 'ระบบอนุญาตให้ใช้ส่งออกได้เฉพาะสถานะ Approved เท่านั้น'); }
function cgSetSenderForm(s) { setVals({ 'cgsf-value':s.value, 'cgsf-channel':s.channel, 'cgsf-scope':s.scope, 'cgsf-provider':s.provider, 'cgsf-status':s.status }); }
function cgNewSender() { cgSenderEditIndex = null; document.getElementById('cgsf-id').textContent = 'ใหม่'; setHeading('cgsf-heading','เพิ่มตัวตนผู้ส่ง','New sender identity'); cgSetSenderForm({ value:'',channel:'voice',scope:'Service',provider:'',status:'PENDING' }); showView('sender-form'); }
function cgEditSender(i) { var s = CG_SENDERS[i]; if (!s) return; cgSenderEditIndex = i; document.getElementById('cgsf-id').textContent = s.id; setHeading('cgsf-heading','แก้ไขตัวตนผู้ส่ง','Edit sender identity'); cgSetSenderForm(s); showView('sender-form'); }
function cgSaveSender() { var existing = cgSenderEditIndex === null ? null : CG_SENDERS[cgSenderEditIndex]; var value=document.getElementById('cgsf-value').value.trim(); if (!value) { toast('ระบุตัวตนผู้ส่งก่อนบันทึก (mock)'); return; } var s={ id:existing ? existing.id : cgNextRecordId(CG_SENDERS,'sender'), value:value, channel:document.getElementById('cgsf-channel').value, scope:document.getElementById('cgsf-scope').value || 'Service', provider:document.getElementById('cgsf-provider').value || '—', status:document.getElementById('cgsf-status').value, verified:existing ? existing.verified : 'รอยืนยัน' }; if (existing) CG_SENDERS[cgSenderEditIndex]=s; else CG_SENDERS.unshift(s); cgSenderEditIndex=null; renderCgSenders(); toast(existing ? 'บันทึกตัวตนผู้ส่งแล้ว (mock)' : 'เพิ่มตัวตนผู้ส่งแล้ว (mock)'); showView('senders'); }
function cgRetireSender(i) { CG_SENDERS[i].status='RETIRED'; renderCgSenders(); toast('เลิกใช้ตัวตนผู้ส่งและบันทึก audit แล้ว (mock)'); }
function cgDeleteSender(i) { var s=CG_SENDERS[i]; if (!s || (s.status !== 'PENDING' && s.status !== 'RETIRED') || !window.confirm('ลบตัวตนผู้ส่ง ' + s.value + ' ใช่หรือไม่?')) return; CG_SENDERS.splice(i,1); renderCgSenders(); toast('ลบตัวตนผู้ส่งแล้ว (mock)'); }

var CG_AUDIT = [
  { at:'วันนี้ 10:42', type:'UNBLOCK', tone:'tag-bad', target:'CIF-TH-0019820 · DNC_GLOBAL', actor:'อรุณี · Compliance', approved:'ปริญญา · DPO', detail:'ยกเลิก DNC ตามคำขอแก้ไขข้อมูลที่ได้รับการยืนยัน' },
  { at:'วันนี้ 09:18', type:'POLICY_PUBLISH', tone:'tag-info', target:'Default Customer Contact v7', actor:'System scheduler', approved:'อรุณี · Compliance', detail:'Publish policy version 7 ตามเวลาอนุมัติ' },
  { at:'วันนี้ 08:54', type:'EXCEPTION_APPROVE', tone:'tag-warn', target:'CIF-TH-0081022 · quiet hours', actor:'สมพร · Supervisor', approved:'อรุณี · Compliance', detail:'อนุมัติ callback ตามคำขอลูกค้า' },
  { at:'เมื่อวาน 17:12', type:'RESTRICTION_ADD', tone:'tag-bad', target:'CIF-TH-0049281 · PURPOSE_OBJECTED', actor:'สมชาย · Agent', approved:'ไม่ต้องอนุมัติ', detail:'ลูกค้าคัดค้าน Collection ผ่าน Voice' },
  { at:'เมื่อวาน 16:42', type:'TEAM_SCOPE_UPDATE', tone:'tag-info', target:'Team D → CARD', actor:'วิภา · Admin', approved:'ปริญญา · DPO', detail:'เพิ่ม CONTACT scope ให้ทีมดูแลลูกค้าบัตร' },
  { at:'27 ส.ค. 10:20', type:'SENDER_RETIRED', tone:'tag', target:'service@d-contact.co.th', actor:'อรุณี · Compliance', approved:'ไม่ต้องอนุมัติ', detail:'เปลี่ยนผู้ให้บริการ Email และเลิกใช้ identity เดิม' },
];
function renderCgAudit() { var b = document.querySelector('[data-view="audit"] tbody'); if (!b) return; b.innerHTML = CG_AUDIT.map(function (a,i) { return '<tr class="cursor-pointer hover:bg-slate-50" onclick="cgViewAudit(' + i + ')"><td class="px-4 py-3 text-slate-500">' + a.at + '</td><td class="px-4 py-3">' + tag(a.tone,a.type) + '</td><td class="px-4 py-3">' + a.target + '</td><td class="px-4 py-3">' + a.actor + '</td><td class="px-4 py-3 ' + (a.approved === 'ไม่ต้องอนุมัติ' ? 'text-slate-400' : '') + '">' + a.approved + '</td></tr>'; }).join(''); }
function cgViewAudit(i) { var a = CG_AUDIT[i]; if (!a) return; cgShowRecord('audit', a.type, 'Append-only audit event', [['เมื่อ',a.at],['เป้าหมาย',a.target],['ผู้ดำเนินการ',a.actor],['ผู้อนุมัติ',a.approved],['รายละเอียด',a.detail]], 'Audit log เป็นหลักฐานย้อนหลัง จึงดูและส่งออกได้ แต่ไม่สามารถสร้าง แก้ไข หรือลบจากหน้าจอนี้'); }

/* ---------- Customer segment & team scope ---------- */
var CG_TEAM_SCOPES = [
  { id:'scope-001', team:'Team A', segment:'LOND', perms:['VIEW','WORK','CONTACT'], effect:'ALLOW', status:'ACTIVE', from:'2026-08-01', to:'', updatedBy:'อรุณี · Compliance', updatedAt:'วันนี้ 09:16', note:'ทีมดูแลผลิตภัณฑ์ LOND ตามโครงสร้างปฏิบัติการ Q3' },
  { id:'scope-002', team:'Team C', segment:'LOND', perms:['VIEW','WORK','CONTACT'], effect:'ALLOW', status:'ACTIVE', from:'2026-08-01', to:'', updatedBy:'อรุณี · Compliance', updatedAt:'วันนี้ 09:16', note:'ทีมสนับสนุน LOND ทำงานร่วมกับ Team A' },
  { id:'scope-003', team:'Team D', segment:'CARD', perms:['VIEW','WORK','CONTACT'], effect:'ALLOW', status:'ACTIVE', from:'2026-08-01', to:'', updatedBy:'วิภา · Admin', updatedAt:'เมื่อวาน 16:42', note:'ทีมดูแลลูกค้าบัตรและรายการติดตามที่เกี่ยวข้อง' },
  { id:'scope-004', team:'Team B', segment:'CARD', perms:['VIEW','WORK'], effect:'ALLOW', status:'ACTIVE', from:'2026-08-15', to:'2026-12-31', updatedBy:'วิภา · Admin', updatedAt:'28 ส.ค. 14:05', note:'สนับสนุน backlog บัตรช่วงแคมเปญปลายปี โดยไม่มีสิทธิ์ติดต่อออก' },
  { id:'scope-005', team:'Team Quality', segment:'LOND', perms:['VIEW'], effect:'ALLOW', status:'ACTIVE', from:'2026-08-01', to:'', updatedBy:'ปริญญา · DPO', updatedAt:'27 ส.ค. 10:20', note:'ตรวจคุณภาพและ audit โดยไม่มีสิทธิ์รับงานหรือติดต่อ' },
  { id:'scope-006', team:'Team D', segment:'LOND', perms:[], effect:'DENY', status:'ACTIVE', from:'2026-08-01', to:'', updatedBy:'ปริญญา · DPO', updatedAt:'27 ส.ค. 10:20', note:'แยกขอบเขตข้อมูล CARD ออกจาก LOND อย่างชัดเจน' },
];
var cgTeamScopeEditIndex = null;

function cgScopePermissions(perms) {
  if (!perms || !perms.length) return '<span class="text-slate-400">—</span>';
  return perms.map(function (p) { return tag(p === 'CONTACT' ? 'tag-ok' : 'tag', p); }).join(' ');
}
function cgScopeEffect(effect) { return effect === 'DENY' ? tag('tag-bad', 'DENY') : tag('tag-ok', 'ALLOW'); }
function cgScopeStatus(status) {
  if (status === 'SCHEDULED') return tag('tag-info', 'Scheduled');
  if (status === 'EXPIRED') return tag('tag', 'Expired');
  return tag('tag-ok', 'Active');
}
function cgScopeDate(v) {
  if (!v) return 'ไม่กำหนด';
  var p = v.split('-');
  if (p.length !== 3) return v;
  var mn = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return Number(p[2]) + ' ' + mn[Number(p[1]) - 1] + ' ' + p[0];
}
function cgScopeWindow(s) { return cgScopeDate(s.from) + (s.to ? ' – ' + cgScopeDate(s.to) : ' – ไม่กำหนด'); }
function cgScopeMetrics() {
  var total = document.getElementById('cg-scope-total');
  var contact = document.getElementById('cg-scope-contact');
  var deny = document.getElementById('cg-scope-deny');
  if (total) total.textContent = CG_TEAM_SCOPES.length;
  if (contact) contact.textContent = CG_TEAM_SCOPES.filter(function (s) { return s.effect === 'ALLOW' && s.perms.indexOf('CONTACT') !== -1 && s.status === 'ACTIVE'; }).length;
  if (deny) deny.textContent = CG_TEAM_SCOPES.filter(function (s) { return s.effect === 'DENY' && s.status === 'ACTIVE'; }).length;
}
function renderCgTeamScopes() {
  var b = document.getElementById('cg-team-scopes-body'); if (!b) return;
  b.innerHTML = CG_TEAM_SCOPES.map(function (s, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><p class="font-medium">' + s.team + '</p><p class="text-xs text-slate-400 font-mono">' + s.id + '</p></td>' +
      '<td class="px-4 py-3"><span class="tag tag-info">' + s.segment + '</span></td>' +
      '<td class="px-4 py-3">' + cgScopePermissions(s.perms) + '</td>' +
      '<td class="px-4 py-3">' + cgScopeEffect(s.effect) + '</td>' +
      '<td class="px-4 py-3 text-xs text-slate-500">' + cgScopeWindow(s) + '</td>' +
      '<td class="px-4 py-3 text-xs text-slate-500"><p>' + s.updatedAt + '</p><p>' + s.updatedBy + '</p></td>' +
      '<td class="px-4 py-3">' + cgScopeStatus(s.status) + '</td>' +
      '<td class="px-4 py-3 text-right whitespace-nowrap"><button class="qbtn !py-1 !px-2" onclick="cgViewTeamScope(' + i + ')"><i class="ti ti-eye"></i>ดู</button>' +
      '<button class="icon-btn" onclick="cgEditTeamScope(' + i + ')" title="แก้ไข"><i class="ti ti-pencil"></i></button>' +
      '<button class="icon-btn text-rose-700" onclick="cgDeleteTeamScope(' + i + ')" title="ลบ"><i class="ti ti-trash"></i></button></td></tr>';
  }).join('');
  cgScopeMetrics();
}
function cgSetTeamScopeForm(s) {
  setVals({
    'cgts-team': s.team, 'cgts-segment': s.segment, 'cgts-effect': s.effect, 'cgts-status': s.status,
    'cgts-from': s.from, 'cgts-to': s.to || '', 'cgts-view': s.perms.indexOf('VIEW') !== -1,
    'cgts-work': s.perms.indexOf('WORK') !== -1, 'cgts-contact': s.perms.indexOf('CONTACT') !== -1,
    'cgts-note': s.note || ''
  });
}
function cgNewTeamScope() {
  cgTeamScopeEditIndex = null;
  var id = document.getElementById('cgts-id'); if (id) id.textContent = 'ใหม่';
  setHeading('cgts-heading', 'เพิ่มขอบเขตทีม', 'New team scope');
  cgSetTeamScopeForm({ team:'Team Collections', segment:'CARD', effect:'ALLOW', status:'ACTIVE', from:'2026-08-30', to:'', perms:['VIEW','WORK','CONTACT'], note:'' });
  showView('team-scope-form');
}
function cgEditTeamScope(i) {
  var s = CG_TEAM_SCOPES[i]; if (!s) return;
  cgTeamScopeEditIndex = i;
  var id = document.getElementById('cgts-id'); if (id) id.textContent = s.id;
  setHeading('cgts-heading', 'แก้ไข: ' + s.team + ' → ' + s.segment, 'Edit: ' + s.team + ' → ' + s.segment);
  cgSetTeamScopeForm(s); showView('team-scope-form');
}
function cgViewTeamScope(i) {
  var s = CG_TEAM_SCOPES[i]; var el = document.getElementById('cg-team-scope-detail'); if (!s || !el) return;
  el.innerHTML = '<div class="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-5"><div><div class="flex items-center gap-2"><h1 class="text-xl font-semibold">' + s.team + ' <span class="text-slate-400">→</span> ' + s.segment + '</h1>' + cgScopeEffect(s.effect) + '</div><p class="text-sm text-slate-500 mt-1">' + s.id + ' · ขอบเขตที่บังคับใช้ก่อนเปิดข้อมูล รับงาน หรือเริ่มติดต่อ</p></div><div class="flex gap-2"><button class="qbtn" onclick="cgEditTeamScope(' + i + ')"><i class="ti ti-pencil"></i>แก้ไข</button><button class="qbtn text-rose-700" onclick="cgDeleteTeamScope(' + i + ')"><i class="ti ti-trash"></i>ลบ</button></div></div>' +
    '<div class="grid grid-cols-1 xl:grid-cols-3 gap-5"><div class="xl:col-span-2 space-y-5"><div class="bg-white border border-slate-200 rounded-xl p-5"><h2 class="text-sm font-semibold mb-4">สิทธิ์และช่วงเวลาที่มีผล</h2><div class="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm"><div><p class="text-xs text-slate-400 mb-1">Customer segment</p><span class="tag tag-info">' + s.segment + '</span></div><div><p class="text-xs text-slate-400 mb-1">Permissions</p><div class="flex flex-wrap gap-1">' + cgScopePermissions(s.perms) + '</div></div><div><p class="text-xs text-slate-400 mb-1">มีผล</p><p>' + cgScopeWindow(s) + '</p></div></div></div><div class="bg-white border border-slate-200 rounded-xl p-5"><h2 class="text-sm font-semibold mb-2">เหตุผล / Ticket reference</h2><p class="text-sm text-slate-600">' + (s.note || '—') + '</p></div></div><div class="space-y-5"><div class="bg-white border border-slate-200 rounded-xl p-5"><h2 class="text-sm font-semibold mb-3">Audit ล่าสุด</h2><dl class="text-sm space-y-3"><div><dt class="text-xs text-slate-400">แก้ไขโดย</dt><dd>' + s.updatedBy + '</dd></div><div><dt class="text-xs text-slate-400">เมื่อ</dt><dd>' + s.updatedAt + '</dd></div><div><dt class="text-xs text-slate-400">สถานะ</dt><dd>' + cgScopeStatus(s.status) + '</dd></div></dl></div><div class="note note-info"><i class="ti ti-lock-check text-lg"></i><p>หาก scope เปลี่ยน ระบบ publish <code>team.segment-scope.changed</code> และตรวจคำสั่งติดต่อที่ค้างอีกครั้ง</p></div></div></div>';
  showView('team-scope-detail');
}
function cgSaveTeamScope() {
  var perms = [];
  if (document.getElementById('cgts-view').checked) perms.push('VIEW');
  if (document.getElementById('cgts-work').checked) perms.push('WORK');
  if (document.getElementById('cgts-contact').checked) perms.push('CONTACT');
  var effect = document.getElementById('cgts-effect').value;
  if (effect === 'ALLOW' && !perms.length) { toast('เลือกสิทธิ์อย่างน้อย 1 รายการก่อนบันทึก (mock)'); return; }
  var existing = cgTeamScopeEditIndex === null ? null : CG_TEAM_SCOPES[cgTeamScopeEditIndex];
  var scope = {
    id: existing ? existing.id : 'scope-' + String(CG_TEAM_SCOPES.reduce(function (max, s) { return Math.max(max, Number(s.id.split('-')[1]) || 0); }, 0) + 1).padStart(3, '0'),
    team: document.getElementById('cgts-team').value,
    segment: document.getElementById('cgts-segment').value,
    perms: perms, effect: effect, status: document.getElementById('cgts-status').value,
    from: document.getElementById('cgts-from').value, to: document.getElementById('cgts-to').value,
    updatedBy: 'สมพร · Supervisor', updatedAt: 'วันนี้ 11:08', note: document.getElementById('cgts-note').value
  };
  if (!scope.from) { toast('ระบุวันเริ่มมีผลก่อนบันทึก (mock)'); return; }
  var duplicate = CG_TEAM_SCOPES.some(function (s, i) { return i !== cgTeamScopeEditIndex && s.team === scope.team && s.segment === scope.segment; });
  if (duplicate) { toast('Team นี้มี scope สำหรับ segment นี้แล้ว ให้แก้ไขรายการเดิมแทน (mock)'); return; }
  if (existing) CG_TEAM_SCOPES[cgTeamScopeEditIndex] = scope; else CG_TEAM_SCOPES.unshift(scope);
  cgTeamScopeEditIndex = null; renderCgTeamScopes(); toast(existing ? 'บันทึกการแก้ไขและส่ง event แล้ว (mock)' : 'เพิ่ม Team scope และส่ง event แล้ว (mock)'); showView('team-scopes');
}
function cgDeleteTeamScope(i) {
  var s = CG_TEAM_SCOPES[i]; if (!s) return;
  if (!window.confirm('ลบ scope ' + s.team + ' → ' + s.segment + ' ใช่หรือไม่?')) return;
  CG_TEAM_SCOPES.splice(i, 1); cgTeamScopeEditIndex = null; renderCgTeamScopes(); toast('ลบ Team scope และส่ง event แล้ว (mock)'); showView('team-scopes');
}
function cgRunDecisionSearch() {
  var q = document.getElementById('cg-search');
  var result = document.getElementById('cg-decision-result');
  if (result) { result.classList.add('opacity-60'); setTimeout(function () { result.classList.remove('opacity-60'); }, 220); }
  toast('พบ 6 คำตัดสินสำหรับ ' + (q ? q.value : 'CIF') + ' (mock)');
}

/* ---------- boot ---------- */
function renderModules() {
  renderFlowTrace(); renderExpertGroups();
  renderCampaigns(); renderObLists(); renderObCallbacks(); renderObDnc(); renderObProactive();
  renderCases(); renderCsTypes(); renderCsSla();
  renderBots(); renderBotTests(); renderKb(); renderKbGaps(); renderAssistPrompts(); renderPlaybooks();
  renderScripts(); renderScriptSteps();
  renderIaTopics(); renderIaSaved(); renderFbSurveys(); renderFbPlans(); renderFbResp();
  renderPmTeam(); renderPmCards();
  renderIntOverview(); renderIntApps(); renderConnectors(); renderVisualApps();
  renderApiClients(); renderWebhooks();
  renderIdentities();
  renderRptFilter(); renderRptLib(); renderRptSched();
  renderJourneys(); renderSegments(); renderTouchLog();
  renderCgRecent(); renderCgDecisions(); renderCgRestrictions(); renderCgExceptions(); renderCgPolicies(); renderCgSenders(); renderCgAudit(); renderCgTeamScopes();
}

/* ============================================================
   JOURNEYS — CX automation (docs/journey-orchestration.md · ADR-025)
   journey ผูกกับ "ลูกค้า" ไม่ใช่ interaction · ห้ามสร้าง interaction เอง
   ============================================================ */
var JOURNEYS = [
  { name: 'ทวงถามค่างวดที่จ่ายไม่ผ่าน', trigger: 'เหตุการณ์: payment.failed', audience: 'ลูกค้าที่มียอดค้าง',
    active: 1284, goal: 'จ่ายสำเร็จภายใน 7 วัน', conv: 46, deflect: 22, status: 'PUBLISHED' },
  { name: 'แจ้งสถานะการจัดส่ง', trigger: 'เหตุการณ์: order.shipped', audience: 'ทุกคำสั่งซื้อ',
    active: 8420, goal: 'ไม่โทรถามสถานะภายใน 5 วัน', conv: 71, deflect: 38, status: 'PUBLISHED' },
  { name: 'ต่ออายุก่อนหมดสัญญา', trigger: 'กลุ่ม: ใกล้หมดอายุใน 30 วัน', audience: 'VIP + ทั่วไป',
    active: 640, goal: 'ต่ออายุสำเร็จ', conv: 29, deflect: 8, status: 'PUBLISHED' },
  { name: 'ติดตามลูกค้าที่ให้คะแนนต่ำ', trigger: 'ผลของสาย: CSAT ≤ 2', audience: 'ทุกช่องทาง',
    active: 41, goal: 'ติดต่อกลับใน 24 ชม. + คะแนนรอบถัดไปดีขึ้น', conv: 63, deflect: 0, status: 'PUBLISHED' },
  { name: 'ต้อนรับลูกค้าใหม่ 14 วัน', trigger: 'กลุ่ม: สมัครใน 24 ชม.', audience: 'ลูกค้าใหม่',
    active: 0, goal: 'ใช้งานครั้งแรกสำเร็จ', conv: 0, deflect: 0, status: 'DRAFT' },
];
function renderJourneys() {
  var b = document.getElementById('jr-body'); if (!b) return;
  b.innerHTML = JOURNEYS.map(function (j, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><p class="font-medium text-slate-800">' + j.name + '</p>' +
      '<p class="text-xs text-slate-400">เป้าหมาย: ' + j.goal + '</p></td>' +
      '<td class="px-4 py-3 text-slate-600 text-[13px]">' + j.trigger + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + (j.active ? j.active.toLocaleString() : '—') + '</td>' +
      '<td class="px-4 py-3 w-32">' + (j.active ? pbar(j.conv, j.conv < 35 ? 'p-warn' : '') +
        '<span class="text-xs text-slate-400">' + j.conv + '%</span>' : '<span class="text-slate-400">—</span>') + '</td>' +
      '<td class="px-4 py-3 ' + (j.deflect >= 20 ? 'text-emerald-700 font-semibold' : 'text-slate-600') + '">' +
        (j.active && j.deflect ? '-' + j.deflect + '%' : '<span class="text-slate-400" title="ลำดับนี้ไม่ได้ตั้งเป้าลดสายเข้า">—</span>') + '</td>' +
      '<td class="px-4 py-3">' + (j.status === 'PUBLISHED' ? tag('tag-ok', 'ทำงานอยู่') : tag('tag-warn', 'ร่าง')) + '</td>' +
      editCell('editJourney', i) + '</tr>';
  }).join('');
}
function newJourney() {
  openForm('journey-form', 'jrf-heading', 'สร้างลำดับการติดต่อใหม่', 'New journey',
    { 'jrf-name': '', 'jrf-trigger': 'เหตุการณ์จากระบบภายนอก', 'jrf-event': '', 'jrf-segment': 'ลูกค้าที่มียอดค้าง',
      'jrf-goal': '', 'jrf-maxdays': '30', 'jrf-priority': '5' });
}
function editJourney(i) {
  var j = JOURNEYS[i];
  openForm('journey-form', 'jrf-heading', 'แก้ไข: ' + j.name, 'Edit: ' + j.name,
    { 'jrf-name': j.name, 'jrf-trigger': 'เหตุการณ์จากระบบภายนอก', 'jrf-event': 'payment.failed',
      'jrf-segment': j.audience, 'jrf-goal': j.goal, 'jrf-maxdays': '30', 'jrf-priority': '5' });
}

var SEGMENTS = [
  { name: 'ลูกค้าที่มียอดค้าง', def: 'attrs.balanceDue > 0', size: 4820, refresh: '60 นาที', used: 2 },
  { name: 'ใกล้หมดอายุใน 30 วัน', def: 'attrs.expiresAt <= today + 30d', size: 1240, refresh: '24 ชม.', used: 1 },
  { name: 'VIP ที่ติดต่อบ่อยเดือนนี้', def: 'vip = true และ interactions30d >= 3', size: 186, refresh: '60 นาที', used: 1 },
  { name: 'เคยให้คะแนนต่ำใน 90 วัน', def: 'csatMin90d <= 2', size: 312, refresh: '24 ชม.', used: 1 },
];
function renderSegments() {
  var b = document.getElementById('sg-body'); if (!b) return;
  b.innerHTML = SEGMENTS.map(function (g, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + g.name + '</td>' +
      '<td class="px-4 py-3 font-mono text-[12.5px] text-slate-600">' + g.def + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + g.size.toLocaleString() + ' คน</td>' +
      '<td class="px-4 py-3 text-slate-600">ทุก ' + g.refresh + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + g.used + ' ลำดับ</td>' +
      editCell('editSegment', i) + '</tr>';
  }).join('');
}
function newSegment() {
  openForm('segment-form', 'sgf-heading', 'สร้างกลุ่มเป้าหมาย', 'New segment',
    { 'sgf-name': '', 'sgf-def': '', 'sgf-refresh': '60' });
}
function editSegment(i) {
  var g = SEGMENTS[i];
  openForm('segment-form', 'sgf-heading', 'แก้ไข: ' + g.name, 'Edit: ' + g.name,
    { 'sgf-name': g.name, 'sgf-def': g.def, 'sgf-refresh': '60' });
}

// บันทึกการติดต่อรายลูกค้า — ตอบคำถาม "เดือนนี้เราไปรบกวนเขากี่ครั้ง"
var TOUCH_LOG = [
  { at: '10-08 09:12', ch: 'line', src: 'ลำดับ: ทวงถามค่างวด', kind: 'PROMOTIONAL', decision: 'SENT' },
  { at: '10-08 09:05', ch: 'sms', src: 'แคมเปญ: เสนอแพ็กเกจ Q3', kind: 'PROMOTIONAL', decision: 'SUPPRESSED',
    gate: 'CONTACT_POLICY', reason: 'เกินเพดาน 1 ครั้ง/วัน' },
  { at: '09-08 14:40', ch: 'sms', src: 'ลำดับ: แจ้งสถานะการจัดส่ง', kind: 'TRANSACTIONAL', decision: 'SENT' },
  { at: '08-08 11:02', ch: 'line', src: 'แบบสำรวจ CSAT', kind: 'PROMOTIONAL', decision: 'SUPPRESSED',
    gate: 'MODULE_RULE', reason: 'เพิ่งถูกถามใน 30 วัน (กฎของแบบสำรวจ)' },
  { at: '07-08 16:20', ch: 'voice', src: 'แคมเปญ: ยืนยันนัดหมาย', kind: 'TRANSACTIONAL', decision: 'SENT' },
  { at: '06-08 10:15', ch: 'sms', src: 'ลำดับ: ต่ออายุก่อนหมดสัญญา', kind: 'PROMOTIONAL', decision: 'SUPPRESSED',
    gate: 'CONSENT', reason: 'ถอนความยินยอมช่องทาง SMS เมื่อ 02-08' },
];
var GATE_LABEL = { CONSENT: ['ชั้น 1 · ยินยอม', 'tag-bad'], MODULE_RULE: ['ชั้น 2 · กฎโมดูล', 'tag'],
                   CONTACT_POLICY: ['ชั้น 3 · เพดาน', 'tag-warn'] };
function renderTouchLog() {
  var b = document.getElementById('cp-body'); if (!b) return;
  b.innerHTML = TOUCH_LOG.map(function (t) {
    var ch = t.ch === 'sms' ? '<span class="ch ch-voice"><i class="ti ti-message"></i>sms</span>' : chBadge(t.ch);
    return '<tr class="border-b border-slate-100">' +
      '<td class="px-4 py-3 text-slate-500">' + t.at + '</td>' +
      '<td class="px-4 py-3">' + ch + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.src + '</td>' +
      '<td class="px-4 py-3">' + (t.kind === 'TRANSACTIONAL' ? tag('tag-info', 'ธุรกรรม') : tag('tag', 'ประชาสัมพันธ์')) + '</td>' +
      '<td class="px-4 py-3">' + (t.decision === 'SENT' ? tag('tag-ok', 'ส่งแล้ว') : tag('tag-bad', 'ถูกกด')) + '</td>' +
      '<td class="px-4 py-3">' + (t.gate && GATE_LABEL[t.gate]
        ? tag(GATE_LABEL[t.gate][1], GATE_LABEL[t.gate][0]) : '<span class="text-slate-300">—</span>') + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-[13px] whitespace-normal">' + (t.reason || '—') + '</td></tr>';
  }).join('');
}
