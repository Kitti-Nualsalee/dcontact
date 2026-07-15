/* ============================================================
   D-Contact mockup framework
   โครงเดียวกับตัวอย่างเดิม: rail (สลับไฟล์ .html ต่อ area) +
   side panel (เมนูจาก MENU object, สลับ view ในหน้าเดียว) + header
   ข้อความสองภาษาใช้ attribute data-i18n / data-i18n-ph (ดู i18n.js)
   ============================================================ */

var currentLang = 'en';

/* ---------- i18n ---------- */
function setLanguage(lang) {
  currentLang = lang;
  var t = window.I18N[lang];
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    var v = t[el.dataset.i18n];
    if (v !== undefined) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
    var v = t[el.dataset.i18nPh];
    if (v !== undefined) el.setAttribute('placeholder', v);
  });
  var en = document.getElementById('lang-en'), th = document.getElementById('lang-th');
  if (en) en.classList.toggle('active', lang === 'en');
  if (th) th.classList.toggle('active', lang === 'th');
  try { localStorage.setItem('dcontact.lang', lang); } catch (e) {}
}

/* ---------- rail + menu definitions ---------- */
var RAIL = [
  ['home', 'ti-layout-dashboard', 'rlHome', 'Home'],
  ['workspace', 'ti-headset', 'rlWorkspace', 'Workspace'],
  ['routing', 'ti-route', 'rlRouting', 'Routing'],
  ['people', 'ti-users', 'rlPeople', 'People'],
  ['channels', 'ti-plug-connected', 'rlChannels', 'Channels'],
  ['history', 'ti-history', 'rlHistory', 'History'],
  ['reports', 'ti-chart-bar', 'rlReports', 'Reports'],
];

var MENU = {
  home: [
    { type: 'label', i18n: 'slOverview', text: 'Overview' },
    { type: 'item', view: 'dashboard', icon: 'ti-layout-dashboard', i18n: 'navDashboard', text: 'Dashboard' },
    { type: 'item', view: 'wallboard', icon: 'ti-device-tv', i18n: 'navWallboard', text: 'Wallboard', badgeNew: 'LIVE' },
  ],
  workspace: [
    { type: 'label', i18n: 'slWorkspace', text: 'Agent workspace' },
    { type: 'item', view: 'inbox', icon: 'ti-inbox', i18n: 'navInbox', text: 'My inbox', badge: '4' },
    { type: 'item', view: 'my-history', icon: 'ti-history', i18n: 'navMyHistory', text: 'My interactions' },
  ],
  routing: [
    { type: 'label', i18n: 'slRouting', text: 'Routing' },
    { type: 'item', view: 'queues', icon: 'ti-stack-2', i18n: 'navQueues', text: 'Queues' },
    { type: 'item', view: 'skills', icon: 'ti-certificate', i18n: 'navSkills', text: 'Skills' },
    { type: 'item', view: 'hours', icon: 'ti-clock-cog', i18n: 'navHours', text: 'Business hours' },
    { type: 'item', view: 'ivr', icon: 'ti-sitemap', i18n: 'navIvr', text: 'IVR flows', badgeNew: 'NEW' },
  ],
  people: [
    { type: 'label', i18n: 'slPeople', text: 'People' },
    { type: 'item', view: 'agents', icon: 'ti-headset', i18n: 'navAgents', text: 'Agents' },
    { type: 'item', view: 'teams', icon: 'ti-users-group', i18n: 'navTeams', text: 'Teams' },
    { type: 'item', view: 'contacts', icon: 'ti-address-book', i18n: 'navContacts', text: 'Contacts' },
  ],
  channels: [
    { type: 'label', i18n: 'slChannels', text: 'Channels' },
    { type: 'item', view: 'numbers', icon: 'ti-phone', i18n: 'navNumbers', text: 'Voice numbers' },
    { type: 'item', view: 'webchat', icon: 'ti-message-circle', i18n: 'navWebchat', text: 'Web chat' },
    { type: 'item', view: 'social', icon: 'ti-brand-line', i18n: 'navSocial', text: 'Social accounts' },
    { type: 'item', view: 'email', icon: 'ti-mail', i18n: 'navEmail', text: 'Email' },
  ],
  history: [
    { type: 'label', i18n: 'slHistory', text: 'Interaction data' },
    { type: 'item', view: 'interactions', icon: 'ti-list-search', i18n: 'navInteractions', text: 'Interactions' },
    { type: 'item', view: 'recordings', icon: 'ti-player-play', i18n: 'navRecordings', text: 'Recordings' },
  ],
  reports: [
    { type: 'label', i18n: 'slReports', text: 'Reports' },
    { type: 'item', view: 'rpt-sla', icon: 'ti-target-arrow', i18n: 'navRptSla', text: 'Queue SLA' },
    { type: 'item', view: 'rpt-agents', icon: 'ti-user-star', i18n: 'navRptAgents', text: 'Agent performance' },
    { type: 'item', view: 'rpt-volume', icon: 'ti-chart-bar', i18n: 'navRptVolume', text: 'Channel volume' },
  ],
  admin: [
    { type: 'label', i18n: 'slAdmin', text: 'Administration' },
    { type: 'group', titleIcon: 'ti-user-shield', titleI18n: 'navUsersGroup', titleText: 'Access', items: [
      { view: 'users', icon: 'ti-users', i18n: 'navUsers', text: 'Users & roles' },
      { view: 'roles', icon: 'ti-lock-access', i18n: 'navRoles', text: 'Permission matrix' },
    ]},
    { type: 'group', titleIcon: 'ti-building', titleI18n: 'navTenantGroup', titleText: 'Tenant', items: [
      { view: 'tenant', icon: 'ti-adjustments', i18n: 'navTenant', text: 'General' },
      { view: 'usage', icon: 'ti-gauge', i18n: 'navUsage', text: 'Usage & plan' },
      { view: 'audit', icon: 'ti-history', i18n: 'navAudit', text: 'Audit log' },
    ]},
  ],
};

