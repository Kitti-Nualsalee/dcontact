# ADR 024: Message delivery & media — แถวข้อความคือ outbox, idempotency สองทาง, ไฟล์จาก provider ต้องดึงทันที

- **สถานะ:** Accepted
- **วันที่:** 2026-08-09

## บริบท

`Message` เดิมมีแค่ `body` + `externalId` + `createdAt` ไม่มีสถานะการส่ง ไม่มี idempotency
ซึ่งขัดกับสิ่งที่เราบังคับไว้ทุกที่อื่นในระบบ:
[ADR-003](003-kafka-event-backbone.md) บอกว่า Kafka เป็น at-least-once และทุก consumer ต้อง dedupe ·
[ADR-015](015-integration-platform.md) บังคับ `Idempotency-Key` กับทุก POST ที่สร้างของ

แต่ **ทางเดียวที่ยังไม่มีการป้องกันคือทางที่ไปถึงลูกค้าจริง** — worker restart กลางทาง
หรือ Kafka redeliver หนึ่งครั้ง = ลูกค้าได้ข้อความซ้ำสองครั้ง ซึ่งเรียกคืนไม่ได้และมองเห็นทันที

เรื่องที่สอง: ลูกค้าส่งรูป/เอกสารเข้ามาทาง LINE/WhatsApp/Facebook — provider ให้ **URL ที่หมดอายุ**
ถ้าไม่ดึงมาเก็บภายในเวลาที่กำหนด ไฟล์นั้นหายถาวรและตามคืนไม่ได้เลย ตอนนี้ schema ไม่มีที่เก็บด้วยซ้ำ
([internal-collaboration §6](../internal-collaboration.md) วางกติกาไว้แล้วแต่เป็นของ**แชทภายใน**เท่านั้น)

## การตัดสินใจ

1. **แถวใน `messages` คือ outbox — ไม่มีตาราง outbox แยก**
   ข้อความขาออกถูกเขียนด้วยสถานะ `QUEUED` ในทรานแซกชันเดียวกับที่บันทึกว่าเราตั้งใจจะส่ง
   แล้ว worker หยิบไปส่ง (`SENDING → SENT → DELIVERED/READ`)
   ตารางแยกจะได้ "ความจริงสองที่" ที่ต้องคอยตกลงกันเอง — ซึ่งพังในวันที่ worker ตายกลางทางพอดี

2. **Idempotency สองทาง เพราะสองทางพังคนละแบบ**

   | ทาง | คีย์ | ขอบเขต unique | กันอะไร |
   |---|---|---|---|
   | ขาเข้า | `providerMessageId` | `(tenantId, channelAccountId, providerMessageId)` | webhook ที่ provider ยิงซ้ำ — LINE/Meta ทำเป็นปกติ |
   | ขาออก | `clientToken` | `(tenantId, clientToken)` — เราเป็นผู้ออกเอง จึงคุม namespace ได้ | Kafka at-least-once / ผู้ใช้กดส่งสองครั้ง / worker restart |

   `clientToken` สร้างจากฝั่งผู้สั่งส่ง (UI หรือ flow engine) **ก่อน** ส่งคำสั่ง —
   ถ้าให้ server สร้างหลังรับคำสั่ง มันจะไม่กันอะไรเลยเพราะคำสั่งซ้ำจะได้ token คนละตัว

   **`providerMessageId` unique ที่ `(tenantId, channelAccountId, providerMessageId)` ไม่ใช่แค่ระดับ tenant**
   เพราะเราไม่ควรพึ่งคำสัญญาว่า provider ทุกเจ้าออก id ที่ unique ทั้งโลก และ `channelAccountId`
   ถูก **denormalize ลงบน `messages`** ด้วย เพราะ **การ dedupe ต้องเกิดก่อน resolve thread** —
   คีย์จึงต้องประกอบจากสิ่งที่รู้ตอน webhook เข้าเท่านั้น (tenant + บัญชีที่รับ + id) ถ้าเอา
   `conversationId` มาเป็นส่วนหนึ่งของคีย์ เราจะต้อง resolve thread ก่อนถึงจะรู้ว่าเป็นของซ้ำ ซึ่งกลับหัวกลับหาง

   **กฎของคอลัมน์: ต้องเป็น id จาก "ระบบผู้รับ" เสมอ ห้ามเป็นค่าที่ผู้ส่งกำหนด**

   | ช่องทาง | ใส่อะไร | ทำไม |
   |---|---|---|
   | LINE · Messenger · WhatsApp | `message.id` · `mid` · `wamid` | แพลตฟอร์มเป็นผู้ออก |
   | เว็บแชท | id ที่เราออกเอง (ULID) | เราเป็นผู้รับและผู้ออก |
   | **อีเมล** | **`UIDVALIDITY:UID` ของ mailbox ที่รับ** | **ห้ามใช้ `Message-ID`** — ผู้ส่งเป็นคนสร้าง ปลอมและซ้ำได้ |
   | SMS / ผู้ให้บริการอื่น | SID **นำหน้าด้วยรหัสผู้ให้บริการ** เช่น `twilio:SM123` | tenant เดียวอาจใช้หลายเจ้าในช่องทางเดียวกัน |

   เคสอีเมลไม่ใช่เรื่องสมมติ: ถ้า dedupe ด้วย `Message-ID` ที่ผู้ส่งกำหนด คนที่รู้กลไกส่งเมลที่มี
   `Message-ID` ซ้ำเข้ามาก่อนจะทำให้**เมลจริงถูกทิ้งเงียบ ๆ ในฐานะข้อความซ้ำ** และแบบไม่ตั้งใจก็เกิดได้
   จาก mailing list ที่ส่งซ้ำด้วย id เดิม — ส่วน `Message-ID` ยังเก็บไว้ แต่ไปอยู่ที่
   `Conversation.externalThreadId` ซึ่งเป็นหน้าที่จริงของมัน (ต่อ thread ผ่าน `In-Reply-To`/`References`)

