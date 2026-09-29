# คู่มือฝัง dphone ในระบบของคุณ

dphone คือโทรศัพท์ของ agent ใน D-Contact ฝังในเว็บของคุณ เช่น CRM ได้ ในหน้าเดียว agent จะทำได้ทั้ง:

- รับสาย
- เห็นข้อมูลลูกค้าเมื่อมีสายเข้า (screen-pop)
- กดโทรจากเบอร์ในระบบของคุณ (click-to-call)
- บันทึกกิจกรรมหลังจบสาย

คู่มือนี้ใช้กับ postMessage API **v1** และ `<dphone-launcher>` **1.x**

- [เริ่มต้นใช้งาน](#เริ่มต้นใช้งาน)
- [ข้อกำหนดของหน้า host](#ข้อกำหนดของหน้า-host)
- [API reference v1](#api-reference-v1)
- [พฤติกรรมที่ควรรู้](#พฤติกรรมที่ควรรู้)
- [การแก้ปัญหา](#การแก้ปัญหา)
- [เวอร์ชันและ changelog](#เวอร์ชันและ-changelog)

## เริ่มต้นใช้งาน

1. ผู้ดูแล tenant (ADMIN) เปิด Console › Integrations › **dphone embedding**
2. เพิ่ม origin ของระบบคุณ เช่น `https://crm.example.com` โดยใส่เฉพาะ `scheme://host[:port]` ไม่มี path และได้สูงสุด 10 origin
3. ให้ D-Contact เปิด flag `dphone.embed.enabled` ของ tenant (ค่าเริ่มต้นปิด) และ tenant ต้องมี plan ที่มี `modules.api.cti`
4. คัดลอก snippet จากหน้าเดียวกันไปวางในหน้าเว็บของคุณ:

```html
<!-- Content-Security-Policy ของหน้า host: script-src https://dphone.example.com; frame-src https://dphone.example.com -->
<script type="module" src="https://dphone.example.com/embed/v1/dphone-launcher.js"></script>
<dphone-launcher tenant="acme" style="width: 360px; height: 640px"></dphone-launcher>
```

5. เปิดหน้าเว็บ agent กด **เข้าสู่ระบบ** ใน dphone ระบบจะเปิดหน้าต่าง login ของ D-Contact แล้วกด **ตรวจอุปกรณ์เสียง** เพื่อเริ่มรับสาย

ตัวอย่างหน้า host ที่ใช้ได้จริงอยู่ที่ [`examples/dphone-host/index.html`](../../examples/dphone-host/index.html) เป็น HTML ธรรมดาที่ไม่ใช้ framework

```js
const dphone = document.querySelector('dphone-launcher');

dphone.addEventListener('screenpop', (event) => openCustomer(event.detail));

dphone.addEventListener('activity', (event) => {
  // launcher ส่ง ack ให้เองเมื่อ promise นี้สำเร็จ ถ้าล้ม dphone จะส่งกิจกรรมเดิมซ้ำ
  event.waitUntil(saveActivity(event.detail));
});

const result = await dphone.call('0812345678', { contactId: 'CIF-0001' });
// agent ต้องกดโทรเองใน dphone แล้ว result จะเป็นผลสุดท้าย เช่น { status: 'blocked', reasonCode: 'QUIET_HOURS' }
```

## ข้อกำหนดของหน้า host

| ข้อกำหนด | รายละเอียด                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Browser  | Chrome หรือ Edge บน desktop สองเวอร์ชันล่าสุด                                                           |
| HTTPS    | หน้า host ต้องเป็น `https://` (`http://localhost` ใช้ได้เฉพาะตอนพัฒนา)                                  |
| Origin   | origin ของหน้า host ต้องตรงกับที่อยู่ใน allowlist ทุกตัวอักษร รวม port                                  |
| CSP      | ถ้าหน้า host มี Content-Security-Policy ให้อนุญาต origin ของ dphone ทั้งใน `script-src` และ `frame-src` |
| ไมโครโฟน | iframe ต้องมี `allow="microphone; autoplay"` (`<dphone-launcher>` ใส่ให้แล้ว)                           |
| Popup    | login เปิดเป็นหน้าต่าง popup ถ้า iframe ถูกห่อด้วย sandbox ต้องมี `allow-popups` (launcher ใส่ให้แล้ว)  |
| ขนาด     | แนะนำกว้าง 360 px สูง 640 px ขึ้นไป                                                                     |

dphone ถูกโหลดจาก `https://<dphone-origin>/dphone/embed?tenant=<alias>` ซึ่งส่ง `frame-ancestors` ตาม allowlist ของ tenant ถ้า origin ไม่อยู่ในรายการ browser จะไม่แสดง dphone และ dphone จะไม่คุยกับหน้านั้น

## API reference v1

### `<dphone-launcher>`

| Attribute | ความหมาย                                                                         |
| --------- | -------------------------------------------------------------------------------- |
| `tenant`  | alias ของ tenant (บังคับ)                                                        |
| `origin`  | origin ของ dphone (ไม่บังคับ ค่าเริ่มต้นคือ origin ของไฟล์ `dphone-launcher.js`) |
| `label`   | ชื่อของ iframe สำหรับ screen reader (ค่าเริ่มต้น `dphone`)                       |

| Method / property              | ความหมาย                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `call(number, { contactId? })` | กรอกเบอร์ใน dphone ให้ agent กดโทรเอง คืน Promise ของ `dphone.call.result` ที่ไม่ใช่ `prefilled` |
| `capabilities`                 | `{ screenPop, clickToCall, activity }` หลังได้ `ready` (ก่อนนั้นเป็น `null`)                     |

| Event         | `event.detail`       | หมายเหตุ                                                              |
| ------------- | -------------------- | --------------------------------------------------------------------- |
| `ready`       | `dphone.ready`       | dphone พร้อมคุยกับหน้านี้ (คำสั่ง `call()` ก่อนหน้านี้จะถูกส่งตอนนี้) |
| `screenpop`   | `dphone.screenpop`   | เมื่อมีสายเข้าและเมื่อรับสาย                                          |
| `activity`    | `dphone.activity`    | เมื่อจบ wrap-up ใช้ `event.waitUntil(promise)` เพื่อเลื่อน ack        |
| `callresult`  | `dphone.call.result` | ทุกสถานะของ `call()` รวม `prefilled`                                  |
| `dphoneerror` | `dphone.error`       | เช่น `unsupported_version`                                            |

### ข้อความ postMessage v1

ทุกข้อความมี `v: 1` และ `type` schema เต็มอยู่ที่ `@d-contact/dphone-embed/schema/v1.json` ถ้าไม่ใช้ launcher ต้องตรวจเองว่า `event.origin` เป็น origin ของ dphone และ `event.source` เป็น iframe นั้น แล้วส่งกลับด้วย `targetOrigin` แบบ exact (ห้ามใช้ `*`)

| จาก → ถึง     | `type`                | field หลัก                                                                                                                                  |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| dphone → host | `dphone.ready`        | `capabilities`, `screenPopLevel`                                                                                                            |
| dphone → host | `dphone.screenpop`    | `requestId`, `level`, `interactionId`, `policyVersion`, `decisionId`, `reasonCode?` และ field ตามระดับ (ดูตารางถัดไป)                       |
| dphone → host | `dphone.call.result`  | `requestId`, `status`, `blocked`, `reasonCode?`, `retryAt?`, `decisionId?`                                                                  |
| dphone → host | `dphone.activity`     | `requestId`, `interactionId`, `direction`, `startedAt`, `endedAt`, `durationSeconds`, `disposition?`, `wrapUpCode?`, `queue?`, `contactId?` |
| dphone → host | `dphone.error`        | `code` (`unsupported_version` \| `invalid_message`), `supportedVersions`, `requestId?`                                                      |
| host → dphone | `dphone.call`         | `requestId`, `number`, `contactId?`                                                                                                         |
| host → dphone | `dphone.activity.ack` | `interactionId`, `requestId?`                                                                                                               |

### ระดับข้อมูลของ screen-pop

ผู้ดูแลตั้งระดับต่อ origin ใน Console การตั้งหรือเปลี่ยนระดับต้องระบุเหตุผลและถูกบันทึกลง audit ค่าเริ่มต้นคือ **ปิด**

| ระดับ     | field ที่ได้                                                                                 |
| --------- | -------------------------------------------------------------------------------------------- |
| `off`     | ไม่มี `dphone.screenpop` เลย                                                                 |
| `ids`     | `interactionId`, `contactId`, `direction`, `queue`, `callState` (ไม่มีข้อมูลส่วนบุคคลโดยตรง) |
| `contact` | ทุก field ของ `ids` + `ani`, `dnis`, `displayName`                                           |
| `custom`  | ยังไม่เปิดให้ใช้ (รอกำหนดรายการ field)                                                       |

server ลดระดับให้เองทุกครั้งตาม Contact Governance และแจ้งเหตุผลใน `reasonCode`:

| `reasonCode`               | เกิดเมื่อ                                       | ได้เหลือ                 |
| -------------------------- | ----------------------------------------------- | ------------------------ |
| `TEAM_SEGMENT_NOT_ALLOWED` | ทีมของ agent ไม่มีสิทธิ์ดูกลุ่มลูกค้านี้        | `interactionId` เท่านั้น |
| `CONTACT_RESTRICTED`       | ลูกค้ามี objection หรือข้อจำกัดการเปิดเผยข้อมูล | ไม่เกินระดับ `ids`       |

ถ้ายังระบุลูกค้าไม่ได้ เบอร์ผู้โทร (`ani`) จะส่งเฉพาะเมื่อตั้งระดับ `contact`

### ผลของ click-to-call (`dphone.call.result`)

| `status`       | ความหมาย                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prefilled`    | กรอกเบอร์ใน dphone แล้ว รอ agent กดโทร                                                                                 |
| `dialing`      | agent กดโทรและผ่านการตรวจแล้ว                                                                                          |
| `blocked`      | Contact Governance ไม่อนุญาต (`BLOCK`, `DEFER` ซึ่งมี `retryAt` หรือ `REVIEW` ที่ต้องได้รับการอนุมัติ) — **ไม่โทรออก** |
| `cancelled`    | agent ยกเลิก หรือมีคำขอใหม่มาแทน (`REPLACED`)                                                                          |
| `rate_limited` | ส่งคำขอถี่เกินไป (ฝั่ง iframe 5 ครั้งต่อ 10 วินาที และฝั่ง server 10 ครั้งต่อนาทีต่อ agent)                            |
| `unavailable`  | dphone ยังไม่พร้อม (`NOT_SIGNED_IN`, `BUSY`) หรือยังไม่เปิดการโทรออก (`OUTBOUND_VOICE_NOT_ENABLED`)                    |

ผลทุกแบบไม่มีข้อมูลส่วนบุคคล หน้า host สั่งโทรออกเองไม่ได้ agent ต้องกดโทรใน dphone ทุกครั้ง

> ตอนนี้ click-to-call ตรวจสิทธิ์ได้ครบ แต่การโทรออกจริงยังไม่เปิด (รอ Voice Delivery Gate) คำขอที่ผ่านการตรวจจึงได้ `unavailable` + `OUTBOUND_VOICE_NOT_ENABLED`

## พฤติกรรมที่ควรรู้

- **Login:**
  - dphone ใช้หน้าต่าง popup ที่เปิดเมื่อ agent กดปุ่ม ไม่มีการ login เงียบผ่าน iframe
  - token อยู่ใน dphone เท่านั้น ไม่มีการส่ง token ให้หน้า host
  - ออกจากระบบได้เฉพาะตอนที่ไม่มีสายหรือ wrap-up ค้างอยู่
- **Reload หน้า host:** agent ยังอยู่ในระบบ และกิจกรรมที่ยังไม่ได้ ack จะถูกส่งซ้ำ
- **Session หมดหรือถูกเพิกถอน:**
  - สายที่คุยอยู่ไม่หลุด dphone แสดงแถบให้ login ใหม่ และคำสั่งที่ค้างรอจน login เสร็จ
  - ถ้าสายจบก่อน login ใหม่ agent จะถูกตั้งเป็นไม่พร้อมรับสาย
- **จุดรับงานเดียว:**
  - agent รับงานได้ที่เดียวในเวลาเดียวกัน ถ้าเปิด Workspace หรือ dphone ที่อื่นอยู่ dphone จะให้เลือก **ย้ายมาที่นี่**
  - ย้ายไม่ได้ระหว่างมีสายหรือ wrap-up
- **Ack และการส่งซ้ำ:**
  - `dphone.activity` ใช้ `interactionId` เป็น idempotency key ฝั่ง host ต้องไม่บันทึกซ้ำเมื่อได้ `interactionId` เดิม
  - ถ้าไม่ ack dphone จะส่งซ้ำเป็นช่วงห่างขึ้นเรื่อยๆ ได้แก่ 2, 5, 15, 30 และ 60 วินาที
  - ข้อความไม่มีไฟล์เสียง, transcript หรือโน้ต
- **ลบหรือปิด origin ใน Console:**
  - dphone บนหน้านั้นหยุดคุยกับหน้า host ทันที ถ้ามีสายอยู่ agent คุยต่อได้จนจบ
  - `frame-ancestors` ใหม่มีผลเมื่อโหลดหน้าใหม่ (ไม่เกิน 30 วินาที)

## การแก้ปัญหา

| อาการ                                             | สาเหตุที่พบบ่อย                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| กรอบ dphone ว่าง / browser แจ้ง `frame-ancestors` | origin ของหน้า host ไม่อยู่ใน allowlist (ตรวจ scheme, host และ port), flag `dphone.embed.enabled` ปิดอยู่ หรือ plan ไม่มี `modules.api.cti` |
| `Refused to load the script` / `frame-src`        | CSP ของหน้า host ยังไม่อนุญาต origin ของ dphone ใน `script-src` หรือ `frame-src`                                                            |
| กดเข้าสู่ระบบแล้วขึ้นว่าหน้าต่างถูกบล็อก          | browser บล็อก popup ให้อนุญาต popup ของเว็บนั้นแล้วกดอีกครั้ง หรือ sandbox ของ iframe ขาด `allow-popups`                                    |
| ตรวจอุปกรณ์เสียงไม่ผ่าน                           | iframe ไม่มี `allow="microphone"` ผู้ใช้ปฏิเสธสิทธิ์ไมค์ หรือหน้า host ไม่ใช่ HTTPS                                                         |
| ไม่ได้ `screenpop`                                | ระดับของ origin เป็น `off` (ค่าเริ่มต้น) หรือได้แค่ `interactionId` เพราะถูกลดระดับ (ดู `reasonCode`)                                       |
| ได้ `activity` ซ้ำ                                | หน้า host ไม่ได้ ack (handler ของ `waitUntil` ล้ม) ให้บันทึกแบบ idempotent ด้วย `interactionId`                                             |
| `dphoneerror` ที่มี `unsupported_version`         | ส่งข้อความที่ไม่ใช่ `v: 1`                                                                                                                  |

## เวอร์ชันและ changelog

- **URL ของ launcher:**
  - `https://<dphone-origin>/embed/v1/dphone-launcher.js` คือ alias ของ major 1 ได้ patch และ minor ใหม่อัตโนมัติ (cache 5 นาที)
  - `https://<dphone-origin>/embed/v1.0.0/dphone-launcher.js` ตรึงเวอร์ชันเต็มและไม่เปลี่ยนตลอดไป (cache 1 ปี) ใช้คู่กับ SRI ได้ ค่า `integrity` ดูได้ที่ `https://<dphone-origin>/embed/releases.json`:

```html
<script
  type="module"
  src="https://dphone.example.com/embed/v1.0.0/dphone-launcher.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
```

- **v1 เพิ่มได้อย่างเดียว:**
  - อาจมี `type` หรือ field ใหม่ แต่จะไม่ลบ ไม่เปลี่ยนความหมาย และไม่เปลี่ยน field ที่ไม่บังคับให้เป็นบังคับ
  - หน้า host ต้องไม่สนใจ `type` หรือ field ที่ไม่รู้จัก
- **v2 (ถ้ามี):** จะทำงานคู่กับ v1 อย่างน้อย 12 เดือน และแจ้ง deprecation ผ่าน changelog นี้และ Console
- **Rollback:** D-Contact ชี้ alias `v1` กลับเวอร์ชันก่อนหน้าได้ทันที หน้า host ที่ตรึงเวอร์ชันไว้ไม่ได้รับผลกระทบ

### Changelog

| เวอร์ชัน | วันที่     | รายการ                                                                                             |
| -------- | ---------- | -------------------------------------------------------------------------------------------------- |
| 1.0.0    | 2026-09-29 | `<dphone-launcher>` แรก: `call()`, event `ready`/`screenpop`/`activity`/`callresult`/`dphoneerror` |
