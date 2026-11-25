/**
 * Call into queue 2000 with real audio for the sales team Demo (used together with `scripts/sales-demo-stack.mjs`)
 *
 * the dev FreeSWITCH sends the SIP call to its own simulated trunk `pstn-sim` over the docker network (through the same ACL as SIPp,
 * without opening port 5080 or editing the ACL for the host machine); the Router sends the call to an Agent who is accepting calls as usual
 * on the Agent side use the real microphone in Chrome; the customer side is one of the following:
 *
 * - `--echo`   audio test: the customer echoes the Agent audio back (hearing yourself means the audio goes and returns in full)
 * - default: the customer "สมหญิง อินทรวงศ์" (the second row of `examples/sales-demo/customers.csv`) speaks the script // allow-thai: Thai name of the customer row in examples/sales-demo/customers.csv
 *   with the macOS Thai synthetic voice (`say -v Kanya`), greets first after the call is answered, then press Enter to speak the next sentence
 *   add `--auto` to have it speak by itself every 12 seconds
 *
 * run: node scripts/sales-demo-call.mjs [--echo | --auto]   hang up from the Workspace or press Ctrl-C
 * DEV ONLY: driven through `fs_cli` in the dev compose container, not for UAT or production
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

// the customer script: the presenter searches +66895550111 and then fixes the company per the third sentence
const lines = [
  'สวัสดีค่ะ ดิฉัน สมหญิง อินทรวงศ์ จากบริษัท เมืองทองการแพทย์ ค่ะ ขอสอบถามสถานะการจัดส่งสินค้า ที่สั่งไว้เมื่อวานค่ะ', // allow-thai: Thai TTS script spoken by the macOS Thai voice
  'เบอร์ที่ลงทะเบียนไว้ คือ ศูนย์ แปด เก้า, ห้า ห้า ห้า, ศูนย์ หนึ่ง หนึ่ง หนึ่ง ค่ะ', // allow-thai: Thai TTS script spoken by the macOS Thai voice
  'อีกเรื่องนะคะ บริษัทเพิ่งเปลี่ยนชื่อเป็น บริษัท เมืองทอง เมดิคอล จำกัด รบกวนช่วยแก้ในระบบให้ด้วยค่ะ', // allow-thai: Thai TTS script spoken by the macOS Thai voice
  'ได้ค่ะ ขอบคุณมากนะคะ', // allow-thai: Thai TTS script spoken by the macOS Thai voice
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
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
    throw new Error(`IP of ${container} not found in ${network}`);
  return address;
}

/** Create the audio files of the script in the container (not kept in the repo) and return the paths in the container in script order */
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
 * the leg the `pstn-sim` trunk receives (the customer leg the Router sees) of this call
 * the originating leg does not know the other side hung up (the BYE does not come back), so use this leg to decide whether the call is still alive
 */
const isTrunkLeg = (row) =>
  row.name.startsWith('sofia/pstn-sim/') && row.initial_cid_num === callerNumber;

/**
 * does not compare times: the FreeSWITCH internal clock in Docker Desktop can drift by several minutes from the machine after the Mac sleeps
 * so treat the trunk leg of this call as the leg that did not exist before the originate
 */
const trunkLeg = (rows, existing) => rows.find((row) => isTrunkLeg(row) && !existing.has(row.uuid));

/** Wait until an Agent answers: the leg to the Agent (bridged from the trunk leg) is in the ACTIVE state */
async function waitAnswered(existing) {
  let queued = false;
  for (let i = 0; i < 200; i += 1) {
    const rows = channels();
    const trunk = trunkLeg(rows, existing);
    if (trunk) {
      if (!queued)
        console.log(
          'the call has entered the queue; if the Agent is not accepting calls yet, click "Accept calls" now',
        );
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
    // the trunk answers with the Contact ext-sip-ip (127.0.0.1), which the container cannot reach itself; unless forced, ACK/BYE get lost
    // and the trunk drops the call with 408 ACK Timeout after 32 seconds, so send every in-call request through the real IP of the trunk
    `sip_route_uri=sip:${address}:5080`,
  ].join(',');
  const app = echo ? '&echo' : '&park';
  const existing = new Set(
    channels()
      .filter(isTrunkLeg)
      .map((row) => row.uuid),
  );
  const job = fs(`bgapi originate {${vars}}sofia/internal/2000@${address}:5080 ${app}`);
  if (!job.startsWith('+OK')) throw new Error(`FreeSWITCH did not accept the call command: ${job}`);

  const hangup = () => {
    if (alive(uuid)) fs(`uuid_kill ${uuid}`);
  };
  process.on('SIGINT', () => {
    hangup();
    process.exit(130);
  });

  console.log(
    `called queue 2000 from ${callerNumber}; waiting for an Agent to answer (up to 90 seconds)...`,
  );
  const trunk = await waitAnswered(existing);
  if (!trunk) {
    hangup();
    throw new Error(
      'no Agent answered: the Agent must click "Accept calls", and if they just hung up the previous call they must click "Save outcome" for that call first',
    );
  }
  console.log('the Agent answered');
  const connected = () => alive(uuid) && alive(trunk);

  if (echo) {
    console.log(
      'audio test mode: speak into the microphone and you should hear yourself back; hang up from the Workspace when done',
    );
  } else {
    const input = auto ? undefined : createInterface({ input: process.stdin });
    // hanging up while waiting for Enter must end the script immediately, not leave the customer leg hanging until someone presses Enter
    const hungUp = (async () => {
      while (connected()) await sleep(1_000);
    })();
    // the first sentence (the customer greeting) is spoken automatically 3 seconds after answering; later sentences wait for Enter or every 12 seconds in --auto
    const next = (index) =>
      index === 0 || auto
        ? sleep(index === 0 ? 3_000 : 12_000)
        : new Promise((resolve) => input.once('line', resolve));
    for (const [index, file] of voice.entries()) {
      if (index > 0 && !auto) {
        console.log(
          `\npress Enter for the customer to speak sentence ${index + 1}: ${lines[index]}`,
        );
      }
      const ended = await Promise.race([next(index).then(() => false), hungUp.then(() => true)]);
      if (ended || !connected()) break;
      fs(`uuid_broadcast ${uuid} ${file} aleg`);
      console.log(`customer says: ${lines[index]}`);
    }
    input?.close();
    if (connected())
      console.log('\nthe customer script is finished; the call stays up until the Agent hangs up');
  }
  while (connected()) await sleep(1_000);
  hangup();
  console.log('hung up');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