3. **การหยิบงานออกจาก outbox ต้อง atomic — `QUEUED → SENDING` เฉย ๆ ไม่กันอะไร**
   worker สองตัวที่ scan พร้อมกันจะเห็นแถวเดียวกันทั้งคู่ ต้องใช้ทั้งสามอย่างร่วมกัน:

   ```sql
   -- 1) claim: อ่านแบบข้ามแถวที่ถูกจอง
   SELECT id FROM messages
    WHERE status = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED LIMIT 20;
   -- 2) lease: จองพร้อมเวลาหมดอายุ (compare-and-set — ต้องได้ 1 row ถึงจะส่ง)
   UPDATE messages SET status='SENDING', locked_by=$worker, locked_at=now(), attempts=attempts+1
    WHERE id = $id AND status='QUEUED';
   -- 3) lease หมดอายุ (worker ตาย) → กวาดกลับเป็น QUEUED
   UPDATE messages SET status='QUEUED', locked_by=NULL
    WHERE status='SENDING' AND locked_at < now() - interval '2 minutes';
   ```

   **แต่การล็อกลด duplicate ได้เท่านั้น ไม่ได้การันตี** — lease หมดอายุตอน HTTP ไปหา provider
   ยังค้างอยู่ได้เสมอ ตัวที่การันตีจริงคือ `clientToken` ที่ส่งเป็น **idempotency key ไปยัง provider**
   ที่รองรับ การล็อกคือชั้นแรก idempotency key คือชั้นสุดท้าย

4. **timeout ไม่ใช่ความล้มเหลว** — ยิงไปแล้วไม่ได้คำตอบให้คงสถานะ `SENDING` แล้วไป **reconcile**
   ด้วย provider message id ทีหลัง **ห้ามเปลี่ยนเป็น `FAILED` แล้วส่งใหม่ทันที**
   เพราะนั่นคือการสร้างข้อความซ้ำด้วยมือของเราเอง

5. **การลองใหม่มีเพดานและมีที่จบ**
   `attempts` + `nextAttemptAt` (backoff 5s → 30s → 2m → 10m, สูงสุด 4 ครั้ง) → `FAILED`
   ข้อความที่ `FAILED` **ต้องปรากฏในหน้าจอ agent ว่าส่งไม่สำเร็จ** ไม่ใช่หายเงียบ —
   agent ที่คิดว่าตอบลูกค้าไปแล้วทั้งที่ข้อความไม่เคยถึง คือความเสียหายที่แย่กว่าส่งช้า

6. **สถานะการส่งเป็นข้อมูลของ "การส่ง" ไม่ใช่ของ "เนื้อหา"**
   เก็บในแถวเดียวกันได้ (ข้อ 1) แต่ **ห้ามเอาไปปนกับ `state` ของ interaction** —
   ข้อความส่งไม่สำเร็จไม่ได้แปลว่างานล้มเหลว และงานที่จบแล้วยังมีข้อความค้างส่งได้

7. **ไฟล์จาก provider ต้องถูกดึงทันทีที่ webhook เข้า ก่อนทำอย่างอื่น**
   ```
   webhook มีไฟล์ → สร้าง message_attachments (PENDING_FETCH)
     → ดึงจาก provider URL ทันที (มีเวลาจำกัด) → เก็บลง media/{tenantId}/…  → PENDING_SCAN
     → ClamAV → CLEAN (เปิดได้) | INFECTED (กักไว้ ไม่ลบ เพราะเป็นหลักฐาน)
     → ดึงไม่ทัน → FETCH_FAILED + แจ้ง agent ว่าลูกค้าส่งไฟล์มาแต่ระบบเก็บไม่ทัน
   ```
   **ห้ามเก็บแค่ URL ของ provider แล้วให้ UI ไปโหลดตอนเปิดดู** — วันที่ agent เปิดดูคือวันที่ลิงก์ตายแล้ว
   และ QM ที่มาตรวจย้อนหลังสามเดือนจะไม่เห็นอะไรเลย

