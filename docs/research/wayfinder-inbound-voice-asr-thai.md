# วิจัย: ASR ภาษาไทยสำหรับ Inbound Voice Phase 1

**ขอบเขต:** softphone demo ที่ต้องเก็บ recording, เล่นกลับ, สร้าง transcript และแสดงหลักฐานสำหรับ QM เท่านั้น ไม่ใช่การเลือก vendor ระยะยาว

## ข้อค้นพบ

1. Azure Speech รองรับ Thai (Thailand) `th-TH` สำหรับ speech-to-text และเอกสารระบุว่ารองรับ fast transcription; การกำหนด locale ที่ทราบล่วงหน้าช่วยทั้งความแม่นยำและ latency [Azure language support](https://learn.microsoft.com/en-us/azure/ai-services/Speech-Service/language-support), [Fast transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create).
2. Azure fast transcription ส่งผลแบบ synchronous และเอกสารระบุว่าเร็วกว่าเวลาของเสียงพร้อม latency ที่คาดการณ์ได้; batch transcription เหมาะกับไฟล์จำนวนมากหรือไฟล์ยาวกว่า จึงไม่ควรอ้างว่าได้ transcript แบบสดหากใช้ batch [Azure REST speech-to-text](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text).
3. Azure รองรับ diarization สำหรับ transcription แต่ demo ควรอัดแยก leg ของ agent/contact ตั้งแต่ telephony แล้วใส่ `speaker` จากต้นทาง: จะตรวจหลักฐาน QM ได้ชัดกว่าและไม่ต้องยึดความถูกต้องกับ speaker separation. ถ้าต้องใช้ mono จึงเปิด diarization เป็น fallback [Azure batch transcription](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription-create).
4. Azure ระบุว่า real-time/fast transcription ไม่เก็บข้อมูลลูกค้าไว้ที่ rest; batch ให้ลูกค้าควบคุมที่เก็บ output หรือกำหนด `timeToLive` เมื่อใช้ที่เก็บของ Microsoft ได้. ระบบยังต้องบังคับ retention, signed access และ audit log ของตนเองตาม ADR-010 [Azure data privacy](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/speech-to-text/data-privacy-security).
5. Google Cloud Speech-to-Text V2 มี `th-TH` บน `chirp`/`chirp_2`; ถ้าไม่ opt in data logging Google ระบุว่าไม่ใช้ audio/transcript นอกเหนือการให้บริการ แต่ async endpoint เก็บผล transcript ราว 5 วัน. จึงเป็นตัวเลือก cloud สำรองได้ แต่ต้องยอมรับ processing location และ retention ของ provider [Google supported languages](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages), [Google data usage FAQ](https://docs.cloud.google.com/speech-to-text/docs/v1/data-usage-faq).
6. สำหรับ deployment ที่ห้ามให้เสียงออกนอกองค์กร ต้องคง `TranscriptionProvider` และ self-hosted provider ไว้ตาม ADR-010; OpenAI Whisper เป็น multilingual implementation ที่มี language code `th` ใน source ของโครงการ แต่การวัด WER/throughput บนเสียง 8 kHz ของลูกค้าจริงเป็นสิ่งที่ต้องพิสูจน์เอง [OpenAI Whisper source](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py).

## ข้อจำกัดและการตัดสินใจที่แนะนำ

- **ใช้ `TranscriptionProvider` ต่อ deployment; สำหรับ softphone demo ให้เริ่ม Azure Fast Transcription ด้วย `th-TH` หลัง `interaction.ended`** เพื่อให้ transcript พร้อมเร็วสำหรับ playback/QM โดยไม่ทำให้การรับสายขึ้นกับ ASR. ไม่มีตัวเลข latency ที่รับประกันได้จากเอกสาร จึงต้องวัด p50/p95 ด้วยไฟล์ demo ก่อนตั้ง SLO.
- อัดเป็น stereo หรือแยกไฟล์ต่อ leg ที่ telephony, แปลงเป็น mono 16 kHz ต่อ leg แล้วเก็บ `speaker=AGENT|CONTACT`, timestamps และ provider/model version กับ transcript. Transcript เป็น draft ที่แก้ได้ ไม่ใช่หลักฐานสมบูรณ์โดยตัวมันเอง.
- ตั้งค่า cloud project โดย **ไม่ opt in data logging**; เก็บ source audio ใน MinIO/S3 ของ D-Contact, จำกัดสิทธิ์ด้วย tenant/RBAC, signed URL อายุสั้น, audit ทุกการเปิด media/transcript, และใช้ retention job ของ D-Contact ที่เคารพ legal hold. การ pause/resume เป็น `recording.pause`/`recording.resume` ฝั่ง telephony ไม่ใช่คำสั่ง ASR.
- ห้ามเผยแพร่ score หรือผล AI อัตโนมัติ: Auto-QM ต้องสร้าง **DRAFT** ที่แนบ `{segmentIds,startMs,endMs,quote}`; ถ้าหาหลักฐานไม่ได้เป็น `INSUFFICIENT_EVIDENCE`; มนุษย์เท่านั้นที่กด publish ตาม ADR-010 ข้อ 7–8.
- ก่อนยกระดับจาก demo ให้เก็บชุดตัวอย่าง Thai จริงที่มี transcript โดยมนุษย์ตรวจแล้ว แยกตาม noise/codec/ศัพท์เฉพาะ tenant เพื่อวัด WER และ review time; ไม่ควรตั้งเกณฑ์คุณภาพจาก claim ของ vendor.

## ทางเลือกที่ยังเปิดอยู่

- ต้องการ provider cloud สำรอง Google Cloud หรือไม่ และ deployment ใดต้อง self-hosted ตั้งแต่แรก
- ค่า SLO สำหรับ transcript-ready หลังจบสาย และ quota/ค่าใช้จ่ายต่อ tenant
- รูปแบบ audio ที่ FreeSWITCH จะส่งให้ recording pipeline (stereo กับ per-leg files)