/* ---------- layout builders ---------- */
var HEADER =
  '<header class="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-5 sticky top-0 z-10">' +
  '<span class="text-xs px-2.5 py-1 rounded-md bg-teal-50 text-teal-700">acme.d-contact.io</span>' +
  '<div class="flex items-center gap-4">' +
  '<div class="flex text-xs border border-slate-200 rounded-lg overflow-hidden">' +
  '<button id="lang-en" class="lang-btn active" type="button">EN</button>' +
  '<button id="lang-th" class="lang-btn" type="button">TH</button></div>' +
  '<span class="st st-available">Available · 00:12:41</span>' +
  '<i class="ti ti-bell text-slate-400 text-lg"></i>' +
  '<div class="w-8 h-8 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-medium">SC</div>' +
  '</div></header>';

function renderMenuItem(item) {
  var badge = item.badge ? '<span class="badge">' + item.badge + '</span>' : '';
  var badgeNew = item.badgeNew ? '<span class="badge-new">' + item.badgeNew + '</span>' : '';
  return '<a class="nav-item" data-view="' + item.view + '"><i class="ti ' + item.icon + '"></i>' +
    '<span data-i18n="' + item.i18n + '">' + item.text + '</span>' + badge + badgeNew + '</a>';
}
function renderMenuArea(area) {
  return (MENU[area] || []).map(function (node) {
    if (node.type === 'label')
      return '<div class="section-label" data-i18n="' + node.i18n + '">' + node.text + '</div>';
    if (node.type === 'item') return renderMenuItem(node);
    if (node.type === 'group')
      return '<div class="grp"><button class="grp-h" onclick="toggleGrp(this)">' +
        '<span><i class="ti ' + node.titleIcon + '"></i><span data-i18n="' + node.titleI18n + '">' + node.titleText + '</span></span>' +
        '<i class="ti ti-chevron-down grp-chev"></i></button>' +
        '<div class="grp-items">' + node.items.map(renderMenuItem).join('') + '</div></div>';
    return '';
  }).join('');
}
function buildRail(area) {
  var top = RAIL.map(function (r) {
    return '<button class="rail-btn' + (r[0] === area ? ' active' : '') + '" onclick="switchRail(\'' + r[0] + '\')" ' +
      'title="' + r[3] + '"><i class="ti ' + r[1] + '"></i><span class="rail-label" data-i18n="' + r[2] + '">' + r[3] + '</span></button>';
  }).join('');
  var bottom = '<div class="flex-1"></div>' +
    '<button class="rail-btn' + (area === 'admin' ? ' active' : '') + '" onclick="switchRail(\'admin\')" title="Admin">' +
    '<i class="ti ti-shield-cog"></i><span class="rail-label" data-i18n="rlAdmin">Admin</span></button>' +
    '<button class="rail-btn" title="Account"><i class="ti ti-user"></i><span class="rail-label" data-i18n="rlProfile">Account</span></button>' +
    '<button class="rail-btn" id="rail-collapse" onclick="toggleSidebar()"><i class="ti ti-chevrons-left" id="collapse-icon"></i></button>';
  return '<aside class="rail h-screen sticky top-0">' + top + bottom + '</aside>';
}
function buildPanel(area) {
  return '<aside id="side-panel" class="w-64 shrink-0 bg-white border-r border-slate-200 flex flex-col h-screen sticky top-0">' +
    '<div class="h-14 flex items-center gap-2 px-4 border-b border-slate-200 shrink-0">' +
    '<span class="w-8 h-8 rounded-lg bg-teal-700 text-white flex items-center justify-center text-base font-semibold">D</span>' +
    '<span class="brand-name">D-Contact</span></div>' +
    '<nav class="flex-1 p-3 overflow-y-auto"><label class="nav-search"><i class="ti ti-search text-base"></i>' +
    '<input data-i18n-ph="navSearch" placeholder="Search menu" oninput="filterNav(this.value)"></label>' +
    renderMenuArea(area) + '</nav>' +
    '<div class="p-3 border-t border-slate-200 text-xs text-slate-400 shrink-0" data-i18n="footnote">Filtered by role</div></aside>';
}

