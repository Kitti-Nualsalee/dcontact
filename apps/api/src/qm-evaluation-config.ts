/**
 * #971: สวิตช์ของการประเมินคุณภาพโดยคนต่อ deployment
 *
 * ค่าเริ่มต้นปิด: route ของฟอร์ม/ผลประเมินตอบ 403 และเมนูไม่แสดง
 * route QM เดิม (transcript, auto-QM draft) ไม่ขึ้นกับสวิตช์นี้
 */
export function resolveQmHumanEvaluation(env: NodeJS.ProcessEnv): boolean {
  const value = env.QM_HUMAN_EVALUATION;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // ค่าที่สะกดผิดต้องไม่ถูกตีความเป็นเปิดหรือปิดเงียบ ๆ
  throw new Error('QM_HUMAN_EVALUATION must be "on" or "off"');
}
