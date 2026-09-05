# Inbound Voice Phase 2: browser softphone กับ FreeSWITCH

- วันที่ตรวจ: 2026-09-05
- Tracker: [ยืนยัน browser softphone stack ที่ทำงานกับ FreeSWITCH](https://github.com/Kitti-Nualsalee/dcontact/issues/37)
- ขอบเขต: decision input สำหรับงานนำร่องใน browser; ไม่รวม production SIP trunk, carrier integration และ FreeSWITCH HA

## สรุปคำตอบ

Phase 2 ควรเดินต่อด้วย **SIP over WSS ผ่าน FreeSWITCH `mod_sofia` และ SIP.js full API** โดย pin เวอร์ชันที่ทดสอบจริง ไม่ใช้ Verto และไม่ใช้ `SimpleUser` เป็นแกนของ application. Router/API ยังคงเป็น authority ของ Interaction; SIP.js รับผิดชอบ SIP dialog และ media ใน tab ที่เป็น workspace leader เท่านั้น

งานนำร่องต้องพิสูจน์ WSS/TLS, microphone readiness, autoplay recovery, device change, codec negotiation, ICE configuration และการคืนสภาพแบบแยกชั้น. ห้ามสัญญาว่า reload หน้าแล้วจะกลับเข้า SIP dialog เดิมได้

## สิ่งที่มีอยู่ใน repository

- `apps/workspace` มี leader election และ WebSocket reconnect/sequence runtime แล้ว แต่ยังไม่มี React UI หรือ SIP.js dependency
- FreeSWITCH dev profile เปิด `ws-binding :5066` สำหรับ localhost แต่ยังไม่เปิด `wss-binding`
- Phase 1 มี router-owned Interaction และ telephony command/event path แล้ว จึงไม่ควรสร้าง call state authority ซ้ำใน browser

## ข้อค้นพบ

### 1. Signaling และ TLS

FreeSWITCH รองรับ SIP over WebSocket ด้วย `mod_sofia`; standard browser SIP library เช่น SIP.js register เข้ากับ Sofia profile ได้โดยไม่ต้องใช้ client protocol เฉพาะ FreeSWITCH. เอกสารทางการแยกทางเลือกนี้ออกจาก Verto และระบุ `wss-binding :7443` เป็นค่าแบบ vanilla. [FreeSWITCH: WebRTC over SIP (WSS)](https://developer.signalwire.com/freeswitch/users-and-endpoints/webrtc-sip/)

ข้อกำหนดของ Phase 2:

- dev บน localhost อาจใช้ `ws://localhost:5066` เพื่อให้วงรอบพัฒนาสั้น
- acceptance แบบ pilot ต้องรันหน้าเว็บบน HTTPS และ signaling ผ่าน `wss://` ด้วย certificate ที่ browser เชื่อถือ
- `wssUrl` ต้องมาจาก configuration/credential response ไม่ hard-code host หรือผูก tenant เข้ากับ FreeSWITCH node

### 2. SIP.js API และ version policy

`SimpleUser` จำกัด media control, รองรับทีละหนึ่งสาย, ไม่มี transfer และลดรูป DTMF; เอกสารแนะนำให้ใช้ full API เมื่อเกินกรณีพื้นฐาน. [SIP.js: Simple User](https://sipjs.com/guides/simple-user/)

release ล่าสุดที่ upstream แสดงระหว่างการตรวจคือ `0.21.2`; SessionManager มีตัวเลือกสำหรับ registration retry, reconnect และ SIP OPTIONS ping. [SIP.js releases](https://github.com/onsip/SIP.js/releases), [SessionManagerOptions](https://github.com/onsip/SIP.js/blob/main/docs/session-manager/sip.js.sessionmanageroptions.md)

ดังนั้น:

- ใช้ SIP.js full API; จะห่อ `SessionManager` หรือสร้าง adapter เองให้ตัดสินใน call-control contract
- pin exact version และมี compatibility test กับ FreeSWITCH image/version ที่ pin เช่นกัน
- ซ่อน SIP.js ไว้หลัง workspace softphone adapter เพื่อไม่ให้ SIP session object รั่วเข้า domain/UI

### 3. Media, ICE และ codec

WebRTC endpoint ต้องรองรับอย่างน้อย Opus, PCMA และ PCMU; RFC แนะนำให้เสนอ Opus ก่อน G.711 เมื่อ endpoint รองรับ wideband audio. [RFC 7874](https://www.rfc-editor.org/info/rfc7874/)

ข้อกำหนดขั้นต่ำ:

- เสนอ Opus ก่อน และคง PCMU/PCMA เป็น interoperability fallback
- assertion ของ integration test ต้องตรวจ negotiated codec และเสียงสองทาง ไม่ใช่ตรวจเพียง SIP `200 OK`
- ICE server list ต้อง configurable ต่อ environment; local-LAN demo ที่ไม่มี TURN ไม่ใช่หลักฐานว่า pilot ข้าม NAT ใช้งานได้
- acceptance ต้องแยก deterministic local media test ออกจาก headed smoke test ที่ใช้ network/อุปกรณ์จริง; เกณฑ์ Pilot-ready จะตัดสินว่าต้องมี TURN path ใน test environment หรือบันทึกเป็น deployment prerequisite

### 4. Permission, autoplay และ device lifecycle

`getUserMedia()` ใช้ได้ใน secure context และอาจล้มเหลวจาก permission, ไม่มี device, device ถูกใช้งาน หรือ constraint ไม่ตรง. `enumerateDevices()` ก็ต้องอยู่ใน secure context และข้อมูล device ถูกจำกัดด้วย permission. [MDN: getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [MDN: enumerateDevices](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices)

browser อาจปฏิเสธการเล่นเสียงที่ไม่ได้เกิดหลัง user gesture; `play()` จะ reject ด้วย `NotAllowedError` แทนที่จะรับประกันว่า remote audio ดัง. [MDN: autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), [MDN: play()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play)

UI จึงต้องมี media-readiness step ก่อนประกาศ `AVAILABLE`, แสดง input/output ที่เลือก, ฟัง `devicechange`, และกลับไปสถานะไม่พร้อมเมื่อไมค์หายหรือ track จบ. [MDN: devicechange](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/devicechange_event)

### 5. Recovery ต้องแยกสามชั้น

1. **SIP transport/registration** — reconnect และ register ใหม่ได้ตาม policy พร้อม backoff
2. **active media/dialog** — network break อาจ recover ด้วย ICE/SIP negotiation ตามเหตุการณ์จริง แต่ page reload หรือ tab ownership loss ต้องถือว่าสูญเสีย browser leg จนพิสูจน์เป็นอย่างอื่น
3. **business Interaction** — reconcile จาก REST snapshot + ordered WebSocket events ของ router; ห้ามสร้าง Interaction ใหม่เพราะ SIP.js reconnect

ระหว่างชั้น 1 หรือ 2 เสีย UI ต้องเข้า `DEGRADED`, กัน offer ใหม่ และยังเปิดทางให้ server-side hangup/wrap-up ที่ปลอดภัย. semantics ที่แน่นอน เช่น timeout, retry ceiling และปุ่มที่กดได้ เป็น decision ของ ticket call-control/recovery

### 6. Automated browser test

Playwright สร้างหลาย isolated browser contexts ใน scenario เดียวได้ และ grant `microphone` ต่อ origin ได้ แต่เอกสารเตือนว่า permission support ต่างกันตาม browser/version. [Playwright: BrowserContext](https://playwright.dev/docs/api/class-browsercontext), [Playwright: isolation](https://playwright.dev/docs/next/browser-contexts)

test pyramid ที่เหมาะกับ Phase 2:

- unit/contract: fake SIP/media adapter เพื่อพิสูจน์ state transitions, idempotency และ tenant isolation
- Chromium E2E แบบ deterministic: fake audio device + pre-granted microphone; ใช้หลาย contexts สำหรับ Agent/Supervisor
- integration กับ FreeSWITCH ที่ pin: register, inbound invite, answer, two-way media evidence, hold/resume, hangup และ reconnect
- headed smoke บน Chrome รุ่นที่ประกาศรองรับ: permission prompt, autoplay unlock, device switch และ WSS certificate
- cross-browser smoke เฉพาะ browser support matrix ที่ ticket Pilot-ready ตกลง; ห้ามตีความ Chromium CI ว่าเป็นหลักฐานของทุก browser

## Decisions ที่ส่งต่อ

- ยึด SIP over WSS + SIP.js full API; ไม่เปลี่ยนเป็น Verto
- pin SIP.js และ FreeSWITCH image/version ที่ผ่าน compatibility suite
- softphone ทำงานเฉพาะ workspace leader tab และอยู่หลัง adapter
- Router/API เป็น authority ของ Interaction; browser reconcile หลัง reconnect
- media readiness เป็นเงื่อนไขก่อนรับ offer
- ICE servers configurable และต้องตัดสิน TURN acceptance boundary ใน ticket Pilot-ready

## เรื่องที่ยังต้องตัดสิน

- state machine, hold/mute semantics, retry/backoff, registration expiry และ degraded actions ที่แน่นอน
- credential lifetime/rotation และผลต่อ registration/active dialog
- browser support matrix, TURN path และหลักฐาน two-way audio ที่ CI ต้องเก็บ