/* ---------- interactions ---------- */
function switchRail(area) { location.href = area + '.html'; }
function toggleGrp(h) { h.parentElement.classList.toggle('collapsed'); }
function showView(v) {
  document.querySelectorAll('.view').forEach(function (s) { s.classList.toggle('active', s.dataset.view === v); });
  document.querySelectorAll('.nav-item').forEach(function (a) { a.classList.toggle('active', a.dataset.view === v); });
  window.scrollTo(0, 0);
}
function filterNav(q) {
  q = (q || '').trim().toLowerCase();
  document.querySelectorAll('#app .nav-item').forEach(function (item) {
    item.classList.toggle('nav-hidden', !!q && item.textContent.toLowerCase().indexOf(q) === -1);
  });
  document.querySelectorAll('#app .grp').forEach(function (grp) {
    var any = [].slice.call(grp.querySelectorAll('.nav-item')).some(function (i) { return !i.classList.contains('nav-hidden'); });
    grp.classList.toggle('nav-hidden', !!q && !any);
    if (q && any) grp.classList.remove('collapsed');
  });
  document.querySelectorAll('.section-label').forEach(function (s) { s.classList.toggle('nav-hidden', !!q); });
}
var sidebarCollapsed = false;
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  document.getElementById('side-panel').classList.toggle('hidden', sidebarCollapsed);
  var ic = document.getElementById('collapse-icon');
  if (ic) ic.className = 'ti ' + (sidebarCollapsed ? 'ti-chevrons-right' : 'ti-chevrons-left');
}
function toast(msg) {
  var el = document.createElement('div');
  el.className = 'fixed bottom-6 right-6 z-50 bg-slate-800 text-white text-sm rounded-lg px-4 py-2.5 shadow-lg flex items-center gap-2';
  el.innerHTML = '<i class="ti ti-check text-emerald-400"></i>' + msg;
  document.body.appendChild(el);
  setTimeout(function () { el.remove(); }, 2200);
}

/* ============================================================
   Sample data — ทั้งหมดเป็น mock สำหรับวิวเท่านั้น
   ============================================================ */
var CH_ICON = { voice: 'ti-phone', webchat: 'ti-message-circle', line: 'ti-brand-line', facebook: 'ti-brand-messenger', whatsapp: 'ti-brand-whatsapp', email: 'ti-mail' };
function chBadge(c) { return '<span class="ch ch-' + c + '"><i class="ti ' + CH_ICON[c] + '"></i>' + c + '</span>'; }
function stPill(s) {
  var lbl = { available: 'Available', busy: 'On interaction', acw: 'After-call work', break: 'Break', offline: 'Offline' }[s];
  return '<span class="st st-' + s + '">' + lbl + '</span>';
}

var QUEUES = [
  { name: 'General Support', channels: ['voice', 'webchat', 'email'], skills: 'general', sla: 20, priority: 1, agents: 12, waiting: 3, active: true },
  { name: 'Sales (TH)', channels: ['voice', 'line'], skills: 'sales, thai', sla: 15, priority: 2, agents: 8, waiting: 1, active: true },
  { name: 'Technical Support', channels: ['voice', 'webchat'], skills: 'technical', sla: 30, priority: 1, agents: 6, waiting: 5, active: true },
  { name: 'VIP Customers', channels: ['voice', 'whatsapp', 'line'], skills: 'vip', sla: 10, priority: 5, agents: 4, waiting: 0, active: true },
  { name: 'Billing Inquiries', channels: ['email', 'facebook'], skills: 'billing', sla: 120, priority: 1, agents: 3, waiting: 8, active: false },
];

var AGENTS = [
  { name: 'สมชาย วงศ์ประเสริฐ', email: 'somchai@acme.co.th', ext: '1000', team: 'Support A', skills: 'general, technical', voice: 1, chat: 3, state: 'available' },
  { name: 'สมหญิง ใจดี', email: 'somying@acme.co.th', ext: '1001', team: 'Support A', skills: 'general, billing', voice: 1, chat: 2, state: 'busy' },
  { name: 'John Anderson', email: 'john.a@acme.co.th', ext: '1002', team: 'Sales', skills: 'sales, english', voice: 1, chat: 3, state: 'acw' },
  { name: 'อรทัย พูลสวัสดิ์', email: 'orathai@acme.co.th', ext: '1003', team: 'Sales', skills: 'sales, vip', voice: 1, chat: 4, state: 'break' },
  { name: 'ปกรณ์ ศรีสุข', email: 'pakorn@acme.co.th', ext: '1004', team: 'Support B', skills: 'technical', voice: 1, chat: 0, state: 'available' },
  { name: 'Maria Garcia', email: 'maria.g@acme.co.th', ext: '1005', team: 'Support B', skills: 'general, english, vip', voice: 1, chat: 3, state: 'offline' },
];

var TEAMS = [
  { name: 'Support A', lead: 'สมชาย วงศ์ประเสริฐ', members: 8, queues: 'General Support, Technical Support' },
  { name: 'Support B', lead: 'ปกรณ์ ศรีสุข', members: 6, queues: 'Technical Support, VIP Customers' },
  { name: 'Sales', lead: 'อรทัย พูลสวัสดิ์', members: 9, queues: 'Sales (TH), VIP Customers' },
];

