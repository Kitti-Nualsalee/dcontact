/**
 * โทรเข้าคิว 2000 ด้วยเสียงจริงสำหรับ Demo ทีมขาย (ใช้คู่กับ `scripts/sales-demo-stack.mjs`)
 *
 * FreeSWITCH dev ส่งสาย SIP เข้า trunk จำลอง `pstn-sim` ของตัวเองผ่าน docker network (ผ่าน ACL เดียวกับ SIPp
 * ไม่เปิด port 5080 หรือแก้ ACL ให้เครื่อง host) Router ส่งสายให้ Agent ที่เปิดรับสายตามปกติ
 * ฝั่ง Agent ใช้ไมโครโฟนจริงใน Chrome ฝั่งลูกค้าเป็นอย่างใดอย่างหนึ่ง:
 *
 * - `--echo`   ทดสอบเสียง: ลูกค้าสะท้อนเสียงของ Agent กลับมา (ได้ยินเสียงตัวเองแปลว่าเสียงไปและกลับครบ)
 * - ค่าเริ่มต้น  ลูกค้า "สมหญิง อินทรวงศ์" (แถวที่สองของ `examples/sales-demo/customers.csv`) พูดตามบท
 *   ด้วยเสียงสังเคราะห์ภาษาไทยของ macOS (`say -v Kanya`) ทักเองหลังรับสาย แล้วกด Enter ให้พูดประโยคถัดไป
 *   เพิ่ม `--auto` ถ้าต้องการให้พูดเองทุก 12 วินาที
 *
 * รัน: node scripts/sales-demo-call.mjs [--echo | --auto]   วางสายจาก Workspace หรือกด Ctrl-C
 * DEV ONLY: สั่งผ่าน `fs_cli` ใน container ของ dev compose ไม่ใช้กับ UAT หรือ production
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const container = process.env.SALES_DEMO_FREESWITCH ?? 'd-contact-dev-freeswitch-1';
const network = 'd-contact-dev_default';
const echo = process.argv.includes('--echo');
const auto = process.argv.includes('--auto');
const callerNumber = process.env.SALES_DEMO_CALLER ?? '0895550111';

// บทของลูกค้า: ผู้นำเสนอค้นด้วย +66895550111 แล้วแก้บริษัทตามประโยคที่สาม
const lines = [
  'สวัสดีค่ะ ดิฉัน สมหญิง อินทรวงศ์ จากบริษัท เมืองทองการแพทย์ ค่ะ ขอสอบถามสถานะการจัดส่งสินค้า ที่สั่งไว้เมื่อวานค่ะ',
  'เบอร์ที่ลงทะเบียนไว้ คือ ศูนย์ แปด เก้า, ห้า ห้า ห้า, ศูนย์ หนึ่ง หนึ่ง หนึ่ง ค่ะ',
  'อีกเรื่องนะคะ บริษัทเพิ่งเปลี่ยนชื่อเป็น บริษัท เมืองทอง เมดิคอล จำกัด รบกวนช่วยแก้ในระบบให้ด้วยค่ะ',
  'ได้ค่ะ ขอบคุณมากนะคะ',
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} ล้มเหลว\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return (result.stdout ?? '').trim();
}

const fs = (command) => run('docker', ['exec', container, 'fs_cli', '-x', command]);
const alive = (uuid) => fs(`uuid_exists ${uuid}`) === 'true';

function freeswitchAddress() {
  const address = run('docker', [
    'inspect',
    '-f',
    `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
    container,
  ]);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address))
    throw new Error(`ไม่พบ IP ของ ${container} ใน ${network}`);
  return address;
}

/** สร้างไฟล์เสียงของบทใน container (ไม่เก็บไว้ใน repo) คืน path ใน container ตามลำดับบท */
function prepareVoice() {
  const local = mkdtempSync(join(tmpdir(), 'dcontact-sales-demo-voice-'));
  const remote = '/tmp/dcontact-sales-demo-voice';
  try {
    const files = lines.map((text, index) => {
      const aiff = join(local, `line-${index + 1}.aiff`);
      const wav = join(local, `line-${index + 1}.wav`);
      run('say', ['-v', 'Kanya', '-r', '165', '-o', aiff, text]);
      run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
      return wav;
    });
    run('docker', ['exec', container, 'mkdir', '-p', remote]);
    return files.map((file, index) => {
      const target = `${remote}/line-${index + 1}.wav`;
      run('docker', ['cp', file, `${container}:${target}`]);
      return target;
    });
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channels = () => JSON.parse(fs('show channels as json')).rows ?? [];

/**
 * ขาที่ trunk `pstn-sim` รับเข้า (ขาลูกค้าที่ Router เห็น) ของสายนี้
 * ขาที่ originate ไม่รู้ว่าอีกฝั่งวางสาย (BYE ไม่กลับมาถึง) จึงใช้ขานี้ตัดสินว่าสายยังอยู่ไหม
 */
const isTrunkLeg = (row) =>
  row.name.startsWith('sofia/pstn-sim/') && row.initial_cid_num === callerNumber;

/**
 * ไม่เทียบเวลา: นาฬิกาภายใน FreeSWITCH ใน Docker Desktop คลาดจากเครื่องได้หลายนาทีหลัง Mac sleep
 * จึงถือว่าขา trunk ของสายนี้คือขาที่ไม่มีอยู่ก่อน originate
 */
const trunkLeg = (rows, existing) => rows.find((row) => isTrunkLeg(row) && !existing.has(row.uuid));

/** รอจน Agent รับสาย: ขาไปหา Agent (bridge จากขา trunk) อยู่ในสถานะ ACTIVE */
async function waitAnswered(existing) {
  let queued = false;
  for (let i = 0; i < 200; i += 1) {
    const rows = channels();
    const trunk = trunkLeg(rows, existing);
    if (trunk) {
      if (!queued)
        console.log('สายเข้าคิวแล้ว ถ้า Agent ยังไม่เปิดรับสาย กด "เปิดรับสาย" ตอนนี้ได้');
      queued = true;
      const agent = rows.find(
        (row) =>
          row.call_uuid === trunk.uuid && row.uuid !== trunk.uuid && row.callstate === 'ACTIVE',
      );
      if (agent) return trunk.uuid;
    } else if (queued || i > 20) return undefined;
    await sleep(500);
  }
  return undefined;
}

async function main() {
  const voice = echo ? [] : prepareVoice();
  const uuid = randomUUID();
  const address = freeswitchAddress();
  const vars = [
    `origination_uuid=${uuid}`,
    `origination_caller_id_number=${callerNumber}`,
    `origination_caller_id_name=${callerNumber}`,
    'originate_timeout=90',
    // trunk ตอบ Contact เป็น ext-sip-ip (127.0.0.1) ซึ่ง container ส่งถึงตัวเองไม่ได้ ถ้าไม่บังคับ ACK/BYE จะหาย
    // และ trunk ตัดสายด้วย 408 ACK Timeout หลัง 32 วินาที จึงส่งทุกคำขอในสายผ่าน IP จริงของ trunk
    `sip_route_uri=sip:${address}:5080`,
  ].join(',');
  const app = echo ? '&echo' : '&park';
  const existing = new Set(
    channels()
      .filter(isTrunkLeg)
      .map((row) => row.uuid),
  );
  const job = fs(`bgapi originate {${vars}}sofia/internal/2000@${address}:5080 ${app}`);
  if (!job.startsWith('+OK')) throw new Error(`FreeSWITCH ไม่รับคำสั่งโทร: ${job}`);

  const hangup = () => {
    if (alive(uuid)) fs(`uuid_kill ${uuid}`);
  };
  process.on('SIGINT', () => {
    hangup();
    process.exit(130);
  });

  console.log(`โทรเข้าคิว 2000 จาก ${callerNumber} แล้ว รอ Agent รับสาย (สูงสุด 90 วินาที)…`);
  const trunk = await waitAnswered(existing);
  if (!trunk) {
    hangup();
    throw new Error(
      'ไม่มี Agent รับสาย: Agent ต้องกด "เปิดรับสาย" และถ้าเพิ่งวางสายรอบก่อน ต้องกด "บันทึกผล" ของสายนั้นก่อน',
    );
  }
  console.log('Agent รับสายแล้ว');
  const connected = () => alive(uuid) && alive(trunk);

  if (echo) {
    console.log(
      'โหมดทดสอบเสียง: พูดใส่ไมโครโฟน ต้องได้ยินเสียงตัวเองกลับมา วางสายจาก Workspace เมื่อเสร็จ',
    );
  } else {
    const input = auto ? undefined : createInterface({ input: process.stdin });
    // วางสายระหว่างรอ Enter ต้องจบสคริปต์ทันที ไม่ทิ้งขาลูกค้าค้างไว้จนมีคนกด Enter
    const hungUp = (async () => {
      while (connected()) await sleep(1_000);
    })();
    // ประโยคแรก (ลูกค้าทัก) พูดเอง 3 วินาทีหลังรับสาย ประโยคต่อไปรอ Enter หรือทุก 12 วินาทีใน --auto
    const next = (index) =>
      index === 0 || auto
        ? sleep(index === 0 ? 3_000 : 12_000)
        : new Promise((resolve) => input.once('line', resolve));
    for (const [index, file] of voice.entries()) {
      if (index > 0 && !auto) {
        console.log(`\nกด Enter ให้ลูกค้าพูดประโยคที่ ${index + 1}: ${lines[index]}`);
      }
      const ended = await Promise.race([next(index).then(() => false), hungUp.then(() => true)]);
      if (ended || !connected()) break;
      fs(`uuid_broadcast ${uuid} ${file} aleg`);
      console.log(`ลูกค้าพูด: ${lines[index]}`);
    }
    input?.close();
    if (connected()) console.log('\nจบบทของลูกค้าแล้ว สายยังค้างไว้จนกว่า Agent จะวางสาย');
  }
  while (connected()) await sleep(1_000);
  hangup();
  console.log('วางสายแล้ว');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
