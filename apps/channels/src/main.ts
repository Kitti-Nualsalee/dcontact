/**
 * Channel gateways — webchat / LINE / Facebook / WhatsApp / email
 *
 * โครงสร้างเป้าหมาย: แต่ละ channel เป็น plugin ที่ implement interface เดียวกัน
 *   inbound:  platform webhook/WS → normalize เป็น Message + Interaction → router
 *   outbound: agent ส่งข้อความ → แปลงกลับเป็น format ของ platform
 *
 * ลำดับการทำ: webchat (Phase 2) → LINE OA → Facebook → WhatsApp → email (Phase 3)
 */

console.log('[channels] gateway service placeholder — implement in Phase 2 (webchat first)');
