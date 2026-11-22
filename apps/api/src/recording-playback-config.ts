/**
 * #967: สวิตช์ของการเปิดฟังเสียงบันทึกโดย Supervisor ต่อ deployment
 *
 * ค่าเริ่มต้นปิด: route ใหม่ตอบ 403 และ route presign เดิมทำงานเหมือนเดิม
 * เปิดแล้ว Supervisor ฟังผ่าน API แบบตรวจสิทธิ์ทุก chunk และ route presign เดิมตอบ 403
 */
export function resolveRecordingSupervisorPlayback(env: NodeJS.ProcessEnv): boolean {
  const value = env.RECORDING_SUPERVISOR_PLAYBACK;
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  // ค่าที่สะกดผิดต้องไม่ถูกตีความเป็นเปิดหรือปิดเงียบ ๆ
  throw new Error('RECORDING_SUPERVISOR_PLAYBACK must be "on" or "off"');
}
