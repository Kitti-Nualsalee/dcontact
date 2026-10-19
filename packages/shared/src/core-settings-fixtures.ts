/** ตัวอย่างตาม Phase Contract ใช้ร่วมใน API และ browser model tests */
export const coreNameFixtures = [
  { value: 'AB', valid: true },
  { value: '😀', valid: true },
  { value: '😀'.repeat(60), valid: true },
  { value: ' A ', valid: false },
  { value: '😀'.repeat(61), valid: false },
  { value: 'a\u200bb', valid: false },
  { value: '\ud800x', valid: false },
] as const;
export const coreTimeZoneFixtures = [
  { value: 'Asia/Bangkok', valid: true },
  { value: 'UTC', valid: true },
  { value: 'America/New_York', valid: true },
  { value: 'GMT+7', valid: false },
  { value: '+07:00', valid: false },
  { value: 'EST', valid: false },
  { value: 'Asia/No_Such_Zone', valid: false },
] as const;
