#!/usr/bin/env node
/**
 * ตัวอย่าง client ของ External customer API (#954): ขอ token แบบ client_credentials → สร้างลูกค้า →
 * อ่านกลับ → ค้นด้วยอีเมล ใช้ HTTP API สาธารณะเท่านั้น ไม่มี credential ของฐานข้อมูล
 *
 *   API_BASE_URL=http://localhost:3000 \
 *   TOKEN_URL=http://localhost:8081/realms/dcontact/protocol/openid-connect/token \
 *   CLIENT_ID=<service client> CLIENT_SECRET=<secret> \
 *   node examples/external-customer-api/client.mjs
 *
 * ผลลัพธ์เป็น JSON หนึ่งบรรทัด ไม่พิมพ์ token, secret หรือข้อมูลลูกค้า
 */
import { randomUUID } from 'node:crypto';

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`ต้องตั้ง ${name}`);
  return value;
};
const api = `${need('API_BASE_URL').replace(/\/$/, '')}/api/v1/customer-360`;

async function accessToken() {
  const response = await fetch(need('TOKEN_URL'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: need('CLIENT_ID'),
      client_secret: need('CLIENT_SECRET'),
    }),
  });
  if (!response.ok) throw new Error(`ขอ token ไม่สำเร็จ: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

async function call(token, method, path, body) {
  const response = await fetch(`${api}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * ส่ง commandId เดิมซ้ำเมื่อผลยังไม่แน่นอน (เครือข่ายขาด, 429, 503): server ไม่สร้างลูกค้าซ้ำ
 * เปลี่ยน commandId เฉพาะเมื่อตั้งใจสร้างลูกค้าอีกราย
 */
async function createContact(token, profile) {
  const commandId = randomUUID();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let result;
    try {
      result = await call(token, 'POST', 'contacts', { commandId, ...profile });
    } catch {
      result = { status: 0, body: null };
    }
    if (result.status === 201 || result.status === 200) return result.body.command;
    if (![0, 429, 503].includes(result.status))
      throw new Error(
        `สร้างลูกค้าไม่สำเร็จ: HTTP ${result.status} ${result.body?.error?.code ?? ''}`,
      );
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error('สร้างลูกค้าไม่สำเร็จหลังลองซ้ำ ตรวจผลด้วย GET commands/:commandId');
}

const token = await accessToken();
const email = `example-${randomUUID().slice(0, 8)}@example.test`;
const receipt = await createContact(token, {
  displayName: 'ลูกค้าตัวอย่างจากระบบภายนอก',
  company: 'บริษัท ตัวอย่าง จำกัด',
  points: [{ kind: 'EMAIL', value: email }],
});
// receipt ไม่มีข้อมูลลูกค้า ต้องอ่านค่าปัจจุบันกลับเอง
const contactId = receipt.resourceRefs[0]?.id;
if (!contactId) throw new Error('receipt ไม่มี Contact ที่อ่านได้');
const profile = await call(token, 'GET', `contacts/${contactId}`);
if (profile.status !== 200) throw new Error(`อ่านลูกค้าไม่สำเร็จ: HTTP ${profile.status}`);
const search = await call(token, 'POST', 'contacts/search', { type: 'EMAIL', query: email });
if (search.status !== 200) throw new Error(`ค้นลูกค้าไม่สำเร็จ: HTTP ${search.status}`);
const found = search.body.items.some((item) => item.contactId === contactId);
if (!found) throw new Error('ค้นด้วยอีเมลไม่พบลูกค้าที่เพิ่งสร้าง');
console.log(JSON.stringify({ result: 'PASS', contactId, readback: true, searchFound: true }));