var CONTACTS = [
  { name: 'คุณนภา จันทร์เพ็ญ', company: 'Siam Retail Co.', phone: '+66 81 234 5678', line: '@napha.c', email: 'napha@siamretail.co.th', last: '14-07-2026 18:22', total: 12 },
  { name: 'David Kim', company: 'Pacific Logistics', phone: '+66 89 555 1200', line: '', email: 'david.kim@paclog.com', last: '14-07-2026 15:40', total: 5 },
  { name: 'คุณวิชัย ตั้งตรงจิตร', company: '—', phone: '+66 86 777 3456', line: '@wichai_t', email: '', last: '13-07-2026 11:05', total: 27 },
  { name: 'คุณเมษา สุขใจ', company: 'Bright Edu Group', phone: '+66 82 000 9911', line: '@maysa.s', email: 'maysa@brightedu.ac.th', last: '12-07-2026 09:12', total: 3 },
];

var NUMBERS = [
  { num: '+66 2 123 4500', label: 'Main hotline', route: 'IVR: Main menu', trunk: 'NT SIP-01', active: true },
  { num: '+66 2 123 4501', label: 'Sales direct', route: 'Queue: Sales (TH)', trunk: 'NT SIP-01', active: true },
  { num: '+66 2 123 4502', label: 'VIP line', route: 'Queue: VIP Customers', trunk: 'AIS SIP-02', active: true },
  { num: '+66 2 123 4509', label: 'Legacy number', route: 'Queue: General Support', trunk: 'NT SIP-01', active: false },
];

var INTERACTIONS = [
  { dir: 'in', ch: 'voice', contact: '+66 81 234 5678', queue: 'General Support', agent: 'สมชาย วงศ์ประเสริฐ', start: '15-07-2026 10:21:04', wait: '00:00:12', dur: '00:04:31', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'webchat', contact: 'David Kim', queue: 'Technical Support', agent: 'ปกรณ์ ศรีสุข', start: '15-07-2026 10:18:47', wait: '00:00:05', dur: '00:12:09', wrap: 'Escalated', state: 'completed' },
  { dir: 'in', ch: 'line', contact: '@wichai_t', queue: 'Sales (TH)', agent: 'อรทัย พูลสวัสดิ์', start: '15-07-2026 10:14:02', wait: '00:01:44', dur: '00:07:55', wrap: 'Order created', state: 'completed' },
  { dir: 'in', ch: 'voice', contact: '+66 89 555 1200', queue: 'VIP Customers', agent: 'Maria Garcia', start: '15-07-2026 10:05:33', wait: '00:00:04', dur: '00:09:12', wrap: 'Resolved', state: 'completed' },
  { dir: 'out', ch: 'voice', contact: '+66 86 777 3456', queue: '—', agent: 'สมหญิง ใจดี', start: '15-07-2026 09:58:20', wait: '—', dur: '00:02:47', wrap: 'Follow-up', state: 'completed' },
  { dir: 'in', ch: 'email', contact: 'maysa@brightedu.ac.th', queue: 'Billing Inquiries', agent: 'สมหญิง ใจดี', start: '15-07-2026 09:41:11', wait: '00:38:02', dur: '—', wrap: 'Refund issued', state: 'completed' },
  { dir: 'in', ch: 'whatsapp', contact: '+66 82 000 9911', queue: 'VIP Customers', agent: 'Maria Garcia', start: '15-07-2026 09:22:56', wait: '00:00:41', dur: '00:15:30', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'voice', contact: '+66 84 242 9351', queue: 'General Support', agent: '—', start: '15-07-2026 09:15:08', wait: '00:02:10', dur: '—', wrap: '—', state: 'abandoned' },
  { dir: 'in', ch: 'facebook', contact: 'Nok P.', queue: 'Billing Inquiries', agent: 'สมหญิง ใจดี', start: '15-07-2026 08:59:37', wait: '00:05:26', dur: '00:06:03', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'webchat', contact: 'Guest #8812', queue: 'General Support', agent: 'สมชาย วงศ์ประเสริฐ', start: '15-07-2026 08:47:19', wait: '00:00:09', dur: '00:03:22', wrap: 'Resolved', state: 'completed' },
];

var RECORDINGS = [
  { id: 'REC-9001', contact: '+66 81 234 5678', agent: 'สมชาย วงศ์ประเสริฐ', queue: 'General Support', start: '15-07-2026 10:21:04', dur: '00:04:31', size: '2.1 MB' },
  { id: 'REC-9000', contact: '+66 89 555 1200', agent: 'Maria Garcia', queue: 'VIP Customers', start: '15-07-2026 10:05:33', dur: '00:09:12', size: '4.4 MB' },
  { id: 'REC-8999', contact: '+66 86 777 3456', agent: 'สมหญิง ใจดี', queue: 'Outbound', start: '15-07-2026 09:58:20', dur: '00:02:47', size: '1.3 MB' },
  { id: 'REC-8998', contact: '+66 82 000 9911', agent: 'อรทัย พูลสวัสดิ์', queue: 'Sales (TH)', start: '14-07-2026 17:44:06', dur: '00:11:58', size: '5.6 MB' },
];

var USERS = [
  { name: 'Krit S.', email: 'krit@acme.co.th', role: 'ADMIN', last: '15-07-2026 10:02', active: true },
  { name: 'สมพร หัวหน้าทีม', email: 'somporn@acme.co.th', role: 'SUPERVISOR', last: '15-07-2026 09:45', active: true },
  { name: 'สมชาย วงศ์ประเสริฐ', email: 'somchai@acme.co.th', role: 'AGENT', last: '15-07-2026 08:01', active: true },
  { name: 'สมหญิง ใจดี', email: 'somying@acme.co.th', role: 'AGENT', last: '15-07-2026 08:00', active: true },
  { name: 'Former Staff', email: 'old@acme.co.th', role: 'AGENT', last: '02-05-2026 17:12', active: false },
];

