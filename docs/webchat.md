# Web Chat รอบแรก (#1044)

ลูกค้าเปิด widget บนเว็บของ tenant แล้วคุยกับ Agent: พิมพ์ข้อความ → เข้าคิว → Agent กดรับใน Workspace → คุยโต้ตอบ → ปิดงานพร้อมบันทึกผล/โน้ต → อ่านบทสนทนาย้อนหลังได้ตามสิทธิ์

ขอบเขตที่ owner ตัดสินเมื่อ 27 พฤศจิกายน 2569 อยู่ใน [#1044](https://github.com/Kitti-Nualsalee/dcontact/issues/1044) แบบหน้าจออยู่ใน [plans/1044-ux.md](plans/1044-ux.md)
ทำตาม [ADR-001](adr/001-unified-interaction-model.md) (Router เดียว), [ADR-023](adr/023-conversation-vs-interaction.md) และ [ADR-024](adr/024-message-delivery-media.md)

## เปิดใช้

1. ตั้ง `WEBCHAT=on` ที่ API ค่าเริ่มต้นปิด: route ของ widget, ของ Agent และของการตั้งค่าไม่มี (404), เมนูไม่แสดง และไม่มีรอบเบื้องหลัง ค่าที่ไม่ใช่ `on`/`off` ทำให้ API ไม่ start
2. apply migration `20261127100000_webchat_round_one` และ `pnpm db:rls`
3. Admin ของ tenant ตั้งค่าที่ Console **การเชื่อมต่อ → ช่องทางลูกค้า → Web Chat**: เลือกคิว ใส่โดเมนที่อนุญาต แล้วเปิดใช้งาน
4. วางโค้ดฝังในเว็บของ tenant หรือกด "เปิดหน้าทดลอง" เพื่อลองโดยไม่ต้องมีเว็บ

```html
<script
  src="https://<host ของ D-Contact>/api/v1/webchat/widget.js"
  data-tenant="<tenant id>"
  data-widget="<widget id>"
  async
></script>
```

flag ปิดแล้ว tenant เดิมไม่เห็นอะไรเปลี่ยน ยกเว้นสองเรื่องที่มีผลกับทุก deployment หลัง migrate: ตาราง `conversations`/`messages` ถูกปรับให้ตรง Prisma model (ไม่มีโค้ดเดิมใช้) และหน้าประวัติมีคอลัมน์ช่องทาง

## การทำงาน

| ส่วน | ที่อยู่ | หน้าที่ |
| --- | --- | --- |
| กฎจ่ายงาน | `apps/router/src/webchat-routing.ts` | เลือก Agent, offer และ timeout, รับงาน, จบแชท, สถานะ Agent |
| ช่องทาง | `apps/api/src/webchat-service.ts` | session ของผู้เยี่ยมชม, ข้อความ, งานของ Agent, รอบเบื้องหลังทุก 1 วินาที |
| API สาธารณะ | `apps/api/src/webchat-public-api.ts` | `/api/v1/webchat/*` สำหรับ widget ไม่ต้อง login |
| API ของ Agent และ Admin | `apps/api/src/webchat-agent-api.ts` | `/api/v1/workspace/agent/webchat`, `/api/v1/webchat/widget` |
| Widget | `packages/webchat-widget` | `widget.js` (ตัวโหลดบนเว็บ tenant) และหน้าต่างแชทใน iframe |
| Workspace | `apps/workspace/src/webchat/` | การ์ด offer, ห้องแชท, สรุปผล |

### สถานะของงานแชท

`QUEUED` (ข้อความแรกของลูกค้า) → `ASSIGNED` (offer ให้ Agent) → `ACTIVE` (Agent กดรับ) → `WRAPUP` (จบแชท) → `COMPLETED` (บันทึกผลและโน้ต)
แชทที่จบก่อนมี Agent รับเป็น `ABANDONED`

- งานถูกสร้างเมื่อลูกค้าส่งข้อความแรก การเปิด widget เฉย ๆ ไม่สร้างอะไร
- ถ้าไม่มี Agent ของคิวที่ออนไลน์อยู่ (สถานะ Ready หรือกำลังทำงาน) widget แจ้งและไม่เปิดงานใหม่
- offer ที่ไม่กดรับภายใน offer timeout ของคิว (ค่าของ tenant ถ้าคิวไม่ได้ตั้ง) กลับเข้าคิว และ Agent คนเดิมไม่ได้ offer ของแชทนั้นอีก 60 วินาที
- ลูกค้าที่รออยู่แล้วหน้าเว็บหยุดถามเกิน 2 นาที ถือว่าออกไปแล้ว งานเป็น `ABANDONED`
- แชทที่กำลังคุยปิดเองเมื่อ Agent ตอบล่าสุดแล้วลูกค้าไม่ตอบเกินเวลาที่ตั้ง (ค่าเริ่มต้น 10 นาที) ลูกค้าที่ยังรอคำตอบจาก Agent ไม่ถูกปิดด้วยเหตุนี้

### เพดานห้องและการไม่ปนกับ Voice

- Agent ถือได้ไม่เกิน `maxChatsPerAgent` ของ widget (ค่าเริ่มต้น 3) นับ offer, ห้องที่คุยอยู่ และห้องที่รอบันทึกผล
- ระหว่างถือแชท state log ของ Agent เป็น `RESERVED`/`BUSY`/`ACW` พร้อมเหตุผล `webchat` Voice router จ่ายสายให้เฉพาะ Agent ที่ `AVAILABLE` จึงไม่จ่ายสายให้ Agent ที่มีแชท และแชทไม่ถูก offer ให้ Agent ที่มีสาย
- Agent เปลี่ยนเป็น Not Ready เองไม่ได้ระหว่างมีแชท ให้ตั้ง "สถานะหลังจบงาน": ระบบหยุดส่งแชทใหม่ และเปลี่ยนสถานะให้เมื่อบันทึกผลห้องสุดท้าย
- คิวที่ผูกทีม Agent ต้องอยู่ทีมนั้นและมีทักษะครบตามคิว เหมือน Voice

## ทำไม widget ไม่ใช้ `@d-contact/ui-react`

widget ฝังบนเว็บของ tenant ทุกหน้า จึงต้องเล็กและไม่ชนกับ CSS หรือ JavaScript ของเว็บนั้น: ตัวโหลด (`widget.js`) วาดแค่ปุ่มลอยด้วย inline style และหน้าต่างแชทอยู่ใน iframe จาก origin ของ D-Contact ทั้งสองส่วนเขียนด้วย DOM ล้วน ไม่มี React เพื่อให้ไฟล์เล็ก (ราว 12 KB และ 23 KB) และไม่ต้องโหลด font หรือ library จากภายนอก
ภาษาภาพยังมาจากที่เดียวกับแอป: `frame.css` ใช้ `var(--dc-*)` ของ `@d-contact/ui` ที่ถูกต่อเข้าไฟล์ตอน build และตัวโหลดอ่านค่า token จาก `tokens.generated.ts` ส่วนบทสนทนาใน Workspace และ Console ใช้ `ChatTranscript` ของ `ui-react`

## ความปลอดภัยของ widget

- ผู้เยี่ยมชมไม่ระบุตัว ระบุ tenant และ widget ใน URL และพิสูจน์ session ด้วย secret ที่ server เก็บเฉพาะ SHA-256
- โดเมนที่ฝังได้ถูกบังคับโดย browser: หน้าต่างแชทตอบ `Content-Security-Policy: frame-ancestors` ตามรายการโดเมนของ widget และตัวโหลดจะวาดปุ่มเมื่อ API ยืนยัน origin แล้วเท่านั้น
- script ยังเรียก API ตรงได้ จึงมี rate limit ต่อ address และต่อ widget (ในหน่วยความจำของ process) และเพดานแชทที่รอได้ 200 ต่อคิว
- widget ที่ปิดอยู่, ไม่มี และ tenant ที่ไม่รู้จัก ตอบ 404 เหมือนกัน
- ทุก query ของ API ทำใน transaction ของ tenant ภายใต้ RLS
- ข้อความยาวได้ 2,000 ตัวอักษร แชทหนึ่งมีได้ 500 ข้อความ

## สิทธิ์อ่านบทสนทนา

ใช้กฎเดียวกับ Voice ([team-history.md](team-history.md), #859, #986)

| ผู้ใช้ | อ่านได้ |
| --- | --- |
| Agent | แชทที่ตัวเองรับ ระหว่างคุยใน Workspace และย้อนหลังใน "ประวัติงานของฉัน" |
| Supervisor | แชทที่ทีมปัจจุบันของตนรับจริง (หลักฐานทีมถูกเขียนตอน Agent กดรับ) |
| Admin | ทุกทีมใน tenant |

ของทีมอื่น tenant อื่น และที่ไม่มี ตอบ 404 เหมือนกัน แชทที่ไม่มี Agent รับไม่มีหลักฐานทีม จึงไม่แสดงในหน้าประวัติ (ข้อมูลยังอยู่ในฐาน)

## ข้อจำกัดของรอบแรก

- ตัวแจ้งเตือนแบบ realtime อยู่ในหน่วยความจำของ API ตัวเดียว ถ้ารัน API หลายตัว การอัปเดตจะมาจากการอ่านซ้ำตามรอบ (Workspace 4 วินาที, widget 25 วินาที) แทน
- Agent ต้องเป็น Ready ซึ่งยังต้องมีโทรศัพท์ (SIP) พร้อม เหมือนการรับสาย
- Agent ที่ปิดหน้า Workspace ระหว่างมีแชท: แชทยังอยู่กับ Agent คนนั้นจนกลับมาปิดเอง ลูกค้ากดจบแชทเองได้
- ชื่อ Agent ไม่แสดงให้ลูกค้า (แสดงเป็น "เจ้าหน้าที่")
- บน Safari ที่ปิด storage ของ iframe การรีเฟรชกลับห้องเดิมใช้สำเนา session ที่เก็บไว้ในหน้าเว็บของ tenant
- ยังไม่มี: ไฟล์แนบ, typing indicator, ข้อความสำเร็จรูป, bot, ฟอร์มก่อนแชท, การโอนแชท, รับสายระหว่างมีแชท, ฝากข้อความ, เวลาทำการ, ปรับหน้าตา widget, หลาย widget ต่อ tenant, บทสนทนาในหน้าลูกค้า Cus360, Supervisor ดูแชทสด และ QM ของแชท

## ทดสอบ

```sh
pnpm --filter @d-contact/router exec tsx --test src/webchat-routing.integration.ts
pnpm --filter @d-contact/api exec tsx --test src/webchat.integration.ts src/webchat-hub.test.ts
pnpm --filter @d-contact/webchat-widget test
pnpm --filter @d-contact/workspace exec tsx --test src/webchat/*.test.ts
pnpm --filter @d-contact/workspace exec playwright test e2e/webchat.spec.ts --project=chromium
```

สองคำสั่งแรกต้องใช้ PostgreSQL แยกที่ migrate และ `db:rls` แล้ว ตั้ง `DATABASE_URL` และ `APPLICATION_DATABASE_URL` (role `dcontact_app` ไม่ bypass RLS) ชุด browser จำลอง API ด้วย route จึงยืนยันเฉพาะหน้าจอ

## ทดลองทั้งเส้นบน dev

ใช้ stack ของ `scripts/sales-demo-stack.mjs` (API 3000, Workspace 5173, Console 5174) กับฐานแยก และเปิด `WEBCHAT=on`

```sh
pnpm infra:up
SALES_DEMO_DATABASE=dcontact_webchat_demo WEBCHAT=on node scripts/sales-demo-stack.mjs
pnpm --filter @d-contact/workspace exec playwright test --config playwright.webchat-trial.config.ts
```

- ถ้าพอร์ต 5433 ของเครื่องถูกใช้อยู่ ให้เปิด PostgreSQL ของ dev ที่พอร์ตอื่นแล้วส่ง `DCONTACT_DEV_POSTGRES_PORT=<พอร์ต>` ให้สคริปต์
- ชุดทดลอง (`apps/workspace/e2e-real/webchat-trial.spec.ts`) เดิน: Admin เปิด widget ใน Console → ผู้เยี่ยมชมพิมพ์จากหน้าทดลอง → Agent รับใน Workspace → คุยสองทางโดยไม่รีเฟรช → รีเฟรชหน้าผู้เยี่ยมชมแล้วกลับห้องเดิม → ผู้เยี่ยมชมคนที่สองเป็นห้องที่สอง → ลูกค้าจบห้องหนึ่ง Agent จบอีกห้อง → บันทึกผลทั้งสอง → Admin อ่านบทสนทนาในประวัติงานของทีม
- เป็นเครื่องมือทดลอง ไม่ใช่หลักฐานของ identity: tenant ถูก seed โดยสคริปต์ และโทรศัพท์ของ Agent ใช้ fake media

