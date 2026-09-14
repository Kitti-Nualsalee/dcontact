/**
 * J2.8 (#136) — PII-safe observability ของ owner command/result path
 *
 * ปิดข้อสุดท้ายของ out-of-scope list ใน PR #149 เดิม relay/consumer/escalator ทำงานเงียบ
 * สนิท ไม่มีทางรู้จากภายนอกเลยว่า command ค้างกี่ใบ ผลถูกปฏิเสธเพราะ binding กี่ครั้ง
 * หรือมี action ที่ escalate ไปแล้วรออยู่เท่าไร
 *
 * สัญญาเดียวกับ `journey-governance-metrics.ts` ของ S1.5 และเป็นเหตุผลที่ interface
 * ตัวนี้ **ไม่รับ label เลย**: metric ของ owner path เกี่ยวข้องกับ tenant, actionKey,
 * commandId และ contactId ทั้งหมด ถ้าเปิดช่องให้ใส่ label เมื่อไรก็จะมีคนใส่ค่าพวกนี้
 * เข้าไปโดยไม่ตั้งใจ แล้วมันจะไหลไป metric backend ที่ retention ยาวกว่าและสิทธิ์เข้าถึง
 * กว้างกว่าฐานข้อมูลมาก — การตัดทิ้งตั้งแต่ระดับ type จึงปลอดภัยกว่าการเตือนใน code review
 *
 * ถ้าต้องสืบว่าใบไหนมีปัญหา ใช้ `JrRecoveryAudit` กับ admin recovery API (#235) ซึ่งอยู่
 * ในขอบเขต tenant และมี access control จริง ไม่ใช่ metric
 */

/** counter — นับจำนวนครั้งล้วน ๆ */
export type JourneyOwnerCounterMetric =
  | 'journey_owner_command_dispatched_total'
  | 'journey_owner_command_dispatch_failed_total'
  | 'journey_owner_result_applied_total'
  | 'journey_owner_result_duplicate_total'
  | 'journey_owner_result_conflict_total'
  | 'journey_owner_result_binding_rejected_total'
  | 'journey_owner_ack_unknown_total'
  | 'journey_owner_ack_reconciled_total'
  | 'journey_owner_ack_escalated_total';

/** gauge/histogram — ค่าที่วัดได้เป็นตัวเลข */
export type JourneyOwnerGaugeMetric =
  'journey_owner_dispatch_to_result_ms' | 'journey_owner_ack_attempts';

export type JourneyOwnerMetric = JourneyOwnerCounterMetric | JourneyOwnerGaugeMetric;

/**
 * ไม่มีพารามิเตอร์ label โดยเจตนา — ดู doc ด้านบน
 */
export interface JourneyOwnerMetrics {
  increment(metric: JourneyOwnerCounterMetric): void;
  observe(metric: JourneyOwnerGaugeMetric, value: number): void;
}

export const noOpJourneyOwnerMetrics: JourneyOwnerMetrics = {
  increment() {},
  observe() {},
};

/** structured log ที่ metric backend เก็บได้ โดยไม่มี identifier ใด ๆ ติดไปด้วย */
export class JsonJourneyOwnerMetrics implements JourneyOwnerMetrics {
  increment(metric: JourneyOwnerCounterMetric): void {
    console.info(JSON.stringify({ metric, value: 1 }));
  }

  observe(metric: JourneyOwnerGaugeMetric, value: number): void {
    console.info(JSON.stringify({ metric, value: Math.max(0, value) }));
  }
}