8. **ไฟล์ฝั่งลูกค้าใช้กติกาชุดเดียวกับไฟล์ในแชทภายใน แต่คนละ bucket คนละ retention**
   `media/{tenantId}/…` (ของลูกค้า อายุตาม retention ของ interaction/conversation) แยกจาก
   `collab/{tenantId}/…` ([ADR-022](022-internal-collaboration.md)) เพราะสิทธิ์เข้าถึงและอายุคนละชุด
   ส่วนกติกาที่เหมือนกัน: ตรวจ magic bytes · สแกนก่อนเปิดได้ · signed URL อายุสั้น · audit ทุกการดาวน์โหลด

9. **ขาออกที่มีไฟล์แนบ = ส่งเมื่อสแกนผ่านเท่านั้น**
   agent แนบไฟล์ → `QUEUED` แต่ worker จะไม่ส่งจนกว่า attachment ทุกใบเป็น `CLEAN`
   เราส่งมัลแวร์ให้ลูกค้าไม่ได้แม้แต่ครั้งเดียว

## ผลที่ตามมา

- schema: `Message` เพิ่ม `interactionId` (ADR-023), `channelAccountId`, `providerMessageId`, `clientToken`, `status`,
  `attempts`, `nextAttemptAt`, `failureCode/Reason`, `sentAt/deliveredAt/readAt`
  + `lockedAt`/`lockedBy` สำหรับ lease + index `(status, nextAttemptAt)` สำหรับ outbox scan;
  ตารางใหม่ `message_attachments`
- `apps/channels` ได้หน้าที่ใหม่ 2 อย่าง: media fetcher (ทันทีที่ webhook เข้า) และ delivery-status
  callback handler (provider แจ้ง delivered/read กลับมา)
- ClamAV ที่ [ADR-022](022-internal-collaboration.md) พาเข้ามาถูกใช้ร่วมกันทั้งสองฝั่ง — ไม่เพิ่มของใหม่
- UI ต้องมีสถานะข้อความ (กำลังส่ง / ส่งแล้ว / ถึงแล้ว / **ส่งไม่สำเร็จ + ปุ่มลองใหม่**)
- quota: ไฟล์ฝั่งลูกค้าเข้า `storageGb` เดิม ไม่ใช่ `collabStorageGb`

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| ตาราง outbox แยกจาก messages | ความจริงสองที่ที่ต้องตกลงกันเอง และ join ทุกครั้งที่แสดงบทสนทนา |
| ใช้ `externalId` ตัวเดียวทำ idempotency ทั้งสองทาง | ขาเข้ากับขาออกมาจากคนละแหล่งและชนกันเองแน่นอน |
| `providerMessageId` unique แค่ระดับ tenant | พึ่งคำสัญญาว่า provider ทุกเจ้า (รวมเจ้าที่ยังไม่ได้ต่อ) ออก id unique ทั้งโลก |
| ใช้ `Message-ID` ของอีเมลเป็นคีย์ dedupe | ผู้ส่งเป็นคนสร้าง — ปลอมเพื่อกลบเมลจริงได้ และซ้ำเองได้จาก mailing list |
| ให้ UI ลองส่งใหม่เองเมื่อ error | ผู้ใช้ปิดแท็บ = ข้อความหาย; และจะกดซ้ำจนลูกค้าได้ข้อความสามรอบ |
| เปลี่ยนสถานะเป็น `SENDING` แล้วถือว่าจองสำเร็จ | worker สองตัวอ่านแถวเดียวกันได้ก่อนที่ใครจะเขียน — ต้อง `FOR UPDATE SKIP LOCKED` + compare-and-set |
| เก็บแค่ URL ของ provider | ลิงก์หมดอายุ → หลักฐานหาย → QM/ข้อพิพาทตรวจไม่ได้ |
| สแกนไฟล์ทีหลังแบบ best-effort | ส่งมัลแวร์ให้ลูกค้าไปแล้วหนึ่งครั้งก็พอที่จะจบความสัมพันธ์ |

## เอกสารเกี่ยวข้อง

[ADR-023](023-conversation-vs-interaction.md) · [interaction-data-flow.md](../interaction-data-flow.md) ·
[ADR-022](022-internal-collaboration.md) · [ADR-003](003-kafka-event-backbone.md)
