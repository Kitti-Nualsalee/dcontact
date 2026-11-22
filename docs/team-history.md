# ประวัติและสรุปงานของทีม

Authority: [#986](https://github.com/Kitti-Nualsalee/dcontact/issues/986) และข้อตัดสินของ owner บน
[#859](https://github.com/Kitti-Nualsalee/dcontact/issues/859) วันที่ 22 พ.ย. 2569

Supervisor เปิดดูงานที่ทีมตัวเองรับและสรุปของทีมตามช่วงเวลา ส่วน Admin ดูได้ทุกทีม กดตัวเลขในสรุป
(ทั้งหมด, ผลบันทึก, Agent) แล้วเห็นรายการต้นทางของตัวเลขนั้น เปิดงานแต่ละรายการเพื่ออ่านผลบันทึกและโน้ตสรุปได้

## สิทธิ์

- **"ของทีม"** คือทีมของ Agent ตอนรับสาย ตามหลักฐาน `voice_interaction_handling_attributions` ที่ Router บันทึก
  ตอนสายเป็น ACTIVE (#967) ไม่ใช้ทีมของคิวหรือทีมปัจจุบันของ Agent Agent ที่ย้ายทีมแล้ว งานเก่ายังอยู่กับทีมเดิม
- **Supervisor** ที่ active และมีทีม เห็นเฉพาะทีมปัจจุบันของตน ย้ายทีมหรือถูกปิดบัญชีแล้วเสียสิทธิ์ทันที
- **Admin** ที่ active เห็นทุกทีมใน tenant ไม่ระบุทีม = ทุกทีม หรือระบุทีมใดทีมหนึ่ง (รวมทีมที่ปิดใช้งานแล้ว)
- Agent และผู้ใช้อื่นตอบ `403 TEAM_HISTORY_ACCESS_DENIED` บทบาท สถานะ และทีมอ่านจาก DB ทุก request
- ทีมอื่น tenant อื่น และงานที่ไม่มีจริง ตอบ `404 RESOURCE_NOT_FOUND` เหมือนกัน
- **งานที่ไม่มีหลักฐานทีม** (ก่อนเปิดใช้หลักฐานนี้ หรือ Agent ไม่มีทีมตอนรับสาย) ไม่แสดงในประวัติหรือสรุปของทีม
  และไม่เติมย้อนหลังจากทีมปัจจุบัน
- รายละเอียดแสดงชื่อ Agent, ทีม, ผลบันทึก, เวลา, ความยาวสาย และโน้ตสรุป เสียงยังอยู่ที่หน้า "เสียงบันทึกของทีม" (#967)

## นิยามตัวเลข

ใช้นิยาม "งานที่จบ" เดียวกับ "งานของฉัน" (#964, `apps/api/src/agent-work-metrics.ts`): งาน VOICE ที่ COMPLETED
และมีผลบันทึก (หรือเป็นงาน LEGACY) นับเข้าช่วงเวลาตามเวลาที่บันทึกผล ช่วงของสรุปจบที่เวลาคำนวณ (as of)
และรายการที่เปิดจากตัวเลขใช้ช่วงเดียวกัน เวลาสนทนา = เวลาวางสาย − เวลารับสาย

## Endpoint

Prefix `/api/v1/team-history` ทุก route ต้องมี role `admin` หรือ `supervisor` และตอบ `Cache-Control: no-store`

| Method และ path                    | ผล                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /teams`                       | ทีมที่ดูได้ `{ allTeams, items }` Supervisor ได้ทีมเดียว Admin ได้ทุกทีม                     |
| `GET /summary?period=&teamId=`     | สรุปตามช่วง `today`/`7d`/`30d`/`all` พร้อม `byDisposition` และ `byAgent`                  |
| `GET /items?from=&to=&teamId=&agentId=&disposition=&limit=&cursor=` | รายการเรียงตามเวลาบันทึกล่าสุด `limit` 20 สูงสุด 100 cursor ผูกกับผู้ขอ ทีม และตัวกรอง |
| `GET /items/:interactionId`        | รายละเอียดพร้อมโน้ตของงานในขอบเขต                                                        |

## หน้า Console

`/?view=team-history` อยู่ในพื้นที่ "ประวัติ" สำหรับ Supervisor และ Admin Admin เลือกทีมจากตัวเลือก "ทีม"
(ค่าเริ่มต้นทุกทีม) Supervisor เห็นชื่อทีมของตน ตัวกรอง (ช่วงเวลา, ทีม, Agent, ผลบันทึก) และงานที่เปิดอยู่เก็บใน URL

## ตรวจ

```sh
pnpm --filter @d-contact/api exec tsx --test --test-concurrency=1 src/team-history.integration.ts
pnpm --filter @d-contact/console exec playwright test e2e/team-history.spec.ts --project=chromium
```

Integration ใช้ฐานแยกที่ migrate และ `db:rls` แล้ว ตรวจผ่าน HTTP ด้วย application role ที่ไม่ bypass RLS
Playwright ใช้ API จำลอง ยืนยันเฉพาะ UI

## ข้อจำกัด

- รายงานเป็นแบบอ่านจาก `interactions` ตรง ยังไม่มีตาราง `rp_*` หรือ index ของรายงาน (ADR-019 ข้อ 4) เหมาะกับปริมาณของ Solo/dev
- ยังไม่มีรายงานเทียบช่วงเวลา, export หรือ scheduled report
- คิว managed บันทึกเสียงไม่ได้ (#977) หน้านี้จึงไม่ผูกกับเสียง
