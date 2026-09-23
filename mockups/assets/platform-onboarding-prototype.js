/*
 * Three variants of Platform Admin tenant onboarding, switchable via ?variant=,
 * on the existing mockups/platform.html route. Throwaway artifact for A1 #391.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var isLocal = ['127.0.0.1', 'localhost', ''].indexOf(window.location.hostname) >= 0;
  if (!isLocal && params.get('prototype') !== '1') return;

  var variants = ['A', 'B', 'C'];
  var variantNames = {
    A: 'Guided onboarding',
    B: 'Operations workspace',
    C: 'Lifecycle mission control'
  };
  var state = {
    variant: variants.indexOf((params.get('variant') || 'A').toUpperCase()) >= 0 ? (params.get('variant') || 'A').toUpperCase() : 'A',
    flow: params.get('flow') || 'list',
    currentStep: 3,
    notice: ''
  };

  var steps = [
    ['สร้าง durable intent และจอง slug/domain', 'Postgres control plane'],
    ['สร้าง Keycloak Organization', 'realm: dcontact'],
    ['ผูก plan, locale และ bootstrap manifest', 'operational-baseline@1.0.0'],
    ['สร้าง first admin', 'platform-wide unique identity'],
    ['ส่ง invitation', 'execute-actions · อายุ 72 ชั่วโมง'],
    ['ตรวจ tenant isolation และ readiness', 'two-tenant smoke test'],
    ['เปิดใช้งาน tenant', 'Tenant ACTIVE · handoff ready']
  ];

  var queue = [
    { name: 'Northstar Clinic', slug: 'northstar', plan: 'Growth', status: 'active', note: 'พร้อมส่งมอบ · invitation accepted', flow: 'handoff' },
    { name: 'Metro Retail Lab', slug: 'metro-retail', plan: 'Starter', status: 'warning', note: 'ACTION_REQUIRED · bootstrap manifest', flow: 'failure' },
    { name: 'Aster Logistics', slug: 'aster-logistics', plan: 'Growth', status: 'running', note: 'RUNNING · first admin', flow: 'progress' },
    { name: 'Siam Service Desk', slug: 'siam-service', plan: 'Enterprise', status: 'active', note: 'ACTIVE · 18 ก.ย. 2026', flow: 'handoff' }
  ];

  function esc(value) {
    return String(value).replace(/[&<>'"]/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c];
    });
  }

  function chip(status, text) {
    return '<span class="proto-chip ' + status + '"><span class="proto-dot"></span>' + esc(text) + '</span>';
  }

  function formFields(dark) {
    return '<div class="proto-field-grid">'
      + '<div class="proto-field wide"><label>ชื่อลูกค้า / องค์กร</label><input class="proto-input" value="Nova Care Thailand" aria-label="ชื่อลูกค้า"></div>'
      + '<div class="proto-field"><label>Slug (แก้ไม่ได้หลังยืนยัน)</label><div class="proto-addon"><input class="proto-input" value="nova-care" aria-label="Slug"><span>.d-contact.io</span></div></div>'
      + '<div class="proto-field"><label>Primary domain</label><input class="proto-input" value="novacare.co.th" aria-label="Primary domain"></div>'
      + '<div class="proto-field"><label>Plan</label><select class="proto-input" aria-label="Plan"><option>Starter</option><option selected>Growth</option><option>Enterprise</option></select></div>'
      + '<div class="proto-field"><label>Timezone</label><select class="proto-input" aria-label="Timezone"><option selected>Asia/Bangkok (UTC+7)</option></select></div>'
      + '<div class="proto-field"><label>Locale</label><select class="proto-input" aria-label="Locale"><option selected>ไทย (th-TH)</option><option>English (en-US)</option></select></div>'
      + '<div class="proto-field"><label>ชื่อ First admin</label><input class="proto-input" value="Narin Chaiyasit" aria-label="ชื่อ First admin"></div>'
      + '<div class="proto-field"><label>อีเมล First admin</label><input class="proto-input" type="email" value="narin@novacare.co.th" aria-label="อีเมล First admin"></div>'
      + '</div>';
  }

  function reviewSummary() {
    return '<dl class="proto-kv">'
      + '<dt>องค์กร</dt><dd>Nova Care Thailand</dd>'
      + '<dt>Tenant identity</dt><dd><span class="proto-code">nova-care</span> · <span class="proto-code">novacare.co.th</span></dd>'
      + '<dt>Plan snapshot</dt><dd>Growth · current published version</dd>'
      + '<dt>Locale</dt><dd>Asia/Bangkok · th-TH</dd>'
      + '<dt>Bootstrap template</dt><dd>operational-baseline@1.0.0</dd>'
      + '<dt>First admin</dt><dd>Narin Chaiyasit · narin@novacare.co.th</dd>'
      + '</dl>';
  }

  function checklist(compact, failureAt) {
    return '<div class="' + (compact ? 'b-log' : '') + '">'
      + steps.map(function (step, i) {
        var status = i < state.currentStep ? 'done' : i === failureAt ? 'failed' : i === state.currentStep ? 'current' : '';
        var icon = status === 'done' ? '✓' : status === 'failed' ? '!' : (i + 1);
        if (compact) {
          return '<div class="b-log-item ' + status + '"><strong>' + esc(step[0]) + '</strong><small>' + esc(status === 'done' ? 'สำเร็จ · verified' : status === 'failed' ? 'หยุดรอ Operator' : step[1]) + '</small></div>';
        }
        return '<div class="a-progress-item ' + status + '"><span class="a-progress-icon">' + icon + '</span><div><strong>' + esc(step[0]) + '</strong><small>' + esc(status === 'done' ? 'สำเร็จ · verified' : status === 'failed' ? 'หยุดรอ Operator' : step[1]) + '</small></div></div>';
      }).join('')
      + '</div>';
  }

  function tenantTable() {
    return '<div class="proto-card" style="overflow:hidden"><table class="proto-table"><thead><tr><th>Tenant</th><th>Identity</th><th>Plan</th><th>Provisioning</th><th>อัปเดตล่าสุด</th><th></th></tr></thead><tbody>'
      + queue.map(function (t) {
        var label = t.status === 'active' ? 'ACTIVE' : t.status === 'warning' ? 'ACTION_REQUIRED' : 'RUNNING';
        return '<tr data-flow="' + t.flow + '"><td><strong>' + esc(t.name) + '</strong><br><span class="proto-help">' + esc(t.note) + '</span></td><td><span class="proto-code">' + esc(t.slug) + '</span></td><td>' + esc(t.plan) + '</td><td>' + chip(t.status, label) + '</td><td>2 นาทีที่แล้ว</td><td><button class="proto-link" data-flow="' + t.flow + '">เปิด →</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function top(title, subtitle, action) {
    return '<div class="proto-toolbar"><div><div class="proto-eyebrow">A1 · INTERNAL PLATFORM OPERATIONS</div><h1 class="proto-title">' + esc(title) + '</h1><p class="proto-subtitle">' + esc(subtitle) + '</p></div>'
      + '<div class="proto-actions">' + (action || '') + '</div></div>';
  }

  function stepper(active) {
    var labels = [['create','1','ข้อมูลลูกค้า'],['review','2','ตรวจสอบ'],['progress','3','Provisioning'],['handoff','4','ส่งมอบ']];
    var order = labels.map(function (x) { return x[0]; }).indexOf(active);
    if (active === 'failure') order = 2;
    return '<div class="proto-card a-stepper">' + labels.map(function (x, i) {
      return '<div class="a-step ' + (i === order ? 'on' : '') + ' ' + (i < order ? 'done' : '') + '"><b>' + (i < order ? '✓' : x[1]) + '</b><span>' + x[2] + '</span></div>';
    }).join('') + '</div>';
  }

  function variantA() {
    if (state.flow === 'list') {
      return '<div class="proto-shell">' + top('Tenants', 'ดูสถานะ onboarding และงานที่ Operator ต้องจัดการจากจุดเดียว', '<button class="proto-btn" data-flow="failure"><i class="ti ti-alert-triangle"></i>เปิดเคสติดขัด</button><button class="proto-btn primary" data-flow="create"><i class="ti ti-plus"></i>สร้าง tenant</button>')
        + '<div class="proto-grid-4" style="margin-bottom:16px">'
        + '<div class="proto-card proto-metric"><span>Active tenants</span><strong>24</strong><span style="color:#047857">+3 ไตรมาสนี้</span></div>'
        + '<div class="proto-card proto-metric"><span>กำลัง Provision</span><strong style="color:#1d4ed8">1</strong><span>ทำงาน 03:42 นาที</span></div>'
        + '<div class="proto-card proto-metric"><span>ต้องจัดการ</span><strong style="color:#be123c">1</strong><span>เกิน SLA 8 นาที</span></div>'
        + '<div class="proto-card proto-metric"><span>รอรับคำเชิญ</span><strong style="color:#b45309">2</strong><span>หมดอายุเร็วสุด 26 ชม.</span></div></div>'
        + tenantTable() + '</div>';
    }

    var main = '';
    var side = '<div class="a-side"><div class="proto-card proto-card-body"><div class="proto-card-title">Completion boundary</div><p class="proto-help" style="margin-top:8px">จะแสดง ACTIVE ต่อเมื่อ Postgres, Keycloak, bootstrap, first admin, invitation delivery และ isolation smoke ผ่านครบ</p></div><div class="proto-callout info"><strong>ข้อมูลปลอดภัย</strong><br>ไม่มี temporary password หรือ secret ใน UI, URL และ audit evidence</div></div>';

    if (state.flow === 'create') {
      main = '<div class="proto-card"><div class="proto-card-head"><div><div class="proto-card-title">ข้อมูลสำหรับสร้าง tenant</div><p class="proto-help">กรอกเฉพาะค่าที่จำเป็นต่อ operational baseline</p></div>' + chip('neutral','Draft') + '</div><div class="proto-card-body">' + formFields() + '<hr class="proto-sep"><div class="proto-actions" style="justify-content:flex-end"><button class="proto-btn" data-flow="list">ยกเลิก</button><button class="proto-btn primary" data-flow="review">ตรวจสอบข้อมูล →</button></div></div></div>';
    } else if (state.flow === 'review') {
      main = '<div class="proto-card"><div class="proto-card-head"><div><div class="proto-card-title">ตรวจสอบก่อน Provision</div><p class="proto-help">slug, primary domain และ first-admin email ถูก reserve หลังยืนยัน</p></div>' + chip('warning','ต้องยืนยัน') + '</div><div class="proto-card-body">' + reviewSummary() + '<hr class="proto-sep"><div class="proto-callout warning"><strong>ค่าที่แก้ไม่ได้หลังส่งคำขอ</strong><br>Tenant UUID จะถูกสร้างโดย server; slug และ primary domain จะคงเดิมตลอด onboarding หากยกเลิกจะติด tombstone 30 วัน</div><div class="proto-empty-gap"></div><label class="proto-check"><input type="checkbox" checked><span>ฉันตรวจสอบ identity, plan และ first admin แล้ว และเข้าใจว่าระบบจะเริ่ม durable provisioning</span></label><div class="proto-actions" style="justify-content:flex-end;margin-top:18px"><button class="proto-btn" data-flow="create">← แก้ไข</button><button class="proto-btn primary" data-action="confirm">ยืนยันและเริ่ม Provision</button></div></div></div>';
    } else if (state.flow === 'progress') {
      main = '<div class="proto-card"><div class="proto-card-head"><div><div class="proto-card-title">กำลัง Provision · Nova Care Thailand</div><p class="proto-help">Request <span class="proto-code">prv_01J8NOVA</span> · ทำซ้ำได้อย่างปลอดภัย</p></div>' + chip('running','RUNNING') + '</div><div class="proto-card-body">' + checklist(false) + '<div class="proto-actions" style="justify-content:flex-end;margin-top:14px"><button class="proto-btn" data-action="simulate-failure">จำลอง failure</button><button class="proto-btn primary" data-action="next-step">เดินขั้นถัดไป →</button></div></div></div>';
    } else if (state.flow === 'failure') {
      state.currentStep = 2;
      main = '<div class="proto-card"><div class="proto-card-head"><div><div class="proto-card-title">Provisioning ต้องการการตัดสินใจ</div><p class="proto-help">Metro Retail Lab · request <span class="proto-code">prv_01J8METRO</span></p></div>' + chip('danger','ACTION_REQUIRED') + '</div><div class="proto-card-body"><div class="proto-callout danger"><strong>Bootstrap manifest digest ไม่ตรงกับเวอร์ชันที่อนุมัติ</strong><br>ขั้นตอนหยุดอย่างปลอดภัยก่อนสร้าง first admin · correlation <span class="proto-code">corr_8fa21</span></div><div class="proto-empty-gap"></div>' + checklist(false,2) + '<hr class="proto-sep"><div class="proto-card-title">แนะนำ: Reconcile ก่อน</div><p class="proto-help" style="margin:5px 0 12px">อ่านสถานะจริงจาก dependency แล้ว adopt ของที่สร้างสำเร็จ เพื่อลดการสร้างซ้ำ</p><div class="proto-actions"><button class="proto-btn primary" data-action="recover">Reconcile &amp; resume</button><button class="proto-btn" data-action="retry">Retry current step</button><button class="proto-btn" data-action="compensate">Safe compensate</button><button class="proto-btn danger" data-action="final-fail">Mark FAILED_FINAL</button></div></div></div>';
    } else {
      main = '<div class="proto-card"><div class="proto-card-head"><div><div class="proto-card-title">พร้อมส่งมอบให้ลูกค้า</div><p class="proto-help">Northstar Clinic · Tenant ACTIVE</p></div>' + chip('success','READY FOR HANDOFF') + '</div><div class="proto-card-body"><div class="proto-callout success"><strong>Provisioning สำเร็จครบ 7 ขั้นตอน</strong><br>Tenant isolation smoke pass และสถานะถูกเปลี่ยนเป็น ACTIVE แบบ atomic</div><div class="proto-empty-gap"></div>' + checklist(false) + '<hr class="proto-sep"><div class="proto-field-grid"><div><div class="proto-card-title">First admin</div><p class="proto-help" style="margin-top:6px">Narin Chaiyasit<br>narin@novacare.co.th</p></div><div><div class="proto-card-title">Invitation</div><p class="proto-help" style="margin-top:6px">ส่งแล้ว · เหลือ 71 ชม. 48 นาที<br>ต้อง verify email + password + TOTP</p></div></div><div class="proto-actions" style="justify-content:flex-end;margin-top:18px"><button class="proto-btn" data-action="resend">ส่งคำเชิญอีกครั้ง</button><button class="proto-btn primary" data-action="copy-handoff">คัดลอก handoff summary</button></div></div></div>';
    }

    return '<div class="proto-shell">' + top('สร้าง tenant ใหม่', 'Guided workflow แยกข้อมูล การยืนยัน ความคืบหน้า และส่งมอบเป็นขั้นชัดเจน', '<button class="proto-btn" data-flow="list">← กลับรายการ</button>') + '<div class="a-layout">' + stepper(state.flow) + main + side + '</div></div>';
  }

  function bQueue() {
    return '<div class="b-queue"><div class="b-queue-tools"><div class="b-search"><i class="ti ti-search"></i> ค้นหา tenant หรือ request…</div><button class="proto-btn" title="Filter"><i class="ti ti-filter"></i></button></div>'
      + queue.map(function (t) {
        var selected = (state.flow === t.flow) ? ' selected' : '';
        return '<div class="b-row' + selected + '" data-flow="' + t.flow + '"><div class="b-row-head"><h3>' + esc(t.name) + '</h3>' + chip(t.status, t.status === 'warning' ? 'ACTION' : t.status.toUpperCase()) + '</div><p>' + esc(t.slug) + ' · ' + esc(t.plan) + '</p><p>' + esc(t.note) + '</p></div>';
      }).join('') + '</div>';
  }

  function bPanel() {
    if (state.flow === 'create') {
      return '<div class="b-panel"><div class="b-panel-head"><div><h2>New tenant request</h2><p class="proto-help">สร้าง draft ใน operator workspace</p></div>' + chip('neutral','DRAFT') + '</div><div class="b-panel-body">' + formFields() + '<div class="proto-actions" style="justify-content:flex-end;margin-top:18px"><button class="proto-btn" data-flow="list">Discard</button><button class="proto-btn primary" data-flow="review">Review request</button></div></div></div>';
    }
    if (state.flow === 'review') {
      return '<div class="b-panel"><div class="b-panel-head"><div><h2>Review request</h2><p class="proto-help">Nova Care Thailand</p></div>' + chip('warning','CONFIRM') + '</div><div class="b-panel-body"><div class="b-band"><div><small>Risk level</small><strong>Standard</strong></div><div><small>Identity conflicts</small><strong style="color:#047857">None</strong></div><div><small>Template</small><strong>Approved</strong></div></div><hr class="proto-sep">' + reviewSummary() + '<hr class="proto-sep"><div class="proto-callout warning"><strong>Commit point</strong><br>Server จะออก tenant UUID และ reserve slug/domain เมื่อ Operator ยืนยัน</div><div class="proto-actions" style="justify-content:flex-end;margin-top:16px"><button class="proto-btn" data-flow="create">Edit</button><button class="proto-btn primary" data-action="confirm">Confirm &amp; run</button></div></div></div>';
    }
    if (state.flow === 'failure') {
      state.currentStep = 2;
      return '<div class="b-panel"><div class="b-panel-head"><div><h2>Metro Retail Lab</h2><p class="proto-help">prv_01J8METRO · corr_8fa21</p></div>' + chip('danger','ACTION_REQUIRED') + '</div><div class="b-panel-body"><div class="proto-callout danger"><strong>Manifest digest mismatch</strong><br>Expected <span class="proto-code">sha256:3d9…</span>, received <span class="proto-code">sha256:0a1…</span>. No identity was created.</div><hr class="proto-sep">' + checklist(true,2) + '<hr class="proto-sep"><div class="proto-card-title">Recovery runbook</div><p class="proto-help" style="margin:5px 0 12px">1. Reconcile actual state · 2. Adopt verified resources · 3. Resume from current step</p><div class="proto-actions"><button class="proto-btn primary" data-action="recover">Reconcile &amp; resume</button><button class="proto-btn" data-action="retry">Retry step</button><button class="proto-btn" data-action="compensate">Safe compensate</button><button class="proto-btn danger" data-action="final-fail">FAILED_FINAL</button></div></div></div>';
    }
    if (state.flow === 'progress') {
      return '<div class="b-panel"><div class="b-panel-head"><div><h2>Aster Logistics</h2><p class="proto-help">prv_01J8ASTER · live operation log</p></div>' + chip('running','RUNNING') + '</div><div class="b-panel-body"><div class="b-band"><div><small>Elapsed</small><strong>03:42</strong></div><div><small>Lease</small><strong>healthy · 30s</strong></div><div><small>Attempt</small><strong>1 / 5</strong></div></div><hr class="proto-sep">' + checklist(true) + '<div class="proto-actions" style="justify-content:flex-end"><button class="proto-btn" data-action="simulate-failure">Inject failure</button><button class="proto-btn primary" data-action="next-step">Advance mock</button></div></div></div>';
    }
    if (state.flow === 'handoff') {
      state.currentStep = 7;
      return '<div class="b-panel"><div class="b-panel-head"><div><h2>Northstar Clinic</h2><p class="proto-help">Tenant <span class="proto-code">tnt_01J8NORTH</span></p></div>' + chip('success','ACTIVE') + '</div><div class="b-panel-body"><div class="proto-callout success"><strong>Ready for customer handoff</strong><br>ทุก resource ผ่าน verified adoption และ isolation smoke</div><hr class="proto-sep"><div class="b-band"><div><small>Invitation</small><strong style="color:#047857">Accepted</strong></div><div><small>TOTP</small><strong style="color:#047857">Enrolled</strong></div><div><small>Last login</small><strong>วันนี้ 10:42</strong></div></div><hr class="proto-sep">' + checklist(true) + '<div class="proto-actions" style="justify-content:flex-end"><button class="proto-btn" data-action="resend">Resend invite</button><button class="proto-btn primary" data-action="copy-handoff">Copy handoff</button></div></div></div>';
    }
    return '<div class="b-panel"><div class="b-panel-head"><div><h2>Operator queue</h2><p class="proto-help">เลือก tenant ด้านซ้าย หรือเริ่มคำขอใหม่</p></div>' + chip('neutral','4 ITEMS') + '</div><div class="b-panel-body"><div class="proto-grid-4" style="grid-template-columns:repeat(2,1fr)"><div class="proto-card proto-metric"><span>Running</span><strong>1</strong></div><div class="proto-card proto-metric"><span>Action required</span><strong style="color:#be123c">1</strong></div><div class="proto-card proto-metric"><span>Invite pending</span><strong style="color:#b45309">2</strong></div><div class="proto-card proto-metric"><span>Completed today</span><strong style="color:#047857">6</strong></div></div><div class="proto-callout info" style="margin-top:14px"><strong>Keyboard-first operations</strong><br>แนวทางนี้เหมาะเมื่อ Operator ต้องสลับตรวจหลาย request โดยไม่ออกจากหน้า</div></div></div>';
  }

  function variantB() {
    return '<div class="proto-shell"><div class="b-shell"><div class="b-command"><div><h1>D-Contact Provisioning Desk</h1><p>internal only · operator queue · durable workflow</p></div><div class="proto-actions"><button class="proto-btn" data-flow="failure"><i class="ti ti-alert-triangle"></i>1 action required</button><button class="proto-btn primary" data-flow="create"><i class="ti ti-plus"></i>New request</button></div></div><div class="b-workspace">' + bQueue() + bPanel() + '</div></div></div>';
  }

  function cBoard() {
    var cols = [
      ['DRAFT', [{name:'Nova Care Thailand',meta:'พร้อมตรวจสอบ',flow:'review',status:'neutral'}]],
      ['PROVISIONING', [{name:'Aster Logistics',meta:'step 4 / 7 · first admin',flow:'progress',status:'running'}]],
      ['NEEDS ACTION', [{name:'Metro Retail Lab',meta:'manifest digest mismatch',flow:'failure',status:'danger'}]],
      ['HANDOFF', [{name:'Northstar Clinic',meta:'invite accepted · ACTIVE',flow:'handoff',status:'success'},{name:'Blue River Foods',meta:'invite pending · 26h left',flow:'handoff',status:'warning'}]]
    ];
    return '<div class="c-board">' + cols.map(function (col) {
      return '<div class="c-column"><div class="c-column-head"><span>' + col[0] + '</span><span class="c-count">' + col[1].length + '</span></div>'
        + col[1].map(function (item) { return '<div class="c-ticket" data-flow="' + item.flow + '"><h3>' + item.name + '</h3><p>' + item.meta + '</p><div class="c-ticket-foot">' + chip(item.status,item.status === 'danger' ? 'ACTION' : item.status.toUpperCase()) + '<span class="proto-help">เปิด →</span></div></div>'; }).join('')
        + '</div>';
    }).join('') + '</div>';
  }

  function cDock() {
    if (state.flow === 'create') {
      return '<div class="c-dock"><div class="c-dock-head"><div><h2>Launch new tenant</h2><p>สร้าง onboarding card ใหม่จาก command dock</p></div><button class="proto-btn ghost" data-flow="list">ปิด</button></div><div class="c-dock-body"><div>' + formFields(true) + '</div><div><div class="proto-callout"><strong>สิ่งที่จะถูกสร้าง</strong><br>Tenant record, Keycloak Organization, pinned plan snapshot, inactive operational baseline, first admin และ 72-hour invitation</div><div class="proto-callout" style="margin-top:10px"><strong>Guardrails</strong><br>Identity fields immutable หลัง submit · no credentials · readiness gate บังคับครบ</div><div class="proto-actions" style="justify-content:flex-end;margin-top:14px"><button class="proto-btn primary" data-flow="review">Review launch</button></div></div></div></div>';
    }
    if (state.flow === 'review') {
      return '<div class="c-dock"><div class="c-dock-head"><div><h2>Launch review · Nova Care Thailand</h2><p>ตรวจ identity และ payload ก่อน commit point</p></div>' + chip('warning','CONFIRM') + '</div><div class="c-dock-body"><div>' + reviewSummary() + '</div><div><div class="proto-callout"><strong>Operator acknowledgement</strong><br>การยืนยันจะ reserve <span class="proto-code">nova-care</span> และ <span class="proto-code">novacare.co.th</span>; cancel/final failure เก็บ tombstone 30 วัน</div><div class="proto-actions" style="justify-content:flex-end;margin-top:14px"><button class="proto-btn" data-flow="create">แก้ไข</button><button class="proto-btn primary" data-action="confirm">Launch provisioning</button></div></div></div></div>';
    }
    if (state.flow === 'failure') {
      state.currentStep = 2;
      return '<div class="c-dock"><div class="c-dock-head"><div><h2>Recovery station · Metro Retail Lab</h2><p>ACTION_REQUIRED · corr_8fa21</p></div>' + chip('danger','BLOCKED') + '</div><div class="c-dock-body"><div><div class="proto-callout danger"><strong>Manifest digest mismatch</strong><br>หยุดก่อน identity creation · safe to reconcile</div><div class="proto-actions" style="margin-top:12px"><button class="proto-btn primary" data-action="recover">Reconcile &amp; resume</button><button class="proto-btn" data-action="retry">Retry</button><button class="proto-btn" data-action="compensate">Compensate</button><button class="proto-btn danger" data-action="final-fail">FAILED_FINAL</button></div></div><div>' + checklist(true,2) + '</div></div></div>';
    }
    if (state.flow === 'progress') {
      return '<div class="c-dock"><div class="c-dock-head"><div><h2>Live run · Aster Logistics</h2><p>lease healthy · attempt 1/5 · elapsed 03:42</p></div>' + chip('running','RUNNING') + '</div><div class="c-dock-body"><div>' + checklist(true) + '</div><div><div class="proto-callout"><strong>Current operation</strong><br>สร้าง first admin identity และตรวจ platform-wide email uniqueness</div><div class="proto-actions" style="margin-top:12px"><button class="proto-btn" data-action="simulate-failure">จำลอง failure</button><button class="proto-btn primary" data-action="next-step">Advance mock</button></div></div></div></div>';
    }
    if (state.flow === 'handoff') {
      state.currentStep = 7;
      return '<div class="c-dock"><div class="c-dock-head"><div><h2>Handoff station · Northstar Clinic</h2><p>Tenant ACTIVE · readiness passed</p></div>' + chip('success','READY') + '</div><div class="c-dock-body"><div><div class="proto-callout success"><strong>ส่งมอบได้</strong><br>First admin accepted invitation, verified email, set password และเปิด TOTP แล้ว</div><div class="proto-actions" style="margin-top:12px"><button class="proto-btn" data-action="resend">Resend invite</button><button class="proto-btn primary" data-action="copy-handoff">Copy handoff summary</button></div></div><div>' + checklist(true) + '</div></div></div>';
    }
    return '<div class="c-dock"><div class="c-dock-head"><div><h2>Mission control</h2><p>เลือก card เพื่อเปิด runbook หรือสร้าง tenant ใหม่</p></div>' + chip('neutral','4 LANES') + '</div><div class="c-dock-body"><div class="proto-callout"><strong>Board-first mental model</strong><br>Operator เห็นคอขวดและงานที่ต้องตัดสินใจก่อน เหมาะกับทีมที่ดูหลาย onboarding พร้อมกัน</div><div class="proto-actions" style="justify-content:flex-end"><button class="proto-btn primary" data-flow="create"><i class="ti ti-rocket"></i>Launch tenant</button></div></div></div>';
  }

  function variantC() {
    return '<div class="proto-shell"><div class="c-shell"><div class="c-hero"><div><div class="proto-eyebrow">TENANT LAUNCH CONTROL</div><h1>Onboarding runway</h1><p>เห็นทุก tenant ตาม lifecycle และเปิด recovery runbook ได้จาก board</p></div><div class="proto-actions"><button class="proto-btn" data-flow="failure"><i class="ti ti-alert-triangle"></i>1 needs action</button><button class="proto-btn primary" data-flow="create"><i class="ti ti-rocket"></i>Launch tenant</button></div></div>' + cBoard() + cDock() + '</div></div>';
  }

  function switcher() {
    return '<div class="prototype-switcher" role="navigation" aria-label="Prototype variants"><button data-variant-prev aria-label="Previous variant">←</button><div class="prototype-switcher-label"><strong>' + state.variant + ' · ' + variantNames[state.variant] + '</strong><small>ใช้ปุ่ม ← → หรือคลิกเพื่อสลับแบบ</small></div><button data-variant-next aria-label="Next variant">→</button></div>';
  }

  function setUrl() {
    var next = new URL(window.location.href);
    next.searchParams.set('variant', state.variant);
    next.searchParams.set('flow', state.flow);
    window.history.replaceState({}, '', next);
  }

  function render() {
    var main = document.querySelector('main');
    if (!main) return;
    main.innerHTML = state.variant === 'A' ? variantA() : state.variant === 'B' ? variantB() : variantC();
    var old = document.querySelector('.prototype-switcher');
    if (old) old.remove();
    document.body.insertAdjacentHTML('beforeend', switcher());
    setUrl();
  }

  function cycle(delta) {
    var index = variants.indexOf(state.variant);
    state.variant = variants[(index + delta + variants.length) % variants.length];
    render();
  }

  function notify(message) {
    var old = document.querySelector('.proto-toast');
    if (old) old.remove();
    var toast = document.createElement('div');
    toast.className = 'proto-toast';
    toast.innerHTML = '<i class="ti ti-check" style="color:#34d399"></i>' + esc(message);
    document.body.appendChild(toast);
    window.setTimeout(function () { toast.remove(); }, 2600);
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-flow],[data-action],[data-variant-prev],[data-variant-next]');
    if (!target) return;
    if (target.hasAttribute('data-variant-prev')) return cycle(-1);
    if (target.hasAttribute('data-variant-next')) return cycle(1);
    if (target.dataset.flow) {
      state.flow = target.dataset.flow;
      if (state.flow === 'progress') state.currentStep = 3;
      render();
      return;
    }
    var action = target.dataset.action;
    if (action === 'confirm') { state.flow = 'progress'; state.currentStep = 1; render(); notify('สร้าง request แล้ว · idempotency key ถูกบันทึก'); }
    if (action === 'next-step') { state.currentStep += 1; if (state.currentStep >= steps.length) state.flow = 'handoff'; render(); }
    if (action === 'simulate-failure') { state.flow = 'failure'; state.currentStep = 2; render(); }
    if (action === 'recover') { state.flow = 'progress'; state.currentStep = 3; render(); notify('Reconcile พบ resource เดิมและ resume อย่างปลอดภัย'); }
    if (action === 'retry') { notify('Retry current step ถูกจัดคิวแล้ว · attempt 2/5'); }
    if (action === 'compensate') { notify('Safe compensation ต้องยืนยันซ้ำใน production'); }
    if (action === 'final-fail') { notify('Prototype: แสดง confirmation + reason ก่อน FAILED_FINAL'); }
    if (action === 'resend') { notify('ส่ง invitation ใหม่แล้ว · เริ่มอายุ 72 ชั่วโมง · 1/3 ครั้งในชั่วโมงนี้'); }
    if (action === 'copy-handoff') { notify('คัดลอก handoff summary แล้ว (mock)'); }
  });

  document.addEventListener('keydown', function (event) {
    var tag = document.activeElement && document.activeElement.tagName;
    var editable = document.activeElement && document.activeElement.isContentEditable;
    if (editable || ['INPUT','TEXTAREA','SELECT'].indexOf(tag) >= 0) return;
    if (event.key === 'ArrowLeft') cycle(-1);
    if (event.key === 'ArrowRight') cycle(1);
  });

  var nav = document.querySelector('aside nav');
  if (nav) nav.innerHTML = '<div class="section-label">Platform operations</div><a class="nav-item p-nav active"><i class="ti ti-building-community"></i>Tenant onboarding<span class="badge-new">PROTO</span></a><a class="nav-item p-nav"><i class="ti ti-history"></i>Audit trail</a><a class="nav-item p-nav"><i class="ti ti-users"></i>Operators</a>';
  var footer = document.querySelector('aside > div:last-child p');
  if (footer) footer.textContent = 'ops@d-contact.io · PLATFORM_OPERATOR';
  render();
})();
