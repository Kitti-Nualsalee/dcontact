# ลำดับการสั่ง acceptance และการตรวจ regression ด้วย marker (#559)

acceptance ของ J2, J3 และ J5 ต้องพิสูจน์ว่า phase ก่อนหน้ายังผ่านบน SHA เดียวกัน (`J2-REG01`, `J3-REG01`,
`J5-REG01`) เดิมทำโดยรัน acceptance ของ phase นั้นใหม่ทั้งชุดแบบซ้อนกัน ซึ่งทำให้เวลารวมเกิน 6 ชม.
ที่ GitHub-hosted runner ยอมให้ (J3 ถูก cancel เพราะหมดเวลาตอน suite 20, J5 ล้มโดยไม่มีรายละเอียด)

ตอนนี้ REG **ไม่รัน acceptance ของ phase อื่นแล้ว** แต่ตรวจ marker ใน evidence manifest ของ phase นั้น:

1. job ดาวน์โหลด manifest จาก CI artifact `<ชื่อ>-evidence-<sha>` ของ run ใดก็ได้บน **main และ SHA เดียวกัน**
   (`scripts/acceptance-fetch-evidence.mjs`) พร้อมบันทึก provenance: run, artifact และ SHA-256 ของไฟล์
2. `scripts/acceptance-dependency-markers.mjs` นับเฉพาะ manifest ที่มี provenance, digest ตรง, `commitSha`
   ตรง, ไม่ใช่ candidate และมี marker ของ phase นั้น ถ้าขาดตัวใดจะ **ล้ม** พร้อมบอกคำสั่งที่ต้องรันก่อน
3. ไฟล์ที่ค้างจาก local run หรือถูกแก้หลังดาวน์โหลด (digest ไม่ตรง) ไม่นับ

ต่างจากเดิมตรงที่ evidence ไม่จำเป็นต้องมาจาก dispatch เดียวกัน (ตัดสินใจข้อ 1 ใน #559): SHA ที่ตรงกันพิสูจน์ว่าเป็นโค้ดชุดเดียวกัน
และ artifact ของ GitHub Actions แก้ไขไม่ได้

## marker ที่แต่ละ acceptance ต้องเห็น

| acceptance | marker ที่ต้องมีบน SHA เดียวกัน | มาจาก artifact |
|---|---|---|
| J2 (`J2-REG01`) | `J1_ACCEPTED`, `CONTACT_GOVERNANCE_CG3_ACCEPTED` | `cxa-c1-evidence`, `s1-evidence` (ทั้งคู่จาก run S1) |
| J3 (`J3-REG01`) | `CONTACT_GOVERNANCE_CG3_ACCEPTED`, `JOURNEY_J2_ACCEPTED`, `CONTACT_GOVERNANCE_CG4_ACCEPTED` | `s1-evidence`, `cxa-j2-evidence`, `cxa-cg4-evidence` |
| CG4 (`CG4-REG01`, #572) | `CONTACT_GOVERNANCE_CG3_ACCEPTED` และ S1-REG-01 PASS ครบ | `s1-evidence` |
| J5 (`J5-REG01`) | `J1_ACCEPTED`, `JOURNEY_J2_ACCEPTED`, `JOURNEY_J3_ACCEPTED`, `CONTACT_GOVERNANCE_CG3_ACCEPTED` | `cxa-c1-evidence`, `cxa-j2-evidence`, `cxa-j3-evidence`, `s1-evidence` |

## ลำดับการสั่งบน SHA เดียวกัน

สั่งทีละขั้น และรอให้ขั้นก่อนหน้าผ่านก่อน (ขั้นเดียวกันสั่งพร้อมกันได้):

```bash
gh workflow run CI --ref main -f acceptance=s1
```

```bash
gh workflow run CI --ref main -f acceptance=j2
```

```bash
gh workflow run CI --ref main -f acceptance=cg4
```

```bash
gh workflow run cxa-j3-acceptance --ref main
```

```bash
gh workflow run CI --ref main -f acceptance=j5
```

1. **S1:** ได้ `s1-evidence` และ `cxa-c1-evidence`
2. **J2 และ CG4:** สั่งพร้อมกันได้ ทั้งคู่ตรวจ S1 จาก artifact ไม่รัน S1 ซ้อนแล้ว (#572)
3. **J3**
4. **J5**

ถ้า main ขยับระหว่างทาง ต้องเริ่มใหม่ตั้งแต่ขั้นแรกบน SHA ใหม่ เพราะ marker นับเฉพาะ SHA ที่ตรงกัน

## เมื่อ REG ล้ม

- `detail` ของ suite dependency บอกว่า marker ตัวไหนขาดและต้องสั่งอะไร
- suite ที่ยังรัน acceptance ซ้อนอยู่ (เช่น S1 → E0/C1/Inbound Voice) จะเก็บบรรทัด `readiness.suite`/`readiness.check` ที่ `FAIL`
  ของชั้นในไว้ใน `detail` (`scripts/readiness-failure-detail.mjs`) ถ้าไม่มีบรรทัดแบบนี้ ก็จะเก็บท้าย output ไว้
  ไม่ใช่เหลือแค่ `process exited with status 1`
