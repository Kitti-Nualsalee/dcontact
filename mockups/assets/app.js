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
  ['supervisor', 'ti-binoculars', 'rlSupervise', 'Supervise'],
  ['outbound', 'ti-phone-outgoing', 'rlOutbound', 'Outbound'],
  ['journeys', 'ti-route-2', 'rlJourneys', 'Journeys'],
  ['governance', 'ti-shield-check', 'rlGovernance', 'Governance'],
  ['cases', 'ti-ticket', 'rlCases', 'Cases'],
  ['routing', 'ti-route', 'rlRouting', 'Routing'],
  ['ai', 'ti-sparkles', 'rlAi', 'AI'],
  ['people', 'ti-users', 'rlPeople', 'People'],
  ['wfm', 'ti-calendar-time', 'rlWfm', 'Workforce'],
  ['qm', 'ti-clipboard-check', 'rlQm', 'Quality'],
  ['analytics', 'ti-chart-dots', 'rlAnalytics', 'Analytics'],
  ['integrations', 'ti-plug-connected', 'rlIntegrations', 'Integrations'],
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
  supervisor: [
    { type: 'label', i18n: 'slSupervise', text: 'Supervision' },
    { type: 'item', view: 'pulse', icon: 'ti-activity-heartbeat', i18n: 'navPulse', text: 'Team pulse', badgeNew: 'LIVE' },
    { type: 'item', view: 'live', icon: 'ti-radar-2', i18n: 'navLive', text: 'Live interactions', badge: '31' },
    { type: 'item', view: 'queue-control', icon: 'ti-adjustments-bolt', i18n: 'navQueueCtl', text: 'Queue control' },
    { type: 'item', view: 'alerts', icon: 'ti-bell-exclamation', i18n: 'navAlerts', text: 'Alerts', badge: '3' },
    { type: 'label', i18n: 'slSupQuality', text: 'Quality' },
    { type: 'item', view: 'evaluations', icon: 'ti-clipboard-check', i18n: 'navEvals', text: 'Evaluations', badge: '5' },
    { type: 'item', view: 'coaching', icon: 'ti-school', i18n: 'navCoaching', text: 'Coaching' },
    { type: 'label', i18n: 'slSupInbox', text: 'My inbox' },
    { type: 'item', view: 'approvals', icon: 'ti-checkbox', i18n: 'navApprovals', text: 'Approvals', badge: '4' },
  ],
  outbound: [
    { type: 'label', i18n: 'slOutbound', text: 'Outbound' },
    { type: 'item', view: 'campaigns', icon: 'ti-speakerphone', i18n: 'navCampaigns', text: 'Campaigns', badgeNew: 'NEW' },
    { type: 'item', view: 'monitor', icon: 'ti-gauge', i18n: 'navObMonitor', text: 'Campaign monitor', badgeNew: 'LIVE' },
    { type: 'item', view: 'lists', icon: 'ti-list-details', i18n: 'navObLists', text: 'Contact lists' },
    { type: 'item', view: 'callbacks', icon: 'ti-phone-incoming', i18n: 'navObCallbacks', text: 'Callbacks', badge: '6' },
    { type: 'label', i18n: 'slObProactive', text: 'Proactive' },
    { type: 'item', view: 'proactive', icon: 'ti-send', i18n: 'navObProactive', text: 'Message broadcasts' },
    { type: 'label', i18n: 'slObSetup', text: 'Setup' },
    { type: 'item', view: 'dispositions', icon: 'ti-tag', i18n: 'navObDisp', text: 'Dispositions' },
  ],
  // CX automation — journey ผูกกับลูกค้า ไม่ใช่ interaction (ADR-025)
  journeys: [
    { type: 'label', i18n: 'slJourney', text: 'CX automation' },
    { type: 'item', view: 'journeys', icon: 'ti-route-2', i18n: 'navJourneys', text: 'Journeys', badgeNew: 'NEW' },
    { type: 'item', view: 'journey-insights', icon: 'ti-chart-arcs', i18n: 'navJrInsights', text: 'Journey results' },
    { type: 'label', i18n: 'slJrSetup', text: 'Setup' },
    { type: 'item', view: 'segments', icon: 'ti-users-group', i18n: 'navSegments', text: 'Segments' },
  ],
  governance: [
    { type: 'label', i18n: 'slCgControl', text: 'Contact control' },
    { type: 'item', view: 'overview', icon: 'ti-layout-dashboard', i18n: 'navCgOverview', text: 'Overview', badgeNew: 'NEW' },
    { type: 'item', view: 'decisions', icon: 'ti-route-square-2', i18n: 'navCgDecisions', text: 'Decision explorer' },
    { type: 'label', i18n: 'slCgRights', text: 'Customer rights' },
    { type: 'item', view: 'restrictions', icon: 'ti-ban', i18n: 'navCgRestrictions', text: 'Restrictions', badge: '3' },
    { type: 'item', view: 'consent', icon: 'ti-user-shield', i18n: 'navCgConsent', text: 'Consent & preferences' },
    { type: 'item', view: 'exceptions', icon: 'ti-shield-up', i18n: 'navCgExceptions', text: 'Approved exceptions', badge: '2' },
    { type: 'label', i18n: 'slCgSetup', text: 'Policy & assurance' },
    { type: 'item', view: 'policies', icon: 'ti-adjustments-horizontal', i18n: 'navCgPolicies', text: 'Policies' },
    { type: 'item', view: 'senders', icon: 'ti-id-badge-2', i18n: 'navCgSenders', text: 'Sender & caller IDs' },
    { type: 'item', view: 'team-scopes', icon: 'ti-users-group', i18n: 'navCgScopes', text: 'Team scopes', badge: '6' },
    { type: 'item', view: 'audit', icon: 'ti-file-search', i18n: 'navCgAudit', text: 'Audit & reports' },
  ],
  cases: [
    { type: 'label', i18n: 'slCases', text: 'Case management' },
    { type: 'item', view: 'cases', icon: 'ti-ticket', i18n: 'navCsAll', text: 'All cases', badge: '18' },
    { type: 'item', view: 'my-cases', icon: 'ti-user-check', i18n: 'navCsMine', text: 'My cases', badge: '7' },
    { type: 'label', i18n: 'slCsSetup', text: 'Setup' },
    { type: 'item', view: 'case-types', icon: 'ti-category', i18n: 'navCsTypes', text: 'Case types' },
    { type: 'item', view: 'case-sla', icon: 'ti-clock-exclamation', i18n: 'navCsSla', text: 'SLA policies' },
  ],
  ai: [
    { type: 'label', i18n: 'slAiBot', text: 'Self-service' },
    { type: 'item', view: 'bots', icon: 'ti-robot', i18n: 'navAiBots', text: 'Virtual agents', badgeNew: 'NEW' },
    { type: 'item', view: 'bot-tests', icon: 'ti-flask', i18n: 'navAiTests', text: 'Test sets' },
    { type: 'item', view: 'deflection', icon: 'ti-arrow-fork', i18n: 'navAiDeflect', text: 'Deflection' },
    { type: 'label', i18n: 'slAiKb', text: 'Knowledge' },
    { type: 'item', view: 'kb', icon: 'ti-book', i18n: 'navAiKb', text: 'Articles' },
    { type: 'item', view: 'kb-gaps', icon: 'ti-help-circle', i18n: 'navAiGaps', text: 'Knowledge gaps', badge: '9' },
    { type: 'label', i18n: 'slAiAssist', text: 'Agent assist' },
    { type: 'item', view: 'assist-settings', icon: 'ti-adjustments', i18n: 'navAiAssist', text: 'Assist settings' },
    { type: 'item', view: 'assist-prompts', icon: 'ti-message-code', i18n: 'navAiPrompts', text: 'Prompts' },
    { type: 'item', view: 'assist-playbooks', icon: 'ti-list-check', i18n: 'navAiPlaybooks', text: 'Playbooks' },
    { type: 'item', view: 'assist-scripts', icon: 'ti-list-numbers', i18n: 'navAiScripts', text: 'Guided scripts', badgeNew: 'NEW' },
    { type: 'item', view: 'assist-quality', icon: 'ti-chart-arrows', i18n: 'navAiQuality', text: 'Assist quality' },
  ],
  analytics: [
    { type: 'label', i18n: 'slIa', text: 'Interaction analytics' },
    { type: 'item', view: 'ia-overview', icon: 'ti-chart-dots', i18n: 'navIaOverview', text: 'Overview' },
    { type: 'item', view: 'ia-topics', icon: 'ti-tags', i18n: 'navIaTopics', text: 'Topics', badgeNew: 'NEW' },
    { type: 'item', view: 'ia-search', icon: 'ti-search', i18n: 'navIaSearch', text: 'Search conversations' },
    { type: 'item', view: 'ia-searches', icon: 'ti-bookmark', i18n: 'navIaSaved', text: 'Saved searches' },
    { type: 'label', i18n: 'slFb', text: 'Voice of customer' },
    { type: 'item', view: 'fb-overview', icon: 'ti-mood-smile', i18n: 'navFbOverview', text: 'CSAT / NPS' },
    { type: 'item', view: 'fb-surveys', icon: 'ti-clipboard-text', i18n: 'navFbSurveys', text: 'Surveys' },
    { type: 'item', view: 'fb-plans', icon: 'ti-target-arrow', i18n: 'navFbPlans', text: 'Survey plans' },
    { type: 'item', view: 'fb-responses', icon: 'ti-message-2-star', i18n: 'navFbResponses', text: 'Responses', badge: '3' },
    { type: 'label', i18n: 'slPm', text: 'Performance' },
    { type: 'item', view: 'pm-team', icon: 'ti-users-group', i18n: 'navPmTeam', text: 'Team scorecard' },
    { type: 'item', view: 'pm-scorecards', icon: 'ti-award', i18n: 'navPmCards', text: 'Scorecards' },
    { type: 'item', view: 'pm-gamification', icon: 'ti-trophy', i18n: 'navPmGame', text: 'Gamification' },
    { type: 'item', view: 'pm-mine', icon: 'ti-user-star', i18n: 'navPmMine', text: 'My performance' },
    { type: 'label', i18n: 'slCollab', text: 'Collaboration' },
    { type: 'item', view: 'co-insights', icon: 'ti-messages', i18n: 'navCoInsights', text: 'Consult insights', badgeNew: 'NEW' },
  ],
  routing: [
    { type: 'label', i18n: 'slRouting', text: 'Routing' },
    { type: 'item', view: 'queues', icon: 'ti-stack-2', i18n: 'navQueues', text: 'Queues' },
    { type: 'item', view: 'skills', icon: 'ti-certificate', i18n: 'navSkills', text: 'Skills' },
    { type: 'item', view: 'hours', icon: 'ti-clock-cog', i18n: 'navHours', text: 'Business hours' },
    { type: 'item', view: 'flows', icon: 'ti-sitemap', i18n: 'navFlows', text: 'Flows', badgeNew: 'NEW' },
  ],
  people: [
    { type: 'label', i18n: 'slPeople', text: 'People' },
    { type: 'item', view: 'agents', icon: 'ti-headset', i18n: 'navAgents', text: 'Agents' },
    { type: 'item', view: 'teams', icon: 'ti-users-group', i18n: 'navTeams', text: 'Teams' },
    { type: 'item', view: 'contacts', icon: 'ti-address-book', i18n: 'navContacts', text: 'Contacts' },
    { type: 'item', view: 'identities', icon: 'ti-git-merge', i18n: 'navIdentities', text: 'Identity merge', badge: '4' },
  ],
  wfm: [
    { type: 'label', i18n: 'slWfm', text: 'Workforce management' },
    { type: 'item', view: 'schedule', icon: 'ti-calendar-week', i18n: 'navSchedule', text: 'Schedules', badgeNew: 'NEW' },
    { type: 'item', view: 'forecast', icon: 'ti-chart-histogram', i18n: 'navForecast', text: 'Forecast & staffing' },
    { type: 'item', view: 'adherence', icon: 'ti-activity-heartbeat', i18n: 'navAdherence', text: 'Adherence (RTA)' },
    { type: 'item', view: 'intraday', icon: 'ti-adjustments-alt', i18n: 'navIntraday', text: 'Intraday' },
    { type: 'item', view: 'timeoff', icon: 'ti-beach', i18n: 'navTimeoff', text: 'Time off', badge: '3' },
    { type: 'label', i18n: 'slWfmSetup', text: 'Setup' },
    { type: 'item', view: 'sites', icon: 'ti-building-community', i18n: 'navSites', text: 'Sites & rules' },
    { type: 'label', i18n: 'slWfmMe', text: 'My workforce' },
    { type: 'item', view: 'my-schedule', icon: 'ti-user-check', i18n: 'navMySchedule', text: 'My schedule' },
  ],
  qm: [
    { type: 'label', i18n: 'slQm', text: 'Quality management' },
    { type: 'item', view: 'queue', icon: 'ti-clipboard-list', i18n: 'navQmQueue', text: 'Evaluation queue', badge: '5' },
    { type: 'item', view: 'calibration', icon: 'ti-scale-outline', i18n: 'navQmCal', text: 'Calibration' },
    { type: 'item', view: 'appeals', icon: 'ti-gavel', i18n: 'navQmAppeals', text: 'Appeals', badge: '2' },
    { type: 'item', view: 'coaching-qm', icon: 'ti-school', i18n: 'navQmCoach', text: 'Coaching' },
    { type: 'label', i18n: 'slQmData', text: 'Interaction data' },
    { type: 'item', view: 'media', icon: 'ti-microphone-2', i18n: 'navQmMedia', text: 'Recordings & transcripts' },
    { type: 'item', view: 'categories', icon: 'ti-tags', i18n: 'navQmCats', text: 'Categories', badgeNew: 'NEW' },
    { type: 'item', view: 'insights', icon: 'ti-chart-dots', i18n: 'navQmInsights', text: 'Quality insights' },
    { type: 'label', i18n: 'slQmSetup', text: 'Setup' },
    { type: 'item', view: 'forms', icon: 'ti-forms', i18n: 'navQmForms', text: 'Evaluation forms' },
    { type: 'item', view: 'plans', icon: 'ti-target-arrow', i18n: 'navQmPlans', text: 'Quality plans' },
    { type: 'item', view: 'compliance', icon: 'ti-shield-lock', i18n: 'navQmCompliance', text: 'Recording & retention' },
    { type: 'label', i18n: 'slQmMe', text: 'My quality' },
    { type: 'item', view: 'my-quality', icon: 'ti-user-star', i18n: 'navQmMine', text: 'My scores' },
  ],
  // ทุกอย่างที่ต่อกับของนอกระบบอยู่ที่เดียว แบ่ง 3 กลุ่ม: รับงานเข้า / ระบบภายนอก / นักพัฒนา
  integrations: [
    { type: 'item', view: 'overview', icon: 'ti-layout-dashboard', i18n: 'navIntOverview', text: 'Overview', badgeNew: 'NEW' },
    { type: 'label', i18n: 'slIntSources', text: 'Work sources' },
    { type: 'item', view: 'numbers', icon: 'ti-phone', i18n: 'navNumbers', text: 'Voice numbers' },
    { type: 'item', view: 'webchat', icon: 'ti-message-circle', i18n: 'navWebchat', text: 'Web chat' },
    { type: 'item', view: 'social', icon: 'ti-brand-line', i18n: 'navSocial', text: 'Social & messaging' },
    { type: 'item', view: 'email', icon: 'ti-mail', i18n: 'navEmail', text: 'Email' },
    { type: 'label', i18n: 'slIntSystems', text: 'Business systems' },
    { type: 'item', view: 'apps', icon: 'ti-apps', i18n: 'navIntApps', text: 'Connected apps' },
    { type: 'item', view: 'connectors', icon: 'ti-plug', i18n: 'navIntConnectors', text: 'Connectors', badgeNew: 'NEW' },
    { type: 'item', view: 'contact-sync', icon: 'ti-address-book', i18n: 'navIntContacts', text: 'Contact sync' },
    { type: 'item', view: 'ai-providers', icon: 'ti-sparkles', i18n: 'navIntAi', text: 'AI providers' },
    { type: 'label', i18n: 'slIntDev', text: 'For developers' },
    { type: 'item', view: 'api-clients', icon: 'ti-key', i18n: 'navIntApi', text: 'API clients' },
    { type: 'item', view: 'webhooks', icon: 'ti-webhook', i18n: 'navIntHooks', text: 'Webhooks' },
    { type: 'item', view: 'visual-apps', icon: 'ti-layout-sidebar-right', i18n: 'navIntVisual', text: 'Visual apps', badgeNew: 'NEW' },
    { type: 'item', view: 'streaming', icon: 'ti-broadcast', i18n: 'navIntStream', text: 'Streaming & data feed' },
    { type: 'item', view: 'event-catalog', icon: 'ti-book-2', i18n: 'navIntCatalog', text: 'Event catalog & API docs' },
  ],
  history: [
    { type: 'label', i18n: 'slHistory', text: 'Interaction data' },
    { type: 'item', view: 'interactions', icon: 'ti-list-search', i18n: 'navInteractions', text: 'Interactions' },
    { type: 'item', view: 'recordings', icon: 'ti-player-play', i18n: 'navRecordings', text: 'Recordings' },
    { type: 'item', view: 'flow-trace', icon: 'ti-route-square-2', i18n: 'navFlowTrace', text: 'Flow trace', badgeNew: 'NEW' },
  ],
  reports: [
    { type: 'label', i18n: 'slReports', text: 'Reports' },
    { type: 'item', view: 'rpt-sla', icon: 'ti-target-arrow', i18n: 'navRptSla', text: 'Queue SLA' },
    { type: 'item', view: 'rpt-agents', icon: 'ti-user-star', i18n: 'navRptAgents', text: 'Agent performance' },
    { type: 'item', view: 'rpt-volume', icon: 'ti-chart-bar', i18n: 'navRptVolume', text: 'Channel volume' },
    { type: 'label', i18n: 'slRptSelf', text: 'Self-service reporting' },
    { type: 'item', view: 'rpt-library', icon: 'ti-folders', i18n: 'navRptLib', text: 'Report library' },
    { type: 'item', view: 'rpt-builder', icon: 'ti-table-plus', i18n: 'navRptBuilder', text: 'Report builder', badgeNew: 'NEW' },
    { type: 'item', view: 'rpt-schedules', icon: 'ti-calendar-clock', i18n: 'navRptSched', text: 'Scheduled delivery' },
    { type: 'item', view: 'rpt-feed', icon: 'ti-database-export', i18n: 'navRptFeed', text: 'Data feed' },
  ],
  admin: [
    { type: 'label', i18n: 'slAdmin', text: 'Administration' },
    { type: 'group', titleIcon: 'ti-user-shield', titleI18n: 'navUsersGroup', titleText: 'Access', items: [
      { view: 'users', icon: 'ti-users', i18n: 'navUsers', text: 'Users & roles' },
      { view: 'roles', icon: 'ti-lock-access', i18n: 'navRoles', text: 'Permission matrix' },
    ]},
    { type: 'group', titleIcon: 'ti-messages', titleI18n: 'navCollabGroup', titleText: 'Internal collaboration', items: [
      { view: 'expert-groups', icon: 'ti-user-search', i18n: 'navExpertGroups', text: 'Expert groups' },
      { view: 'collab-policy', icon: 'ti-shield-lock', i18n: 'navCollabPolicy', text: 'Files & retention' },
      { view: 'collab-access', icon: 'ti-history', i18n: 'navCollabAccess', text: 'Access log' },
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
  '<button id="chat-btn" class="chat-btn" onclick="toggleChat()" title="การสื่อสารภายใน">' +
  '<i class="ti ti-message-2"></i><span class="chat-dot">3</span></button>' +
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
  if (typeof swFitHeight === 'function') swFitHeight();   // กลับเข้ากล่องงาน = วัดความสูงใหม่
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
   Internal collaboration — แผงแชทที่ติดทุกหน้าจอ
   docs/internal-collaboration.md · ADR-022
   แชทภายใน "ไม่ใช่" interaction — ไม่เข้า router ไม่กิน capacity
   ============================================================ */
var CHAT_PRESENCE = { available: ['ว่างให้ถาม', '#16a34a'], busy: ['กำลังคุยสาย — ข้อความเข้าแบบเงียบ', '#dc2626'],
  acw: ['สรุปงานอยู่', '#d97706'], break: ['พัก', '#64748b'], offline: ['ออฟไลน์', '#94a3b8'] };
var CHAT_CONVS = [
  { id: 'c1', kind: 'CONSULT', title: 'ถามผู้เชี่ยวชาญ · สินเชื่อ', sub: 'ผูกกับ INT-88077 · คุณนภา จันทร์เพ็ญ',
    who: 'ธนพล (สินเชื่อ)', state: 'available', unread: 2, at: 'เมื่อสักครู่' },
  { id: 'c2', kind: 'DM', title: 'สมพร หัวหน้าทีม', sub: 'ตรวจสอบเคส CS-4821 ให้หน่อยนะ',
    who: 'สมพร', state: 'available', unread: 1, at: '3 นาที' },
  { id: 'c3', kind: 'TEAM', title: 'ทีม Support A', sub: 'ส่งเวรกะบ่าย · 6 คน', who: '', state: 'available', unread: 0, at: '18 นาที' },
  { id: 'c4', kind: 'DM', title: 'ปกรณ์ ศรีสุข', sub: 'ขอบคุณครับพี่', who: 'ปกรณ์', state: 'busy', unread: 0, at: '1 ชม.' },
  { id: 'c5', kind: 'BROADCAST', title: 'ประกาศถึงคนบนพื้น', sub: 'คิว General ล้น — ใครว่างช่วยรับ', who: 'สมพร', state: 'available', unread: 0, at: '2 ชม.' },
];
var CHAT_MSGS = {
  c1: [
    { sys: 'เปิด consult จากสาย INT-88077 · ลูกค้า: คุณนภา จันทร์เพ็ญ · คุยมาแล้ว 4:12 นาที' },
    { me: true, t: 'ลูกค้าขอผ่อน 0% 10 เดือน แต่ยอดต่ำกว่าเกณฑ์ ทำได้ไหมครับ' },
    { me: false, name: 'ธนพล', t: 'ทำได้ครับ ถ้าเป็นลูกค้า tier Gold ใช้ดุลพินิจได้ถึง 8 เดือน — แนบตารางให้ดู' ,
      att: [{ n: 'promo-installment-2026.pdf', s: '840 KB', kind: 'pdf' }] },
    { me: false, name: 'ธนพล', t: 'ข้อ 3.2 หน้า 2 ครับ' },
  ],
  c2: [
    { me: false, name: 'สมพร', t: 'เคส CS-4821 เกิน SLA แล้ว ลูกค้าโทรตามอีกรอบ ช่วยดูให้หน่อยนะ' },
    { me: true, t: 'กำลังตามฝ่ายคลังอยู่ครับ เดี๋ยวอัปเดตให้ก่อนเที่ยง' },
    { me: false, name: 'สมพร', t: 'ส่งภาพหน้าจอที่ลูกค้าส่งมาให้ดูหน่อย', urgent: true },
    { me: true, t: 'นี่ครับ', att: [{ n: 'ลูกค้าส่งมา.png', s: '1.2 MB', kind: 'img' }] },
  ],
  c3: [
    { me: false, name: 'อรทัย', t: 'ส่งเวร: เคส CS-4818 รอลูกค้ายืนยันที่อยู่ · CS-4821 รอคลัง' },
    { me: false, name: 'สมพร', t: 'รับทราบ กะบ่ายช่วยตามสองใบนี้ด้วย' },
  ],
  c4: [{ me: false, name: 'ปกรณ์', t: 'ขอบคุณครับพี่' }],
  c5: [{ me: false, name: 'สมพร', t: 'คิว General ล้น 12 สาย ใครว่างช่วยรับหน่อยครับ', urgent: true }],
};
var chatOpen = false, chatConv = null;

function buildChatPanel() {
  return '<div id="chat-panel" class="chatp">' +
    '<div class="chatp-h">' +
      '<button id="chat-back" class="act" onclick="chatBack()" style="display:none"><i class="ti ti-arrow-left"></i></button>' +
      '<div class="flex-1 min-w-0"><p id="chat-title" class="font-semibold text-[15px] truncate">การสื่อสารภายใน</p>' +
      '<p id="chat-sub" class="text-[11px] text-slate-400 truncate">แชทภายในไม่นับเป็นงาน ไม่กิน capacity ของคิว</p></div>' +
      '<button class="act" onclick="toggleChat()"><i class="ti ti-x"></i></button>' +
    '</div>' +
    '<div id="chat-list" class="chatp-b"></div>' +
    '<div id="chat-thread" class="chatp-b" style="display:none"></div>' +
    '<div id="chat-composer" class="chatp-f" style="display:none">' +
      '<div class="flex items-center gap-1.5 mb-2">' +
        '<button class="qbtn" onclick="toast(\'แนบรูป/เอกสาร — jpg png pdf docx xlsx · ≤ 20 MB (mock)\')"><i class="ti ti-paperclip"></i>แนบไฟล์</button>' +
        '<button class="qbtn" onclick="toast(\'ส่งแบบด่วน — เด้งทับได้ และถูกบันทึกว่าใครส่ง (mock)\')"><i class="ti ti-urgent"></i>ด่วน</button>' +
        '<span class="text-[11px] text-slate-400 ml-auto">Enter เพื่อส่ง</span>' +
      '</div>' +
      '<div class="flex gap-2"><input id="chat-input" class="inp" placeholder="พิมพ์ข้อความ…">' +
      '<button class="h-10 px-3 rounded-lg bg-teal-700 text-white text-sm" onclick="sendChat()"><i class="ti ti-send"></i></button></div>' +
    '</div></div>';
}
function renderChatList() {
  var el = document.getElementById('chat-list'); if (!el) return;
  var kind = { CONSULT: ['ti-help-circle', '#4f46e5'], DM: ['ti-user', '#0f766e'],
    TEAM: ['ti-users-group', '#2563eb'], BROADCAST: ['ti-speakerphone', '#d97706'] };
  el.innerHTML = CHAT_CONVS.map(function (c) {
    var k = kind[c.kind], p = CHAT_PRESENCE[c.state];
    return '<div class="chat-item" onclick="openConv(\'' + c.id + '\')">' +
      '<span class="chat-ic" style="background:' + k[1] + '18;color:' + k[1] + '"><i class="ti ' + k[0] + '"></i></span>' +
      '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center gap-1.5"><p class="font-medium text-[14px] truncate">' + c.title + '</p>' +
        (c.unread ? '<span class="chat-unread">' + c.unread + '</span>' : '') +
        '<span class="text-[11px] text-slate-400 ml-auto shrink-0">' + c.at + '</span></div>' +
        '<p class="text-[12px] text-slate-500 truncate">' + c.sub + '</p>' +
        (c.who ? '<p class="text-[11px] mt-0.5" style="color:' + p[1] + '">● ' + c.who + ' · ' + p[0] + '</p>' : '') +
      '</div></div>';
  }).join('');
}
function renderChatThread(id) {
  var el = document.getElementById('chat-thread'); if (!el) return;
  el.innerHTML = (CHAT_MSGS[id] || []).map(function (m) {
    if (m.sys) return '<div class="chat-sys"><i class="ti ti-link mr-1"></i>' + m.sys + '</div>';
    var att = (m.att || []).map(function (a) {
      var ic = a.kind === 'img' ? 'ti-photo' : 'ti-file-type-pdf';
      return '<div class="att"><i class="ti ' + ic + '"></i><span class="flex-1 truncate">' + a.n + '</span>' +
        '<span class="text-[11px] text-slate-400">' + a.s + '</span>' +
        '<i class="ti ti-shield-check text-emerald-600" title="สแกนไวรัสผ่านแล้ว"></i></div>';
    }).join('');
    return '<div class="mb-2.5">' +
      (m.me ? '' : '<p class="text-[11px] text-slate-400 mb-0.5">' + m.name + (m.urgent ? ' <span class="tag tag-bad">ด่วน</span>' : '') + '</p>') +
      '<div class="bubble ' + (m.me ? 'bubble-out' : 'bubble-in') + '">' + m.t + att + '</div></div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}
function openConv(id) {
  chatConv = id;
  var c = CHAT_CONVS.filter(function (x) { return x.id === id; })[0] || {};
  document.getElementById('chat-title').textContent = c.title || '';
  document.getElementById('chat-sub').textContent = c.sub || '';
  document.getElementById('chat-list').style.display = 'none';
  document.getElementById('chat-thread').style.display = 'block';
  document.getElementById('chat-composer').style.display = c.kind === 'BROADCAST' ? 'none' : 'block';
  document.getElementById('chat-back').style.display = 'flex';
  renderChatThread(id);
}
function chatBack() {
  chatConv = null;
  document.getElementById('chat-title').textContent = 'การสื่อสารภายใน';
  document.getElementById('chat-sub').textContent = 'แชทภายในไม่นับเป็นงาน ไม่กิน capacity ของคิว';
  document.getElementById('chat-list').style.display = 'block';
  document.getElementById('chat-thread').style.display = 'none';
  document.getElementById('chat-composer').style.display = 'none';
  document.getElementById('chat-back').style.display = 'none';
}
function toggleChat(convId) {
  var p = document.getElementById('chat-panel'); if (!p) return;
  chatOpen = !chatOpen || !!convId;
  p.classList.toggle('open', chatOpen);
  if (chatOpen) { renderChatList(); convId ? openConv(convId) : chatBack(); }
}
function sendChat() {
  var i = document.getElementById('chat-input');
  if (!i || !i.value.trim()) return;
  (CHAT_MSGS[chatConv] = CHAT_MSGS[chatConv] || []).push({ me: true, t: i.value });
  i.value = ''; renderChatThread(chatConv);
}
// เปิดแชทกับคนใดคนหนึ่งจากหน้าอื่น (เช่น การ์ดเอเจนต์ในหน้า Supervise)
function chatWith(name) {
  var c = CHAT_CONVS.filter(function (x) { return x.title.indexOf(name) === 0; })[0];
  if (!c) { c = { id: 'c_' + Date.now(), kind: 'DM', title: name, sub: 'สนทนาใหม่', who: name, state: 'busy', unread: 0, at: 'now' };
    CHAT_CONVS.unshift(c); CHAT_MSGS[c.id] = []; }
  toggleChat(c.id);
}

/* ============================================================
   Sample data — ทั้งหมดเป็น mock สำหรับวิวเท่านั้น
   ============================================================ */
var CH_ICON = { voice: 'ti-phone', webchat: 'ti-message-circle', line: 'ti-brand-line', facebook: 'ti-brand-messenger', whatsapp: 'ti-brand-whatsapp', email: 'ti-mail',
  outbound: 'ti-phone-outgoing', any: 'ti-box-multiple' };
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

// wfm = ที่นั่งโมดูล WFM ที่ admin เปิดให้รายคน (ADR-009 ข้อ 12 — ไม่นับอัตโนมัติ)
var WFM_SEAT_LIMIT = 50;
var AGENTS = [
  { name: 'สมชาย วงศ์ประเสริฐ', email: 'somchai@acme.co.th', ext: '1000', team: 'Support A', skills: 'general, technical', voice: 1, chat: 3, state: 'available', wfm: true },
  { name: 'สมหญิง ใจดี', email: 'somying@acme.co.th', ext: '1001', team: 'Support A', skills: 'general, billing', voice: 1, chat: 2, state: 'busy', wfm: true },
  { name: 'John Anderson', email: 'john.a@acme.co.th', ext: '1002', team: 'Sales', skills: 'sales, english', voice: 1, chat: 3, state: 'acw', wfm: true },
  { name: 'อรทัย พูลสวัสดิ์', email: 'orathai@acme.co.th', ext: '1003', team: 'Sales', skills: 'sales, vip', voice: 1, chat: 4, state: 'break', wfm: true },
  { name: 'ปกรณ์ ศรีสุข', email: 'pakorn@acme.co.th', ext: '1004', team: 'Support B', skills: 'technical', voice: 1, chat: 0, state: 'available', wfm: false },
  { name: 'Maria Garcia', email: 'maria.g@acme.co.th', ext: '1005', team: 'Support B', skills: 'general, english, vip', voice: 1, chat: 3, state: 'offline', wfm: true },
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
  { num: '+66 2 123 4500', label: 'Main hotline', route: 'Flow: Voice — Main menu', trunk: 'NT SIP-01', active: true },
  { num: '+66 2 123 4501', label: 'Sales direct', route: 'Queue: Sales (TH)', trunk: 'NT SIP-01', active: true },
  { num: '+66 2 123 4502', label: 'VIP line', route: 'Queue: VIP Customers', trunk: 'AIS SIP-02', active: true },
  { num: '+66 2 123 4509', label: 'Legacy number', route: 'Queue: General Support', trunk: 'NT SIP-01', active: false },
];

// Flows — omnichannel routing flows (เดิมชื่อ IVR flows) เปิดใน flow-editor.html (React Flow)
var FLOWS = [
  { id: 'flow_voice_mainmenu', name: 'Voice — Main menu', ch: 'voice', status: 'published', ver: 3, updated: '20-07-2026', purpose: 'เมนูเสียงหลัก กด 1/2/3 เข้าคิว, 0 หา operator' },
  { id: 'flow_voice_afterhours', name: 'Voice — After-hours voicemail', ch: 'voice', status: 'published', ver: 2, updated: '18-07-2026', purpose: 'นอกเวลาทำการ → ฝากข้อความ หรือขอ callback' },
  { id: 'flow_webchat_prechat', name: 'Web chat — Pre-chat routing', ch: 'webchat', status: 'published', ver: 4, updated: '21-07-2026', purpose: 'ถามหัวข้อก่อนแชท แล้วส่งเข้าคิวตามเรื่อง' },
  { id: 'flow_line_welcome', name: 'LINE — Welcome + menu', ch: 'line', status: 'published', ver: 1, updated: '15-07-2026', purpose: 'ต้อนรับ + เมนู quick reply เลือกภาษา/แผนก' },
  { id: 'flow_fb_faq', name: 'Facebook — FAQ deflection', ch: 'facebook', status: 'draft', ver: 1, updated: '22-07-2026', purpose: 'บอตตอบ FAQ ก่อน ถ้าไม่จบส่งต่อเอเจนต์' },
  { id: 'flow_wa_orderstatus', name: 'WhatsApp — Order status lookup', ch: 'whatsapp', status: 'published', ver: 2, updated: '19-07-2026', purpose: 'ถามเลขออเดอร์ → เรียก API → ตอบสถานะ' },
  { id: 'flow_email_autoack', name: 'Email — Auto-ack + classify', ch: 'email', status: 'published', ver: 3, updated: '17-07-2026', purpose: 'ตอบรับอัตโนมัติ + จัดหมวด → เข้าคิว' },
  { id: 'flow_vip_priority', name: 'VIP — CRM priority routing', ch: 'voice', status: 'published', ver: 5, updated: '20-07-2026', purpose: 'ค้น CRM จากเบอร์ ถ้า VIP เพิ่ม priority เข้าคิว VIP' },
  { id: 'flow_voice_language', name: 'Voice — Language selection', ch: 'voice', status: 'draft', ver: 1, updated: '22-07-2026', purpose: 'เลือก TH/EN แล้ว route ตามภาษา (skill)' },
  { id: 'flow_overflow_callback', name: 'Overflow — Callback offer', ch: 'voice', status: 'published', ver: 2, updated: '16-07-2026', purpose: 'คิวยาว → เสนอ callback แทนการรอสาย' },
  { id: 'flow_shared_verify', name: 'Shared — ยืนยันตัวตน (sub-flow)', ch: 'any', status: 'published', ver: 4, updated: '08-08-2026', purpose: 'ผังย่อยที่ผังอื่นเรียกใช้ 6 ที่ — แก้ที่เดียวมีผลทุกผัง' },
  { id: 'flow_outbound_notify', name: 'Outbound — แจ้งยอดก่อนต่อเอเจนต์', ch: 'outbound', status: 'published', ver: 2, updated: '08-08-2026', purpose: 'สายขาออกที่ปลายทางรับแล้ว — ตรวจเครื่องตอบรับ, กด 9 = ไม่ให้ติดต่ออีก' },
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

// My interactions — งานของเอเจนต์ที่ล็อกอินอยู่ (สมชาย ext 1000) ย้อนหลัง 7 วัน
var MY_INTERACTIONS = [
  { dir: 'in', ch: 'voice', contact: '+66 81 234 5678', queue: 'General Support', start: '15-07-2026 10:21:04', wait: '00:00:12', dur: '00:04:31', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'whatsapp', contact: 'David Kim', queue: 'VIP Customers', start: '15-07-2026 10:05:33', wait: '00:00:41', dur: '00:11:04', wrap: '—', state: 'wrapup' },
  { dir: 'in', ch: 'webchat', contact: 'Guest #8812', queue: 'General Support', start: '15-07-2026 09:58:41', wait: '00:00:09', dur: '00:03:22', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'voice', contact: '+66 84 111 2233', queue: 'Technical Support', start: '15-07-2026 09:31:07', wait: '00:00:26', dur: '00:08:16', wrap: 'Escalated', state: 'completed' },
  { dir: 'in', ch: 'line', contact: '@wichai_t', queue: 'Sales (TH)', start: '14-07-2026 16:44:12', wait: '00:01:02', dur: '00:07:55', wrap: 'Order created', state: 'completed' },
  { dir: 'in', ch: 'email', contact: 'maysa@brightedu.ac.th', queue: 'General Support', start: '14-07-2026 14:02:38', wait: '00:22:15', dur: '—', wrap: 'Quote sent', state: 'completed' },
  { dir: 'out', ch: 'voice', contact: '+66 86 777 3456', queue: '—', start: '14-07-2026 11:19:50', wait: '—', dur: '00:02:47', wrap: 'Follow-up', state: 'completed' },
  { dir: 'in', ch: 'voice', contact: '+66 82 555 9014', queue: 'Technical Support', start: '13-07-2026 15:26:33', wait: '00:00:18', dur: '00:15:52', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'webchat', contact: 'Guest #8790', queue: 'Technical Support', start: '13-07-2026 10:44:09', wait: '00:00:07', dur: '00:05:38', wrap: 'Resolved', state: 'completed' },
  { dir: 'in', ch: 'voice', contact: '+66 89 222 7788', queue: 'General Support', start: '11-07-2026 13:57:21', wait: '00:01:33', dur: '—', wrap: '—', state: 'abandoned' },
  { dir: 'in', ch: 'email', contact: 'napha@siamretail.co.th', queue: 'General Support', start: '10-07-2026 09:15:04', wait: '00:41:20', dur: '—', wrap: 'Refund issued', state: 'completed' },
  { dir: 'in', ch: 'voice', contact: '+66 81 900 4455', queue: 'General Support', start: '09-07-2026 16:38:47', wait: '00:00:15', dur: '00:06:19', wrap: 'Resolved', state: 'completed' },
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

// งานที่ agent ถืออยู่ — เรียงตาม "ใครรอตอบนานสุด" ไม่ใช่ตาม unread (ADR-023/§4.2)
// waitSec = ลูกค้าส่งข้อความล่าสุดมาแล้วกี่วินาทีโดยยังไม่ได้รับคำตอบ · slaSec = เป้าการตอบของคิว
var CONVS = [
  // งานที่เพิ่งถูก push มา — ต้องกดรับภายใน 15 วินาที ไม่งั้นคืนคิว (interaction-data-flow §4.1)
  { id: 'w0', ch: 'line', name: '@ploy.k', queue: 'General Support', preview: 'สอบถามการคืนสินค้าค่ะ',
    waitSec: 8, slaSec: 120, unread: 1, fromBot: false, state: 'ASSIGNED', ackLeft: 12 },
  { id: 'w1', ch: 'webchat', name: 'Guest #8812', queue: 'General Support', preview: 'ORD-7731 ครับ',
    waitSec: 95, slaSec: 120, unread: 2, fromBot: true, state: 'ACTIVE',
    assist: { title: 'บทความ: PAYMENT_DECLINED', detail: 'ยืนยัน order id → ตรวจ reason code → แนะนำช่องทางชำระใหม่', source: 'KB Payments v4 · ใช้แล้ว 82% จบโดยไม่โอน' } },
  { id: 'w2', ch: 'line', name: '@wichai_t', queue: 'Sales (TH)', preview: 'สนใจแพ็กเกจ 50 users ครับ มีส่วนลดไหม',
    waitSec: 240, slaSec: 180, unread: 1, fromBot: false, state: 'ACTIVE', scriptId: 'sc_upsell',
    // เรคคอร์ดที่ visual app (Salesforce) จับคู่ได้จาก contactId ที่เราส่งให้ตอน dc:context
    crm: { obj: 'Opportunity', id: '0065g00000ABCd', name: 'ต่ออายุ + เพิ่ม 50 ที่นั่ง', acct: 'บริษัท วิชัยเทรดดิ้ง จำกัด',
           fields: [['ระยะ', 'Negotiation'], ['มูลค่า', '฿480,000'], ['ปิดคาดการณ์', '30-09-2026'], ['เจ้าของ', 'สมชาย วงศ์ประเสริฐ']],
           suggest: { msg: 'app:disposition.suggest { code: "quote_sent" }', label: 'แอปเสนอผลการติดต่อ: "ส่งใบเสนอราคาแล้ว"' } },
    caseInfo: { number: 'CS-4821', subject: 'ขอข้อเสนอราคา 50 users', state: 'PENDING_INTERNAL', due: 'เหลือ 1 ชม. 18 นาที', owner: 'สมชาย วงศ์ประเสริฐ' },
    journey: { name: 'ต่ออายุก่อนหมดสัญญา', step: 'ขั้นที่ 2/5 · รอ 3 วัน', state: 'RUNNING',
               goal: 'ต่ออายุสำเร็จ', next: '14-08 10:00 · SMS เตือนวันหมดอายุ' } },
  { id: 'w3', ch: 'voice', name: 'คุณนภา จันทร์เพ็ญ', queue: 'VIP Customers', preview: 'กำลังคุยสาย · 02:41',
    waitSec: 0, slaSec: 0, unread: 0, fromBot: false, state: 'ACTIVE', voiceLive: true, scriptId: 'sc_collect',
    crm: { obj: 'Invoice (custom)', id: 'a0X5g00000INV88', name: 'INV-2026-07-8841 · ค้างชำระ ฿2,480', acct: 'นภา จันทร์เพ็ญ (ลูกค้าบุคคล · VIP)',
           fields: [['ครบกำหนด', '31-07-2026'], ['ค้างมาแล้ว', '16 วัน'], ['ยอดรวมทั้งบัญชี', '฿2,480'], ['ระดับ', 'Gold']],
           suggest: { msg: 'app:note.append { text: "…" }', label: 'แอปเสนอบันทึก: "ชำระผ่าน mobile banking 16-08 09:41 · ref 8841"' } },
    // สายนี้เกิดจากลำดับ แล้วลูกค้าจ่ายเงินระหว่างที่สายกำลังคุย — ยกเลิกสายที่ต่อแล้วไม่ได้
    journey: { name: 'ทวงถามค่างวดที่จ่ายไม่ผ่าน', step: 'ขั้นที่ 3/4 · โทรติดตาม', state: 'GOAL_REACHED',
               goal: 'จ่ายสำเร็จภายใน 7 วัน',
               goalAt: '2 นาทีที่แล้ว', goalEvent: 'payment.succeeded · จาก billing',
               actionKey: 'enr_8841:v3:step_call' } },
  { id: 'w4', ch: 'whatsapp', name: 'David Kim', queue: 'VIP Customers', preview: 'Can you resend the invoice for June?',
    waitSec: 15, slaSec: 180, unread: 1, fromBot: false, state: 'ACTIVE',
    crm: { obj: 'Account', id: '0015g00000KLMn', name: 'Kim Logistics (Thailand)', acct: 'ผู้ติดต่อ: David Kim · CFO',
           fields: [['สัญญา', 'Enterprise · ต่ออัตโนมัติ'], ['ใบแจ้งหนี้ค้าง', '0 ใบ'], ['เคสเปิดอยู่', '2'], ['เจ้าของ', 'ฝ่ายขายองค์กร']] } },
  { id: 'w5', ch: 'email', name: 'maysa@brightedu.ac.th', queue: 'Billing Inquiries', preview: 'RE: ขอใบเสนอราคาระบบ contact center',
    waitSec: 3600, slaSec: 14400, unread: 0, fromBot: false, state: 'IDLE' },
];
var selectedWork = 'w1';   // งานที่เลือกอยู่ — ทุก panel ต้องอ้างอิงตัวเดียวกันนี้เสมอ

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
      '<td class="px-4 py-3">' + wfmSeatToggle(a, i) + '</td>' +
      '<td class="px-4 py-3">' + stPill(a.state) + '</td>' +
      '<td class="px-4 py-3 text-right"><span class="icon-btn" onclick="editAgent(' + i + ')" title="Edit"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
  renderWfmSeatCount();
}
function wfmSeatToggle(a, i) {
  return a.wfm
    ? '<span class="st st-available cursor-pointer" onclick="toggleWfmSeat(' + i + ')" title="ปิดที่นั่ง WFM">เปิด</span>'
    : '<span class="st st-offline cursor-pointer" onclick="toggleWfmSeat(' + i + ')" title="เปิดที่นั่ง WFM"><i class="ti ti-lock text-[10px]"></i>ปิด</span>';
}
function wfmSeatsUsed() { return AGENTS.filter(function (a) { return a.wfm; }).length; }
function renderWfmSeatCount() {
  var el = document.getElementById('wfm-seat-count'); if (!el) return;
  el.textContent = 'ใช้ไป ' + wfmSeatsUsed() + ' จาก ' + WFM_SEAT_LIMIT + ' ที่นั่ง';
}
// เปิดเกินเพดานไม่ได้ — บล็อกตั้งแต่ตอนติ๊ก ไม่ใช่ไปเจอตอนออกบิล (licensing.md §6.2 จุดที่ 2)
function toggleWfmSeat(i) {
  var a = AGENTS[i];
  if (!a.wfm && wfmSeatsUsed() >= WFM_SEAT_LIMIT) {
    toast(currentLang === 'th'
      ? 'ที่นั่ง WFM เต็ม (' + WFM_SEAT_LIMIT + ') — ปิดของคนอื่นก่อนหรืออัปเกรดแพ็กเกจ'
      : 'WFM seats are full (' + WFM_SEAT_LIMIT + ') — free one up or upgrade the plan');
    return;
  }
  a.wfm = !a.wfm;
  renderAgents();
  toast(a.wfm ? 'เปิดที่นั่ง WFM ให้ ' + a.name + ' แล้ว (mock)' : 'ปิดที่นั่ง WFM ของ ' + a.name + ' แล้ว (mock)');
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

function flowStatusPill(s) {
  return s === 'published'
    ? '<span class="st st-available">Published</span>'
    : '<span class="st st-acw">Draft</span>';
}
function renderFlows() {
  var b = document.getElementById('flows-body'); if (!b) return;
  b.innerHTML = FLOWS.map(function (f) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-3"><p class="font-medium text-slate-800">' + f.name + '</p><p class="text-xs text-slate-400">' + f.purpose + '</p></td>' +
      '<td class="px-4 py-3">' + chBadge(f.ch) + '</td>' +
      '<td class="px-4 py-3">' + flowStatusPill(f.status) + '</td>' +
      '<td class="px-4 py-3 text-slate-500">v' + f.ver + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + f.updated + '</td>' +
      '<td class="px-4 py-3 text-right whitespace-nowrap">' +
      '<span class="icon-btn bg-teal-50 text-teal-700" title="Open in Designer" onclick="openFlow(\'' + f.id + '\')"><i class="ti ti-sitemap"></i></span>' +
      '<span class="icon-btn" title="Edit" onclick="openFlow(\'' + f.id + '\')"><i class="ti ti-pencil"></i></span>' +
      '<span class="icon-btn" title="Duplicate" onclick="toast(currentLang===\'th\'?\'ทำสำเนาโฟลว์แล้ว (mock)\':\'Flow duplicated (mock)\')"><i class="ti ti-copy"></i></span>' +
      '<span class="icon-btn">' + dots + '</span></td></tr>';
  }).join('');
}
function openFlow(id) { location.href = 'flow-editor.html?id=' + id; }

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
}

function renderMyInteractions() {
  var b = document.getElementById('myhis-body'); if (!b) return;
  var stMap = {
    completed: '<span class="st st-available">Completed</span>',
    wrapup: '<span class="st st-acw">Wrap-up</span>',
    abandoned: '<span class="st st-busy">Abandoned</span>',
  };
  b.innerHTML = MY_INTERACTIONS.map(function (r) {
    var arrow = r.dir === 'out' ? '<i class="ti ti-arrow-up-right text-blue-600"></i>' : '<i class="ti ti-arrow-down-left text-emerald-600"></i>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50 text-[13px]">' +
      '<td class="px-3 py-2.5">' + arrow + '</td>' +
      '<td class="px-3 py-2.5">' + chBadge(r.ch) + '</td>' +
      '<td class="px-3 py-2.5 font-medium text-slate-700">' + r.contact + '</td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + r.queue + '</td>' +
      '<td class="px-3 py-2.5 text-slate-500">' + r.start + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.wait + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.dur + '</td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + r.wrap + '</td>' +
      '<td class="px-3 py-2.5">' + stMap[r.state] + '</td></tr>';
  }).join('');
  var c = document.getElementById('myhis-count');
  if (c) c.textContent = MY_INTERACTIONS.length;
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

function mmssShort(sec) {
  if (sec >= 3600) return Math.floor(sec / 3600) + ' ชม.';
  if (sec >= 60) return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  return sec + ' วิ';
}

/* บทสนทนาต่องาน — ทุก panel ผูกกับ selectedWork ตัวเดียวกัน (ADR-023 · รีวิว P0 ข้อ 2) */
var HANDOFF_W1 = { bot: 'Support TH (FAQ)', turns: 4, dur: '1:12 นาที', conf: 0.31,
  why: 'ไม่มีคำตอบในคลังความรู้', got: 'เลขคำสั่งซื้อ ORD-7731 · อาการ PAYMENT_DECLINED · ลองแล้ว 3 ครั้ง',
  said: '"ขอโทษครับ เรื่องนี้ขอส่งต่อเจ้าหน้าที่นะครับ"' };
var TRANSCRIPTS = {
  w1: [
    { in: 1, t: 'สวัสดีครับ หน้าชำระเงินขึ้น error ครับ กดจ่ายแล้วไม่ไปต่อ' },
    { in: 1, t: 'ขึ้นว่า "PAYMENT_DECLINED" ครับ ลอง 3 รอบแล้ว',
      atts: [{ n: 'screenshot-error.png · 840 KB', st: 'CLEAN' },
             { n: 'slip-payment.jpg · 1.4 MB', st: 'PENDING_SCAN' }] },
    { in: 1, t: 'อันนี้ไฟล์ที่ธนาคารส่งมาครับ',
      atts: [{ n: 'bank-notice.zip · 2.1 MB', st: 'INFECTED' },
             { n: 'statement.pdf · 3.0 MB', st: 'FETCH_FAILED' }] },
    { in: 0, t: 'สวัสดีค่ะ ขอโทษในความไม่สะดวกนะคะ ขอทราบ 4 ตัวท้ายของ order id ได้ไหมคะ', st: 'delivered', at: '09:41' },
    { in: 1, t: 'ORD-7731 ครับ' },
    { in: 0, t: 'ตรวจสอบให้สักครู่นะคะ 🙏', st: 'sent', at: '09:42' },
    { in: 0, t: 'พบว่าบัตรถูกปฏิเสธจากธนาคารค่ะ', st: 'failed', at: 'provider timeout · ลองแล้ว 4 ครั้ง' },
  ],
  w2: [
    { in: 1, t: 'สนใจแพ็กเกจ 50 users ครับ มีส่วนลดไหม' },
    { in: 0, t: 'มีค่ะ ขอเวลาตรวจสอบเงื่อนไขสักครู่นะคะ', st: 'delivered', at: '09:38' },
    { in: 1, t: 'รอนะครับ' },
    { in: 1, t: 'ยังอยู่ไหมครับ' },
  ],
  w3: [{ sys: 'สายเสียง — ไม่มีบทสนทนาแบบข้อความ ดูบันทึกเสียงได้ในเมนูประวัติหลังจบสาย' }],
  w4: [
    { in: 1, t: 'Can you resend the invoice for June?' },
    { in: 0, t: 'Sure, sending it now.', st: 'delivered', at: '09:20', att: 'invoice-june.pdf · 210 KB' },
    { in: 1, t: 'Got it, thanks!' },
  ],
  w5: [
    { in: 1, t: 'RE: ขอใบเสนอราคาระบบ contact center — รบกวนส่งใบเสนอราคาฉบับล่าสุดด้วยครับ' },
    { in: 0, t: 'เรียนคุณเมษา แนบใบเสนอราคาฉบับล่าสุดมาพร้อมอีเมลนี้ค่ะ', st: 'delivered', at: 'เมื่อวาน 16:40', att: 'quotation-2026-08.pdf · 1.1 MB' },
  ],
};
function renderTranscript(id) {
  var el = document.getElementById('sw-transcript'); if (!el) return;
  var head = '';
  if (id === 'w1') {
    var h = HANDOFF_W1;
    head = '<div class="rounded-xl border border-violet-200 bg-violet-50/60 p-3">' +
      '<div class="flex items-center justify-between mb-1.5">' +
      '<p class="text-sm font-semibold text-violet-900"><i class="ti ti-robot mr-1"></i>รับช่วงจากบอต — ' + h.bot + '</p>' +
      '<span class="tag tag-ai">คุยไป ' + h.turns + ' รอบ · ' + h.dur + '</span></div>' +
      '<dl class="text-[13px] text-slate-700 space-y-0.5">' +
      '<div><b>เหตุผลที่ส่งต่อ:</b> ' + h.why + ' (ความมั่นใจ ' + h.conf + ')</div>' +
      '<div><b>บอตเก็บข้อมูลได้:</b> ' + h.got + '</div>' +
      '<div><b>บอตตอบไปแล้วว่า:</b> ' + h.said + '</div></dl>' +
      '<p class="text-[11px] text-violet-800/70 mt-1.5">คำถามนี้ถูกส่งเข้าคิวเขียนบทความอัตโนมัติแล้ว (kb_gap)</p></div>';
  }
  var ST = {
    sent: '<i class="ti ti-check"></i> ส่งแล้ว ',
    delivered: '<i class="ti ti-checks"></i> ถึงแล้ว ',
    failed: '<i class="ti ti-alert-triangle"></i> ส่งไม่สำเร็จ ',
  };
  el.innerHTML = head + (TRANSCRIPTS[id] || []).map(function (m) {
    if (m.sys) return '<div class="chat-sys">' + m.sys + '</div>';
    var AT = {
      CLEAN:         ['ti-shield-check', 'text-emerald-600', 'สแกนแล้ว เปิดได้'],
      PENDING_SCAN:  ['ti-loader', 'text-amber-600', 'กำลังสแกน — ยังเปิดไม่ได้'],
      INFECTED:      ['ti-virus', 'text-rose-600', 'กักไว้ — พบมัลแวร์ (ไม่ลบ เพราะเป็นหลักฐาน)'],
      FETCH_FAILED:  ['ti-cloud-off', 'text-slate-400', 'ดึงจาก provider ไม่ทันก่อนลิงก์หมดอายุ'],
    };
    var list = m.atts || (m.att ? [{ n: m.att, st: 'CLEAN' }] : []);
    var att = list.map(function (a) {
      var d = AT[a.st] || AT.CLEAN;
      var dim = (a.st === 'INFECTED' || a.st === 'FETCH_FAILED') ? ' style="opacity:.72"' : '';
      return '<div class="att' + (m.in ? ' !bg-white !border-slate-200 !text-slate-600' : '') + '"' + dim + ' title="' + d[2] + '">' +
        '<i class="ti ' + (/\.pdf/.test(a.n) ? 'ti-file-type-pdf' : /\.zip/.test(a.n) ? 'ti-file-zip' : 'ti-photo') + '"></i>' +
        '<span class="flex-1 truncate' + (a.st === 'CLEAN' ? '' : ' line-through') + '">' + a.n + '</span>' +
        '<i class="ti ' + d[0] + ' ' + d[1] + '"></i></div>';
    }).join('');
    var status = '';
    if (!m.in && m.st) {
      var fail = m.st === 'failed';
      status = '<span class="block text-right text-[10px] mt-1 ' + (fail ? '' : 'opacity-70') + '">' + ST[m.st] + m.at +
        (fail ? ' <button class="underline" onclick="toast(\'ส่งใหม่ด้วย clientToken เดิม — ลูกค้าไม่ได้ข้อความซ้ำ (mock)\')">ลองส่งใหม่</button>' : '') + '</span>';
    }
    var cls = m.in ? 'bubble bubble-in' : 'bubble bubble-out' + (m.st === 'failed' ? ' !bg-rose-50 !text-rose-800 border border-rose-200' : '');
    return '<div class="' + (m.in ? '' : 'flex justify-end') + '"><div class="' + cls + '">' + m.t + att + status + '</div></div>';
  }).join('');
}

var ackTimer = null;
function renderInbox() {
  var list = document.getElementById('conv-list'); if (!list) return;
  renderTranscript(selectedWork);
  var selected = CONVS.filter(function (x) { return x.id === selectedWork; })[0];
  renderWorkPanels(selected);
  if (!ackTimer) ackTimer = setInterval(tickAck, 1000);
  // งานที่รอ ack ขึ้นบนสุดเสมอ (มีนาฬิกาเดิน) จากนั้นเรียงตามคนที่รอตอบนานสุดเทียบ SLA
  var rows = CONVS.slice().sort(function (a, b) {
    if ((a.state === 'ASSIGNED') !== (b.state === 'ASSIGNED')) return a.state === 'ASSIGNED' ? -1 : 1;
    return (b.waitSec / (b.slaSec || 1)) - (a.waitSec / (a.slaSec || 1));
  });
  list.innerHTML = rows.map(function (c) {
    if (c.state === 'ASSIGNED') {
      return '<div class="conv-item" style="background:#fff7ed;border-left:3px solid #ea580c;padding-left:11px">' +
        '<span class="ch ch-' + c.ch + '" style="height:28px;width:28px;justify-content:center;padding:0"><i class="ti ' + CH_ICON[c.ch] + '"></i></span>' +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-center justify-between gap-2"><p class="font-medium text-sm text-slate-800 truncate">' + c.name + '</p>' +
          '<span class="text-[11px] font-bold text-orange-600 tabular-nums" id="ack-' + c.id + '">' + c.ackLeft + ' วิ</span></div>' +
          '<p class="text-xs text-slate-500 truncate">' + c.preview + '</p>' +
          '<p class="text-[11px] text-orange-700 mt-0.5">งานใหม่ · กดรับก่อนหมดเวลา ไม่งั้นคืนคิว</p>' +
          '<div class="flex gap-1.5 mt-1.5">' +
            '<button class="qbtn on" style="font-size:11px;padding:3px 9px" onclick="event.stopPropagation();ackWork(\'' + c.id + '\')"><i class="ti ti-check"></i>รับงาน</button>' +
            '<button class="qbtn" style="font-size:11px;padding:3px 9px" onclick="event.stopPropagation();declineWork(\'' + c.id + '\')">ปฏิเสธ</button>' +
          '</div>' +
        '</div></div>';
    }
    var pct = c.slaSec ? Math.min(c.waitSec / c.slaSec * 100, 100) : 0;
    var over = c.slaSec && c.waitSec > c.slaSec;
    var bar = c.voiceLive
      ? '<span class="st st-busy" style="font-size:10px">กำลังคุยสาย</span>'
      : '<div class="slabar" style="margin-top:5px"><div class="' + (over ? 's-bad' : pct > 70 ? 's-mid' : 's-good') +
        '" style="width:' + pct + '%"></div></div>';
    var waitTxt = c.voiceLive ? '' :
      '<span class="text-[11px] ' + (over ? 'text-rose-600 font-semibold' : 'text-slate-400') + '">' +
      (c.state === 'IDLE' ? 'เงียบมา ' : 'ลูกค้ารอ ') + mmssShort(c.waitSec) + '</span>';
    return '<div class="conv-item' + (c.id === selectedWork ? ' active' : '') + '" onclick="selectWork(\'' + c.id + '\')">' +
      '<span class="ch ch-' + c.ch + '" style="height:28px;width:28px;justify-content:center;padding:0"><i class="ti ' + CH_ICON[c.ch] + '"></i></span>' +
      '<div class="flex-1 min-w-0">' +
        '<div class="flex items-center justify-between gap-2"><p class="font-medium text-sm text-slate-800 truncate">' + c.name + '</p>' +
        (c.unread ? '<span class="badge" style="margin-left:0">' + c.unread + '</span>' : '') + '</div>' +
        '<p class="text-xs text-slate-500 truncate">' + c.preview + '</p>' +
        '<div class="flex items-center gap-2 mt-0.5">' + waitTxt +
        (c.fromBot ? '<span class="tag tag-ai" style="font-size:10px">จากบอต</span>' : '') +
        (c.state === 'IDLE' ? '<span class="tag" style="font-size:10px">ห้องเงียบ</span>' : '') + '</div>' +
        bar +
      '</div></div>';
  }).join('');
}

/* บริบทของลำดับอัตโนมัติบนหน้าเอเจนต์ (docs/journey-orchestration.md §5.3)
   กติกา: งานที่ "ส่งไปแล้ว" ยกเลิกไม่ได้ — สายที่ต่อแล้วยิ่งไม่ได้
   ระบบทำได้อย่างเดียวคือหยุดขั้นที่เหลือ แล้ว **บอกคนที่กำลังคุยอยู่** ว่าเหตุผลของสายนี้หมดไปแล้ว */
function renderJourneyContext(c) {
  var alertEl = document.getElementById('sw-goal-alert');
  var cardEl = document.getElementById('sw-journey');
  var j = c && c.journey;
  var reached = !!(j && j.state === 'GOAL_REACHED');

  if (alertEl) {
    alertEl.innerHTML = reached
      ? '<div class="border-t border-b border-rose-200 bg-rose-50/80 px-4 py-3">' +
          '<div class="flex items-start gap-2">' +
            '<i class="ti ti-alert-triangle text-rose-600 text-lg mt-0.5"></i>' +
            '<div class="flex-1 min-w-0">' +
              '<p class="text-sm font-semibold text-rose-900">เหตุผลของสายนี้หมดไปแล้ว — ลูกค้าทำสำเร็จเมื่อ ' + j.goalAt + '</p>' +
              '<p class="text-xs text-rose-800 mt-0.5">สายนี้มาจากลำดับ <b>' + j.name + '</b> (' + j.step + ') ' +
                'ระบบได้รับ <code class="text-[11px]">' + j.goalEvent + '</code> หลังจากต่อสายแล้ว ' +
                '<b>สายที่ต่อแล้วยกเลิกไม่ได้</b> — ขั้นที่เหลือถูกหยุดให้แล้ว</p>' +
              '<p class="text-xs text-rose-800 mt-1">เปลี่ยนบทสนทนาเป็น <b>ยืนยันการชำระ</b> ไม่ใช่ทวงถาม</p>' +
              '<div class="flex flex-wrap gap-2 mt-2">' +
                '<button class="qbtn on" style="font-size:12px" onclick="ackGoalReached()"><i class="ti ti-check"></i>รับทราบ · แจ้งลูกค้าแล้ว</button>' +
                '<button class="qbtn" style="font-size:12px" onclick="toast(\'เปิดรายละเอียดการกระทำ ' + j.actionKey + ' (mock)\')">' +
                  '<i class="ti ti-route"></i>ดูขั้นตอนของลำดับ</button>' +
              '</div>' +
            '</div></div></div>'
      : '';
  }

  if (!cardEl) return;
  if (!j) {
    cardEl.innerHTML = '';
    return;
  }
  var badge = reached ? '<span class="tag tag-bad">หยุดแล้ว · บรรลุเป้าหมาย</span>'
                      : '<span class="tag tag-ok">กำลังทำงาน</span>';
  cardEl.innerHTML = '<div class="bg-white border ' + (reached ? 'border-rose-200' : 'border-teal-200') + ' rounded-xl p-4">' +
    '<div class="flex items-center justify-between gap-2 mb-2">' +
      '<h2 class="text-sm font-semibold ' + (reached ? 'text-rose-900' : 'text-teal-900') + '"><i class="ti ti-route mr-1"></i>ลำดับอัตโนมัติของลูกค้า</h2>' + badge + '</div>' +
    '<p class="text-sm font-medium text-slate-800">' + j.name + '</p>' +
    '<p class="text-xs text-slate-500 mt-0.5">' + j.step + ' · เป้าหมาย: ' + j.goal + '</p>' +
    (reached
      ? '<p class="text-xs text-rose-700 mt-2"><i class="ti ti-flag-check mr-1"></i>บรรลุเป้าหมาย ' + j.goalAt + ' — ไม่มีข้อความอัตโนมัติออกไปอีก</p>'
      : '<p class="text-xs text-slate-600 mt-2"><i class="ti ti-clock mr-1"></i>ถัดไป: ' + j.next + '</p>' +
        '<button class="qbtn w-full justify-center mt-2" onclick="holdJourney()"><i class="ti ti-player-pause"></i>ระงับลำดับ 24 ชม. ระหว่างที่เอเจนต์ดูแลอยู่</button>') +
    '<button class="qbtn w-full justify-center mt-2" onclick="location.href=\'journeys.html?view=journey-insights\'">' +
      '<i class="ti ti-arrow-up-right"></i>เปิดลำดับนี้</button>' +
    '<p class="text-[11px] text-slate-400 mt-2">ลำดับผูกกับ "ลูกค้า" ไม่ใช่งานชิ้นนี้ — มันไม่สร้างงานเข้าคิวเอง</p></div>';
}
function ackGoalReached() {
  var el = document.getElementById('sw-goal-alert');
  if (el) el.innerHTML = '<div class="border-t border-b border-emerald-200 bg-emerald-50/70 px-4 py-2 text-xs text-emerald-800">' +
    '<i class="ti ti-check mr-1"></i>บันทึกแล้วว่าเอเจนต์แจ้งลูกค้าเรื่องการชำระที่สำเร็จแล้ว — จะไปอยู่ในบันทึกของ interaction</div>';
  toast(currentLang === 'th' ? 'บันทึกการรับทราบแล้ว (mock)' : 'Acknowledged (mock)');
}
function holdJourney() {
  toast(currentLang === 'th' ? 'ระงับลำดับสำหรับลูกค้ารายนี้ 24 ชม. (mock)' : 'Journey held 24h for this customer (mock)');
}

/* ============================================================
   สคริปต์นำบทสนทนา — docs/agent-assist.md §3 A6
   ถ้อยคำเป็นของที่คนเขียนและ publish เป็นเวอร์ชัน — ไม่ผ่านโมเดลแม้แต่ขั้นเดียว
   เวอร์ชันถูก pin ตอนงานเริ่ม · node มี 5 ชนิด (SAY/ASK/BRANCH/KB/ACTION) ไม่มีลูป
   ============================================================ */
var SCRIPTS = {
  sc_upsell: {
    name: 'ขายที่นั่งเพิ่ม — ลูกค้าถามส่วนลด', ver: 6, bind: 'คิว Sales (TH)', purpose: 'SALES',
    stage: 'Discovery → qualification → proposal', metric: 'เก็บที่นั่งจริง + เดือนเริ่มใช้ + next step',
    steps: [
      { id: 's1', kind: 'SAY', req: true, title: 'เปิดการสนทนา + ระบุตัวตนผู้ติดต่อ', next: 's2',
        say: 'สวัสดีครับ ผมสมชาย จาก D-Contact ครับ ขอบคุณที่สนใจแพ็กเกจสำหรับทีม 50 ที่นั่งนะครับ ขออนุญาตสอบถาม 2–3 ข้อ เพื่อเสนอราคาที่ตรงกับการใช้งานจริงที่สุดครับ' },
      { id: 's2', kind: 'ASK', title: 'จำนวนที่นั่งจริง + เดือนที่จะเริ่มใช้', next: 's3',
        say: 'ตอนนี้ทีมที่จะใช้งานจริงกี่ที่นั่งครับ และวางแผนจะเริ่มใช้เดือนไหนครับ',
        cap: { label: 'ที่นั่ง + เดือนที่เริ่ม', ph: 'เช่น 50 ที่นั่ง · ต.ค. 2026', to: 'ฟิลด์ของเคส CS-4821' } },
      { id: 's3', kind: 'BRANCH', title: 'ลูกค้าเปิดเรื่องราคาแบบไหน',
        say: 'ก่อนจะสรุปราคาให้ ขอถามอีกนิดนะครับ ตอนนี้เทียบกับระบบอื่นอยู่ด้วยไหมครับ',
        br: [{ label: 'ขอส่วนลดตรง ๆ', to: 's4' }, { label: 'เทียบกับเจ้าอื่นอยู่', to: 's5' }, { label: 'อื่น ๆ / ยังไม่ถามราคา', to: 's6' }] },
      { id: 's4', kind: 'SAY', title: 'กรอบส่วนลดที่ให้ได้เอง', next: 's6', kb: 'ตารางส่วนลดตามจำนวนที่นั่ง (ภายใน)',
        say: 'สำหรับ 50 ที่นั่งขึ้นไป ผมให้ได้ถึง 12% ครับ ถ้าต้องการมากกว่านั้นต้องขออนุมัติหัวหน้าทีมก่อน ใช้เวลาประมาณ 1 ชั่วโมงครับ — ผมไม่อยากรับปากเกินกว่าที่ให้ได้จริงครับ' },
      { id: 's5', kind: 'SAY', title: 'เทียบกับเจ้าอื่น — พูดถึงของเราเท่านั้น', next: 's6',
        kb: 'แพ็กเกจและราคา ปี 2026', kbStale: true,
        say: 'ผมขอเล่าเฉพาะของเรานะครับ จุดที่ลูกค้ามักเลือกเราคือทุกช่องทางอยู่ในคิวเดียวและรายงานชุดเดียว และติดตั้งในองค์กรเองได้ถ้านโยบายต้องการครับ' },
      { id: 's6', kind: 'ACTION', req: true, title: 'สรุปขั้นถัดไปก่อนวางสาย',
        say: 'สรุปนะครับ ผมจะส่งใบเสนอราคาให้ทางอีเมลภายในวันนี้ และขอติดต่อกลับวันศุกร์เพื่อสอบถามผลครับ',
        act: [{ label: 'ส่งใบเสนอราคาทางอีเมล', t: 'ร่างอีเมลใบเสนอราคาแนบเข้าเคส CS-4821 (mock)' },
              { label: 'บันทึกผล: กำลังพิจารณา', t: 'เสนอ disposition "กำลังพิจารณา" — เอเจนต์เป็นคนกดยืนยัน (mock)' }] },
    ],
  },
  sc_collect: {
    name: 'ติดตามค่างวดที่ชำระไม่ผ่าน', ver: 11, bind: 'แคมเปญ "ทวงถามยอดค้าง ส.ค."', purpose: 'COLLECTION',
    steps: [
      { id: 'c1', kind: 'SAY', req: true, title: 'แจ้งบันทึกเสียง + ยืนยันตัวตนผู้รับสาย', next: 'c2',
        say: 'สวัสดีครับ สายนี้มีการบันทึกเสียงเพื่อคุณภาพการให้บริการครับ ขออนุญาตยืนยันตัวตนก่อนนะครับ รบกวนขอวันเดือนปีเกิดของคุณนภาครับ' },
      { id: 'c2', kind: 'SAY', req: true, title: 'แจ้งวัตถุประสงค์การติดต่อให้ชัด', next: 'c3',
        say: 'ผมติดต่อมาเรื่องค่างวดงวดเดือนกรกฎาคม ยอด 2,480 บาท ที่ระบบแจ้งว่าชำระไม่ผ่านครับ' },
      { id: 'c3', kind: 'BRANCH', title: 'ลูกค้าตอบว่าอย่างไร', say: 'ไม่ทราบว่าตอนนี้สถานะเป็นอย่างไรบ้างครับ',
        br: [{ label: 'ชำระไปแล้ว', to: 'c6' }, { label: 'ขอผ่อนผัน', to: 'c4' }, { label: 'โต้แย้งยอด', to: 'c5' }] },
      { id: 'c4', kind: 'ASK', title: 'นัดวันที่จะชำระ (ห้ามเกิน 7 วัน)', next: 'c7',
        say: 'เข้าใจครับ ไม่ทราบว่าสะดวกชำระภายในวันไหนครับ',
        cap: { label: 'วันที่ลูกค้ารับปาก', ph: 'เช่น 20-08-2026', to: 'ob_record.attrs.promiseDate' } },
      { id: 'c5', kind: 'ACTION', title: 'เปิดเคสโต้แย้งยอด — หยุดการติดตามระหว่างตรวจสอบ', next: 'c7',
        say: 'ผมจะเปิดเรื่องให้ทีมตรวจสอบยอดให้นะครับ ระหว่างนี้จะไม่มีการติดตามจนกว่าจะได้ข้อสรุปครับ',
        act: [{ label: 'สร้างเคสโต้แย้งยอด', t: 'สร้างเคสประเภท "โต้แย้งยอด" พร้อมบริบทของสายนี้ (mock)' }] },
      { id: 'c6', kind: 'SAY', title: 'ยืนยันการชำระที่เข้าระบบแล้ว + ขออภัย', next: 'c7',
        say: 'ระบบเพิ่งได้รับการชำระของคุณแล้วครับ ต้องขออภัยที่โทรมารบกวน ผมยกเลิกการติดตามให้เรียบร้อยแล้วครับ' },
      { id: 'c7', kind: 'ACTION', req: true, title: 'บันทึกผลการติดต่อก่อนปิดงาน',
        say: 'ขอบคุณที่สละเวลาครับ หากมีข้อสงสัยติดต่อกลับได้ที่เบอร์นี้ตลอดเวลาทำการครับ',
        act: [{ label: 'บันทึกผลการติดต่อ', t: 'เสนอ disposition ตามทางแยกที่เดินมา — เอเจนต์กดยืนยัน (mock)' }] },
    ],
  },
};
var SCRIPT_RUNS = {};   // ต่อ interaction — เก็บเส้นทางที่เดินจริง เป็นหลักฐานเดียวกับ assist_script_run.path
function scriptRun(c) {
  if (!c || !c.scriptId) return null;
  var s = SCRIPTS[c.scriptId]; if (!s) return null;
  if (!SCRIPT_RUNS[c.id]) SCRIPT_RUNS[c.id] = { cur: s.steps[0].id, done: {}, cap: {}, skip: {}, asking: false };
  return SCRIPT_RUNS[c.id];
}
function scriptStep(s, id) { return s.steps.filter(function (x) { return x.id === id; })[0]; }
function scriptMissed(c) {
  var s = c && c.scriptId ? SCRIPTS[c.scriptId] : null, r = SCRIPT_RUNS[c && c.id];
  if (!s || !r) return [];
  return s.steps.filter(function (x) { return x.req && !r.done[x.id] && !r.skip[x.id]; });
}
function renderScriptPanel(c) {
  var el = document.getElementById('sw-script'); if (!el) return;
  var r = scriptRun(c);
  if (!r) { el.innerHTML = ''; return; }
  var s = SCRIPTS[c.scriptId], st = scriptStep(s, r.cur);
  var doneN = Object.keys(r.done).length, total = s.steps.length;
  var KIND = { SAY: ['ti-quote', 'พูด'], ASK: ['ti-help-square', 'ถามและเก็บคำตอบ'], BRANCH: ['ti-arrows-split', 'ทางแยก'],
               ACTION: ['ti-bolt', 'ลงมือทำ'], KB: ['ti-book', 'บทความ'] };
  var k = KIND[st.kind] || KIND.SAY;
  var q = "'" + c.id + "'";

  // สายนี้มาจากลำดับที่เพิ่งบรรลุเป้าหมาย — สคริปต์ต้องยอมให้กระโดดไปขั้นที่ตรงกับความจริง
  var jump = (c.journey && c.journey.state === 'GOAL_REACHED' && scriptStep(s, 'c6') && r.cur !== 'c6' && !r.done.c6)
    ? '<div class="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 mb-3 text-xs text-rose-900">' +
        '<i class="ti ti-alert-triangle mr-1"></i>ลูกค้าชำระแล้วระหว่างที่สายกำลังคุย — ขั้นทวงถามใช้ไม่ได้แล้ว' +
        '<button class="qbtn w-full justify-center mt-2" style="font-size:12px" onclick="scriptGo(' + q + ',\'c6\',\'ข้ามเพราะลำดับบรรลุเป้าหมายระหว่างสาย\')">' +
        '<i class="ti ti-player-track-next"></i>ข้ามไปขั้น "ยืนยันการชำระ"</button></div>' : '';

  var body = '<div class="rounded-lg bg-slate-50 border border-slate-200 p-3 mb-2">' +
    '<p class="text-[11px] text-slate-400 mb-1">' + (st.kind === 'ASK' ? 'คำถาม' : 'ถ้อยคำที่ต้องใช้') + '</p>' +
    '<p class="text-sm text-slate-800 leading-relaxed">' + st.say + '</p></div>';

  if (st.kb) body += '<div class="att mb-2" title="สคริปต์อ้างบทความ ไม่ได้เก็บเนื้อหาซ้ำ">' +
    '<i class="ti ti-book text-teal-700"></i><span class="flex-1 truncate">' + st.kb + '</span>' +
    (st.kbStale ? '<span class="tag tag-bad" style="font-size:10px">เลยรอบทบทวน</span>'
                : '<i class="ti ti-external-link text-slate-400"></i>') + '</div>';
  if (st.kbStale) body += '<p class="text-[11px] text-rose-600 mb-2"><i class="ti ti-alert-circle mr-1"></i>บทความที่ขั้นนี้อ้างเลยรอบทบทวนมา 60 วัน — แจ้งเจ้าของบทความแล้ว</p>';

  if (st.kind === 'ASK') {
    body += '<div class="flex gap-2 mb-2"><input class="inp !h-9 flex-1 text-[13px]" id="sc-cap" placeholder="' + st.cap.ph + '" value="' + (r.cap[st.id] || '') + '">' +
      '<button class="qbtn on" onclick="scriptCapture(' + q + ')"><i class="ti ti-device-floppy"></i>เก็บ</button></div>' +
      '<p class="text-[11px] text-slate-400 mb-2">เก็บลง <code>' + st.cap.to + '</code> — node ASK ต้องมีปลายทางเสมอ</p>';
  }
  if (st.kind === 'BRANCH') {
    body += '<p class="text-xs text-slate-500 mb-1.5">ลูกค้าตอบแบบไหน</p><div class="space-y-1.5 mb-2">' +
      st.br.map(function (b) {
        return '<button class="qbtn w-full justify-start" onclick="scriptGo(' + q + ',\'' + b.to + '\')">' +
          '<i class="ti ti-arrow-right"></i>' + b.label + '</button>';
      }).join('') + '</div>';
  }
  if (st.kind === 'ACTION') {
    body += '<div class="space-y-1.5 mb-2">' + st.act.map(function (a) {
      return '<button class="qbtn w-full justify-start" onclick="toast(\'' + a.t + '\')"><i class="ti ti-bolt"></i>' + a.label + '</button>';
    }).join('') + '</div>';
  }

  var nav = '<div class="flex gap-2">';
  if (c.ch !== 'voice') nav += '<button class="qbtn" onclick="toast(\'แทรกถ้อยคำลง composer — เอเจนต์กดส่งเอง (mock)\')" title="แทรกลงช่องพิมพ์"><i class="ti ti-file-invoice"></i></button>';
  if (st.kind !== 'BRANCH') nav += '<button class="qbtn on flex-1 justify-center" onclick="scriptGo(' + q + ',' + (st.next ? "'" + st.next + "'" : 'null') + ')">' +
    '<i class="ti ti-check"></i>' + (st.next ? 'ทำแล้ว · ขั้นถัดไป' : 'ทำแล้ว · จบสคริปต์') + '</button>';
  nav += '<button class="qbtn" onclick="scriptAskSkip(' + q + ')" title="ข้ามขั้นนี้"><i class="ti ti-player-skip-forward"></i></button></div>';

  var skipBox = r.asking
    ? '<div class="rounded-lg bg-amber-50 border border-amber-200 p-2.5 mt-2">' +
        '<p class="text-xs text-amber-900 mb-1.5">' + (st.req ? '<b>ขั้นบังคับ</b> — ข้ามได้ แต่เหตุผลจะถูกบันทึกและเข้ารายงานชั้นกำกับ' : 'ระบุเหตุผลที่ข้าม') + '</p>' +
        '<select class="inp !h-9 text-[13px] mb-1.5" id="sc-skip">' +
          '<option>ลูกค้าพูดเรื่องนี้ไปเองแล้ว</option><option>ไม่เกี่ยวกับเรื่องที่ลูกค้าติดต่อมา</option>' +
          '<option>ลูกค้าเร่ง/ไม่สะดวกฟัง</option><option>ข้อมูลในสคริปต์ไม่ตรงกับความจริงแล้ว</option></select>' +
        '<div class="flex gap-2"><button class="qbtn on flex-1 justify-center" onclick="scriptSkip(' + q + ')">ยืนยันข้าม</button>' +
        '<button class="qbtn" onclick="scriptAskSkip(' + q + ',1)">ยกเลิก</button></div></div>'
    : '';

  var trail = s.steps.map(function (x, i) {
    var cls = x.id === r.cur ? 'background:#0f766e;color:#fff'
      : r.done[x.id] ? 'background:#d1fae5;color:#065f46'
      : r.skip[x.id] ? 'background:#fee2e2;color:#991b1b' : 'background:#f1f5f9;color:#94a3b8';
    return '<span title="' + x.title + (r.skip[x.id] ? ' — ข้าม: ' + r.skip[x.id] : '') + '" ' +
      'style="' + cls + ';display:inline-flex;width:22px;height:22px;border-radius:6px;align-items:center;justify-content:center;font-size:11px;font-weight:600">' + (i + 1) + '</span>';
  }).join('');

  el.innerHTML = '<div class="bg-white border border-teal-300 rounded-xl p-4">' +
    '<div class="flex items-center justify-between gap-2 mb-1">' +
      '<h2 class="text-sm font-semibold text-teal-900"><i class="ti ti-list-numbers mr-1"></i>สคริปต์นำบทสนทนา</h2>' +
      '<span class="tag tag-ok" title="เวอร์ชันถูกล็อกไว้กับสายนี้ — publish ใหม่ไม่สลับกลางสาย">v' + s.ver + ' · ล็อกกับสายนี้</span></div>' +
    '<p class="text-xs text-slate-500 mb-1">' + s.name + ' <span class="text-slate-400">· ' + s.bind + '</span></p>' +
    (s.purpose === 'SALES' ? '<div class="flex flex-wrap gap-1.5 mb-3"><span class="tag tag-info"><i class="ti ti-route mr-1"></i>' + s.stage + '</span><span class="tag"><i class="ti ti-chart-dots mr-1"></i>' + s.metric + '</span></div>' : '') +
    '<div class="slabar" style="margin:8px 0 4px"><div class="s-good" style="width:' + Math.round(doneN / total * 100) + '%"></div></div>' +
    '<p class="text-[11px] text-slate-400 mb-3">เดินแล้ว ' + doneN + ' จาก ' + total + ' ขั้น</p>' +
    jump +
    '<div class="flex items-center gap-1.5 mb-1.5"><i class="ti ' + k[0] + ' text-teal-700"></i>' +
      '<span class="text-sm font-medium text-slate-800">' + st.title + '</span>' +
      (st.req ? '<span class="tag tag-warn" style="font-size:10px">บังคับ</span>' : '') +
      '<span class="tag" style="font-size:10px;margin-left:auto">' + k[1] + '</span></div>' +
    body + nav + skipBox +
    '<div class="border-t border-slate-100 mt-3 pt-2.5">' +
      '<div class="flex flex-wrap gap-1 mb-1.5">' + trail + '</div>' +
      '<p class="text-[11px] text-slate-400">เส้นทางที่เดินจริงถูกบันทึกพร้อมเวอร์ชัน — ใช้เป็นหลักฐานย้อนหลังได้ 24 เดือน</p>' +
      '<p class="text-[11px] text-slate-400 mt-0.5"><i class="ti ti-circle-off mr-1"></i>ถ้อยคำนี้ไม่ผ่าน AI — คนเขียนและ publish เป็นเวอร์ชัน</p>' +
    '</div></div>';
}
function scriptGo(id, to, reason) {
  var c = CONVS.filter(function (x) { return x.id === id; })[0], r = SCRIPT_RUNS[id]; if (!c || !r) return;
  if (reason) r.skip[r.cur] = reason; else r.done[r.cur] = 1;
  r.asking = false;
  if (to) { r.cur = to; } else { toast('เดินสคริปต์ครบแล้ว — ผลถูกแนบเข้า interaction (mock)'); }
  renderScriptPanel(c); renderSwTabs(c); renderScriptBlock();
}
function scriptCapture(id) {
  var c = CONVS.filter(function (x) { return x.id === id; })[0], r = SCRIPT_RUNS[id];
  var v = document.getElementById('sc-cap'); if (!c || !r || !v) return;
  r.cap[r.cur] = v.value;
  toast(v.value ? 'เก็บคำตอบแล้ว (mock)' : 'ยังไม่ได้กรอกคำตอบ');
  renderScriptPanel(c);
}
function scriptAskSkip(id, cancel) {
  var c = CONVS.filter(function (x) { return x.id === id; })[0], r = SCRIPT_RUNS[id]; if (!c || !r) return;
  r.asking = !cancel; renderScriptPanel(c);
}
function scriptSkip(id) {
  var sel = document.getElementById('sc-skip');
  var c = CONVS.filter(function (x) { return x.id === id; })[0], r = SCRIPT_RUNS[id]; if (!c || !r) return;
  var s = SCRIPTS[c.scriptId], st = scriptStep(s, r.cur);
  var to = st.next || (st.br && st.br[st.br.length - 1].to) || null;
  scriptGo(id, to, sel ? sel.value : 'ไม่ระบุ');
  toast('ข้ามขั้น "' + st.title + '" · บันทึกเหตุผลแล้ว (mock)');
}
// ขั้นบังคับที่ยังไม่ได้ทำ บล็อกได้แค่หน้าสรุปงาน — ห้ามบล็อกการคุยหรือการรับสาย
function renderScriptBlock() {
  var el = document.getElementById('sw-script-block'); if (!el) return;
  var c = CONVS.filter(function (x) { return x.id === selectedWork; })[0];
  var miss = scriptMissed(c);
  el.innerHTML = miss.length
    ? '<div class="rounded-lg bg-rose-50 border border-rose-200 p-2.5 mb-2">' +
        '<p class="text-xs font-semibold text-rose-900 mb-1"><i class="ti ti-shield-exclamation mr-1"></i>ขั้นบังคับของสคริปต์ยังไม่ครบ ' + miss.length + ' ขั้น</p>' +
        miss.map(function (m) {
          return '<p class="text-xs text-rose-800">· ' + m.title +
            ' <button class="underline" onclick="scriptJump(\'' + c.id + '\',\'' + m.id + '\')">ไปที่ขั้นนี้</button></p>';
        }).join('') +
        '<p class="text-[11px] text-rose-700 mt-1">ปิดงานไม่ได้จนกว่าจะทำ หรือระบุเหตุผลที่ข้าม — การคุยไม่ถูกบล็อก</p></div>'
    : '';
}
function scriptJump(id, to) {
  var c = CONVS.filter(function (x) { return x.id === id; })[0], r = SCRIPT_RUNS[id]; if (!c || !r) return;
  r.cur = to; r.asking = false; renderScriptPanel(c);
}

/* ============================================================
   แท็บของแผงบริบท — แผงมันเยอะเกินกว่าจะเรียงซ้อนกันในคอลัมน์เดียว
   กติกาที่ห้ามผิด: แท็บที่ปิดอยู่ต้องไม่กลืนของด่วน → badge บนแท็บ + แถบเตือนด้านบน
   และห้ามสลับแท็บให้เอเจนต์เองระหว่างที่เขากำลังพิมพ์ — เสนอปุ่มให้กดแทน
   ============================================================ */
var SW_TABS = {};        // แท็บที่เปิดอยู่ — จำแยกต่อชิ้นงาน ไม่ใช่ค่าเดียวทั้งหน้าจอ
var SW_APP_DONE = {};    // ข้อเสนอจากแอปที่เอเจนต์ตัดสินไปแล้ว
function swTabDefs(c) {
  var d = [{ k: 'customer', i: 'ti-user', n: 'ลูกค้า' }];
  if (c && c.scriptId) d.push({ k: 'script', i: 'ti-list-numbers', n: 'สคริปต์' });
  d.push({ k: 'work', i: 'ti-ticket', n: 'งานค้าง' });
  d.push({ k: 'help', i: 'ti-help-circle', n: 'ขอความช่วย' });
  d.push({ k: 'apps', i: 'ti-apps', n: 'แอป' });
  return d;
}
// badge: {n: ข้อความ, u: ด่วน(แดง), why: เหตุผลที่จะขึ้นแถบเตือนถ้าแท็บนี้ไม่ได้เปิดอยู่}
function swBadge(c, k) {
  if (!c) return null;
  if (k === 'script') {
    // ขั้นบังคับที่ยังไม่ครบเป็น "ของด่วน" ตอนสรุปงานเท่านั้น — ระหว่างคุยมันคือเรื่องปกติ ไม่ต้องทำเป็นสีแดง
    var miss = scriptMissed(c).length;
    if (c.state === 'WRAPUP' && miss) return { n: miss, u: 1, why: 'สคริปต์: ขั้นบังคับยังไม่ครบ ' + miss + ' ขั้น — ปิดงานไม่ได้' };
    var r = SCRIPT_RUNS[c.id], s = SCRIPTS[c.scriptId];
    var left = s ? s.steps.length - (r ? Object.keys(r.done).length + Object.keys(r.skip).length : 0) : 0;
    return left > 0 ? { n: left } : null;
  }
  if (k === 'work') {
    if (c.journey && c.journey.state === 'GOAL_REACHED') return { n: '!', u: 1, why: 'ลำดับอัตโนมัติ: เหตุผลของสายนี้หมดไปแล้ว' };
    if (c.caseInfo) return { n: 1, u: /เหลือ 1 ชม/.test(c.caseInfo.due) ? 1 : 0, why: 'เคส ' + c.caseInfo.number + ' · SLA ' + c.caseInfo.due };
    return null;
  }
  if (k === 'help') return { n: 1 + (c.assist ? 1 : 0), why: 'ผู้เชี่ยวชาญตอบกลับแล้ว' };
  if (k === 'apps') { var a = swAppSuggest(c); return a ? { n: 1, why: 'Salesforce เสนอ: ' + a.label } : null; }
  return null;
}
function swTab(id, k) { SW_TABS[id] = k; var c = CONVS.filter(function (x) { return x.id === id; })[0]; if (c) renderWorkPanels(c); }
function renderSwTabs(c) {
  var bar = document.getElementById('sw-tabs'); if (!bar || !c) return;
  var defs = swTabDefs(c), keys = defs.map(function (d) { return d.k; });
  // ค่าเริ่มต้น: งานที่มีสคริปต์ให้เดิน เปิดแท็บสคริปต์ก่อน — นั่นคือสิ่งที่ต้องทำจริงตอนนี้
  var cur = SW_TABS[c.id];
  if (!cur || keys.indexOf(cur) < 0) cur = SW_TABS[c.id] = (c.scriptId ? 'script' : 'customer');
  bar.innerHTML = defs.map(function (d) {
    var b = swBadge(c, d.k);
    return '<button class="swtab' + (d.k === cur ? ' on' : '') + '" onclick="swTab(\'' + c.id + '\',\'' + d.k + '\')" title="' + d.n + '">' +
      '<i class="ti ' + d.i + '"></i><span>' + d.n + '</span>' +
      (b ? '<span class="swtab-dot' + (b.u ? '' : ' q') + '">' + b.n + '</span>' : '') + '</button>';
  }).join('');
  document.querySelectorAll('#app .swpane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === cur); });

  // ของด่วนที่อยู่หลังแท็บที่ปิดอยู่ — ยกขึ้นมาให้เห็น พร้อมปุ่มไปที่แท็บนั้น
  var al = document.getElementById('sw-alerts'); if (!al) return;
  var urgent = defs.filter(function (d) { var b = swBadge(c, d.k); return d.k !== cur && b && b.u; });
  al.innerHTML = urgent.map(function (d) {
    var b = swBadge(c, d.k);
    return '<div class="flex items-center gap-2 rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 mb-2">' +
      '<i class="ti ti-alert-triangle text-rose-600"></i>' +
      '<p class="text-xs text-rose-900 flex-1">' + b.why + '</p>' +
      '<button class="qbtn" onclick="swTab(\'' + c.id + '\',\'' + d.k + '\')">ไปที่แท็บ</button></div>';
  }).join('');
}

/* ---------- แท็บแอป: visual app ของลูกค้าฝังในพื้นที่ทำงาน (integration-platform §9)
   ทิศทางตรงข้ามกับ CTI — และแอป "เสนอ" ได้อย่างเดียว เอเจนต์เป็นคนกดยืนยันเสมอ ---------- */
function swAppSuggest(c) {
  if (!c || !c.crm || !c.crm.suggest || SW_APP_DONE[c.id]) return null;
  return c.crm.suggest;
}
function renderApps(c) {
  var el = document.getElementById('sw-apps'); if (!el || !c) return;
  var crm = c.crm, sug = swAppSuggest(c);

  var sf = '<div class="bg-white border border-slate-200 rounded-xl p-4">' +
    '<div class="flex items-center gap-2 mb-1">' +
      '<span class="w-7 h-7 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center"><i class="ti ti-cloud"></i></span>' +
      '<div class="flex-1 min-w-0"><p class="text-sm font-semibold text-slate-800">Salesforce</p>' +
      '<p class="text-[11px] text-slate-400">ตัวเชื่อม <code>sf-prod</code> · OAuth ของ tenant</p></div>' +
      (crm ? '<span class="tag tag-ok">พบเรคคอร์ด</span>' : '<span class="tag tag-warn">ไม่พบเรคคอร์ด</span>') + '</div>';

  if (crm) {
    sf += '<div class="rounded-lg bg-slate-50 border border-slate-200 p-3 mt-2">' +
      '<p class="text-[11px] text-slate-400">' + crm.obj + ' · <span class="font-mono">' + crm.id + '</span></p>' +
      '<p class="text-sm font-medium text-slate-800 mt-0.5">' + crm.name + '</p>' +
      '<p class="text-xs text-slate-500">' + crm.acct + '</p>' +
      '<dl class="text-xs text-slate-600 mt-2 space-y-1">' + crm.fields.map(function (f) {
        return '<div class="flex justify-between gap-3"><dt class="text-slate-400">' + f[0] + '</dt><dd class="text-right">' + f[1] + '</dd></div>';
      }).join('') + '</dl></div>' +
      '<div class="flex gap-2 mt-2">' +
        '<button class="qbtn flex-1 justify-center" onclick="toast(\'เปิดเรคคอร์ดใน Salesforce แท็บใหม่ (mock)\')"><i class="ti ti-external-link"></i>เปิดใน Salesforce</button>' +
        '<button class="qbtn" onclick="toast(\'บันทึก activity กลับเข้า Salesforce พร้อมลิงก์ไปยัง interaction นี้ (mock)\')" title="บันทึก activity"><i class="ti ti-notes"></i></button></div>';
  } else {
    sf += '<p class="text-xs text-slate-500 mt-2">ยังจับคู่กับเรคคอร์ดไม่ได้เพราะงานนี้ยังไม่ระบุตัวตนลูกค้า — ' +
      'screen pop ทำงานหลังผูกตัวตนแล้วเท่านั้น</p>' +
      '<button class="qbtn w-full justify-center mt-2" onclick="toast(\'ค้นหาใน Salesforce ด้วยอีเมล/เบอร์ที่ลูกค้าให้ไว้ (mock)\')"><i class="ti ti-search"></i>ค้นหาใน Salesforce</button>';
  }

  if (sug) {
    sf += '<div class="rounded-lg bg-violet-50 border border-violet-200 p-3 mt-3">' +
      '<p class="text-[11px] text-violet-700 font-mono mb-1">' + sug.msg + '</p>' +
      '<p class="text-sm text-slate-800">' + sug.label + '</p>' +
      '<div class="flex gap-2 mt-2">' +
        '<button class="qbtn on flex-1 justify-center" onclick="appDecide(\'' + c.id + '\',1)"><i class="ti ti-check"></i>ยืนยัน</button>' +
        '<button class="qbtn" onclick="appDecide(\'' + c.id + '\',0)">ไม่ใช้</button></div>' +
      '<p class="text-[11px] text-violet-700 mt-2">แอปภายนอกแก้ข้อมูลของเราเองไม่ได้ — เสนอได้อย่างเดียว</p></div>';
  }
  sf += '<p class="text-[11px] text-slate-400 mt-2 font-mono">dc:context { interactionId, contactId: ' +
    (crm ? '"ct_8841"' : 'null') + ', channel: "' + c.ch + '" }</p></div>';

  var order = '<div class="bg-white border border-slate-200 rounded-xl p-4">' +
    '<div class="flex items-center gap-2 mb-2">' +
      '<span class="w-7 h-7 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center"><i class="ti ti-package"></i></span>' +
      '<div class="flex-1 min-w-0"><p class="text-sm font-semibold text-slate-800">Order panel</p>' +
      '<p class="text-[11px] text-slate-400">crm.acme.co.th · iframe ที่ลูกค้าดูแลเอง</p></div>' +
      '<span class="tag tag-ok">ใช้งาน</span></div>' +
    '<div class="appframe"><i class="ti ti-layout-board text-xl"></i><span>หน้าจอของลูกค้าเรนเดอร์ตรงนี้<br>สูงตามที่แอปขอผ่าน <code>app:resize</code></span></div></div>';

  var ins = '<div class="bg-white border border-slate-200 rounded-xl p-4 opacity-70">' +
    '<div class="flex items-center gap-2">' +
      '<span class="w-7 h-7 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center"><i class="ti ti-shield-half"></i></span>' +
      '<div class="flex-1 min-w-0"><p class="text-sm font-semibold text-slate-700">ตรวจสอบสิทธิ์ประกัน</p>' +
      '<p class="text-[11px] text-slate-400">ยังเป็นฉบับร่าง — ยังไม่ปล่อยให้เอเจนต์เห็นของจริง</p></div>' +
      '<span class="tag tag-warn">ร่าง</span></div></div>';

  el.innerHTML = '<div class="space-y-3">' + sf + order + ins +
    '<div class="note note-info !text-[12px] !py-2.5"><i class="ti ti-shield-lock"></i>' +
      '<p>token ของแอปอายุสั้นและผูกกับ origin ที่ลงทะเบียนไว้ · ทุกข้อความต้องมี namespace <code>dc:</code> / <code>app:</code> ' +
      '(<a class="underline" href="../docs/integration-platform.md">integration-platform §9</a>)</p></div>' +
    '<p class="text-[11px] text-slate-400">ยังมีแอปอีก 1 ตัวที่ผูกกับ<b>หน้าจอสรุปงาน</b> — จะขึ้นตอนกด Resolve ไม่ใช่ตรงนี้ · ' +
      '<a class="underline" href="integrations.html?view=visual-apps">จัดการแอปที่ฝังได้</a></p></div>';
}
function appDecide(id, ok) {
  SW_APP_DONE[id] = 1;
  var c = CONVS.filter(function (x) { return x.id === id; })[0];
  toast(ok ? 'รับข้อเสนอของแอปแล้ว — บันทึกว่ามาจาก Salesforce (mock)' : 'ปฏิเสธข้อเสนอของแอป · เก็บไว้วัดคุณภาพของแอป (mock)');
  if (c) renderWorkPanels(c);
}

// แผงย่อของ module อื่น: แสดงเฉพาะข้อมูลที่ช่วยให้จัดการงานตรงหน้าได้ แล้ว deep-link ไปหน้าของโมดูลนั้น
function renderWorkPanels(c) {
  renderJourneyContext(c);
  renderScriptPanel(c);
  renderApps(c);
  renderSwTabs(c);
  var caseEl = document.getElementById('sw-case');
  var assistEl = document.getElementById('sw-assist');
  if (caseEl) {
    if (c && c.caseInfo) {
      var k = c.caseInfo;
      caseEl.innerHTML = '<div class="bg-white border border-amber-200 rounded-xl p-4">' +
        '<div class="flex items-center justify-between gap-2 mb-2"><h2 class="text-sm font-semibold text-amber-900"><i class="ti ti-ticket mr-1"></i>เคสที่เกี่ยวข้อง</h2><span class="tag tag-warn">' + k.state + '</span></div>' +
        '<p class="font-medium text-sm">' + k.number + ' · ' + k.subject + '</p>' +
        '<p class="text-xs text-rose-700 mt-1"><i class="ti ti-clock-exclamation mr-1"></i>SLA ' + k.due + '</p>' +
        '<p class="text-xs text-slate-500 mt-1">เจ้าของ: ' + k.owner + '</p>' +
        '<button class="qbtn w-full justify-center mt-3" onclick="location.href=\'cases.html?view=case-detail\'"><i class="ti ti-arrow-up-right"></i>เปิดเคสและงานย่อย</button></div>';
    } else {
      caseEl.innerHTML = '<div class="bg-white border border-slate-200 rounded-xl p-4">' +
        '<div class="flex items-center justify-between gap-2"><div><h2 class="text-sm font-semibold text-slate-700"><i class="ti ti-ticket mr-1"></i>Case</h2><p class="text-xs text-slate-500 mt-1">ยังไม่มีเคสเปิดสำหรับงานนี้</p></div>' +
        '<button class="qbtn" onclick="toast(\'สร้าง case พร้อมบริบทของงานนี้ (mock)\')"><i class="ti ti-plus"></i>สร้างเคส</button></div></div>';
    }
  }
  if (assistEl) {
    if (c && c.assist) {
      var a = c.assist;
      assistEl.innerHTML = '<div class="bg-white border border-violet-200 rounded-xl p-4">' +
        '<div class="flex items-center justify-between gap-2 mb-2"><h2 class="text-sm font-semibold text-violet-900"><i class="ti ti-sparkles mr-1"></i>คำแนะนำที่เกี่ยวข้อง</h2><span class="tag tag-ai">1 ใบ</span></div>' +
        '<p class="text-sm font-medium text-slate-800">' + a.title + '</p><p class="text-xs text-slate-600 mt-1">' + a.detail + '</p>' +
        '<p class="text-[11px] text-slate-400 mt-2">ที่มา: ' + a.source + '</p>' +
        '<div class="flex gap-2 mt-3"><button class="qbtn on flex-1 justify-center" onclick="toast(\'แทรกข้อความร่างลง composer — agent ต้องกดส่งเอง (mock)\')"><i class="ti ti-file-invoice"></i>แทรกข้อความ</button>' +
        '<button class="qbtn" onclick="toast(\'บันทึกว่าไม่เกี่ยว เพื่อวัด acceptance rate (mock)\')">ไม่เกี่ยว</button></div></div>';
    } else {
      assistEl.innerHTML = '';
    }
  }
}
// Resolve = ปิดงานชิ้นนี้ ไม่ใช่ปิดห้อง (ADR-023 ข้อ 5) — เข้าโหมดสรุปงานจริง ไม่ใช่แค่ toast
function resolveWork() {
  var c = CONVS.filter(function (x) { return x.id === selectedWork; })[0]; if (!c) return;
  c.state = 'WRAPUP';
  var w = document.getElementById('sw-wrapmode'); if (w) w.style.display = 'block';
  var cm = document.getElementById('sw-composer'); if (cm) cm.style.display = 'none';
  var rb = document.getElementById('sw-resolve'); if (rb) rb.style.display = 'none';
  var st = document.getElementById('sw-state'); if (st) { st.textContent = 'งาน: WRAPUP · ห้อง: OPEN'; st.className = 'tag tag-warn'; }
  renderInbox();
  renderScriptBlock();
  toast('เข้าโหมดสรุปงาน — ห้องยังเปิด ลูกค้าพิมพ์กลับได้ (mock)');
}
function completeWork() {
  var cur = CONVS.filter(function (x) { return x.id === selectedWork; })[0];
  var miss = scriptMissed(cur);
  if (miss.length) {
    renderScriptBlock(); renderSwTabs(cur);
    toast('ยังปิดงานไม่ได้ — ขั้นบังคับของสคริปต์เหลือ ' + miss.length + ' ขั้น');
    return;
  }
  var i = CONVS.map(function (x) { return x.id; }).indexOf(selectedWork);
  var name = i >= 0 ? CONVS[i].name : '';
  if (i >= 0) CONVS.splice(i, 1);
  var w = document.getElementById('sw-wrapmode'); if (w) w.style.display = 'none';
  var cm = document.getElementById('sw-composer'); if (cm) cm.style.display = 'block';
  var rb = document.getElementById('sw-resolve'); if (rb) rb.style.display = 'inline-flex';
  var st = document.getElementById('sw-state'); if (st) { st.textContent = 'ห้อง: OPEN'; st.className = 'tag tag-ok'; }
  if (CONVS.length) selectWork(CONVS[0].id); else renderInbox();
  toast('ปิดงาน ' + name + ' → COMPLETED · ห้องเป็น IDLE · ถ้าลูกค้าพิมพ์กลับใน 30 นาทีจะได้งานใหม่ที่ชี้กลับใบนี้ (mock)');
}

// รับงาน digital ภายในเวลา ack — ถ้าไม่กด ระบบคืนคิวและ slot ว่างทันที (§4.1)
function ackWork(id) {
  var c = CONVS.filter(function (x) { return x.id === id; })[0]; if (!c) return;
  c.state = 'ACTIVE'; delete c.ackLeft;
  TRANSCRIPTS[id] = TRANSCRIPTS[id] || [{ in: 1, t: c.preview }];
  renderInbox(); selectWork(id);
  toast('รับงานแล้ว → ACTIVE (mock)');
}
function declineWork(id) {
  var i = CONVS.map(function (x) { return x.id; }).indexOf(id);
  if (i >= 0) CONVS.splice(i, 1);
  renderInbox();
  toast('ปฏิเสธ → คืนคิว + จับคู่ agent คนอื่น · slot ว่างทันที (mock)');
}
// นาฬิกาถอยหลังของงานที่รอ ack — หมดเวลา = คืนคิวเอง
function tickAck() {
  var changed = false;
  CONVS.forEach(function (c) {
    if (c.state !== 'ASSIGNED') return;
    c.ackLeft -= 1;
    var el = document.getElementById('ack-' + c.id);
    if (el) el.textContent = Math.max(c.ackLeft, 0) + ' วิ';
    if (c.ackLeft <= 0) {
      c.state = 'REQUEUED'; changed = true;
      var i = CONVS.map(function (x) { return x.id; }).indexOf(c.id);
      if (i >= 0) CONVS.splice(i, 1);
      toast('ไม่ได้กดรับใน 15 วินาที → คืนคิว + ทำเครื่องหมาย missed (mock)');
    }
  });
  if (changed) renderInbox();
}

// เลือกงาน — ทุก panel (บทสนทนา · ลูกค้า · สรุปงาน) ต้องเปลี่ยนตามพร้อมกัน
function selectWork(id) {
  selectedWork = id;
  var c = CONVS.filter(function (x) { return x.id === id; })[0]; if (!c) return;
  renderInbox();
  var set = function (elId, val) { var e = document.getElementById(elId); if (e) e.textContent = val; };
  set('sw-name', c.name); set('sw-queue', c.queue);
  var chip = document.getElementById('sw-channel');
  if (chip) chip.innerHTML = '<span class="ch ch-' + c.ch + '"><i class="ti ' + CH_ICON[c.ch] + '"></i>' + c.ch + '</span>';
  ['sw-cust-name', 'sw-wrap-name'].forEach(function (elId) { set(elId, c.name); });
  var guest = document.getElementById('sw-guest');
  if (guest) guest.style.display = (c.name.indexOf('Guest') === 0) ? 'block' : 'none';
  var known = document.getElementById('sw-known');
  if (known) known.style.display = (c.name.indexOf('Guest') === 0) ? 'none' : 'block';
  renderTranscript(id);
  renderWorkPanels(c);
  toast(currentLang === 'th' ? 'สลับไปงาน: ' + c.name : 'Switched to: ' + c.name);
}

/* ============================================================
   WFM (Workforce management) — mock data ตาม docs/workforce-management.md
   ============================================================ */

// รูปแบบกะ = shift template (เวลาท้องถิ่นของไซต์ — ดู ADR-008 ข้อ 4)
var SHIFT = {
  D: { t: '08:00–17:00', cls: 'sh-day' },
  M: { t: '10:00–19:00', cls: 'sh-mid' },
  E: { t: '13:00–22:00', cls: 'sh-eve' },
  N: { t: '22:00–07:00', cls: 'sh-night' },
  T: { t: 'Training', cls: 'sh-train' },
  L: { t: 'Leave', cls: 'sh-leave' },
  O: { t: 'Off', cls: 'sh-off' },
};
var WFM_DAYS = [
  { d: 'Mon', n: '10', hol: false }, { d: 'Tue', n: '11', hol: false },
  { d: 'Wed', n: '12', hol: true }, { d: 'Thu', n: '13', hol: false },
  { d: 'Fri', n: '14', hol: false }, { d: 'Sat', n: '15', hol: false },
  { d: 'Sun', n: '16', hol: false },
];
// จัดกะ 10 คน × 7 วัน (ของจริง 1,000 คน × 28 วัน — ดู §7.2 การซอยปัญหา)
var WFM_STAFF = [
  { name: 'สมชาย วงศ์ประเสริฐ', grp: 'Voice TH', sh: ['D', 'D', 'D', 'D', 'D', 'O', 'O'] },
  { name: 'สมหญิง ใจดี', grp: 'Voice TH', sh: ['D', 'D', 'D', 'O', 'O', 'D', 'D'] },
  { name: 'John Anderson', grp: 'Voice EN', sh: ['M', 'M', 'M', 'M', 'M', 'O', 'O'] },
  { name: 'อรทัย พูลสวัสดิ์', grp: 'Voice TH', sh: ['E', 'E', 'E', 'E', 'O', 'O', 'E'] },
  { name: 'ปกรณ์ ศรีสุข', grp: 'Chat TH', sh: ['D', 'D', 'L', 'L', 'D', 'O', 'O'] },
  { name: 'Maria Garcia', grp: 'Voice EN', sh: ['M', 'M', 'M', 'M', 'M', 'O', 'O'] },
  { name: 'กิตติ เจริญพร', grp: 'Chat TH', sh: ['E', 'E', 'E', 'E', 'E', 'O', 'O'] },
  { name: 'นภา จันทร์เพ็ญ', grp: 'Voice TH', sh: ['N', 'N', 'N', 'O', 'O', 'N', 'N'] },
  { name: 'วีระ ตันติกุล', grp: 'Chat TH', sh: ['D', 'T', 'T', 'D', 'D', 'O', 'O'] },
  { name: 'พรทิพย์ สายบัว', grp: 'Voice TH', sh: ['O', 'O', 'D', 'D', 'D', 'D', 'D'] },
];
// requirement ต่อวัน (มาจาก forecast → Erlang → หาร shrinkage) เทียบกับที่จัดได้จริง
var WFM_REQ_DAY = [9, 9, 5, 8, 8, 4, 4];

// segment ในกะ (นาทีนับจาก 08:00, หน้าต่างแสดงผล 08:00–18:00 = 600 นาที)
var TL_WIN = 600;
var ADH = [
  { name: 'สมชาย วงศ์ประเสริฐ', st: 'busy', adh: 98.4, cnf: 100,
    sched: [{ a: 'work', f: 0, t: 120 }, { a: 'break', f: 120, t: 135 }, { a: 'work', f: 135, t: 240 }, { a: 'lunch', f: 240, t: 300 }, { a: 'work', f: 300, t: 420 }, { a: 'break', f: 420, t: 435 }, { a: 'work', f: 435, t: 600 }],
    actual: [{ a: 'work', f: 0, t: 122 }, { a: 'break', f: 122, t: 137 }, { a: 'work', f: 137, t: 240 }, { a: 'lunch', f: 240, t: 302 }, { a: 'work', f: 302, t: 420 }, { a: 'break', f: 420, t: 436 }, { a: 'work', f: 436, t: 600 }] },
  { name: 'สมหญิง ใจดี', st: 'available', adh: 94.1, cnf: 100,
    sched: [{ a: 'work', f: 0, t: 120 }, { a: 'break', f: 120, t: 135 }, { a: 'work', f: 135, t: 240 }, { a: 'lunch', f: 240, t: 300 }, { a: 'work', f: 300, t: 600 }],
    actual: [{ a: 'work', f: 0, t: 120 }, { a: 'break', f: 120, t: 135 }, { a: 'out', f: 135, t: 152 }, { a: 'work', f: 152, t: 240 }, { a: 'lunch', f: 240, t: 300 }, { a: 'work', f: 300, t: 600 }] },
  { name: 'John Anderson', st: 'busy', adh: 91.2, cnf: 96.0,
    sched: [{ a: 'work', f: 0, t: 210 }, { a: 'lunch', f: 210, t: 270 }, { a: 'work', f: 270, t: 600 }],
    actual: [{ a: 'out', f: 0, t: 25 }, { a: 'work', f: 25, t: 210 }, { a: 'lunch', f: 210, t: 268 }, { a: 'work', f: 268, t: 600 }] },
  { name: 'อรทัย พูลสวัสดิ์', st: 'break', adh: 95.6, cnf: 100,
    sched: [{ a: 'work', f: 0, t: 180 }, { a: 'lunch', f: 180, t: 240 }, { a: 'work', f: 240, t: 420 }, { a: 'break', f: 420, t: 435 }, { a: 'work', f: 435, t: 600 }],
    actual: [{ a: 'work', f: 0, t: 180 }, { a: 'lunch', f: 180, t: 240 }, { a: 'work', f: 240, t: 330 }, { a: 'out', f: 330, t: 344 }, { a: 'work', f: 344, t: 420 }, { a: 'break', f: 420, t: 435 }, { a: 'work', f: 435, t: 600 }] },
  { name: 'ปกรณ์ ศรีสุข', st: 'acw', adh: 99.1, cnf: 100,
    sched: [{ a: 'train', f: 0, t: 240 }, { a: 'lunch', f: 240, t: 300 }, { a: 'work', f: 300, t: 600 }],
    actual: [{ a: 'train', f: 0, t: 242 }, { a: 'lunch', f: 242, t: 300 }, { a: 'work', f: 300, t: 600 }] },
  { name: 'Maria Garcia', st: 'offline', adh: 0, cnf: 0,
    sched: [{ a: 'work', f: 0, t: 210 }, { a: 'lunch', f: 210, t: 270 }, { a: 'work', f: 270, t: 600 }],
    actual: [{ a: 'out', f: 0, t: 600 }] },
];

// requirement ราย interval — Voice TH, จันทร์ 10 ส.ค. (SLA 80/20, AHT 245 วิ, shrinkage 30%)
var WFM_REQ = [
  { iv: '08:00', vol: 24, aht: 245, floor: 5, sched: 8 },
  { iv: '08:30', vol: 33, aht: 245, floor: 7, sched: 10 },
  { iv: '09:00', vol: 52, aht: 248, floor: 10, sched: 14 },
  { iv: '09:30', vol: 61, aht: 252, floor: 11, sched: 16 },
  { iv: '10:00', vol: 68, aht: 255, floor: 12, sched: 17 },
  { iv: '10:30', vol: 64, aht: 251, floor: 12, sched: 18 },
  { iv: '11:00', vol: 57, aht: 247, floor: 11, sched: 16 },
  { iv: '11:30', vol: 45, aht: 244, floor: 9, sched: 14 },
];

var WFM_TIMEOFF = [
  { who: 'สมหญิง ใจดี', type: 'ลาพักร้อน', from: '17-08-2026', to: '19-08-2026', days: 3, impact: 'ok', note: 'ไม่กระทบ coverage', status: 'pending' },
  { who: 'ปกรณ์ ศรีสุข', type: 'ลากิจ', from: '12-08-2026', to: '12-08-2026', days: 1, impact: 'warn', note: 'Chat TH เหลือ 2 คน — ต่ำกว่า requirement 1', status: 'pending' },
  { who: 'นภา จันทร์เพ็ญ', type: 'ลาพักร้อน', from: '24-08-2026', to: '28-08-2026', days: 5, impact: 'warn', note: 'กะดึกเหลือคนเดียวทั้งสัปดาห์', status: 'pending' },
  { who: 'Maria Garcia', type: 'ลาป่วย', from: '07-08-2026', to: '07-08-2026', days: 1, impact: 'ok', note: 'แจ้งย้อนหลัง — ตารางถูก publish แล้ว', status: 'approved' },
  { who: 'วีระ ตันติกุล', type: 'ลาพักร้อน', from: '03-08-2026', to: '04-08-2026', days: 2, impact: 'ok', note: '—', status: 'approved' },
];

var WFM_SITES = [
  { name: 'Bangkok HQ', tz: 'Asia/Bangkok', dst: false, cal: 'วันหยุดราชการไทย 2026 (16 วัน)', rules: 'TH Labour — 8 ชม./วัน · 48 ชม./สัปดาห์ · พัก 1 ชม. หลัง 5 ชม. · เว้นระหว่างกะ 11 ชม.', agents: 62 },
  { name: 'Chiang Mai', tz: 'Asia/Bangkok', dst: false, cal: 'วันหยุดราชการไทย 2026 (16 วัน)', rules: 'TH Labour (ชุดเดียวกับ Bangkok)', agents: 24 },
  { name: 'Manila', tz: 'Asia/Manila', dst: false, cal: 'PH public holidays 2026 (18 วัน)', rules: 'PH Labour — 8 ชม./วัน · night differential 22:00–06:00', agents: 45 },
  { name: 'Kuala Lumpur', tz: 'Asia/Kuala_Lumpur', dst: false, cal: 'MY public holidays 2026 (14 วัน)', rules: 'MY Employment Act — 8 ชม./วัน · 45 ชม./สัปดาห์', agents: 18 },
  { name: 'Sydney', tz: 'Australia/Sydney', dst: true, cal: 'NSW public holidays 2026 (11 วัน)', rules: 'Fair Work — 38 ชม./สัปดาห์ · เว้นระหว่างกะ 10 ชม.', agents: 12 },
];

var WFM_GROUPS = [
  { name: 'Voice TH', ch: ['voice'], queues: 'General Support, Sales (TH)', skills: 'general, thai', agents: 38, cov: 96 },
  { name: 'Voice EN', ch: ['voice'], queues: 'VIP Customers', skills: 'english, vip', agents: 16, cov: 88 },
  { name: 'Chat TH', ch: ['webchat', 'line'], queues: 'General Support, Technical Support', skills: 'general, technical', agents: 22, cov: 92 },
  { name: 'Billing', ch: ['email', 'facebook'], queues: 'Billing Inquiries', skills: 'billing', agents: 9, cov: 74 },
];

var WFM_ALERTS = [
  { lv: 'high', at: '10:30', msg: 'Voice TH — ปริมาณจริงสูงกว่าคาดการณ์ 22% คนบนพื้นขาด 3 · แนะนำเลื่อนพักช่วง 10:45–11:30' },
  { lv: 'high', at: '09:12', msg: 'Maria Garcia ไม่ล็อกอินตามกะ (ลาป่วยแจ้งย้อนหลัง) — Voice EN ขาด 1 ทั้งวัน' },
  { lv: 'mid', at: '08:45', msg: 'อรทัย พูลสวัสดิ์ หลุด adherence 14 นาที (BREAK ขณะตารางเป็น WORK)' },
  { lv: 'low', at: '—', msg: '12 ส.ค. (วันแม่) เป็นวันหยุด — คาดการณ์ต่ำกว่าปกติ 42% แต่ตารางจัดคนไว้เกิน 3 · แนะนำเสนอลาแบบสมัครใจ' },
];

var MY_SHIFTS = [
  { d: 'จ. 10 ส.ค.', code: 'D', seg: 'งาน 08:00–10:00 · พัก 10:00–10:15 · งาน 10:15–12:00 · พักเที่ยง 12:00–13:00 · งาน 13:00–17:00' },
  { d: 'อ. 11 ส.ค.', code: 'D', seg: 'เหมือนวันจันทร์' },
  { d: 'พ. 12 ส.ค.', code: 'D', seg: 'วันแม่ (วันหยุด) — ยังมีกะ · ค่าล่วงเวลาตามนโยบายไซต์' },
  { d: 'พฤ. 13 ส.ค.', code: 'D', seg: 'เหมือนวันจันทร์' },
  { d: 'ศ. 14 ส.ค.', code: 'D', seg: 'เหมือนวันจันทร์' },
  { d: 'ส. 15 ส.ค.', code: 'O', seg: '—' },
  { d: 'อา. 16 ส.ค.', code: 'O', seg: '—' },
];

/* ---------- WFM renderers ---------- */
function shChip(c) { return '<span class="shift ' + SHIFT[c].cls + '">' + c + ' · ' + SHIFT[c].t + '</span>'; }
function tlBar(segs) {
  return segs.map(function (s) {
    return '<span class="tl-seg a-' + s.a + '" style="left:' + (s.f / TL_WIN * 100) + '%;width:' + ((s.t - s.f) / TL_WIN * 100) + '%"></span>';
  }).join('');
}
function deltaPill(d) {
  if (d === 0) return '<span class="st st-available">ครบ</span>';
  if (d < 0) return '<span class="st st-busy">ขาด ' + Math.abs(d) + '</span>';
  return '<span class="st st-acw">เกิน ' + d + '</span>';
}

function renderSchedule() {
  var b = document.getElementById('sch-body'); if (!b) return;
  var head = document.getElementById('sch-head');
  if (head) {
    head.innerHTML = '<th class="font-normal px-3 py-2.5 text-left sticky left-0 bg-slate-50/60">Agent</th>' +
      '<th class="font-normal px-3 py-2.5 text-left">Group</th>' +
      WFM_DAYS.map(function (d) {
        return '<th class="font-normal px-2 py-2.5 text-center' + (d.hol ? ' text-rose-600' : '') + '">' + d.d + ' ' + d.n +
          (d.hol ? '<br><span class="text-[10px]">วันแม่</span>' : '') + '</th>';
      }).join('') + '<th class="font-normal px-3 py-2.5 text-right whitespace-nowrap">ชม. ตามกะ</th>';
  }
  b.innerHTML = WFM_STAFF.map(function (s) {
    var hrs = s.sh.filter(function (c) { return 'DMEN'.indexOf(c) !== -1; }).length * 9;
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-3 py-2 font-medium text-slate-800 whitespace-nowrap sticky left-0 bg-white">' + s.name + '</td>' +
      '<td class="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">' + s.grp + '</td>' +
      s.sh.map(function (c) { return '<td class="px-1.5 py-2">' + shChip(c) + '</td>'; }).join('') +
      '<td class="px-3 py-2 text-right text-slate-600">' + hrs + '</td></tr>';
  }).join('');

  var cov = document.getElementById('sch-coverage'); if (!cov) return;
  var sched = WFM_DAYS.map(function (_, i) {
    return WFM_STAFF.filter(function (s) { return 'DMEN'.indexOf(s.sh[i]) !== -1; }).length;
  });
  cov.innerHTML =
    '<tr class="bg-slate-50/70 border-t-2 border-slate-200"><td class="px-3 py-2 text-xs font-semibold text-slate-600 sticky left-0 bg-slate-50">ต้องการ (จาก forecast)</td><td></td>' +
    WFM_REQ_DAY.map(function (r) { return '<td class="px-1.5 py-2 text-center text-sm text-slate-700">' + r + '</td>'; }).join('') + '<td></td></tr>' +
    '<tr class="bg-slate-50/70"><td class="px-3 py-2 text-xs font-semibold text-slate-600 sticky left-0 bg-slate-50">จัดได้</td><td></td>' +
    sched.map(function (s) { return '<td class="px-1.5 py-2 text-center text-sm font-semibold text-slate-800">' + s + '</td>'; }).join('') + '<td></td></tr>' +
    '<tr class="bg-slate-50/70 border-b border-slate-200"><td class="px-3 py-2 text-xs font-semibold text-slate-600 sticky left-0 bg-slate-50">ส่วนต่าง</td><td></td>' +
    sched.map(function (s, i) { return '<td class="px-1.5 py-2 text-center">' + deltaPill(s - WFM_REQ_DAY[i]) + '</td>'; }).join('') + '<td></td></tr>';
}

function renderRequirement() {
  var b = document.getElementById('req-body'); if (!b) return;
  b.innerHTML = WFM_REQ.map(function (r) {
    var toSched = Math.ceil(r.floor / 0.7);
    var d = r.sched - toSched;
    return '<tr class="border-b border-slate-100 hover:bg-slate-50 text-[13px]">' +
      '<td class="px-3 py-2.5 font-medium text-slate-700">' + r.iv + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.vol + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.aht + 's</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + (r.vol / 1800 * r.aht).toFixed(1) + '</td>' +
      '<td class="px-3 py-2.5 text-right font-semibold text-slate-800">' + r.floor + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-500">30%</td>' +
      '<td class="px-3 py-2.5 text-right font-semibold text-teal-700">' + toSched + '</td>' +
      '<td class="px-3 py-2.5 text-right text-slate-600">' + r.sched + '</td>' +
      '<td class="px-3 py-2.5 text-right">' + deltaPill(d) + '</td></tr>';
  }).join('');
}

function renderAdherence() {
  var b = document.getElementById('adh-body'); if (!b) return;
  b.innerHTML = ADH.map(function (a) {
    var pctCls = a.adh >= 95 ? 'text-emerald-600' : a.adh >= 90 ? 'text-amber-600' : 'text-rose-600';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-3 py-3 whitespace-nowrap"><p class="font-medium text-slate-800 text-sm">' + a.name + '</p>' + stPill(a.st) + '</td>' +
      '<td class="px-3 py-3 w-full"><div class="space-y-1">' +
      '<div class="flex items-center gap-2"><span class="text-[10px] text-slate-400 w-9 shrink-0">ตาราง</span><div class="tl flex-1">' + tlBar(a.sched) + '</div></div>' +
      '<div class="flex items-center gap-2"><span class="text-[10px] text-slate-400 w-9 shrink-0">จริง</span><div class="tl flex-1">' + tlBar(a.actual) + '</div></div>' +
      '</div></td>' +
      '<td class="px-3 py-3 text-right font-semibold ' + pctCls + '">' + a.adh.toFixed(1) + '%</td>' +
      '<td class="px-3 py-3 text-right text-slate-600">' + a.cnf.toFixed(1) + '%</td></tr>';
  }).join('');
}

function renderIntraday() {
  var b = document.getElementById('intra-alerts'); if (!b) return;
  var color = { high: 'border-rose-200 bg-rose-50 text-rose-800', mid: 'border-amber-200 bg-amber-50 text-amber-800', low: 'border-slate-200 bg-slate-50 text-slate-700' };
  var icon = { high: 'ti-alert-triangle-filled', mid: 'ti-alert-circle', low: 'ti-info-circle' };
  b.innerHTML = WFM_ALERTS.map(function (a) {
    return '<div class="border rounded-lg px-4 py-3 text-sm flex gap-3 ' + color[a.lv] + '">' +
      '<i class="ti ' + icon[a.lv] + ' text-lg shrink-0"></i>' +
      '<div><span class="font-semibold mr-2">' + a.at + '</span>' + a.msg + '</div></div>';
  }).join('');
}

function renderTimeoff() {
  var b = document.getElementById('timeoff-body'); if (!b) return;
  b.innerHTML = WFM_TIMEOFF.map(function (r) {
    var st = r.status === 'pending' ? '<span class="st st-acw">รออนุมัติ</span>' : '<span class="st st-available">อนุมัติแล้ว</span>';
    var imp = r.impact === 'warn'
      ? '<span class="text-amber-700 text-xs"><i class="ti ti-alert-triangle mr-1"></i>' + r.note + '</span>'
      : '<span class="text-slate-500 text-xs">' + r.note + '</span>';
    var act = r.status === 'pending'
      ? '<span class="icon-btn bg-emerald-50 text-emerald-700" title="Approve" onclick="toast(\'อนุมัติแล้ว (mock)\')"><i class="ti ti-check"></i></span>' +
        '<span class="icon-btn bg-rose-50 text-rose-700" title="Reject" onclick="toast(\'ปฏิเสธแล้ว (mock)\')"><i class="ti ti-x"></i></span>'
      : '<span class="icon-btn">' + dots + '</span>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50 text-sm">' +
      '<td class="px-4 py-3 font-medium text-slate-800 whitespace-nowrap">' + r.who + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + r.type + '</td>' +
      '<td class="px-4 py-3 text-slate-600 whitespace-nowrap">' + r.from + ' → ' + r.to + '</td>' +
      '<td class="px-4 py-3 text-right text-slate-600">' + r.days + '</td>' +
      '<td class="px-4 py-3">' + imp + '</td>' +
      '<td class="px-4 py-3">' + st + '</td>' +
      '<td class="px-4 py-3 text-right whitespace-nowrap">' + act + '</td></tr>';
  }).join('');
}

function renderSites() {
  var b = document.getElementById('sites-grid'); if (!b) return;
  b.innerHTML = WFM_SITES.map(function (s) {
    var dst = s.dst
      ? '<span class="st st-acw">มี DST</span>'
      : '<span class="st st-break">ไม่มี DST</span>';
    return '<div class="bg-white border border-slate-200 rounded-xl p-5">' +
      '<div class="flex items-center justify-between mb-3"><h2 class="font-semibold">' + s.name + '</h2>' + dst + '</div>' +
      '<dl class="text-sm space-y-2">' +
      '<div class="flex gap-2"><dt class="text-slate-400 w-24 shrink-0">Timezone</dt><dd class="text-slate-700"><code class="text-xs bg-slate-100 rounded px-1.5 py-0.5">' + s.tz + '</code></dd></div>' +
      '<div class="flex gap-2"><dt class="text-slate-400 w-24 shrink-0">วันหยุด</dt><dd class="text-slate-700">' + s.cal + '</dd></div>' +
      '<div class="flex gap-2"><dt class="text-slate-400 w-24 shrink-0">กฎแรงงาน</dt><dd class="text-slate-700">' + s.rules + '</dd></div>' +
      '<div class="flex gap-2"><dt class="text-slate-400 w-24 shrink-0">Agents</dt><dd class="text-slate-700">' + s.agents + '</dd></div>' +
      '</dl></div>';
  }).join('');

  var g = document.getElementById('pg-body'); if (!g) return;
  g.innerHTML = WFM_GROUPS.map(function (p) {
    var c = p.cov >= 90 ? '#16a34a' : p.cov >= 80 ? '#d97706' : '#dc2626';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50 text-sm">' +
      '<td class="px-4 py-3 font-medium text-slate-800">' + p.name + '</td>' +
      '<td class="px-4 py-3"><div class="flex flex-wrap gap-1">' + p.ch.map(chBadge).join('') + '</div></td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.queues + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + p.skills + '</td>' +
      '<td class="px-4 py-3 text-right text-slate-600">' + p.agents + '</td>' +
      '<td class="px-4 py-3"><div class="flex items-center gap-2"><div class="cov w-24"><div style="width:' + p.cov + '%;background:' + c + '"></div></div>' +
      '<span class="text-xs text-slate-500">' + p.cov + '%</span></div></td></tr>';
  }).join('');
}

function renderMySchedule() {
  var b = document.getElementById('mysch-body'); if (!b) return;
  b.innerHTML = MY_SHIFTS.map(function (m) {
    return '<tr class="border-b border-slate-100 text-sm">' +
      '<td class="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">' + m.d + '</td>' +
      '<td class="px-4 py-3 w-28">' + shChip(m.code) + '</td>' +
      '<td class="px-4 py-3 text-slate-600">' + m.seg + '</td></tr>';
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
  // WFM — forecast vs actual (ปริมาณงานรายชั่วโมง)
  var wfmHours = ['08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19'];
  var fcVol = [57, 113, 132, 102, 74, 96, 121, 118, 94, 71, 42, 21];
  var acVol = [61, 108, 161, 119, 68, 91, 116, 124, 88, 66, 39, 18];
  var fcEl = document.getElementById('chart-wfm-fc');
  if (fcEl && !fcEl.dataset.done) {
    fcEl.dataset.done = '1';
    new Chart(fcEl, { type: 'line', data: { labels: wfmHours, datasets: [
      { label: 'Forecast', data: fcVol, borderColor: '#0f766e', backgroundColor: 'rgba(15,118,110,.08)', fill: true, tension: .35, pointRadius: 2 },
      { label: 'Actual', data: acVol, borderColor: '#d97706', borderDash: [5, 4], tension: .35, pointRadius: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
        plugins: { legend: { position: 'top', labels: { boxWidth: 12 } }, tooltip: { mode: 'index' } } } });
  }
  var fcTodayEl = document.getElementById('chart-wfm-fc-today');
  if (fcTodayEl && !fcTodayEl.dataset.done) {
    fcTodayEl.dataset.done = '1';
    // วันนี้เดินมาถึง 11:42 — ของจริงจึงมีข้อมูลถึงชั่วโมง 11 เท่านั้น
    var partial = acVol.map(function (v, i) { return i <= 3 ? v : null; });
    new Chart(fcTodayEl, { type: 'line', data: { labels: wfmHours, datasets: [
      { label: 'Forecast', data: fcVol, borderColor: '#94a3b8', tension: .35, pointRadius: 2 },
      { label: 'Actual (ถึง 11:42)', data: partial, borderColor: '#dc2626', backgroundColor: 'rgba(220,38,38,.08)', fill: true, tension: .35, pointRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
        plugins: { legend: { position: 'top', labels: { boxWidth: 12 } }, tooltip: { mode: 'index' } } } });
  }
  // WFM — คนที่ต้องจัด vs คนที่จัดได้
  var stEl = document.getElementById('chart-wfm-staff');
  if (stEl && !stEl.dataset.done) {
    stEl.dataset.done = '1';
    new Chart(stEl, { type: 'bar', data: { labels: WFM_REQ.map(function (r) { return r.iv; }), datasets: [
      { label: 'ต้องจัด (หลัง shrinkage)', data: WFM_REQ.map(function (r) { return Math.ceil(r.floor / 0.7); }), backgroundColor: '#cbd5e1', borderRadius: 3 },
      { label: 'จัดได้', data: WFM_REQ.map(function (r) { return r.sched; }), backgroundColor: '#0f766e', borderRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true }, x: { grid: { display: false } } },
        plugins: { legend: { position: 'top', labels: { boxWidth: 12 } } } } });
  }
  // WFM — intraday: ส่วนต่างคนบนพื้นเทียบ requirement ที่คำนวณใหม่จาก actual
  var idEl = document.getElementById('chart-intraday');
  if (idEl && !idEl.dataset.done) {
    idEl.dataset.done = '1';
    var delta = [1, -1, -3, -2, 2, 1, 0, -1, 1, 2, 3, 2];
    new Chart(idEl, { type: 'bar', data: { labels: wfmHours, datasets: [
      { label: 'คนเกิน (+) / คนขาด (−)', data: delta, borderRadius: 3,
        backgroundColor: delta.map(function (v) { return v < 0 ? '#dc2626' : '#16a34a'; }) }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false } } },
        plugins: { legend: { display: false } } } });
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

/* ============================================================
   Supervisor workspace — ข้อมูลตัวอย่าง
   หลักการของหน้านี้: ทุกแถว/ทุกการ์ดต้องมี action ไม่ใช่แค่ตัวเลข
   (ตัวเลขล้วนอยู่ที่ home dashboard / reports แล้ว)
   ============================================================ */

// สโคปที่ supervisor คนนี้ดูแล — ของจริงมาจาก span of control (ทีม + คิว) ไม่ใช่ทั้ง tenant
var SUP_SCOPE = { teams: ['Support A', 'Support B'], queues: ['General Support', 'Technical Support', 'Billing Inquiries'] };

// state = สถานะตอนนี้, sec = อยู่สถานะนี้มากี่วินาที (ตัวนี้สำคัญกว่าสถานะเอง)
// adh = หลุด adherence อยู่ไหม (จาก WFM), work = งานที่ถืออยู่
var SUP_TEAM = [
  { name: 'สมชาย วงศ์ประเสริฐ', ext: '1000', team: 'Support A', state: 'busy', sec: 271, adh: false,
    work: { ch: 'voice', queue: 'General Support', label: '+66 81 234 5678' }, chats: 2, chatMax: 3, today: 24, aht: '04:51' },
  { name: 'สมหญิง ใจดี', ext: '1001', team: 'Support A', state: 'acw', sec: 402, adh: false,
    work: { ch: 'email', queue: 'Billing Inquiries', label: 'maysa@brightedu.ac.th' }, chats: 0, chatMax: 3, today: 19, aht: '05:22' },
  { name: 'ปกรณ์ ศรีสุข', ext: '1004', team: 'Support B', state: 'busy', sec: 1163, adh: false,
    work: { ch: 'voice', queue: 'Technical Support', label: '+66 84 111 2233' }, chats: 0, chatMax: 0, today: 11, aht: '08:04' },
  { name: 'Maria Garcia', ext: '1005', team: 'Support B', state: 'busy', sec: 96, adh: false,
    work: { ch: 'webchat', queue: 'Technical Support', label: 'Guest #8841 + 2 more' }, chats: 3, chatMax: 3, today: 31, aht: '03:12' },
  { name: 'อรทัย พูลสวัสดิ์', ext: '1003', team: 'Support A', state: 'break', sec: 1584, adh: true,
    work: null, chats: 0, chatMax: 4, today: 16, aht: '05:47' },
  { name: 'John Anderson', ext: '1002', team: 'Support B', state: 'available', sec: 38, adh: false,
    work: null, chats: 0, chatMax: 3, today: 22, aht: '06:04' },
  { name: 'ณัฐพล มีสุข', ext: '1006', team: 'Support A', state: 'available', sec: 214, adh: false,
    work: null, chats: 1, chatMax: 3, today: 27, aht: '04:20' },
  { name: 'Kanya T.', ext: '1007', team: 'Support B', state: 'offline', sec: 2940, adh: true,
    work: null, chats: 0, chatMax: 3, today: 4, aht: '07:38' },
];

// งานที่ยังไม่จบ — รวม "รอในคิว" กับ "กำลังคุย" ไว้ตารางเดียว เพราะ supervisor ตัดสินใจจากภาพรวม
// pct = % ของเวลา SLA ที่ใช้ไปแล้ว (>100 = พัง SLA แล้ว)
var LIVE_IX = [
  { st: 'waiting', ch: 'voice', contact: '+66 92 887 1120', queue: 'Billing Inquiries', agent: null, t: '04:12', pct: 128, pri: 1 },
  { st: 'waiting', ch: 'voice', contact: '+66 81 553 7781', queue: 'Billing Inquiries', agent: null, t: '03:04', pct: 112, pri: 1 },
  { st: 'waiting', ch: 'webchat', contact: 'Guest #8902', queue: 'Technical Support', agent: null, t: '00:47', pct: 84, pri: 2 },
  { st: 'waiting', ch: 'email', contact: 'ops@paclog.com', queue: 'Billing Inquiries', agent: null, t: '18:22', pct: 61, pri: 1 },
  { st: 'waiting', ch: 'line', contact: '@somsak.k', queue: 'General Support', agent: null, t: '00:19', pct: 38, pri: 1 },
  { st: 'talking', ch: 'voice', contact: '+66 81 234 5678', queue: 'General Support', agent: 'สมชาย วงศ์ประเสริฐ', t: '04:31', pct: 0, pri: 1 },
  { st: 'talking', ch: 'voice', contact: '+66 84 111 2233', queue: 'Technical Support', agent: 'ปกรณ์ ศรีสุข', t: '19:23', pct: 0, pri: 1, flag: 'ยาวผิดปกติ (AHT ×2.4)' },
  { st: 'talking', ch: 'webchat', contact: 'Guest #8841', queue: 'Technical Support', agent: 'Maria Garcia', t: '01:36', pct: 0, pri: 2 },
  { st: 'hold', ch: 'voice', contact: '+66 89 200 4412', queue: 'General Support', agent: 'ณัฐพล มีสุข', t: '02:58', pct: 0, pri: 1, flag: 'พักสายเกิน 2 นาที' },
  { st: 'acw', ch: 'email', contact: 'maysa@brightedu.ac.th', queue: 'Billing Inquiries', agent: 'สมหญิง ใจดี', t: '06:42', pct: 0, pri: 1, flag: 'ACW เกิน 5 นาที' },
];

// คิวในสโคปของฉัน + ตัวเลข staffing มาจาก WFM (ไม่คำนวณซ้ำที่นี่)
var SUP_QUEUES = [
  { name: 'Billing Inquiries', channels: ['email', 'facebook', 'voice'], waiting: 8, longest: '04:12', sla: 61, target: 80,
    staffed: 3, required: 6, overflow: false, callback: false },
  { name: 'Technical Support', channels: ['voice', 'webchat'], waiting: 5, longest: '00:47', sla: 76, target: 80,
    staffed: 6, required: 7, overflow: true, callback: false },
  { name: 'General Support', channels: ['voice', 'webchat', 'email'], waiting: 3, longest: '00:19', sla: 92, target: 80,
    staffed: 12, required: 11, overflow: false, callback: false },
];

var SUP_ALERTS = [
  { sev: 'crit', at: '11:38', title: 'Billing Inquiries — SLA ต่ำกว่าเป้า 10 นาทีติดต่อกัน', detail: 'SLA 61% (เป้า 80%) · รออยู่ 8 · คนบนพื้น 3 จากที่ต้องการ 6', rule: 'SLA < เป้า นาน 10 นาที', ack: null },
  { sev: 'crit', at: '11:36', title: 'สายรอนานเกิน 3 นาที — Billing Inquiries', detail: '+66 92 887 1120 รอ 04:12 · เกิน SLA 20 วินาทีไปแล้ว 12 เท่า', rule: 'Longest wait > 3 นาที', ack: null },
  { sev: 'warn', at: '11:31', title: 'ปกรณ์ ศรีสุข — สายยาวผิดปกติ 19:23', detail: 'AHT ของคิวนี้ 08:04 · สายนี้ยาวกว่า 2.4 เท่า', rule: 'Talk time > AHT × 2', ack: null },
  { sev: 'warn', at: '11:24', title: 'สมหญิง ใจดี — ACW เกิน 5 นาที', detail: 'อยู่ใน after-call work มา 06:42', rule: 'ACW > 5 นาที', ack: 'สมพร · 11:26' },
  { sev: 'info', at: '11:02', title: 'อรทัย พูลสวัสดิ์ — หลุด adherence 26 นาที', detail: 'ตารางกะ: งาน · สถานะจริง: Break', rule: 'Adherence exception > 10 นาที', ack: 'สมพร · 11:05' },
];

// Team pulse แสดงเฉพาะ risk ที่ action ได้ทันที ส่วนข้อมูลลึกยังอยู่ใน Cases/WFM/QM ตามเจ้าของโมดูล
var SUP_RISKS = [
  { kind: 'service', icon: 'ti-stack-2', tone: 'rose', title: 'คิวเสี่ยง SLA', value: 'Billing · 61%', detail: 'รอ 8 งาน · ขาด 3 คน', action: 'จัดการคิว', view: 'queue-control' },
  { kind: 'case', icon: 'ti-ticket', tone: 'amber', title: 'Case ใกล้เกิน SLA', value: '3 ใบ', detail: 'ใบแรกเหลือ 1 ชม. 18 นาที', action: 'เปิด Cases', href: 'cases.html?view=cases' },
  { kind: 'customer', icon: 'ti-mood-sad', tone: 'rose', title: 'ลูกค้าเสี่ยง', value: 'CSAT 1–2 · 2 คน', detail: '1 คนกำลังรอใน Billing', action: 'ดูงานสด', view: 'live' },
  { kind: 'workforce', icon: 'ti-calendar-time', tone: 'amber', title: 'กำลังคนผิดแผน', value: '2 exceptions', detail: 'Break 1 · ACW เกิน 1', action: 'ดู adherence', href: 'wfm.html?view=adherence' },
];

var SUP_RULES = [
  { name: 'SLA ต่ำกว่าเป้าต่อเนื่อง', cond: '< เป้าคิว นาน 10 นาที', sev: 'crit', on: true },
  { name: 'สายรอนานสุด', cond: '> 3 นาที', sev: 'crit', on: true },
  { name: 'Abandon rate พุ่ง', cond: '> 8% ในช่วง 15 นาที', sev: 'crit', on: true },
  { name: 'ACW ค้าง', cond: '> 5 นาที', sev: 'warn', on: true },
  { name: 'พักสายค้าง', cond: '> 2 นาที', sev: 'warn', on: true },
  { name: 'สายยาวผิดปกติ', cond: '> AHT ของคิว × 2', sev: 'warn', on: true },
  { name: 'ไม่มีคนรับคิว', cond: 'agent available = 0 นาน 2 นาที', sev: 'crit', on: true },
  { name: 'Adherence exception', cond: 'หลุด > 10 นาที', sev: 'info', on: false },
];

var EVALS = [
  { id: 'EV-1042', agent: 'ปกรณ์ ศรีสุข', ch: 'voice', queue: 'Technical Support', when: '06-08-2026 14:12', dur: '12:40', evaluator: 'สมพร หัวหน้าทีม', status: 'todo', score: null, why: 'สุ่มตามโควตา 4 สาย/เดือน' },
  { id: 'EV-1041', agent: 'สมชาย วงศ์ประเสริฐ', ch: 'voice', queue: 'General Support', when: '06-08-2026 10:21', dur: '04:31', evaluator: 'สมพร หัวหน้าทีม', status: 'todo', score: null, why: 'ลูกค้าให้ CSAT 2/5' },
  { id: 'EV-1040', agent: 'Maria Garcia', ch: 'webchat', queue: 'Technical Support', when: '05-08-2026 16:40', dur: '08:11', evaluator: 'สมพร หัวหน้าทีม', status: 'todo', score: null, why: 'ถูก escalate' },
  { id: 'EV-1039', agent: 'สมหญิง ใจดี', ch: 'email', queue: 'Billing Inquiries', when: '05-08-2026 09:15', dur: '—', evaluator: 'สมพร หัวหน้าทีม', status: 'todo', score: null, why: 'สุ่มตามโควตา' },
  { id: 'EV-1038', agent: 'ณัฐพล มีสุข', ch: 'voice', queue: 'General Support', when: '04-08-2026 13:02', dur: '06:19', evaluator: 'สมพร หัวหน้าทีม', status: 'todo', score: null, why: 'พนักงานใหม่ — ประเมินทุกสัปดาห์' },
  { id: 'EV-1035', agent: 'สมชาย วงศ์ประเสริฐ', ch: 'voice', queue: 'General Support', when: '31-07-2026 11:44', dur: '05:02', evaluator: 'สมพร หัวหน้าทีม', status: 'acknowledged', score: 92, why: 'สุ่มตามโควตา' },
  { id: 'EV-1034', agent: 'ปกรณ์ ศรีสุข', ch: 'voice', queue: 'Technical Support', when: '30-07-2026 15:20', dur: '15:52', evaluator: 'สมพร หัวหน้าทีม', status: 'disputed', score: 64, why: 'ถูก escalate' },
  { id: 'EV-1033', agent: 'Maria Garcia', ch: 'whatsapp', queue: 'VIP Customers', when: '29-07-2026 10:08', dur: '11:04', evaluator: 'สมพร หัวหน้าทีม', status: 'sent', score: 88, why: 'สุ่มตามโควตา' },
];

var SCORECARD = [
  { sec: 'การเปิดบทสนทนา', items: [
    { t: 'แนะนำตัวและชื่อบริษัทครบ', w: 5, got: 5 },
    { t: 'ยืนยันตัวตนลูกค้าตามขั้นตอน', w: 10, got: 10 },
  ]},
  { sec: 'การแก้ปัญหา', items: [
    { t: 'จับประเด็นถูกต้องภายใน 1 นาทีแรก', w: 15, got: 12 },
    { t: 'ใช้ knowledge base / ไม่เดา', w: 15, got: 15 },
    { t: 'แก้จบในครั้งเดียว (FCR)', w: 20, got: 12 },
  ]},
  { sec: 'การสื่อสาร', items: [
    { t: 'น้ำเสียงและความสุภาพ', w: 10, got: 10 },
    { t: 'สรุปสิ่งที่จะทำต่อให้ลูกค้าฟัง', w: 10, got: 6 },
  ]},
  { sec: 'ความถูกต้องของระบบงาน', items: [
    { t: 'บันทึก wrap-up code ถูกต้อง', w: 10, got: 10 },
    { t: 'ไม่พักสายเกิน 2 นาทีโดยไม่แจ้ง', w: 5, got: 0, fail: true },
  ]},
];

var COACHING = [
  { agent: 'ปกรณ์ ศรีสุข', topic: 'ลด AHT ของเคส technical — ใช้ KB ให้เร็วขึ้น', from: 'EV-1034 (64 คะแนน) + alert สายยาว 3 ครั้ง',
    when: '08-08-2026 09:00', status: 'scheduled', owner: 'สมพร หัวหน้าทีม', follow: 'วัด AHT อีกครั้ง 22-08' },
  { agent: 'อรทัย พูลสวัสดิ์', topic: 'Adherence — พักเกินเวลา 4 ครั้งใน 2 สัปดาห์', from: 'WFM adherence exception',
    when: '05-08-2026 16:30', status: 'done', owner: 'สมพร หัวหน้าทีม', follow: 'ดีขึ้น 86% → 94% ✓' },
  { agent: 'สมชาย วงศ์ประเสริฐ', topic: 'รับมือลูกค้าอารมณ์เสีย (CSAT 2/5)', from: 'EV-1041',
    when: '—', status: 'draft', owner: 'สมพร หัวหน้าทีม', follow: '—' },
  { agent: 'ณัฐพล มีสุข', topic: 'Onboarding สัปดาห์ที่ 3 — ตรวจ wrap-up code', from: 'แผน onboarding',
    when: '07-08-2026 15:00', status: 'done', owner: 'สมพร หัวหน้าทีม', follow: 'ผิดพลาด 8% → 2% ✓' },
];

var APPROVALS = [
  { type: 'timeoff', src: 'WFM', who: 'สมหญิง ใจดี', what: 'ลาพักร้อน 14–15 ส.ค. (2 วัน)', impact: 'คิว Billing ขาด 1 คนช่วง 13:00–17:00', at: '2 ชม.ที่แล้ว', bad: true },
  { type: 'shift', src: 'WFM', who: 'John Anderson', what: 'ขอสลับกะ 12 ส.ค. เช้า → บ่าย', impact: 'ไม่กระทบ coverage', at: '4 ชม.ที่แล้ว', bad: false },
  { type: 'overtime', src: 'WFM', who: 'Maria Garcia', what: 'ขอ OT 2 ชม. วันนี้ 17:30–19:30', impact: 'ช่วยปิดช่องว่าง Technical 18:00', at: '25 นาทีที่แล้ว', bad: false },
  { type: 'dispute', src: 'Quality', who: 'ปกรณ์ ศรีสุข', what: 'โต้แย้งผลประเมิน EV-1034 (64 คะแนน)', impact: 'ต้องตอบภายใน 5 วันทำการ', at: 'เมื่อวาน', bad: false },
];

/* ---------- supervisor helpers ---------- */
var SUP_STATE_LIMIT = { available: 900, busy: 900, acw: 300, break: 900, offline: 99999 }; // เกินนี้ = ย้อมแดง
function mmss(s) { var m = Math.floor(s / 60), r = s % 60; return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r; }
function supOver(a) { return a.sec > (SUP_STATE_LIMIT[a.state] || 900); }
function supInitial(n) { return n.charAt(0); }

var supFilter = { state: 'all', team: 'all' };
var supCompact = false;

function supStateCounts() {
  var c = { all: SUP_TEAM.length, available: 0, busy: 0, acw: 0, break: 0, offline: 0 };
  SUP_TEAM.forEach(function (a) { c[a.state]++; });
  return c;
}
function supVisible() {
  return SUP_TEAM.filter(function (a) {
    return (supFilter.state === 'all' || a.state === supFilter.state) &&
      (supFilter.team === 'all' || a.team === supFilter.team);
  }).sort(function (x, y) { return y.sec - x.sec; });
}
function setSupFilter(k, v) { supFilter[k] = v; renderPulse(); }
function toggleCompact() { supCompact = !supCompact; renderPulse(); }

function supActions(a, i) {
  var voice = a.work && a.work.ch === 'voice';
  var mon = voice
    ? '<button class="act" onclick="startMonitor(' + i + ',\'listen\')" title="ฟังเงียบ"><i class="ti ti-ear"></i></button>' +
      '<button class="act" onclick="startMonitor(' + i + ',\'whisper\')" title="กระซิบ (ลูกค้าไม่ได้ยิน)"><i class="ti ti-microphone"></i></button>' +
      '<button class="act" onclick="startMonitor(' + i + ',\'barge\')" title="แทรกสาย"><i class="ti ti-arrow-merge"></i></button>'
    : (a.work
      ? '<button class="act" onclick="startMonitor(' + i + ',\'listen\')" title="ดูบทสนทนาสด"><i class="ti ti-eye"></i></button>' +
        '<button class="act" onclick="startMonitor(' + i + ',\'whisper\')" title="โน้ตถึงเอเจนต์ (ลูกค้าไม่เห็น)"><i class="ti ti-message-2-bolt"></i></button>' +
        '<button class="act act-off" disabled title="แทรกได้เฉพาะเสียง — ดิจิทัลใช้ join เป็นผู้ร่วมสนทนา"><i class="ti ti-arrow-merge"></i></button>'
      : '<button class="act act-off" disabled title="ยังไม่มีงานให้ติดตาม"><i class="ti ti-ear"></i></button>' +
        '<button class="act act-off" disabled><i class="ti ti-microphone"></i></button>' +
        '<button class="act act-off" disabled><i class="ti ti-arrow-merge"></i></button>');
  return mon +
    '<button class="act" onclick="chatWith(\'' + a.name + '\')" title="ส่งข้อความ (แชทภายใน — ไม่กิน capacity)"><i class="ti ti-message-2"></i></button>' +
    '<button class="act" onclick="forceState(' + i + ')" title="เปลี่ยนสถานะให้"><i class="ti ti-user-cog"></i></button>' +
    '<button class="act" onclick="toast(\'บันทึกลง audit log แล้ว (mock)\')" title="เพิ่มเติม"><i class="ti ti-dots"></i></button>';
}

function renderPulse() {
  var wrap = document.getElementById('pulse-body'); if (!wrap) return;
  var c = supStateCounts();
  var chips = document.getElementById('pulse-chips');
  if (chips) {
    var defs = [['all', 'ทั้งหมด', ''], ['available', 'Available', 'st-available'], ['busy', 'On interaction', 'st-busy'],
      ['acw', 'ACW', 'st-acw'], ['break', 'Break', 'st-break'], ['offline', 'Offline', 'st-offline']];
    chips.innerHTML = defs.map(function (d) {
      return '<button class="fchip' + (supFilter.state === d[0] ? ' on' : '') + '" onclick="setSupFilter(\'state\',\'' + d[0] + '\')">' +
        (d[2] ? '<span class="st ' + d[2] + ' !px-0 !bg-transparent"></span>' : '') + d[1] + ' <b>' + c[d[0]] + '</b></button>';
    }).join('');
  }
  var risks = document.getElementById('pulse-risks');
  if (risks) risks.innerHTML = SUP_RISKS.map(function (r) {
    var color = r.tone === 'rose' ? 'border-rose-200 bg-rose-50/50 text-rose-800' : 'border-amber-200 bg-amber-50/50 text-amber-900';
    var go = r.href ? "location.href='" + r.href + "'" : "showView('" + r.view + "')";
    return '<div class="border rounded-xl p-4 ' + color + '"><div class="flex items-start gap-3"><i class="ti ' + r.icon + ' text-lg mt-0.5"></i><div class="min-w-0 flex-1"><p class="text-xs opacity-70">' + r.title + '</p><p class="font-semibold mt-0.5">' + r.value + '</p><p class="text-xs opacity-75 mt-1">' + r.detail + '</p><button class="qbtn mt-3" onclick="' + go + '">' + r.action + ' <i class="ti ti-arrow-right"></i></button></div></div></div>';
  }).join('');
  var list = supVisible();
  document.getElementById('pulse-count').textContent = list.length;
  if (supCompact) {
    wrap.className = 'bg-white border border-slate-200 rounded-xl overflow-hidden';
    wrap.innerHTML = '<div class="overflow-x-auto"><table class="w-full text-sm whitespace-nowrap">' +
      '<thead class="text-slate-500 text-left bg-slate-50/60"><tr class="border-b border-slate-100">' +
      '<th class="font-normal px-3 py-2.5">Agent</th>' +
      '<th class="font-normal px-3 py-2.5">State</th><th class="font-normal px-3 py-2.5 text-right">In state</th>' +
      '<th class="font-normal px-3 py-2.5">Working on</th><th class="font-normal px-3 py-2.5 text-right">Today</th>' +
      '<th class="font-normal px-3 py-2.5 text-right">AHT</th><th class="px-3 py-2.5"></th></tr></thead><tbody>' +
      list.map(function (a) {
        var i = SUP_TEAM.indexOf(a);
        return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
          '<td class="px-3 py-2.5"><span class="font-medium">' + a.name + '</span>' +
          (a.adh ? ' <i class="ti ti-alert-triangle text-amber-500" title="หลุด adherence"></i>' : '') +
          '<p class="text-xs text-slate-400">' + a.ext + ' · ' + a.team + '</p></td>' +
          '<td class="px-3 py-2.5">' + stPill(a.state) + '</td>' +
          '<td class="px-3 py-2.5 text-right tabular-nums ' + (supOver(a) ? 'text-rose-600 font-semibold' : 'text-slate-600') + '">' + mmss(a.sec) + '</td>' +
          '<td class="px-3 py-2.5">' + (a.work ? chBadge(a.work.ch) + ' <span class="text-slate-500">' + a.work.queue + '</span>' : '<span class="text-slate-300">—</span>') + '</td>' +
          '<td class="px-3 py-2.5 text-right text-slate-600">' + a.today + '</td>' +
          '<td class="px-3 py-2.5 text-right text-slate-600">' + a.aht + '</td>' +
          '<td class="px-3 py-2.5 text-right whitespace-nowrap">' + supActions(a, i) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    return;
  }
  wrap.className = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4';
  wrap.innerHTML = list.map(function (a) {
    var i = SUP_TEAM.indexOf(a);
    var dots = '';
    if (a.chatMax) {
      for (var k = 0; k < a.chatMax; k++) dots += '<span class="cdot' + (k < a.chats ? ' on' : '') + '"></span>';
      dots = '<div class="flex items-center gap-1.5 text-xs text-slate-400"><span>chat</span>' + dots + '<span>' + a.chats + '/' + a.chatMax + '</span></div>';
    }
    return '<div class="pcard' + (supOver(a) ? ' pcard-warn' : '') + '">' +
      '<div class="flex items-start gap-3">' +
      '<div class="w-9 h-9 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-sm font-semibold shrink-0">' + supInitial(a.name) + '</div>' +
      '<div class="min-w-0 flex-1">' +
      '<p class="font-medium text-slate-800 leading-snug">' + a.name + (a.adh ? ' <i class="ti ti-alert-triangle text-amber-500 text-sm" title="หลุด adherence — ตารางกะบอกว่าควรทำงาน"></i>' : '') + '</p>' +
      '<p class="text-xs text-slate-400">' + a.ext + ' · ' + a.team + '</p>' +
      '<div class="flex items-center gap-2 mt-1.5">' + stPill(a.state) +
      '<span class="text-xs tabular-nums ' + (supOver(a) ? 'text-rose-600 font-semibold' : 'text-slate-400') + '">' + mmss(a.sec) + '</span></div></div></div>' +
      '<div class="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm min-h-[52px]">' +
      (a.work
        ? chBadge(a.work.ch) + '<span class="text-xs text-slate-400 ml-1">' + a.work.queue + '</span>' +
          '<p class="text-slate-600 truncate mt-0.5">' + a.work.label + '</p>'
        : '<p class="text-slate-400 text-xs pt-2">ไม่มีงานอยู่ในมือ</p>') + '</div>' +
      '<div class="mt-2 flex items-center justify-between">' + (dots || '<span></span>') +
      '<span class="text-xs text-slate-400">วันนี้ ' + a.today + ' · AHT ' + a.aht + '</span></div>' +
      '<div class="mt-2 pt-2 border-t border-slate-100 flex items-center gap-0.5">' + supActions(a, i) + '</div></div>';
  }).join('');
}

function forceState(i) {
  var a = SUP_TEAM[i];
  toast('เปลี่ยนสถานะ ' + a.name + ' → Available · บันทึก audit log แล้ว (mock)');
}

/* monitor bar — ค้างทุกหน้าเพราะกดข้ามวิวแล้วต้องไม่ลืมว่ายังฟังอยู่ */
var MON_LBL = { listen: ['กำลังฟังเงียบ', 'ลูกค้าและเอเจนต์ไม่ได้ยินคุณ'], whisper: ['กำลังกระซิบ', 'เฉพาะเอเจนต์ได้ยินคุณ'], barge: ['แทรกสายอยู่', 'ทั้งลูกค้าและเอเจนต์ได้ยินคุณ'] };
function startMonitor(i, mode) {
  var a = SUP_TEAM[i], bar = document.getElementById('mon-bar'); if (!bar) return;
  bar.classList.remove('hidden');
  document.getElementById('mon-who').textContent = a.name + (a.work ? ' · ' + a.work.label : '');
  document.getElementById('mon-mode').textContent = MON_LBL[mode][0];
  document.getElementById('mon-hint').textContent = MON_LBL[mode][1];
  document.querySelectorAll('#mon-bar .mon-btn').forEach(function (b) { b.classList.toggle('on', b.dataset.mode === mode); });
  toast(MON_LBL[mode][0] + ' — ' + a.name + ' (mock) · เอเจนต์เห็นสัญลักษณ์ถูกติดตาม');
}
function stopMonitor() { document.getElementById('mon-bar').classList.add('hidden'); toast('หยุดติดตามแล้ว · บันทึก audit log (mock)'); }

function renderLive() {
  var b = document.getElementById('live-body'); if (!b) return;
  var lbl = { waiting: ['รอในคิว', 'st-busy'], talking: ['กำลังคุย', 'st-available'], hold: ['พักสาย', 'st-acw'], acw: ['ACW', 'st-acw'] };
  b.innerHTML = LIVE_IX.map(function (x, i) {
    var bar = x.st === 'waiting'
      ? '<div class="slabar"><div style="width:' + Math.min(x.pct, 100) + '%;background:' + (x.pct >= 100 ? '#dc2626' : x.pct >= 75 ? '#f59e0b' : '#16a34a') + '"></div></div>' +
        '<span class="text-xs ' + (x.pct >= 100 ? 'text-rose-600 font-semibold' : 'text-slate-400') + '">' + (x.pct >= 100 ? 'เกิน SLA' : x.pct + '% ของ SLA') + '</span>'
      : '<span class="text-xs text-slate-300">—</span>';
    return '<tr class="border-b border-slate-100 hover:bg-slate-50' + (x.st === 'waiting' && x.pct >= 100 ? ' bg-rose-50/40' : '') + '">' +
      '<td class="px-3 py-2.5"><span class="st ' + lbl[x.st][1] + '">' + lbl[x.st][0] + '</span>' +
      '<div class="mt-1">' + chBadge(x.ch) + '</div></td>' +
      '<td class="px-3 py-2.5 font-medium text-slate-700">' + x.contact +
      (x.flag ? '<p class="text-xs font-normal text-amber-600"><i class="ti ti-flag mr-0.5"></i>' + x.flag + '</p>' : '') + '</td>' +
      '<td class="px-3 py-2.5 text-slate-500">' + x.queue + (x.pri > 1 ? ' <span class="pri">P' + x.pri + '</span>' : '') + '</td>' +
      '<td class="px-3 py-2.5 text-slate-600">' + (x.agent || '<span class="text-slate-300">ยังไม่มีคนรับ</span>') + '</td>' +
      '<td class="px-3 py-2.5 text-right tabular-nums font-medium">' + x.t + '</td>' +
      '<td class="px-3 py-2.5 w-32">' + bar + '</td>' +
      '<td class="px-3 py-2.5 text-right whitespace-nowrap">' +
      (x.st === 'waiting'
        ? '<button class="act" onclick="toast(\'มอบหมายให้เอเจนต์ที่ว่าง (mock)\')" title="มอบหมายเอง"><i class="ti ti-user-plus"></i></button>' +
          '<button class="act" onclick="toast(\'ย้ายไปคิว General Support (mock)\')" title="ย้ายคิว"><i class="ti ti-transfer"></i></button>' +
          '<button class="act" onclick="toast(\'ดันลำดับขึ้นบนสุด (mock)\')" title="ดันลำดับ"><i class="ti ti-arrow-bar-to-up"></i></button>'
        : '<button class="act" onclick="toast(\'เข้าติดตามงานนี้ (mock)\')" title="ติดตาม"><i class="ti ti-ear"></i></button>' +
          '<button class="act" onclick="toast(\'ย้ายไปเอเจนต์คนอื่น (mock)\')" title="ย้ายให้คนอื่น"><i class="ti ti-user-share"></i></button>' +
          '<button class="act" onclick="toast(\'บังคับปิดงาน (mock)\')" title="บังคับปิด"><i class="ti ti-square-x"></i></button>') +
      '</td></tr>';
  }).join('');
  var w = LIVE_IX.filter(function (x) { return x.st === 'waiting'; }).length;
  var el = document.getElementById('live-sum');
  if (el) el.innerHTML = 'รอในคิว <b class="text-rose-600">' + w + '</b> · กำลังทำงาน <b class="text-slate-700">' + (LIVE_IX.length - w) + '</b>';
}

function renderQueueCtl() {
  var b = document.getElementById('qctl-body'); if (!b) return;
  b.innerHTML = SUP_QUEUES.map(function (q, i) {
    var gap = q.staffed - q.required;
    var slaColor = q.sla >= q.target ? 'text-emerald-600' : q.sla >= q.target - 15 ? 'text-amber-600' : 'text-rose-600';
    return '<div class="bg-white border border-slate-200 rounded-xl overflow-hidden">' +
      '<div class="px-5 py-3 border-b border-slate-100 flex items-center justify-between flex-wrap gap-2">' +
      '<div class="flex items-center gap-2"><h2 class="font-semibold">' + q.name + '</h2>' + q.channels.map(chBadge).join('') + '</div>' +
      '<a class="text-xs text-slate-400 hover:text-teal-700" href="routing.html?view=queues"><i class="ti ti-settings mr-1"></i>ตั้งค่าคิวถาวร →</a></div>' +
      '<div class="px-5 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">' +
      '<div><p class="text-xs text-slate-400">รออยู่</p><p class="text-2xl font-semibold ' + (q.waiting > 4 ? 'text-rose-600' : '') + '">' + q.waiting + '</p></div>' +
      '<div><p class="text-xs text-slate-400">รอนานสุด</p><p class="text-2xl font-semibold">' + q.longest + '</p></div>' +
      '<div><p class="text-xs text-slate-400">SLA กะนี้</p><p class="text-2xl font-semibold ' + slaColor + '">' + q.sla + '%</p><p class="text-xs text-slate-400">เป้า ' + q.target + '%</p></div>' +
      '<div><p class="text-xs text-slate-400">คนบนพื้น / ที่ต้องการ</p><p class="text-2xl font-semibold ' + (gap < 0 ? 'text-rose-600' : 'text-emerald-600') + '">' + q.staffed + '<span class="text-base text-slate-400">/' + q.required + '</span></p>' +
      '<a class="text-xs text-slate-400 hover:text-teal-700" href="wfm.html?view=intraday">จาก WFM intraday →</a></div></div>' +
      '<div class="px-5 pb-4 flex flex-wrap gap-2">' +
      '<button class="qbtn' + (q.overflow ? ' on' : '') + '" onclick="qctlToggle(' + i + ',\'overflow\')"><i class="ti ti-arrow-fork"></i>Overflow ไปคิวสำรอง' + (q.overflow ? ' · เปิดอยู่' : '') + '</button>' +
      '<button class="qbtn' + (q.callback ? ' on' : '') + '" onclick="qctlToggle(' + i + ',\'callback\')"><i class="ti ti-phone-outgoing"></i>เสนอ callback แทนรอสาย' + (q.callback ? ' · เปิดอยู่' : '') + '</button>' +
      '<button class="qbtn" onclick="toast(\'ยืมคนจากทีมอื่นเข้าคิวชั่วคราว (mock)\')"><i class="ti ti-users-plus"></i>ยืมคนเข้าคิว</button>' +
      '<button class="qbtn" onclick="toast(\'ส่งประกาศถึงทุกคนในคิว (mock)\')"><i class="ti ti-speakerphone"></i>ประกาศถึงทีม</button>' +
      '</div></div>';
  }).join('');
}
function qctlToggle(i, k) {
  SUP_QUEUES[i][k] = !SUP_QUEUES[i][k];
  renderQueueCtl();
  toast((SUP_QUEUES[i][k] ? 'เปิด' : 'ปิด') + ' ' + k + ' — ' + SUP_QUEUES[i].name + ' จนจบกะ (mock)');
}

function renderAlerts() {
  var b = document.getElementById('alert-body'); if (!b) return;
  var sevMap = { crit: ['al-crit', 'ti-alert-octagon', 'วิกฤต'], warn: ['al-warn', 'ti-alert-triangle', 'เฝ้าระวัง'], info: ['al-info', 'ti-info-circle', 'แจ้งให้ทราบ'] };
  b.innerHTML = SUP_ALERTS.map(function (a, i) {
    var s = sevMap[a.sev];
    return '<div class="alrow ' + s[0] + '">' +
      '<i class="ti ' + s[1] + ' text-lg mt-0.5"></i>' +
      '<div class="flex-1 min-w-0"><div class="flex items-center gap-2 flex-wrap"><p class="font-medium text-slate-800">' + a.title + '</p>' +
      '<span class="text-xs text-slate-400">' + a.at + '</span></div>' +
      '<p class="text-sm text-slate-600 mt-0.5">' + a.detail + '</p>' +
      '<p class="text-xs text-slate-400 mt-1">กฎ: ' + a.rule + '</p></div>' +
      '<div class="shrink-0 text-right">' + (a.ack
        ? '<span class="text-xs text-slate-400"><i class="ti ti-check text-emerald-500 mr-1"></i>รับทราบโดย<br>' + a.ack + '</span>'
        : '<button class="qbtn" onclick="ackAlert(' + i + ')"><i class="ti ti-check"></i>รับทราบ</button>' +
          '<button class="qbtn mt-1" onclick="toast(\'มอบหมายให้หัวหน้าอีกคน (mock)\')"><i class="ti ti-user-share"></i>มอบหมาย</button>') +
      '</div></div>';
  }).join('');
  var r = document.getElementById('rule-body');
  if (r) r.innerHTML = SUP_RULES.map(function (x, i) {
    var pill = { crit: 'st-busy', warn: 'st-acw', info: 'st-offline' }[x.sev];
    return '<tr class="border-b border-slate-100"><td class="px-4 py-2.5 font-medium">' + x.name + '</td>' +
      '<td class="px-4 py-2.5 text-slate-600">' + x.cond + '</td>' +
      '<td class="px-4 py-2.5"><span class="st ' + pill + '">' + x.sev + '</span></td>' +
      '<td class="px-4 py-2.5 text-right"><span class="st ' + (x.on ? 'st-available' : 'st-offline') + ' cursor-pointer" onclick="toggleRule(' + i + ')">' + (x.on ? 'เปิด' : 'ปิด') + '</span></td></tr>';
  }).join('');
}
function ackAlert(i) { SUP_ALERTS[i].ack = 'สมพร · เมื่อสักครู่'; renderAlerts(); toast('รับทราบแล้ว — บันทึกว่าใครรับเมื่อไหร่ (mock)'); }
function toggleRule(i) { SUP_RULES[i].on = !SUP_RULES[i].on; renderAlerts(); toast('อัปเดตกฎแจ้งเตือน (mock)'); }

function renderEvals() {
  var b = document.getElementById('eval-body'); if (!b) return;
  var st = { todo: ['st-acw', 'รอประเมิน'], sent: ['st-available', 'ส่งให้เอเจนต์แล้ว'], acknowledged: ['st-available', 'เอเจนต์รับทราบ'], disputed: ['st-busy', 'ถูกโต้แย้ง'] };
  b.innerHTML = EVALS.map(function (e) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-4 py-2.5 text-slate-400 text-xs">' + e.id + '</td>' +
      '<td class="px-4 py-2.5 font-medium">' + e.agent + '</td>' +
      '<td class="px-4 py-2.5">' + chBadge(e.ch) + '</td>' +
      '<td class="px-4 py-2.5 text-slate-500">' + e.queue + '</td>' +
      '<td class="px-4 py-2.5 text-slate-500">' + e.when + '</td>' +
      '<td class="px-4 py-2.5 text-slate-500">' + e.dur + '</td>' +
      '<td class="px-4 py-2.5 text-xs text-slate-500">' + e.why + '</td>' +
      '<td class="px-4 py-2.5 text-right font-semibold ' + (e.score === null ? 'text-slate-300' : e.score >= 80 ? 'text-emerald-600' : 'text-rose-600') + '">' + (e.score === null ? '—' : e.score) + '</td>' +
      '<td class="px-4 py-2.5"><span class="st ' + st[e.status][0] + '">' + st[e.status][1] + '</span></td>' +
      '<td class="px-4 py-2.5 text-right whitespace-nowrap">' +
      '<button class="act" onclick="showView(\'eval-form\')" title="' + (e.status === 'todo' ? 'ประเมิน' : 'ดูผล') + '"><i class="ti ti-' + (e.status === 'todo' ? 'clipboard-check' : 'eye') + '"></i></button>' +
      '<button class="act" onclick="toast(\'เปิดไฟล์บันทึก (mock)\')" title="ฟังย้อนหลัง"><i class="ti ti-player-play"></i></button></td></tr>';
  }).join('');
  var sc = document.getElementById('score-body');
  if (sc) {
    var tot = 0, max = 0;
    sc.innerHTML = SCORECARD.map(function (s) {
      return '<div class="border-b border-slate-100 last:border-0">' +
        '<div class="px-4 py-2 bg-slate-50/70 text-xs font-semibold text-slate-500 uppercase tracking-wide">' + s.sec + '</div>' +
        s.items.map(function (it) {
          tot += it.got; max += it.w;
          var pctv = Math.round(it.got / it.w * 100);
          return '<div class="px-4 py-3 flex items-center gap-4">' +
            '<p class="flex-1 text-sm ' + (it.fail ? 'text-rose-700 font-medium' : 'text-slate-700') + '">' + it.t +
            (it.fail ? ' <span class="pri !bg-rose-100 !text-rose-700">ข้อตัดคะแนนอัตโนมัติ</span>' : '') + '</p>' +
            '<div class="w-28 slabar"><div style="width:' + pctv + '%;background:' + (pctv >= 80 ? '#0f766e' : pctv >= 50 ? '#f59e0b' : '#dc2626') + '"></div></div>' +
            '<span class="w-16 text-right text-sm tabular-nums font-medium">' + it.got + '/' + it.w + '</span></div>';
        }).join('') + '</div>';
    }).join('');
    var t = document.getElementById('score-total');
    if (t) t.innerHTML = tot + '<span class="text-lg text-slate-400">/' + max + '</span>';
  }
}

function renderCoaching() {
  var b = document.getElementById('coach-body'); if (!b) return;
  var st = { draft: ['st-offline', 'ร่าง'], scheduled: ['st-acw', 'นัดแล้ว'], done: ['st-available', 'คุยแล้ว'] };
  b.innerHTML = COACHING.map(function (c) {
    return '<div class="bg-white border border-slate-200 rounded-xl p-5">' +
      '<div class="flex items-start justify-between gap-3 mb-2">' +
      '<div><p class="font-medium text-slate-800">' + c.agent + '</p><p class="text-sm text-slate-600 mt-0.5">' + c.topic + '</p></div>' +
      '<span class="st ' + st[c.status][0] + ' shrink-0">' + st[c.status][1] + '</span></div>' +
      '<dl class="text-xs text-slate-500 space-y-1 border-t border-slate-100 pt-3">' +
      '<div class="flex gap-2"><dt class="w-20 shrink-0 text-slate-400">มาจาก</dt><dd>' + c.from + '</dd></div>' +
      '<div class="flex gap-2"><dt class="w-20 shrink-0 text-slate-400">นัดคุย</dt><dd>' + c.when + '</dd></div>' +
      '<div class="flex gap-2"><dt class="w-20 shrink-0 text-slate-400">ติดตามผล</dt><dd>' + c.follow + '</dd></div></dl>' +
      '<div class="flex gap-2 mt-3"><button class="qbtn" onclick="toast(\'เปิดบันทึกการโค้ช (mock)\')"><i class="ti ti-notes"></i>บันทึก</button>' +
      '<button class="qbtn" onclick="toast(\'ตั้งวันติดตามผล (mock)\')"><i class="ti ti-calendar-plus"></i>ติดตามผล</button></div></div>';
  }).join('');
}

function renderApprovals() {
  var b = document.getElementById('appr-body'); if (!b) return;
  var ico = { timeoff: 'ti-beach', shift: 'ti-arrows-exchange', overtime: 'ti-clock-plus', dispute: 'ti-scale' };
  b.innerHTML = APPROVALS.map(function (a, i) {
    return '<tr class="border-b border-slate-100 hover:bg-slate-50">' +
      '<td class="px-3 py-3"><i class="ti ' + ico[a.type] + ' text-teal-700 mr-1.5"></i><span class="text-slate-600">' + a.type + '</span>' +
      '<span class="pri ml-1">' + a.src + '</span></td>' +
      '<td class="px-3 py-3 font-medium">' + a.who + '<p class="text-xs font-normal text-slate-400">' + a.at + '</p></td>' +
      '<td class="px-3 py-3 text-slate-600 whitespace-normal min-w-[180px]">' + a.what + '</td>' +
      '<td class="px-3 py-3 text-sm whitespace-normal min-w-[180px] ' + (a.bad ? 'text-rose-600' : 'text-slate-500') + '">' + (a.bad ? '<i class="ti ti-alert-triangle mr-1"></i>' : '') + a.impact + '</td>' +
      '<td class="px-3 py-3 text-right whitespace-nowrap">' +
      '<button class="qbtn" onclick="decide(' + i + ',1)"><i class="ti ti-check"></i>อนุมัติ</button> ' +
      '<button class="qbtn" onclick="decide(' + i + ',0)"><i class="ti ti-x"></i>ปฏิเสธ</button></td></tr>';
  }).join('');
}
function decide(i, ok) {
  var a = APPROVALS[i];
  toast((ok ? 'อนุมัติ' : 'ปฏิเสธ') + ' — ' + a.who + ' · ' + a.what + ' (mock)');
}

/* ============================================================
   QM (Quality Management) — ADR-010 / docs/quality-management.md
   ============================================================ */

// คิวงานตรวจ — คอลัมน์ "ทำไมถูกเลือก" คือสิ่งที่แยกระบบที่ใช้ได้จริง
// ออกจากระบบที่สุ่มมั่วแล้วไม่มีใครเปิดดู
var QM_QUEUE = [
  { id: 'INT-88213', agent: 'สมชาย วงศ์ประเสริฐ', ch: 'voice', dur: '6:12',
    why: 'หมวด “เสี่ยงยกเลิกบริการ”', whyKind: 'cat', score: 78, st: 'draft' },
  { id: 'INT-88190', agent: 'สมหญิง ใจดี', ch: 'webchat', dur: '11:40',
    why: 'เงียบต่อเนื่อง 38 วิ', whyKind: 'metric', score: 66, st: 'draft' },
  { id: 'INT-88155', agent: 'John Anderson', ch: 'voice', dur: '4:05',
    why: 'สุ่มตามโควตา', whyKind: 'random', score: null, st: 'todo' },
  { id: 'INT-88141', agent: 'อรทัย พูลสวัสดิ์', ch: 'line', dur: '8:22',
    why: 'หมวด “โต้เถียง” + sentiment ติดลบ', whyKind: 'cat', score: 54, st: 'disputed' },
  { id: 'INT-88120', agent: 'ปกรณ์ ศรีสุข', ch: 'voice', dur: '3:31',
    why: 'สุ่มเพื่อ audit ตัว AI', whyKind: 'audit', score: 91, st: 'pub' },
  { id: 'INT-88098', agent: 'Maria Garcia', ch: 'email', dur: '—',
    why: 'สุ่มตามโควตา', whyKind: 'random', score: null, st: 'todo' },
  { id: 'INT-88077', agent: 'สมชาย วงศ์ประเสริฐ', ch: 'voice', dur: '9:47',
    why: 'โอนสายเกิน 2 ครั้ง', whyKind: 'metric', score: 82, st: 'pub' },
  { id: 'INT-88052', agent: 'สมหญิง ใจดี', ch: 'voice', dur: '5:18',
    why: 'หมวด “สัญญาเกินจริง”', whyKind: 'cat', score: 61, st: 'disputed' },
];
var QM_WHY_ICON = { cat: 'ti-tag', metric: 'ti-gauge', random: 'ti-dice-3', audit: 'ti-robot' };
var QM_ST = {
  todo: ['es-void', 'ค้างตรวจ'], draft: ['es-draft', 'ร่างจาก AI'],
  pub: ['es-pub', 'เผยแพร่แล้ว'], disputed: ['es-disp', 'ถูกโต้แย้ง'], amend: ['es-amend', 'แก้ไขแล้ว'],
};
function qmScoreCell(s) {
  if (s === null) return '<span class="text-slate-300">—</span>';
  var c = s >= 85 ? 'text-emerald-600' : (s >= 70 ? 'text-amber-600' : 'text-rose-600');
  return '<span class="font-semibold ' + c + '">' + s + '</span>';
}
function renderQmQueue() {
  var b = document.getElementById('qm-queue-body'); if (!b) return;
  b.innerHTML = QM_QUEUE.map(function (r, i) {
    var st = QM_ST[r.st];
    return '<tr class="border-b border-slate-50 hover:bg-slate-50/60">' +
      '<td class="px-4 py-3 font-medium">' + r.id + '</td>' +
      '<td class="px-4 py-3">' + r.agent + '</td>' +
      '<td class="px-4 py-3"><span class="ch ch-' + r.ch + '">' + r.ch + '</span></td>' +
      '<td class="px-4 py-3 text-slate-500 tabular-nums">' + r.dur + '</td>' +
      '<td class="px-4 py-3 text-slate-600"><i class="ti ' + QM_WHY_ICON[r.whyKind] + ' mr-1.5 text-slate-400"></i>' + r.why + '</td>' +
      '<td class="px-4 py-3 text-right">' + qmScoreCell(r.score) + '</td>' +
      '<td class="px-4 py-3"><span class="es ' + st[0] + '">' + st[1] + '</span></td>' +
      '<td class="px-4 py-3 text-right"><button class="qbtn" onclick="openScore(' + i + ')"><i class="ti ti-clipboard-check"></i>ตรวจ</button></td></tr>';
  }).join('');
}

// สัดส่วนที่มาของสายที่ถูกเลือก — ต้องเห็นว่าไม่ได้สุ่มล้วน
var QM_MIX = [
  { k: 'หมวดอัตโนมัติ (targeted)', v: 50, c: '#7c3aed' },
  { k: 'เงื่อนไขตัวเลข (silence/transfer)', v: 25, c: '#0ea5e9' },
  { k: 'สุ่มตามโควตา', v: 15, c: '#0f766e' },
  { k: 'สุ่มเพื่อ audit ตัว AI', v: 10, c: '#f59e0b' },
];
function renderQmMix() {
  var el = document.getElementById('qm-mix'); if (!el) return;
  el.innerHTML = QM_MIX.map(function (m) {
    return '<div><div class="flex justify-between text-sm mb-1"><span class="text-slate-600">' + m.k + '</span>' +
      '<span class="font-medium tabular-nums">' + m.v + '%</span></div>' +
      '<div class="sbar"><div style="width:' + m.v + '%;background:' + m.c + '"></div></div></div>';
  }).join('');
}

/* ---------- scorecard: waveform + transcript + form ---------- */
// ช่วงที่หยุดอัดตาม PCI (เป็น % ของความยาวสาย) — ต้องมองเห็นบน waveform
var QM_PCI = [{ from: 61, to: 68, why: 'รับเลขบัตรเครดิต' }];
// หมุดหลักฐานที่ AI/ผู้ตรวจอ้างอิง
var QM_EVMARK = [3, 14, 47, 74, 88];
function renderQmWave() {
  var el = document.getElementById('qm-wave'); if (!el) return;
  var bars = '', n = 130;
  for (var i = 0; i < n; i++) {
    var p = i / n * 100, cls, h;
    var inPci = QM_PCI.some(function (x) { return p >= x.from && p <= x.to; });
    // สลับช่วงพูดคุยแบบคร่าว ๆ ให้ดูเหมือนสายจริง
    var who = (Math.sin(i / 7.3) + Math.sin(i / 3.1) * .6) > 0 ? 'w-agent' : 'w-contact';
    var quiet = Math.sin(i / 11.7) < -0.72;
    if (inPci) { cls = 'w-silence'; h = 6; }
    else if (quiet) { cls = 'w-silence'; h = 5 + (i % 3); }
    else { cls = who; h = 12 + Math.abs(Math.sin(i / 2.2) * 34) + (i % 5) * 3; }
    bars += '<div class="wave-bar ' + cls + '" style="height:' + Math.round(h) + '%"></div>';
  }
  var overlay = QM_PCI.map(function (x) {
    return '<div class="wave-pci" style="left:' + x.from + '%;width:' + (x.to - x.from) + '%" title="หยุดอัด — ' + x.why + '"></div>';
  }).join('') + QM_EVMARK.map(function (p) {
    return '<div class="wave-ev" style="left:' + p + '%" title="หลักฐานที่อ้างอิง"></div>';
  }).join('') + '<div class="wave-cursor" style="left:22%"></div>';
  el.innerHTML = bars + overlay;
}

// บทสนทนา — โครงเดียวกันไม่ว่าต้นทางจะเป็นเสียงหรือข้อความ (ADR-010 ข้อ 5)
var QM_TRANSCRIPT = [
  { t: '00:02', who: 'AGENT', s: 'สวัสดีค่ะ บริษัทแอคมี ยินดีให้บริการค่ะ พิมพ์ใจนะคะ' },
  { t: '00:07', who: 'CONTACT', s: 'ครับ ผมโทรมาเรื่องบิลเดือนนี้ครับ มันขึ้นมาเยอะกว่าเดิมมาก' },
  { t: '00:14', who: 'AGENT', s: 'ต้องขออภัยด้วยนะคะ รบกวนขอชื่อ-นามสกุลและเบอร์ที่ลงทะเบียนไว้ได้ไหมคะ' },
  { t: '00:21', who: 'CONTACT', s: 'สมศักดิ์ รุ่งเรือง เบอร์ 08x-xxx-4471 ครับ' },
  { t: '00:31', who: 'AGENT', s: 'ขอบคุณค่ะ สักครู่นะคะ' },
  { t: '00:58', who: 'CONTACT', s: 'ผมดูของเจ้าอื่นแล้วนะ ถ้าแพงขนาดนี้ผมว่าผมขอยกเลิกดีกว่า', cat: 'เสี่ยงยกเลิกบริการ' },
  { t: '01:09', who: 'AGENT', s: 'เข้าใจเลยค่ะ ขอสรุปให้ตรงกันนะคะ — บิลเดือนนี้สูงขึ้นเพราะมีค่าบริการเสริมที่เพิ่งหมดโปรฯ ใช่ไหมคะ' },
  { t: '01:24', who: 'CONTACT', s: 'ใช่ครับ แต่ผมไม่เคยรู้เลยว่าโปรฯ มันจะหมด' },
  { t: '01:33', who: 'AGENT', s: 'ตรงนี้ต้องขอโทษจริง ๆ ค่ะ เดี๋ยวพิมพ์ใจขอตรวจสอบและช่วยดูส่วนลดให้นะคะ' },
  { t: '02:10', who: 'AGENT', s: 'รบกวนขอเลขบัตรเพื่อยืนยันการชำระนะคะ — ระบบจะหยุดบันทึกเสียงช่วงนี้ค่ะ' },
  { t: '02:15', who: 'SYSTEM', s: '— หยุดบันทึกเสียง (PCI) 34 วินาที —' },
  { t: '02:49', who: 'SYSTEM', s: '— เริ่มบันทึกเสียงอีกครั้ง —' },
  { t: '03:02', who: 'AGENT', s: 'เรียบร้อยค่ะ ระบบจะปรับส่วนลดให้ในรอบบิลถัดไปแน่นอนค่ะ รับรองเลยค่ะว่าจะไม่ขึ้นอีก', low: true, cat: 'สัญญาเกินจริง' },
  { t: '05:41', who: 'AGENT', s: 'มีอะไรให้ช่วยเพิ่มเติมไหมคะ' },
  { t: '05:48', who: 'CONTACT', s: 'ไม่มีแล้วครับ ขอบคุณมากครับ' },
  { t: '05:52', who: 'AGENT', s: 'ขอบคุณที่ใช้บริการค่ะ สวัสดีค่ะ' },
];
function renderQmTranscript() {
  var el = document.getElementById('qm-transcript'); if (!el) return;
  var label = { AGENT: 'เอเจนต์', CONTACT: 'ลูกค้า', SYSTEM: 'ระบบ' };
  var cls = { AGENT: 'tr-agent', CONTACT: 'tr-contact', SYSTEM: 'tr-sys' };
  el.innerHTML = QM_TRANSCRIPT.map(function (r, i) {
    var body = '<span' + (r.low ? ' class="tr-low"' : '') + '>' + r.s + '</span>';
    if (r.cat) body += ' <span class="cat cat-risk"><i class="ti ti-tag"></i>' + r.cat + '</span>';
    if (r.low) body += ' <span class="text-[11px] text-amber-600"><i class="ti ti-alert-triangle"></i> ASR 0.62</span>';
    return '<div class="tr-line ' + cls[r.who] + '" id="trl-' + i + '" onclick="qmSeek(' + i + ')">' +
      '<span class="tr-t">' + r.t + '</span><span class="tr-who">' + label[r.who] + '</span>' +
      '<span class="flex-1">' + body + '</span></div>';
  }).join('');
}
function qmSeek(i) {
  document.querySelectorAll('#qm-transcript .tr-line').forEach(function (l) { l.classList.remove('on'); });
  var el = document.getElementById('trl-' + i);
  if (el) { el.classList.add('on'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  var t = document.getElementById('qm-wave-time');
  if (t && QM_TRANSCRIPT[i]) t.textContent = QM_TRANSCRIPT[i].t + ' / 06:12';
}

// ฟอร์มประเมิน — คะแนนทุกข้อที่ AI ให้ต้องผูกหลักฐาน (ADR-010 ข้อ 7)
var QM_FORM = [
  { sec: 'การเปิดสาย', w: 20, qs: [
    { q: 'กล่าวชื่อบริษัทและชื่อตัวเอง', pts: 10, v: 'YES', ai: true, conf: .94, ev: 'สวัสดีค่ะ บริษัทแอคมี…', evi: 0 },
    { q: 'ยืนยันตัวตนลูกค้าครบถ้วน', pts: 10, v: 'YES', ai: true, conf: .88, fail: true, ev: 'ขอชื่อ-นามสกุลและเบอร์…', evi: 2 },
  ]},
  { sec: 'การแก้ปัญหา', w: 45, qs: [
    { q: 'ทวนปัญหาของลูกค้าด้วยคำพูดตัวเอง', pts: 15, v: 'YES', ai: true, conf: .91, ev: 'ขอสรุปให้ตรงกันนะคะ — บิลเดือนนี้…', evi: 6 },
    { q: 'ให้ข้อมูลถูกต้องและไม่สัญญาเกินจริง', pts: 15, v: 'NO', ai: true, conf: .79, ev: 'รับรองเลยค่ะว่าจะไม่ขึ้นอีก', evi: 12 },
    { q: 'เสนอทางเลือกที่เหมาะกับลูกค้า', pts: 10, v: 'NEED', ai: true, conf: .31 },
  ]},
  { sec: 'ความใส่ใจ', w: 25, qs: [
    { q: 'แสดงความเห็นอกเห็นใจเมื่อลูกค้าไม่พอใจ', pts: 15, v: 'YES', ai: true, conf: .72, ev: 'เข้าใจเลยค่ะ…', evi: 6 },
    { q: 'ไม่ตัดบทหรือพูดทับ', pts: 10, v: 'YES', ai: true, conf: .96, ev: 'crosstalk 1.2% ต่ำกว่าเกณฑ์', evi: 0 },
  ]},
  { sec: 'การปิดสาย', w: 10, qs: [
    { q: 'สรุปสิ่งที่จะทำต่อและกล่าวลา', pts: 10, v: 'YES', ai: true, conf: .93, ev: 'ขอบคุณที่ใช้บริการค่ะ', evi: 15 },
    { q: 'เสนอช่องทางติดต่อกลับ (ถ้าเกี่ยวข้อง)', pts: 5, v: 'NA' },
  ]},
];
function qmChip(v, on, label) {
  return '<button class="qchip ' + (on ? v : 'off') + '" onclick="toast(\'เปลี่ยนคำตอบ (mock)\')">' + label + '</button>';
}
function renderQmForm() {
  var el = document.getElementById('qm-form'); if (!el) return;
  el.innerHTML = QM_FORM.map(function (s) {
    var qs = s.qs.map(function (q) {
      var extra = q.fail ? ' qq-fail' : (q.v === 'NEED' ? ' qq-need' : (q.ai ? ' qq-ai' : ''));
      var chips = qmChip('chip-y', q.v === 'YES', 'ใช่') + ' ' + qmChip('chip-n', q.v === 'NO', 'ไม่') + ' ' + qmChip('chip-na', q.v === 'NA', 'N/A');
      var head = '<div class="flex items-start justify-between gap-3">' +
        '<p class="text-sm flex-1">' + q.q +
        (q.fail ? ' <span class="text-[10px] font-bold text-rose-600 align-middle">AUTO-FAIL</span>' : '') +
        '</p><span class="text-xs text-slate-400 whitespace-nowrap">' + q.pts + ' คะแนน</span></div>';
      var foot;
      if (q.v === 'NEED') {
        foot = '<p class="text-xs text-slate-500 mt-2"><i class="ti ti-help-circle mr-1"></i>' +
          '<b>INSUFFICIENT_EVIDENCE</b> — AI หาหลักฐานไม่ได้ (ความมั่นใจ ' + q.conf.toFixed(2) + ') ' +
          'จึงไม่ให้คะแนนและ<b>ไม่ใช่ 0</b> · ข้อนี้นับเป็น N/A จนกว่าคนจะตัดสิน</p>';
      } else if (q.ev) {
        foot = '<div class="mt-2 flex items-center gap-2 flex-wrap">' +
          '<button class="ev" onclick="qmSeek(' + q.evi + ')"><i class="ti ti-quote"></i><span>' + q.ev + '</span></button>' +
          '<span class="text-[11px] text-slate-400">AI ' + q.conf.toFixed(2) + '</span></div>';
      } else {
        foot = '<p class="text-xs text-slate-400 mt-2">ไม่เกี่ยวข้องกับสายนี้ — ถูกตัดออกจากตัวหาร</p>';
      }
      return '<div class="qq' + extra + '">' + head + '<div class="mt-2">' + chips + '</div>' + foot + '</div>';
    }).join('');
    return '<div class="mb-4"><div class="flex items-center justify-between mb-2">' +
      '<h3 class="text-sm font-semibold text-slate-700">' + s.sec + '</h3>' +
      '<span class="text-xs text-slate-400">น้ำหนัก ' + s.w + '%</span></div>' + qs + '</div>';
  }).join('');
}
function openScore(i) {
  var r = QM_QUEUE[i] || QM_QUEUE[0];
  var sub = document.getElementById('qm-score-sub');
  if (sub) sub.textContent = r.id + ' · ' + r.agent + ' · ' + r.ch + ' ' + r.dur + ' · คิว Support TH';
  var st = document.getElementById('qm-score-status');
  if (st) {
    var s = QM_ST[r.st];
    st.className = 'es ' + s[0];
    st.innerHTML = '<i class="ti ti-robot"></i>' + s[1];
  }
  showView('score');
}

/* ---------- calibration ---------- */
var QM_CAL = [
  { q: 'กล่าวชื่อบริษัทและชื่อตัวเอง', v: [10, 10, 10, 10], ai: 10, note: 'ตรงกันหมด — คำถามเขียนดี' },
  { q: 'ยืนยันตัวตนลูกค้าครบถ้วน', v: [10, 10, 0, 10], ai: 10, note: 'John ตีความ “ครบถ้วน” ต่างจากคนอื่น' },
  { q: 'ทวนปัญหาด้วยคำพูดตัวเอง', v: [15, 12, 15, 15], ai: 15, note: '—' },
  { q: 'ไม่สัญญาเกินจริง', v: [0, 0, 8, 0], ai: 0, note: 'ต้องยกตัวอย่างประโยคที่ถือว่าเกินจริง' },
  { q: 'แสดงความเห็นอกเห็นใจ', v: [15, 6, 12, 4], ai: 11, note: 'วัดด้วยความรู้สึก — ต้องแก้ฟอร์ม' },
];
function renderQmCal() {
  var b = document.getElementById('qm-cal-body'); if (!b) return;
  b.innerHTML = QM_CAL.map(function (r) {
    var max = Math.max.apply(null, r.v), min = Math.min.apply(null, r.v), spread = max - min;
    var sc = spread === 0 ? 'text-emerald-600' : (spread <= 5 ? 'text-slate-500' : 'text-rose-600');
    var cells = r.v.map(function (x) {
      return '<td class="px-4 py-3 text-center tabular-nums">' + x + '</td>';
    }).join('');
    return '<tr class="border-b border-slate-50">' +
      '<td class="px-4 py-3">' + r.q + '</td>' + cells +
      '<td class="px-4 py-3 text-center tabular-nums text-amber-600 font-medium">' + r.ai + '</td>' +
      '<td class="px-4 py-3 text-right font-semibold ' + sc + '">±' + spread + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-[13px]">' + r.note + '</td></tr>';
  }).join('');
}

/* ---------- appeals ---------- */
var QM_APPEALS = [
  { id: 'INT-88141', agent: 'อรทัย พูลสวัสดิ์', evaluator: 'นภา สุขใจ', was: 54, ask: 'ข้อ “ไม่ตัดบทลูกค้า”',
    reason: 'ลูกค้าพูดพร้อมกันเพราะสายดีเลย์ ไม่ใช่การตัดบท — ขอให้ฟังนาที 03:12 ประกอบ',
    due: 'ครบกำหนด 12 ส.ค.', who: 'ผู้พิจารณา: พิมพ์ใจ (ไม่ใช่ผู้ให้คะแนน)' },
  { id: 'INT-88052', agent: 'สมหญิง ใจดี', evaluator: 'AI ร่าง → John ยืนยัน', was: 61, ask: 'ข้อ auto-fail “ยืนยันตัวตน”',
    reason: 'ยืนยันตัวตนไปแล้วในช่วงที่ระบบหยุดอัดตาม PCI จึงไม่มีในไฟล์เสียง',
    due: 'ครบกำหนด 10 ส.ค.', who: 'ผู้พิจารณา: นภา (ไม่ใช่ผู้ให้คะแนน)', flag: true },
];
function renderQmAppeals() {
  var el = document.getElementById('qm-appeals'); if (!el) return;
  el.innerHTML = QM_APPEALS.map(function (a, i) {
    return '<div class="bg-white border border-slate-200 rounded-xl p-5' + (a.flag ? ' border-l-4 border-l-rose-500' : '') + '">' +
      '<div class="flex items-start justify-between gap-4 flex-wrap">' +
      '<div class="flex-1 min-w-[260px]">' +
      '<div class="flex items-center gap-2 mb-1"><span class="es es-disp">DISPUTED</span>' +
      '<span class="font-medium">' + a.agent + '</span><span class="text-sm text-slate-400">· ' + a.id + '</span></div>' +
      '<p class="text-sm text-slate-600 mb-2">โต้แย้ง ' + a.ask + ' · ให้คะแนนโดย ' + a.evaluator + '</p>' +
      '<p class="text-sm bg-slate-50 border border-slate-100 rounded-lg p-3">“' + a.reason + '”</p>' +
      (a.flag ? '<p class="text-xs text-rose-600 mt-2"><i class="ti ti-alert-triangle mr-1"></i>' +
        'เคสนี้ชี้ปัญหาเชิงระบบ: หลักฐานอยู่ในช่วงที่ถูกหยุดอัด — ข้อ auto-fail ไม่ควรตัดสินจากไฟล์เสียงเพียงอย่างเดียว</p>' : '') +
      '</div>' +
      '<div class="text-right">' +
      '<p class="text-2xl font-semibold text-rose-600">' + a.was + '</p>' +
      '<p class="text-xs text-slate-400 mb-3">คะแนนที่โต้แย้ง</p>' +
      '<button class="qbtn" onclick="toast(\'แก้คะแนน — บันทึกเป็น AMENDED เก็บค่าเดิมไว้ (mock)\')"><i class="ti ti-edit"></i>แก้คะแนน</button> ' +
      '<button class="qbtn" onclick="toast(\'ยืนตามเดิม — ต้องระบุเหตุผล (mock)\')"><i class="ti ti-check"></i>ยืนตามเดิม</button>' +
      '</div></div>' +
      '<div class="flex items-center gap-4 mt-3 pt-3 border-t border-slate-100 text-xs text-slate-400">' +
      '<span><i class="ti ti-clock mr-1"></i>' + a.due + '</span><span><i class="ti ti-user-shield mr-1"></i>' + a.who + '</span></div></div>';
  }).join('');
}

/* ---------- coaching ---------- */
var QM_COACH = [
  { agent: 'สมหญิง ใจดี', topic: 'การให้ข้อมูลโดยไม่สัญญาเกินจริง', from: 'ผลประเมิน INT-88052',
    slot: '12 ส.ค. 14:00–14:30', slotOk: true, ack: true, fu: 'คะแนนข้อนี้ 0 → 15 ใน 2 ใบถัดมา', fuOk: true },
  { agent: 'John Anderson', topic: 'ขั้นตอนยืนยันตัวตน', from: 'Calibration CAL-0043',
    slot: '13 ส.ค. 10:00–10:30', slotOk: true, ack: false, fu: 'รอผล', fuOk: null },
  { agent: 'ปกรณ์ ศรีสุข', topic: 'ลดความเงียบระหว่างค้นข้อมูล', from: 'หมวด “เงียบนาน” 4 ครั้ง/สัปดาห์',
    slot: 'ยังไม่มีช่องว่างในกะ', slotOk: false, ack: false, fu: '—', fuOk: null },
];
function renderQmCoach() {
  var b = document.getElementById('qm-coach-body'); if (!b) return;
  b.innerHTML = QM_COACH.map(function (c) {
    var slot = c.slotOk
      ? '<span class="text-slate-600"><i class="ti ti-calendar-check mr-1 text-teal-600"></i>' + c.slot + '</span>'
      : '<span class="text-rose-600"><i class="ti ti-calendar-x mr-1"></i>' + c.slot + '</span>';
    var ack = c.ack
      ? '<span class="es es-pub">รับทราบแล้ว</span>'
      : '<span class="es es-draft">รอรับทราบ</span>';
    var fu = c.fuOk === true ? '<span class="text-emerald-600">' + c.fu + '</span>'
      : '<span class="text-slate-400">' + c.fu + '</span>';
    return '<tr class="border-b border-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + c.agent + '</td>' +
      '<td class="px-4 py-3">' + c.topic + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-[13px]">' + c.from + '</td>' +
      '<td class="px-4 py-3 text-[13px]">' + slot + '</td>' +
      '<td class="px-4 py-3">' + ack + '</td>' +
      '<td class="px-4 py-3 text-[13px]">' + fu + '</td></tr>';
  }).join('');
}

/* ---------- media library ---------- */
var QM_MEDIA = [
  { id: 'INT-88213', ch: 'voice', agent: 'สมชาย ว.', when: '7 ส.ค. 10:12', dur: '6:12',
    cats: ['เสี่ยงยกเลิกบริการ'], media: 'audio', left: '11 เดือน' },
  { id: 'INT-88190', ch: 'webchat', agent: 'สมหญิง ใจดี', when: '7 ส.ค. 09:48', dur: '11:40',
    cats: [], media: 'text', left: '23 เดือน' },
  { id: 'INT-88141', ch: 'line', agent: 'อรทัย พ.', when: '6 ส.ค. 16:31', dur: '8:22',
    cats: ['โต้เถียง'], media: 'text', left: '23 เดือน' },
  { id: 'INT-84002', ch: 'voice', agent: 'ปกรณ์ ศ.', when: '3 ส.ค. 2025', dur: '5:03',
    cats: ['สัญญาเกินจริง'], media: 'gone', left: 'transcript 12 เดือน' },
  { id: 'INT-83771', ch: 'voice', agent: 'Maria G.', when: '28 ก.ค. 2025', dur: '14:55',
    cats: ['เสี่ยงยกเลิกบริการ', 'ร้องเรียน'], media: 'hold', left: 'ระงับการลบ' },
];
function renderQmMedia() {
  var b = document.getElementById('qm-media-body'); if (!b) return;
  var M = {
    audio: '<span class="text-teal-700"><i class="ti ti-microphone-2 mr-1"></i>เสียง + บทสนทนา</span>',
    text: '<span class="text-slate-600"><i class="ti ti-message-2 mr-1"></i>ข้อความ (ไม่ผ่าน ASR)</span>',
    gone: '<span class="text-slate-400"><i class="ti ti-microphone-2-off mr-1"></i>เสียงถูกลบแล้ว</span>',
    hold: '<span class="text-rose-600"><i class="ti ti-lock mr-1"></i>legal hold</span>',
  };
  b.innerHTML = QM_MEDIA.map(function (r) {
    var cats = r.cats.length
      ? r.cats.map(function (c) { return '<span class="cat cat-risk">' + c + '</span>'; }).join(' ')
      : '<span class="text-slate-300">—</span>';
    var play = r.media === 'gone'
      ? '<button class="act act-off" title="ไฟล์ถูกลบตามนโยบายแล้ว"><i class="ti ti-player-play"></i></button>'
      : '<button class="act" onclick="toast(\'ออก signed URL อายุ 5 นาที + บันทึก access log (mock)\')"><i class="ti ti-player-play"></i></button>';
    return '<tr class="border-b border-slate-50 hover:bg-slate-50/60">' +
      '<td class="px-4 py-3 font-medium">' + r.id + '</td>' +
      '<td class="px-4 py-3"><span class="ch ch-' + r.ch + '">' + r.ch + '</span></td>' +
      '<td class="px-4 py-3">' + r.agent + '</td>' +
      '<td class="px-4 py-3 text-slate-500">' + r.when + '</td>' +
      '<td class="px-4 py-3 text-slate-500 tabular-nums">' + r.dur + '</td>' +
      '<td class="px-4 py-3">' + cats + '</td>' +
      '<td class="px-4 py-3 text-[13px]">' + M[r.media] + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-[13px]">' + r.left + '</td>' +
      '<td class="px-4 py-3 text-right">' + play +
      '<button class="act" onclick="showView(\'score\')" title="เปิดบทสนทนา"><i class="ti ti-file-text"></i></button></td></tr>';
  }).join('');
}

/* ---------- categories ---------- */
var QM_CATS = [
  { n: 'เสี่ยงยกเลิกบริการ', v: 3, hits: 412, tr: 18, plan: true },
  { n: 'โต้เถียง / เสียงดัง', v: 2, hits: 96, tr: -7, plan: true },
  { n: 'สัญญาเกินจริง', v: 1, hits: 61, tr: 42, plan: true },
  { n: 'เงียบนานเกิน 30 วิ', v: 4, hits: 288, tr: -12, plan: true },
  { n: 'ขอคุยกับหัวหน้า', v: 1, hits: 47, tr: 3, plan: false },
  { n: 'ชมเชยการบริการ', v: 2, hits: 174, tr: 9, plan: false },
];
function renderQmCats() {
  var b = document.getElementById('qm-cat-body'); if (!b) return;
  b.innerHTML = QM_CATS.map(function (c) {
    var up = c.tr >= 0;
    return '<tr class="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer" onclick="toast(\'เปิดกฎของหมวด (mock)\')">' +
      '<td class="px-4 py-3 font-medium">' + c.n + '</td>' +
      '<td class="px-4 py-3 text-center text-slate-500">v' + c.v + '</td>' +
      '<td class="px-4 py-3 text-right tabular-nums">' + c.hits + '</td>' +
      '<td class="px-4 py-3"><span class="' + (up ? 'kpi-delta-down' : 'kpi-delta-up') + '">' +
      '<i class="ti ti-arrow-' + (up ? 'up' : 'down') + '-right"></i> ' + Math.abs(c.tr) + '%</span></td>' +
      '<td class="px-4 py-3">' + (c.plan ? '<i class="ti ti-check text-teal-600"></i>' : '<span class="text-slate-300">—</span>') + '</td></tr>';
  }).join('');
}

/* ---------- insights ---------- */
var QM_FAILS = [
  { q: 'ไม่สัญญาเกินจริง', pct: 38 },
  { q: 'เสนอทางเลือกที่เหมาะกับลูกค้า', pct: 29 },
  { q: 'ทวนปัญหาด้วยคำพูดตัวเอง', pct: 21 },
  { q: 'สรุปสิ่งที่จะทำต่อ', pct: 14 },
];
var QM_CORR = [
  { k: 'คะแนน QM ↔ CSAT', v: 0.61, good: true },
  { k: 'คะแนน QM ↔ การโทรซ้ำใน 24 ชม.', v: -0.44, good: true },
  { k: 'คะแนน QM ↔ AHT', v: 0.08, good: false },
];
function renderQmInsights() {
  var f = document.getElementById('qm-fails');
  if (f) f.innerHTML = QM_FAILS.map(function (x) {
    return '<div><div class="flex justify-between text-sm mb-1"><span class="text-slate-600">' + x.q + '</span>' +
      '<span class="font-medium tabular-nums">' + x.pct + '%</span></div>' +
      '<div class="sbar"><div class="' + (x.pct >= 30 ? 's-bad' : 's-mid') + '" style="width:' + x.pct + '%"></div></div></div>';
  }).join('');
  var c = document.getElementById('qm-corr');
  if (c) c.innerHTML = QM_CORR.map(function (x) {
    var w = Math.abs(x.v) * 100;
    var note = Math.abs(x.v) < 0.2 ? '<span class="text-xs text-slate-400 ml-2">แทบไม่สัมพันธ์ — คุยเร็วไม่ได้แปลว่าคุยดี</span>' : '';
    return '<div><div class="flex justify-between text-sm mb-1"><span class="text-slate-600">' + x.k + '</span>' +
      '<span class="font-medium tabular-nums">' + x.v.toFixed(2) + note + '</span></div>' +
      '<div class="sbar"><div class="' + (Math.abs(x.v) >= 0.4 ? 's-good' : 's-mid') + '" style="width:' + w + '%"></div></div></div>';
  }).join('');
}

/* ---------- forms ---------- */
var QM_FORMS = [
  { n: 'Inbound Service', v: 7, q: 9, af: 1, used: 1284, st: 'locked' },
  { n: 'Inbound Service', v: 8, q: 10, af: 1, used: 0, st: 'draft' },
  { n: 'Sales Outbound', v: 3, q: 12, af: 2, used: 611, st: 'locked' },
  { n: 'Digital (chat/email)', v: 2, q: 8, af: 1, used: 942, st: 'locked' },
  { n: 'Complaint handling', v: 1, q: 11, af: 3, used: 0, st: 'draft' },
];
function renderQmForms() {
  var b = document.getElementById('qm-forms-body'); if (!b) return;
  b.innerHTML = QM_FORMS.map(function (f) {
    var st = f.st === 'locked'
      ? '<span class="es es-pub"><i class="ti ti-lock"></i>ใช้งานอยู่ · ล็อก</span>'
      : '<span class="es es-draft">ฉบับร่าง</span>';
    var act = f.st === 'locked'
      ? '<button class="qbtn" onclick="toast(\'สร้างเวอร์ชันใหม่จาก v' + f.v + ' (mock)\')"><i class="ti ti-copy"></i>ออกเวอร์ชันใหม่</button>'
      : '<button class="qbtn" onclick="toast(\'แก้ไขฟอร์ม (mock)\')"><i class="ti ti-pencil"></i>แก้ไข</button>';
    return '<tr class="border-b border-slate-50">' +
      '<td class="px-4 py-3 font-medium">' + f.n + '</td>' +
      '<td class="px-4 py-3 text-center">v' + f.v + '</td>' +
      '<td class="px-4 py-3 text-center text-slate-500">' + f.q + '</td>' +
      '<td class="px-4 py-3 text-center text-slate-500">' + f.af + '</td>' +
      '<td class="px-4 py-3 text-right tabular-nums">' + (f.used ? f.used.toLocaleString() : '—') + '</td>' +
      '<td class="px-4 py-3">' + st + '</td>' +
      '<td class="px-4 py-3 text-right">' + act + '</td></tr>';
  }).join('');
}

/* ---------- quality plans ---------- */
var QM_PLANS = [
  { n: 'ทีม Inbound — รายเดือน', form: 'Inbound Service v7', scope: 'ทีม Support A, Support B · คิว Support TH',
    quota: '4 สาย/คน/เดือน', min: '60 วินาที', assign: 'หัวหน้าของเอเจนต์',
    mix: [['หมวดอัตโนมัติ', 50], ['เงื่อนไขตัวเลข', 25], ['สุ่ม', 25]], on: true },
  { n: 'Sales — รายสัปดาห์', form: 'Sales Outbound v3', scope: 'ทีม Sales · คิว Sales TH/EN',
    quota: '2 สาย/คน/สัปดาห์', min: '90 วินาที', assign: 'หมุนเวียนในกลุ่มผู้ตรวจ',
    mix: [['หมวดอัตโนมัติ', 40], ['สุ่ม', 60]], on: true },
  { n: 'Auto-QM ทุกการติดต่อ', form: 'Inbound Service v7', scope: 'ทุกทีม · ทุกช่องทาง',
    quota: 'AI ตรวจ 100% · คนตรวจซ้ำ 10% ที่คะแนนต่ำสุด + สุ่ม 3% เพื่อ audit',
    min: '60 วินาที', assign: 'AI ร่าง → หัวหน้ายืนยัน',
    mix: [['AI ตรวจทั้งหมด', 87], ['คนตรวจซ้ำ (คะแนนต่ำ)', 10], ['สุ่ม audit ตัว AI', 3]], on: true, ai: true },
  { n: 'Digital — รายเดือน', form: 'Digital (chat/email) v2', scope: 'ทุกทีม · webchat/LINE/email',
    quota: '3 งาน/คน/เดือน', min: '4 ข้อความ', assign: 'หัวหน้าของเอเจนต์',
    mix: [['หมวดอัตโนมัติ', 30], ['สุ่ม', 70]], on: false },
];
function renderQmPlans() {
  var el = document.getElementById('qm-plans'); if (!el) return;
  var colors = ['#7c3aed', '#0ea5e9', '#0f766e', '#f59e0b'];
  el.innerHTML = QM_PLANS.map(function (p) {
    var bar = '<div class="flex h-2 rounded-full overflow-hidden bg-slate-100 mb-2">' +
      p.mix.map(function (m, i) { return '<div style="width:' + m[1] + '%;background:' + colors[i] + '"></div>'; }).join('') + '</div>' +
      '<div class="flex flex-wrap gap-3 text-xs text-slate-500">' +
      p.mix.map(function (m, i) {
        return '<span class="tl-legend"><span class="tl-key" style="background:' + colors[i] + '"></span>' + m[0] + ' ' + m[1] + '%</span>';
      }).join('') + '</div>';
    return '<div class="bg-white border border-slate-200 rounded-xl p-5' + (p.ai ? ' border-l-4 border-l-amber-400' : '') + '">' +
      '<div class="flex items-start justify-between gap-3 mb-3">' +
      '<div><h3 class="font-semibold text-slate-800">' + p.n +
      (p.ai ? ' <span class="badge-new !ml-0">AUTO-QM</span>' : '') + '</h3>' +
      '<p class="text-xs text-slate-400 mt-0.5">' + p.form + ' · ' + p.scope + '</p></div>' +
      '<span class="es ' + (p.on ? 'es-pub' : 'es-void') + '">' + (p.on ? 'ใช้งาน' : 'ปิดอยู่') + '</span></div>' +
      '<dl class="text-sm space-y-1.5 mb-4">' +
      '<div class="flex justify-between gap-4"><dt class="text-slate-500 shrink-0">โควตา</dt><dd class="font-medium text-right">' + p.quota + '</dd></div>' +
      '<div class="flex justify-between gap-4"><dt class="text-slate-500 shrink-0">ความยาวขั้นต่ำ</dt><dd class="font-medium">' + p.min + '</dd></div>' +
      '<div class="flex justify-between gap-4"><dt class="text-slate-500 shrink-0">มอบหมายให้</dt><dd class="font-medium text-right">' + p.assign + '</dd></div>' +
      '</dl>' + bar + '</div>';
  }).join('');
}

/* ---------- compliance ---------- */
var QM_RETENTION = [
  { k: 'ไฟล์เสียง / สื่อ', v: '12 เดือน', w: 33, c: '#dc2626', note: 'ใหญ่ที่สุด แพงที่สุด อ่อนไหวที่สุด · มาจาก entitlement recording.retentionMonths' },
  { k: 'บทสนทนา + ตัวชี้วัด', v: '24 เดือน', w: 66, c: '#f59e0b', note: 'ยาวกว่าเสียง — วิเคราะห์ย้อนหลังได้โดยไม่ต้องถือครองเสียง' },
  { k: 'ผลประเมิน + คำโต้แย้ง + โค้ช', v: '36 เดือน', w: 100, c: '#0f766e', note: 'ยาวสุด — เป็นเอกสารด้านบุคคล ลบแล้วเถียงกันไม่จบ' },
];
function renderQmRetention() {
  var el = document.getElementById('qm-retention'); if (!el) return;
  el.innerHTML = QM_RETENTION.map(function (r) {
    return '<div><div class="flex justify-between items-baseline mb-1">' +
      '<span class="text-sm font-medium text-slate-700">' + r.k + '</span>' +
      '<span class="text-sm font-semibold tabular-nums">' + r.v + '</span></div>' +
      '<div class="sbar mb-1.5"><div style="width:' + r.w + '%;background:' + r.c + '"></div></div>' +
      '<p class="text-xs text-slate-400">' + r.note + '</p></div>';
  }).join('');
}
var QM_HOLDS = [
  { n: 'คดี ปค. 41/2568', scope: '212 การติดต่อ · ลูกค้า 3 ราย', by: 'ฝ่ายกฎหมาย · 14 มี.ค. 2026' },
  { n: 'ข้อร้องเรียน กสทช.', scope: '18 การติดต่อ · คิว Support TH', by: 'ฝ่ายกำกับ · 2 ก.ค. 2026' },
];
function renderQmHolds() {
  var el = document.getElementById('qm-holds'); if (!el) return;
  el.innerHTML = QM_HOLDS.map(function (h) {
    return '<div class="border border-rose-100 bg-rose-50 rounded-lg p-3">' +
      '<p class="text-sm font-medium text-rose-900"><i class="ti ti-lock mr-1"></i>' + h.n + '</p>' +
      '<p class="text-xs text-rose-700 mt-1">' + h.scope + '</p>' +
      '<p class="text-xs text-rose-500 mt-1">' + h.by + '</p></div>';
  }).join('');
}
var QM_QUOTA = [
  { k: 'นาทีถอดเสียง / เดือน', used: 14320, cap: 20000, unit: 'นาที' },
  { k: 'สายที่ AI ให้คะแนน / เดือน', used: 1866, cap: 2000, unit: 'สาย' },
  { k: 'พื้นที่จัดเก็บสื่อ', used: 214, cap: 300, unit: 'GB' },
];
function renderQmQuota() {
  var el = document.getElementById('qm-quota'); if (!el) return;
  el.innerHTML = QM_QUOTA.map(function (q) {
    var pct = Math.round(q.used / q.cap * 100);
    var c = pct >= 90 ? 's-bad' : (pct >= 70 ? 's-mid' : 's-good');
    return '<div><div class="flex justify-between text-sm mb-1"><span class="text-slate-600">' + q.k + '</span>' +
      '<span class="font-medium tabular-nums">' + q.used.toLocaleString() + ' / ' + q.cap.toLocaleString() + '</span></div>' +
      '<div class="sbar"><div class="' + c + '" style="width:' + Math.min(pct, 100) + '%"></div></div>' +
      (pct >= 90 ? '<p class="text-xs text-rose-600 mt-1">ชนเพดานแล้วจะหยุดร่างคะแนนใหม่ — <b>การอัดและการรับสายไม่ได้รับผลกระทบ</b></p>' : '') +
      '</div>';
  }).join('');
}
var QM_ACCESS = [
  { t: '7 ส.ค. 11:42', u: 'พิมพ์ใจ ส.', r: 'SUPERVISOR', a: 'ฟังเสียง', id: 'INT-88213', ip: '203.0.113.44' },
  { t: '7 ส.ค. 11:40', u: 'พิมพ์ใจ ส.', r: 'SUPERVISOR', a: 'เปิดบทสนทนา', id: 'INT-88213', ip: '203.0.113.44' },
  { t: '7 ส.ค. 10:58', u: 'svc-qm-worker', r: 'SERVICE', a: 'ถอดเสียง', id: 'INT-88213', ip: '10.0.4.12' },
  { t: '7 ส.ค. 09:31', u: 'สมชาย ว.', r: 'AGENT', a: 'ฟังเสียงของตัวเอง', id: 'INT-88077', ip: '203.0.113.91' },
  { t: '6 ส.ค. 17:02', u: 'นภา ส.', r: 'SUPERVISOR', a: 'ดาวน์โหลด', id: 'INT-88141', ip: '203.0.113.44' },
  { t: '6 ส.ค. 16:45', u: 'admin@acme', r: 'ADMIN', a: 'ตั้ง legal hold', id: '18 รายการ', ip: '203.0.113.7' },
];
function renderQmAccess() {
  var b = document.getElementById('qm-access-body'); if (!b) return;
  b.innerHTML = QM_ACCESS.map(function (a) {
    var rc = a.r === 'SERVICE' ? 'text-slate-400' : (a.r === 'ADMIN' ? 'text-rose-600' : 'text-slate-500');
    return '<tr class="border-b border-slate-50">' +
      '<td class="px-4 py-2.5 text-slate-500 tabular-nums">' + a.t + '</td>' +
      '<td class="px-4 py-2.5">' + a.u + '</td>' +
      '<td class="px-4 py-2.5 text-xs ' + rc + '">' + a.r + '</td>' +
      '<td class="px-4 py-2.5">' + a.a + '</td>' +
      '<td class="px-4 py-2.5 text-slate-500">' + a.id + '</td>' +
      '<td class="px-4 py-2.5 text-slate-400 tabular-nums">' + a.ip + '</td></tr>';
  }).join('');
}

/* ---------- my scores (agent) ---------- */
var QM_MINE = [
  { d: '5 ส.ค.', id: 'INT-88077', f: 'Inbound Service v7', ev: 'พิมพ์ใจ ส.', s: 82, st: 'pub' },
  { d: '29 ก.ค.', id: 'INT-87540', f: 'Inbound Service v7', ev: 'นภา ส.', s: 91, st: 'pub' },
  { d: '22 ก.ค.', id: 'INT-87102', f: 'Inbound Service v7', ev: 'พิมพ์ใจ ส.', s: 76, st: 'amend' },
  { d: '15 ก.ค.', id: 'INT-86688', f: 'Inbound Service v7', ev: 'นภา ส.', s: 95, st: 'pub' },
  { d: '8 ก.ค.', id: 'INT-86201', f: 'Inbound Service v7', ev: 'พิมพ์ใจ ส.', s: 88, st: 'pub' },
];
function renderQmMine() {
  var b = document.getElementById('qm-mine-body'); if (!b) return;
  b.innerHTML = QM_MINE.map(function (r) {
    var st = QM_ST[r.st];
    var note = r.st === 'amend' ? ' <span class="text-xs text-slate-400">(เดิม 68 · โต้แย้งแล้วชนะ)</span>' : '';
    return '<tr class="border-b border-slate-50">' +
      '<td class="px-4 py-3 text-slate-500">' + r.d + '</td>' +
      '<td class="px-4 py-3 font-medium">' + r.id + '</td>' +
      '<td class="px-4 py-3 text-slate-500 text-[13px]">' + r.f + '</td>' +
      '<td class="px-4 py-3">' + r.ev + '</td>' +
      '<td class="px-4 py-3 text-right">' + qmScoreCell(r.s) + note + '</td>' +
      '<td class="px-4 py-3"><span class="es ' + st[0] + '">' + st[1] + '</span></td>' +
      '<td class="px-4 py-3 text-right"><button class="qbtn" onclick="toast(\'ยื่นคำโต้แย้ง — จะถูกตัดสินโดยคนอื่น (mock)\')"><i class="ti ti-gavel"></i>โต้แย้ง</button></td></tr>';
  }).join('');
}

function renderQmCharts() {
  if (typeof Chart === 'undefined') return;
  var weeks = ['W23', 'W24', 'W25', 'W26', 'W27', 'W28', 'W29', 'W30', 'W31'];
  var trendEl = document.getElementById('chart-qm-trend');
  if (trendEl && !trendEl.dataset.done) {
    trendEl.dataset.done = '1';
    new Chart(trendEl, { type: 'line', data: { labels: weeks, datasets: [
      { label: 'คะแนนจากคน', data: [81, 82.4, 80.9, 83.1, 84, 83.6, 85.2, 84.1, 84.6], borderColor: '#0f766e', backgroundColor: '#0f766e22', tension: .35, fill: true },
      { label: 'ร่างจาก AI', data: [76, 78.2, 77.4, 80.2, 81.1, 80.4, 82.6, 80.9, 81.2], borderColor: '#f59e0b', borderDash: [5, 4], tension: .35 },
    ]}, options: { responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 65, max: 95, ticks: { callback: function (v) { return v + '%'; } } } },
      plugins: { legend: { position: 'bottom' } } } });
  }
  var catEl = document.getElementById('chart-qm-cats');
  if (catEl && !catEl.dataset.done) {
    catEl.dataset.done = '1';
    new Chart(catEl, { type: 'line', data: { labels: weeks, datasets: [
      { label: 'เสี่ยงยกเลิกบริการ', data: [42, 46, 51, 58, 71, 82, 88, 96, 104], borderColor: '#dc2626', tension: .3 },
      { label: 'สัญญาเกินจริง', data: [6, 7, 5, 9, 11, 14, 12, 17, 19], borderColor: '#7c3aed', tension: .3 },
      { label: 'เงียบนานเกิน 30 วิ', data: [61, 58, 55, 52, 49, 47, 44, 42, 40], borderColor: '#0ea5e9', tension: .3 },
    ]}, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } } });
  }
  var mineEl = document.getElementById('chart-qm-mine');
  if (mineEl && !mineEl.dataset.done) {
    mineEl.dataset.done = '1';
    new Chart(mineEl, { type: 'bar', data: { labels: ['8 ก.ค.', '15 ก.ค.', '22 ก.ค.', '29 ก.ค.', '5 ส.ค.'], datasets: [
      { label: 'คะแนนของฉัน', data: [88, 95, 76, 91, 82], backgroundColor: '#0f766e' },
      { label: 'ค่าเฉลี่ยทีม', type: 'line', data: [84, 84.6, 83.9, 85.2, 84.6], borderColor: '#94a3b8', borderDash: [4, 4], tension: .3 },
    ]}, options: { responsive: true, maintainAspectRatio: false,
      scales: { y: { min: 50, max: 100 } }, plugins: { legend: { position: 'bottom' } } } });
  }
}

function renderQm() {
  renderQmQueue(); renderQmMix(); renderQmWave(); renderQmTranscript(); renderQmForm();
  renderQmCal(); renderQmAppeals(); renderQmCoach(); renderQmMedia(); renderQmCats();
  renderQmInsights(); renderQmForms(); renderQmPlans();
  renderQmRetention(); renderQmHolds(); renderQmQuota(); renderQmAccess(); renderQmMine();
  renderQmCharts();
}

/* ---------- boot ---------- */
function renderAll() {
  renderQueues(); renderAgents(); renderTeams(); renderContacts(); renderNumbers();
  renderFlows(); renderInteractions(); renderMyInteractions(); renderRecordings(); renderUsers(); renderAudit();
  renderQueueLive(); renderInbox();
  renderSchedule(); renderRequirement(); renderAdherence(); renderIntraday();
  renderTimeoff(); renderSites(); renderMySchedule();
  renderPulse(); renderLive(); renderQueueCtl(); renderAlerts();
  renderEvals(); renderCoaching(); renderApprovals();
  renderQm();
  // โมดูลใหม่ (outbound/cases/ai/analytics/integrations/customer-360/reporting) อยู่ใน modules.js
  if (typeof renderModules === 'function') renderModules();
  renderCharts();
}
/* ============================================================
   ความกว้างของคอลัมน์ในพื้นที่ทำงาน — เอเจนต์ลากปรับเอง (interaction-data-flow §4.4)
   ค่าที่บันทึกไว้ต้องถูก clamp ทุกครั้งที่โหลด: preference ที่ทำให้มองไม่เห็นบทสนทนา
   คือ preference ที่ต้องถูกปฏิเสธ — mockup เก็บใน localStorage, ของจริงเก็บผูกกับผู้ใช้
   ============================================================ */
var WS_COL_KEY = 'dcontact.ws.cols';
var WS_MIN_MID = 360;   // บทสนทนาแคบกว่านี้แล้วอ่านไม่รู้เรื่อง
function swColsDefault() { return { c1: 300, c3: 340 }; }
function swColsClamp(cols, total) {
  // ขั้นต่ำลดตามจอด้วย — จอ 1280 ที่กริดเหลือ ~900px ถ้าใช้ขั้นต่ำของจอใหญ่ บทสนทนาจะโดนบีบจนแคบกว่าเดิม
  var minC1 = Math.min(220, Math.round(total * 0.2));
  var minC3 = Math.min(280, Math.round(total * 0.26));
  var minMid = Math.min(WS_MIN_MID, Math.round(total * 0.36));
  var c = { c1: cols.c1, c3: cols.c3 };
  c.c1 = Math.max(minC1, Math.min(520, c.c1));
  c.c3 = Math.max(minC3, Math.min(640, c.c3));
  var mid = total - 40 - c.c1 - c.c3;                 // 40 = ที่จับสองอัน
  if (mid < minMid) {                                 // เบียดคืนจากแผงบริบทก่อน แล้วค่อยรายการงาน
    var over = minMid - mid;
    var fromC3 = Math.min(over, c.c3 - minC3); c.c3 -= fromC3; over -= fromC3;
    c.c1 = Math.max(minC1, c.c1 - over);
  }
  return c;
}
function swColsLoad() {
  try { return JSON.parse(localStorage.getItem(WS_COL_KEY)) || swColsDefault(); } catch (e) { return swColsDefault(); }
}
function swColsSave(cols) {
  try { cols ? localStorage.setItem(WS_COL_KEY, JSON.stringify(cols)) : localStorage.removeItem(WS_COL_KEY); } catch (e) {}
}
function swColsApply(cols) {
  var g = document.getElementById('sw-grid'); if (!g) return null;
  var c = swColsClamp(cols || swColsDefault(), g.getBoundingClientRect().width);
  g.style.setProperty('--ws-c1', c.c1 + 'px');
  g.style.setProperty('--ws-c3', c.c3 + 'px');
  return c;
}
// พื้นที่ทำงานสูงเต็มจอ — คำนวณด้วย JS เพราะ root font-size 18px ทำให้ความสูง header/padding
// เป็น rem ที่เดาค่าคงที่ไม่ได้ และต้องหักแถบสายที่กำลังคุยซึ่งลอยทับด้านล่าง
function swFitHeight() {
  var g = document.getElementById('sw-grid'); if (!g || !g.offsetParent) return;   // วิวนี้ถูกซ่อนอยู่
  var mb = document.querySelector('.monbar');
  var bottom = mb ? mb.offsetHeight + 28 : 24;
  g.style.height = Math.max(420, window.innerHeight - g.getBoundingClientRect().top - bottom) + 'px';
}
function swSplitDrag(e, which) {
  var g = document.getElementById('sw-grid'); if (!g) return;
  e.preventDefault();
  var rect = g.getBoundingClientRect(), cols = swColsLoad(), latest = cols;
  var handle = e.currentTarget; handle.classList.add('drag');
  document.body.classList.add('ws-resizing');
  var move = function (ev) {
    var x = ev.clientX - rect.left;
    if (which === '1') cols.c1 = x - 10; else cols.c3 = rect.width - x - 10;
    latest = swColsApply(cols) || cols;
  };
  var up = function () {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.classList.remove('ws-resizing');
    handle.classList.remove('drag');
    swColsSave(latest);                                // บันทึกตอนปล่อยเท่านั้น ไม่ใช่ทุกเฟรม
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
function swSplitKey(e, which) {
  var step = e.shiftKey ? 64 : 16, dir = e.key === 'ArrowLeft' ? -1 : (e.key === 'ArrowRight' ? 1 : 0);
  if (!dir) return;
  e.preventDefault();
  var cols = swColsLoad();
  if (which === '1') cols.c1 += dir * step; else cols.c3 -= dir * step;
  swColsSave(swColsApply(cols));
}
function swResetCols() {
  swColsSave(null); swColsApply(null);
  toast(currentLang === 'th' ? 'คืนความกว้างคอลัมน์เป็นค่าเริ่มต้นแล้ว' : 'Column widths reset');
}
// วัดใหม่ทั้งความกว้างและความสูง — ค่าที่บันทึกไว้ถูก clamp ตามพื้นที่จริงของจอตอนนี้เสมอ
function swRelayout() { swColsApply(swColsLoad()); swFitHeight(); }
function swInitLayout() {
  var g = document.getElementById('sw-grid'); if (!g) return;
  swRelayout();
  [].slice.call(g.querySelectorAll('.sw-split')).forEach(function (h) {
    var which = h.dataset.split;
    h.addEventListener('pointerdown', function (e) { swSplitDrag(e, which); });
    h.addEventListener('dblclick', swResetCols);
    h.addEventListener('keydown', function (e) { swSplitKey(e, which); });
  });
  window.addEventListener('resize', swRelayout);
  // วัดซ้ำหลังฟอนต์/เลย์เอาต์นิ่ง — ค่ารอบแรกวัดได้ก่อนที่ viewport จริงจะเซ็ตตัวเสร็จ
  setTimeout(swRelayout, 0);
  window.addEventListener('load', swRelayout);
}

function initApp() {
  var area = document.body.dataset.area; if (!area) return;
  var def = document.body.dataset.default;
  var app = document.getElementById('app');
  app.className = 'flex min-h-screen';
  app.innerHTML = buildRail(area) + buildPanel(area) + '<div id="content-col" class="flex-1 flex flex-col min-w-0">' + HEADER + '</div>';
  var tmpl = document.getElementById('area-main');
  if (tmpl) document.getElementById('content-col').appendChild(tmpl.content.cloneNode(true));
  document.body.insertAdjacentHTML('beforeend', buildChatPanel());   // แผงแชทติดทุกหน้าจอ (ADR-022)
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
  swInitLayout();   // หน้าอื่นไม่มี #sw-grid — ฟังก์ชันจะคืนค่าออกไปเอง
}
document.addEventListener('DOMContentLoaded', initApp);
