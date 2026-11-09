import type { PhoneStatus } from './runtime.js';

export type Language = 'th' | 'en';

const thai = {
  subtitle: 'โทรศัพท์สำหรับ Agent Workspace',
  audio: 'อุปกรณ์เสียง',
  micNeeded: 'เปิดไมโครโฟนเพื่อเริ่มรับสาย',
  micPending: 'กำลังรอสิทธิ์ใช้ไมโครโฟน',
  micReady: 'ไมโครโฟนพร้อม',
  micFailed: 'เปิดไมโครโฟนไม่สำเร็จ ตรวจสิทธิ์ใน Chrome และลองอีกครั้ง',
  enableMic: 'เปิดไมโครโฟน',
  retryMic: 'ลองเปิดไมโครโฟนอีกครั้ง',
  enableAudio: 'เปิดเสียงสายสนทนา',
  audioBlocked: 'Chrome พักเสียงสายสนทนาไว้ กดเปิดเสียงเพื่อฟังปลายสาย',
  workspace: 'กลับไปยัง Workspace',
  instructions: 'เริ่มใช้งาน',
  firstStep: 'เปิดไมโครโฟนในแท็บนี้',
  secondStep: 'กลับไปเชื่อม D-Phone และเปิดรับงานใน Workspace',
  thirdStep: 'รับสายและวางสายจาก Workspace',
  keepOpen: 'เปิดแท็บ D-Phone ไว้ขณะรับสาย',
  connection: 'สถานะการโทร',
  status: {
    waiting: ['รอเชื่อมต่อ', 'เชื่อม D-Phone จาก Agent Workspace เมื่อไมโครโฟนพร้อม'],
    connecting: ['กำลังเชื่อมต่อ', 'กำลังเตรียม D-Phone ให้พร้อมรับสาย'],
    ready: ['โทรศัพท์พร้อม', 'เปิดรับงานจาก Workspace เพื่อเริ่มรับสาย'],
    ringing: ['มีสายเรียกเข้า', 'เปิด Workspace เพื่อรับสาย'],
    active: ['กำลังสนทนา', 'เสียงสายสนทนาอยู่ใน D-Phone วางสายจาก Workspace'],
    lost: ['การเชื่อมต่อขาดหาย', 'ตรวจสถานะใน Workspace แล้วลองเชื่อม D-Phone อีกครั้ง'],
    duplicate: ['D-Phone เปิดอยู่แล้ว', 'กลับไปใช้แท็บ D-Phone ที่เปิดอยู่'],
  } satisfies Record<PhoneStatus, [string, string]>,
};

const english: typeof thai = {
  subtitle: 'Softphone for Agent Workspace',
  audio: 'Audio setup',
  micNeeded: 'Enable your microphone to receive calls',
  micPending: 'Waiting for microphone permission',
  micReady: 'Microphone ready',
  micFailed: 'Microphone unavailable. Check permissions in Chrome and try again.',
  enableMic: 'Enable microphone',
  retryMic: 'Retry microphone setup',
  enableAudio: 'Play call audio',
  audioBlocked: 'Chrome paused the call audio. Select Play call audio to hear the caller.',
  workspace: 'Return to Workspace',
  instructions: 'Get started',
  firstStep: 'Enable the microphone in this tab.',
  secondStep: 'Connect D-Phone and go available in Workspace.',
  thirdStep: 'Answer and end calls from Workspace.',
  keepOpen: 'Keep this D-Phone tab open while taking calls.',
  connection: 'Call status',
  status: {
    waiting: [
      'Waiting to connect',
      'Connect D-Phone from Agent Workspace when the microphone is ready.',
    ],
    connecting: ['Connecting', 'D-Phone is getting ready for incoming calls.'],
    ready: ['Phone ready', 'Go available in Workspace to receive calls.'],
    ringing: ['Incoming call', 'Open Workspace to answer.'],
    active: ['On a call', 'D-Phone carries the audio. End the call from Workspace.'],
    lost: ['Connection lost', 'Check Workspace and try connecting D-Phone again.'],
    duplicate: ['D-Phone is already open', 'Return to the existing D-Phone tab.'],
  },
};

export const catalog = { th: thai, en: english };