var AUDIT = [
  { at: '15-07-2026 09:12', user: 'krit@acme.co.th', action: 'queue.update', detail: 'Queue "VIP Customers": SLA 15s → 10s' },
  { at: '15-07-2026 08:47', user: 'somporn@acme.co.th', action: 'agent.state.force', detail: 'Force "อรทัย" Break → Available' },
  { at: '14-07-2026 18:30', user: 'krit@acme.co.th', action: 'user.invite', detail: 'Invited maria.g@acme.co.th (AGENT)' },
  { at: '14-07-2026 16:05', user: 'krit@acme.co.th', action: 'channel.line.connect', detail: 'Connected LINE OA @acme-support' },
  { at: '14-07-2026 11:20', user: 'somporn@acme.co.th', action: 'queue.create', detail: 'Created queue "Billing Inquiries"' },
];

var CONVS = [
  { ch: 'webchat', name: 'Guest #8812', preview: 'หน้าชำระเงินขึ้น error ครับ กดจ่ายแล้วไม่ไปต่อ', time: '2m', unread: 2 },
  { ch: 'line', name: '@wichai_t', preview: 'สนใจแพ็กเกจ 50 users ครับ มีส่วนลดไหม', time: '7m', unread: 1 },
  { ch: 'voice', name: '+66 81 234 5678', preview: 'Incoming call · General Support', time: 'now', unread: 0, live: true },
  { ch: 'whatsapp', name: 'David Kim', preview: 'Can you resend the invoice for June?', time: '18m', unread: 1 },
  { ch: 'email', name: 'maysa@brightedu.ac.th', preview: 'RE: ขอใบเสนอราคาระบบ contact center', time: '1h', unread: 0 },
];

/* ============================================================
   Renderers — ทุกตัว self-guard: ถ้าไม่มี element ในหน้านั้นจะข้าม
   ============================================================ */
var dots = '<i class="ti ti-dots"></i>';

function renderQueues() {
  var b = document.getElementById('queues-body'); if (!b) return;
  b.innerHTML = QUEUES.map(function (q, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + q.name + '</td>' +
      '<td class="px-4 py-3"><div class="flex flex-wrap gap-1">' + q.channels.map(chBadge).join('') + '</div></td>' +
      '<td class="px-4 py-3 text-slate-600">' + q.skills + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + q.sla + 's</td>' +
      '<td class="px-4 py-3 text-slate-600">' + q.agents + '</td>' +
      '<td class="px-4 py-3 ' + (q.waiting > 4 ? 'text-rose-600 font-semibold' : 'text-slate-600') + '">' + q.waiting + '</td>' +
      '<td class="px-4 py-3">' + (q.active ? '<span class="st st-available">Active</span>' : '<span class="st st-break">Paused</span>') + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="editQueue(' + i + ')" title="Edit"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}
function newQueue() {
  ['qf-name', 'qf-skills'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('qf-sla').value = 20;
  document.getElementById('qf-priority').value = 1;
  document.querySelectorAll('.qf-ch').forEach(function (c) { c.checked = false; });
  document.getElementById('qf-heading').textContent = currentLang === 'th' ? 'สร้างคิวใหม่' : 'New queue';
  showView('queue-form');
}
function editQueue(i) {
  var q = QUEUES[i];
  document.getElementById('qf-name').value = q.name;
  document.getElementById('qf-skills').value = q.skills;
  document.getElementById('qf-sla').value = q.sla;
  document.getElementById('qf-priority').value = q.priority;
  document.querySelectorAll('.qf-ch').forEach(function (c) { c.checked = q.channels.indexOf(c.value) !== -1; });
  document.getElementById('qf-heading').textContent = (currentLang === 'th' ? 'แก้ไขคิว — ' : 'Edit queue — ') + q.name;
  showView('queue-form');
}
function saveQueue() { toast(currentLang === 'th' ? 'บันทึกคิวแล้ว (mock)' : 'Queue saved (mock)'); showView('queues'); }

function renderAgents() {
  var b = document.getElementById('agents-body'); if (!b) return;
  b.innerHTML = AGENTS.map(function (a, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-semibold">' + a.name.charAt(0) + '</div>' +
      '<div><p class="font-medium text-slate-800">' + a.name + '</p><p class="text-xs text-slate-400">' + a.email + '</p></div></div></td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.ext + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.team + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.skills + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.voice + ' call · ' + a.chat + ' chats</td>' +
      '<td class="px-4 py-3">' + stPill(a.state) + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="editAgent(' + i + ')" title="Edit"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}
function newAgent() {
  ['af-name', 'af-email', 'af-ext', 'af-skills'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('af-team').value = 'Support A';
  document.getElementById('af-voice').value = 1;
  document.getElementById('af-chat').value = 3;
  document.getElementById('af-heading').textContent = currentLang === 'th' ? 'เพิ่มเอเจนต์' : 'New agent';
  showView('agent-form');
}
function editAgent(i) {
  var a = AGENTS[i];
  document.getElementById('af-name').value = a.name;
  document.getElementById('af-email').value = a.email;
  document.getElementById('af-ext').value = a.ext;
  document.getElementById('af-skills').value = a.skills;
  document.getElementById('af-team').value = a.team;
  document.getElementById('af-voice').value = a.voice;
  document.getElementById('af-chat').value = a.chat;
  document.getElementById('af-heading').textContent = (currentLang === 'th' ? 'แก้ไขเอเจนต์ — ' : 'Edit agent — ') + a.name;
  showView('agent-form');
}
function saveAgent() { toast(currentLang === 'th' ? 'บันทึกเอเจนต์แล้ว (mock)' : 'Agent saved (mock)'); showView('agents'); }

function renderTeams() {
  var b = document.getElementById('teams-body'); if (!b) return;
  b.innerHTML = TEAMS.map(function (t) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + t.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.lead + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.members + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + t.queues + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}

function renderContacts() {
  var b = document.getElementById('contacts-body'); if (!b) return;
  b.innerHTML = CONTACTS.map(function (c, i) {
    var ids = [];
    if (c.phone) ids.push('<span class="ch ch-voice"><i class="ti ti-phone"></i>' + c.phone + '</span>');
    if (c.line) ids.push('<span class="ch ch-line"><i class="ti ti-brand-line"></i>' + c.line + '</span>');
    if (c.email) ids.push('<span class="ch ch-email"><i class="ti ti-mail"></i>' + c.email + '</span>');
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + c.name + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.company + '</td>' +
      '<td class="px-4 py-3"><div class="flex flex-wrap gap-1">' + ids.join('') + '</div></td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.last + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + c.total + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="editContact(' + i + ')" title="Edit"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}
function newContact() {
  ['cf-name', 'cf-company', 'cf-phone', 'cf-line', 'cf-email'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('cf-heading').textContent = currentLang === 'th' ? 'เพิ่มลูกค้า' : 'New contact';
  showView('contact-form');
}
function editContact(i) {
  var c = CONTACTS[i];
  document.getElementById('cf-name').value = c.name;
  document.getElementById('cf-company').value = c.company;
  document.getElementById('cf-phone').value = c.phone;
  document.getElementById('cf-line').value = c.line;
  document.getElementById('cf-email').value = c.email;
  document.getElementById('cf-heading').textContent = (currentLang === 'th' ? 'แก้ไขลูกค้า — ' : 'Edit contact — ') + c.name;
  showView('contact-form');
}
function saveContact() { toast(currentLang === 'th' ? 'บันทึกลูกค้าแล้ว (mock)' : 'Contact saved (mock)'); showView('contacts'); }

function renderNumbers() {
  var b = document.getElementById('numbers-body'); if (!b) return;
  b.innerHTML = NUMBERS.map(function (n, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + n.num + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + n.label + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + n.route + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + n.trunk + '</td>' +
      '<td class="px-4 py-3">' + (n.active ? '<span class="st st-available">Active</span>' : '<span class="st st-offline">Inactive</span>') + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="editNumber(' + i + ')" title="Edit"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}
function newNumber() {
  ['nf-num', 'nf-label'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('nf-heading').textContent = currentLang === 'th' ? 'เพิ่มเบอร์' : 'New number';
  showView('number-form');
}
function editNumber(i) {
  var n = NUMBERS[i];
  document.getElementById('nf-num').value = n.num;
  document.getElementById('nf-label').value = n.label;
  document.getElementById('nf-heading').textContent = (currentLang === 'th' ? 'แก้ไขเบอร์ — ' : 'Edit number — ') + n.num;
  showView('number-form');
}
function saveNumber() { toast(currentLang === 'th' ? 'บันทึกเบอร์แล้ว (mock)' : 'Number saved (mock)'); showView('numbers'); }

function renderInteractions() {
  var b = document.getElementById('inter-body'); if (!b) return;
  b.innerHTML = INTERACTIONS.map(function (r) {
    var arrow = r.dir === 'out' ? '<i class="ti ti-arrow-up-right text-blue-600"></i>' : '<i class="ti ti-arrow-down-left text-emerald-600"></i>';
    var st = r.state === 'abandoned' ? '<span class="st st-busy">Abandoned</span>' : '<span class="st st-available">Completed</span>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50 text-[13px]">' +
      '<td class="px-3 py-2.5">' + arrow + '</td>' +
      '<td class="px-3 py-2.5">' + chBadge(r.ch) + '</td>' +
      '<td class="px-3 py-2.5 font-medium text-slate-700">' + r.contact + '</td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + r.queue + '</td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + r.agent + '</td>' +
      '<td class="px-3 py-2.5 text-slate-500">' + r.start + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.wait + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.dur + '</td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + r.wrap + '</td>' +
      '<td class="px-3 py-2.5">' + st + '</td></tr>';
  }).join('');
  var mh = document.getElementById('myhis-body');
  if (mh) mh.innerHTML = b.innerHTML;
}

function renderRecordings() {
  var b = document.getElementById('rec-body'); if (!b) return;
  b.innerHTML = RECORDINGS.map(function (r) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><span class="icon-btn bg-teal-50 text-teal-700"><i class="ti ti-player-play-filled"></i></span></td>' +
      '<td class="px-4 py-3 font-medium text-slate-700">' + r.id + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.contact + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.agent + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.queue + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + r.start + '</td>' +
      '<td class="px-4 py-3 text-right text-slate-600">' + r.dur + '</td>' +
      '<td class="px-4 py-3 text-right text-slate-500">' + r.size + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn"><i class="ti ti-download"></i></span></td></tr>';
  }).join('');
}

function renderUsers() {
  var b = document.getElementById('users-body'); if (!b) return;
  var roleColor = { ADMIN: 'bg-rose-50 text-rose-700', SUPERVISOR: 'bg-amber-50 text-amber-700', AGENT: 'bg-teal-50 text-teal-700' };
  b.innerHTML = USERS.map(function (u, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><p class="font-medium text-slate-800">' + u.name + '</p><p class="text-xs text-slate-400">' + u.email + '</p></td>' +
      '<td class="px-4 py-3"><span class="text-xs font-semibold px-2 py-1 rounded-md ' + roleColor[u.role] + '">' + u.role + '</span></td>' +
      '<td class="px-4 py-3 text-slate-500">' + u.last + '</td>' +
      '<td class="px-4 py-3">' + (u.active ? '<span class="st st-available">Active</span>' : '<span class="st st-offline">Disabled</span>') + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="editUser(' + i + ')" title="Edit"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}
function newUser() {
  ['uf-name', 'uf-email'].forEach(function (id) { document.getElementById(id).value = ''; });
  document.getElementById('uf-role').value = 'AGENT';
  document.getElementById('uf-heading').textContent = currentLang === 'th' ? 'เชิญผู้ใช้' : 'Invite user';
  showView('user-form');
}
function editUser(i) {
  var u = USERS[i];
  document.getElementById('uf-name').value = u.name;
  document.getElementById('uf-email').value = u.email;
  document.getElementById('uf-role').value = u.role;
  document.getElementById('uf-heading').textContent = (currentLang === 'th' ? 'แก้ไขผู้ใช้ — ' : 'Edit user — ') + u.name;
  showView('user-form');
}
function saveUser() { toast(currentLang === 'th' ? 'บันทึกผู้ใช้แล้ว (mock)' : 'User saved (mock)'); showView('users'); }

function renderAudit() {
  var b = document.getElementById('audit-body'); if (!b) return;
  b.innerHTML = AUDIT.map(function (a) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3 text-slate-500 whitespace-nowrap">' + a.at + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.user + '</td>' +
      '<td class="px-4 py-3"><code class="text-xs bg-slate-100 rounded px-1.5 py-0.5 text-slate-700">' + a.action + '</code></td>' +
      '<td class="px-4 py-3 text-slate-600">' + a.detail + '</td></tr>';
  }).join('');
}

function renderQueueLive() {
  var b = document.getElementById('dash-queue-body'); if (!b) return;
  b.innerHTML = QUEUES.map(function (q) {
    var pct = q.active ? Math.max(35, 100 - q.waiting * 9) : 0;
    var color = pct >= 80 ? '#16a34a' : pct >= 60 ? '#d97706' : '#dc2626';
    return '<tr class="border-b border-slate-100">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + q.name + '</td>' +
      '<td class="px-4 py-3"><div class="flex flex-wrap gap-1">' + q.channels.map(chBadge).join('') + '</div></td>' +
      '<td class="px-4 py-3 ' + (q.waiting > 4 ? 'text-rose-600 font-semibold' : 'text-slate-700') + '">' + q.waiting + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + (q.waiting ? '00:0' + Math.min(9, q.waiting) + ':1' + q.waiting : '—') + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + q.agents + '</td>' +
      '<td class="px-4 py-3"><div class="flex items-center gap-2"><div class="h-2 rounded-full bg-slate-100 overflow-hidden w-28">' +
      '<div class="h-full rounded-full" style="width:' + pct + '%;background:' + color + '"></div></div>' +
      '<span class="text-xs text-slate-500">' + (q.active ? pct + '%' : 'paused') + '</span></div></td></tr>';
  }).join('');
}

function renderInbox() {
  var list = document.getElementById('conv-list'); if (!list) return;
  list.innerHTML = CONVS.map(function (c, i) {
    var live = c.live ? '<span class="st st-busy" style="font-size:11px">ringing</span>' : '';
    var unread = c.unread ? '<span class="badge" style="margin-left:0">' + c.unread + '</span>' : '';
    return '<div class="conv-item' + (i === 0 ? ' active' : '') + '">' +
      '<span class="ch ch-' + c.ch + '" style="height:28px;width:28px;justify-content:center;padding:0"><i class="ti ' + CH_ICON[c.ch] + '"></i></span>' +
      '<div class="flex-1 min-w-0"><div class="flex items-center justify-between gap-2"><p class="font-medium text-sm text-slate-800 truncate">' + c.name + '</p>' +
      '<span class="text-xs text-slate-400 shrink-0">' + c.time + '</span></div>' +
      '<div class="flex items-center justify-between gap-2"><p class="text-xs text-slate-500 truncate">' + c.preview + '</p>' + unread + live + '</div></div></div>';
  }).join('');
}

/* ---------- charts ---------- */
var CH_COLORS = { voice: '#4338ca', webchat: '#0f766e', line: '#15803d', facebook: '#1d4ed8', whatsapp: '#047857', email: '#b45309' };
function renderCharts() {
  if (!window.Chart) return;
  Chart.defaults.font.size = 11;
  var hourEl = document.getElementById('chart-hour');
  if (hourEl && !hourEl.dataset.done) {
    hourEl.dataset.done = '1';
    var hours = Array.from({ length: 24 }, function (_, i) { return (i < 10 ? '0' : '') + i; });
    var base = [0, 0, 0, 0, 0, 0, 2, 24, 68, 122, 138, 116, 61, 104, 131, 118, 96, 54, 18, 6, 2, 0, 0, 0];
    var mk = function (label, ratio) {
      return { label: label, backgroundColor: CH_COLORS[label], data: base.map(function (v) { return Math.round(v * ratio); }), stack: 'ch', categoryPercentage: .75, barPercentage: .95 };
    };
    new Chart(hourEl, { type: 'bar', data: { labels: hours, datasets: [mk('voice', .48), mk('webchat', .22), mk('line', .14), mk('email', .09), mk('whatsapp', .07)] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } }, y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 } } } }, plugins: { legend: { position: 'top', labels: { boxWidth: 12 } }, tooltip: { mode: 'index' } } } });
  }
  var pieEl = document.getElementById('chart-channel');
  if (pieEl && !pieEl.dataset.done) {
    pieEl.dataset.done = '1';
    var vol = { voice: 612, webchat: 284, line: 178, email: 120, whatsapp: 86, facebook: 64 };
    var keys = Object.keys(vol);
    new Chart(pieEl, { type: 'doughnut', data: { labels: keys, datasets: [{ data: keys.map(function (k) { return vol[k]; }), backgroundColor: keys.map(function (k) { return CH_COLORS[k]; }), borderWidth: 1, borderColor: '#fff' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } } });
  }
  var slaEl = document.getElementById('chart-sla');
  if (slaEl && !slaEl.dataset.done) {
    slaEl.dataset.done = '1';
    new Chart(slaEl, { type: 'bar', data: { labels: QUEUES.map(function (q) { return q.name; }), datasets: [
      { label: 'SLA %', data: [92, 88, 76, 97, 61], backgroundColor: [92, 88, 76, 97, 61].map(function (v) { return v >= 80 ? '#16a34a' : v >= 70 ? '#d97706' : '#dc2626'; }), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, max: 100, ticks: { callback: function (v) { return v + '%'; } } }, x: { grid: { display: false } } }, plugins: { legend: { display: false } } } });
  }
  var volEl = document.getElementById('chart-volume');
  if (volEl && !volEl.dataset.done) {
    volEl.dataset.done = '1';
    var labels = [], series = { voice: [], webchat: [], line: [], email: [] };
    for (var i = 13; i >= 0; i--) {
      var d = new Date(2026, 6, 15); d.setDate(d.getDate() - i);
      labels.push(d.getDate() + '/' + (d.getMonth() + 1));
      var weekend = d.getDay() === 0 || d.getDay() === 6;
      var all = weekend ? 240 + (i * 37) % 90 : 980 + (i * 83) % 380;
      series.voice.push(Math.round(all * .5)); series.webchat.push(Math.round(all * .22));
      series.line.push(Math.round(all * .17)); series.email.push(Math.round(all * .11));
    }
    new Chart(volEl, { type: 'bar', data: { labels: labels, datasets: Object.keys(series).map(function (k) {
      return { label: k, data: series[k], backgroundColor: CH_COLORS[k], stack: 'v', categoryPercentage: .7, barPercentage: .95 };
    }) }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } }, y: { stacked: true, beginAtZero: true } }, plugins: { legend: { position: 'top', labels: { boxWidth: 12 } }, tooltip: { mode: 'index' } } } });
  }
}

/* ---------- boot ---------- */
function renderAll() {
  renderQueues(); renderAgents(); renderTeams(); renderContacts(); renderNumbers();
  renderInteractions(); renderRecordings(); renderUsers(); renderAudit();
  renderQueueLive(); renderInbox(); renderCharts();
}
function initApp() {
  var area = document.body.dataset.area; if (!area) return;
  var def = document.body.dataset.default;
  var app = document.getElementById('app');
  app.className = 'flex min-h-screen';
  app.innerHTML = buildRail(area) + buildPanel(area) + '<div id="content-col" class="flex-1 flex flex-col min-w-0">' + HEADER + '</div>';
  var tmpl = document.getElementById('area-main');
  if (tmpl) document.getElementById('content-col').appendChild(tmpl.content.cloneNode(true));
  document.querySelectorAll('.nav-item').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); if (a.dataset.view) showView(a.dataset.view); });
  });
  document.getElementById('lang-en').addEventListener('click', function () { setLanguage('en'); });
  document.getElementById('lang-th').addEventListener('click', function () { setLanguage('th'); });
  var lang = 'en'; try { lang = localStorage.getItem('dcontact.lang') || 'en'; } catch (e) {}
  setLanguage(lang);
  renderAll();
  var forced = new URLSearchParams(window.location.search).get('view');
  showView(forced || def);
}
document.addEventListener('DOMContentLoaded', initApp);
