/**
 * AC3 (#596) บน Postgres จริงด้วย role ของแอป (`dcontact_app`, RLS) และ mailpit ของ dev stack:
 * ส่งสำเร็จ (ชื่อผู้ส่ง D-Contact, Message-ID คงที่), dedupeKey ซ้ำไม่เพิ่มงาน, SMTP ล้มแล้ว retry แบบ backoff,
 * 5xx/ครบจำนวนครั้ง = DEAD, ไม่ส่งซ้ำแม้ dispatcher สองตัวแย่งกัน, lease หมดแล้วจองใหม่ได้,
 * ล้างผู้รับ/token เมื่อจบ, log ไม่มีอีเมลหรือ token และ RLS แยก tenant
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  AccountEmailDispatcher,
  EmailSendError,
  SmtpEmailSender,
  enqueueAccountEmail,
  messageIdFor,
  type EmailSender,
  type EnqueueAccountEmail,
  type OutgoingEmail,
} from './account-email.js';

const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const SMTP_HOST = process.env.MAILPIT_SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? '1025');
const CONSOLE = 'http://localhost:5173';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

const mailpit = new SmtpEmailSender({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  fromAddress: 'no-reply@dcontact.local',
  helo: 'dcontact.local',
});
/** port ที่ไม่มีใครฟัง — จำลอง SMTP ล่ม */
const unreachable = new SmtpEmailSender({
  host: '127.0.0.1',
  port: 1,
  secure: false,
  fromAddress: 'no-reply@dcontact.local',
});

type MailpitMessage = {
  ID: string;
  MessageID: string;
  From: { Name: string; Address: string };
  To: Array<{ Address: string }>;
  Subject: string;
};

async function inbox(recipient: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${MAILPIT_API}/api/v1/search?${new URLSearchParams({ query: `to:"${recipient}"` })}`,
  );
  assert.equal(response.status, 200, 'mailpit ต้องรันอยู่ (dev stack)');
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

/** รอเงื่อนไขแบบมีเพดานเวลา — test ไม่ค้างถ้าเงื่อนไขไม่เกิด */
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `รอ ${label} เกิน 5 วินาที`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(t: TestContext) {
  const tenants = [randomUUID(), randomUUID()] as const;
  await owner.tenant.createMany({
    data: tenants.map((id) => ({
      id,
      name: `mail-${id.slice(0, 8)}`,
      slug: `mail-${id.slice(0, 8)}`,
      sipDomain: `${id}.mail.test`,
    })),
  });
  t.after(async () => {
    await owner.accountEmailOutbox.deleteMany({ where: { tenantId: { in: [...tenants] } } });
    await owner.tenant.deleteMany({ where: { id: { in: [...tenants] } } });
  });
  // available_at ตั้งด้วยเวลาของ Postgres ตอน insert — นาฬิกาของ test เริ่มนำหน้าเล็กน้อยให้งานใหม่ถึงเวลาทันที
  let clock = Date.now() + 5_000;
  const logs: Array<Record<string, unknown>> = [];
  const dispatcher = (sender: EmailSender, options: { maxAttempts?: number } = {}) =>
    new AccountEmailDispatcher(application, sender, {
      consoleUrl: CONSOLE,
      now: () => new Date(clock),
      log: (event) => logs.push(event),
      ...options,
    });
  const recipient = () => `ac3-${randomUUID().slice(0, 8)}@example.test`;
  const enqueue = (input: Partial<EnqueueAccountEmail<'verify-new-email'>> = {}) => {
    const job: EnqueueAccountEmail<'verify-new-email'> = {
      tenantId: tenants[0],
      template: 'verify-new-email',
      locale: 'th',
      recipient: recipient(),
      variables: { token: `token-${randomUUID()}`, expiresInMinutes: 30 },
      dedupeKey: `email-change:${randomUUID()}:verify`,
      ...input,
    };
    return withTenantDatabaseTransaction(application, job.tenantId, async (tx) => ({
      ...(await enqueueAccountEmail(tx, job)),
      job,
    }));
  };
  const row = (id: string) => owner.accountEmailOutbox.findUniqueOrThrow({ where: { id } });
  return {
    tenants,
    logs,
    dispatcher,
    enqueue,
    row,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('ส่งผ่าน SMTP สำเร็จ: ผู้ส่ง D-Contact, Message-ID คงที่, ลิงก์ของ Console และล้างผู้รับ/token เมื่อจบ', async (t) => {
  const f = await setup(t);
  const { id, created, job } = await f.enqueue();
  assert.equal(created, true);

  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), ['SENT']);
  const [message, ...rest] = await inbox(job.recipient);
  assert.equal(rest.length, 0);
  assert.equal(message!.MessageID, messageIdFor(id).slice(1, -1));
  assert.deepEqual(message!.From, { Name: 'D-Contact', Address: 'no-reply@dcontact.local' });
  assert.equal(message!.Subject, 'ยืนยันอีเมลใหม่ของบัญชี D-Contact');
  const detail = (await (await fetch(`${MAILPIT_API}/api/v1/message/${message!.ID}`)).json()) as {
    Text: string;
  };
  assert.ok(detail.Text.includes(`${CONSOLE}/?view=account&verify=${job.variables.token}`));

  const sent = await f.row(id);
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.attempts, 1);
  assert.ok(sent.sentAt);
  assert.equal(sent.recipient, null);
  assert.equal(sent.variables, null);

  // เรียกซ้ำ: ไม่มีงานค้าง ไม่ส่งซ้ำ
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), []);
  assert.equal((await inbox(job.recipient)).length, 1);
});

test('dedupeKey ซ้ำไม่เพิ่มงาน (เรียกซ้ำได้ ไม่ซ้ำผล)', async (t) => {
  const f = await setup(t);
  const first = await f.enqueue({ dedupeKey: 'password:1' });
  const again = await f.enqueue({ dedupeKey: 'password:1', recipient: first.job.recipient });
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);
  assert.equal(await owner.accountEmailOutbox.count({ where: { tenantId: f.tenants[0] } }), 1);
  // tenant อื่นใช้ key เดียวกันได้
  const other = await f.enqueue({ tenantId: f.tenants[1], dedupeKey: 'password:1' });
  assert.equal(other.created, true);

  await f.dispatcher(mailpit).drainTenant(f.tenants[0]);
  assert.equal((await inbox(first.job.recipient)).length, 1);
});

test('SMTP ล่ม: retry แบบ backoff แล้วส่งสำเร็จเมื่อ SMTP กลับมา — ส่งครั้งเดียว', async (t) => {
  const f = await setup(t);
  const { id, job } = await f.enqueue();
  const down = f.dispatcher(unreachable);

  assert.deepEqual(await down.drainTenant(f.tenants[0]), ['RETRY']);
  let failed = await f.row(id);
  assert.equal(failed.status, 'PENDING');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastErrorCode, 'SMTP_UNAVAILABLE');
  assert.ok(failed.recipient, 'ยังไม่จบ ต้องเก็บผู้รับไว้ส่งรอบหน้า');
  const firstRetryAt = failed.availableAt.getTime();

  // ยังไม่ถึงเวลา = ไม่ลองซ้ำ
  assert.deepEqual(await down.drainTenant(f.tenants[0]), []);
  f.advance(30_000);
  assert.deepEqual(await down.drainTenant(f.tenants[0]), ['RETRY']);
  failed = await f.row(id);
  assert.equal(failed.attempts, 2);
  assert.equal(failed.availableAt.getTime() - firstRetryAt, 60_000, 'backoff เพิ่มเป็นสองเท่า');

  f.advance(60_000);
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), ['SENT']);
  assert.equal((await f.row(id)).attempts, 3);
  assert.equal((await inbox(job.recipient)).length, 1);
});

test('5xx = DEAD ทันที; ล้มครบจำนวนครั้ง = DEAD; ทั้งสองกรณีล้างผู้รับ/token', async (t) => {
  const f = await setup(t);
  const rejected = await f.enqueue();
  const reject: EmailSender = {
    send: async () => {
      throw new EmailSendError('SMTP_REJECTED', true);
    },
  };
  assert.deepEqual(await f.dispatcher(reject).drainTenant(f.tenants[0]), ['DEAD']);
  const dead = await f.row(rejected.id);
  assert.deepEqual(
    [dead.status, dead.lastErrorCode, dead.recipient, dead.variables],
    ['DEAD', 'SMTP_REJECTED', null, null],
  );

  const flaky = await f.enqueue();
  const down = f.dispatcher(unreachable, { maxAttempts: 2 });
  assert.deepEqual(await down.drainTenant(f.tenants[0]), ['RETRY']);
  f.advance(30_000);
  assert.deepEqual(await down.drainTenant(f.tenants[0]), ['DEAD']);
  assert.equal((await f.row(flaky.id)).status, 'DEAD');
  assert.equal((await f.row(flaky.id)).recipient, null);
});

test('dispatcher สองตัวแย่งงานเดียวกัน: ส่งครั้งเดียว; lease หมด (process ตาย) แล้วจองใหม่ได้', async (t) => {
  const f = await setup(t);
  const { id } = await f.enqueue();
  const sent: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: EmailSender = {
    send: async (email: OutgoingEmail) => {
      sent.push(email.messageId);
      await gate;
    },
  };
  const first = f.dispatcher(slow).drainTenant(f.tenants[0]);
  // รอให้ตัวแรกจองแถวแล้ว
  await until(() => sent.length > 0, 'dispatcher ตัวแรกจองงาน');
  assert.deepEqual(await f.dispatcher(slow).drainTenant(f.tenants[0]), []);
  release();
  assert.deepEqual(await first, ['SENT']);
  assert.deepEqual(sent, [messageIdFor(id)]);

  // จองแล้ว process ตาย (ไม่ปิดงาน) → lease หมดแล้วตัวใหม่จองต่อได้ และตัวเก่าที่กลับมาปิดงานทับไม่ได้
  const crashed = await f.enqueue();
  const hung: EmailSender = { send: () => new Promise(() => undefined) };
  void f.dispatcher(hung).dispatchNext(f.tenants[0]);
  await until(async () => (await f.row(crashed.id)).status === 'SENDING', 'งานถูกจอง');
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), []);
  f.advance(60_001);
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), ['SENT']);
  const reclaimed = await f.row(crashed.id);
  assert.deepEqual([reclaimed.status, reclaimed.attempts], ['SENT', 2]);
});

test('log ไม่มีอีเมลผู้รับหรือ token', async (t) => {
  const f = await setup(t);
  const ok = await f.enqueue();
  const retry = await f.enqueue();
  await f.dispatcher(mailpit).dispatchNext(f.tenants[0]);
  await f.dispatcher(unreachable).dispatchNext(f.tenants[0]);
  const output = JSON.stringify(f.logs);
  assert.ok(f.logs.some((event) => event.type === 'account.email.sent'));
  assert.ok(f.logs.some((event) => event.type === 'account.email.retry'));
  for (const job of [ok.job, retry.job]) {
    assert.ok(!output.includes(job.recipient));
    assert.ok(!output.includes(job.variables.token));
  }
});

test('RLS: tenant อื่นอ่าน outbox ไม่เห็น และ role ของแอปลบแถวไม่ได้', async (t) => {
  const f = await setup(t);
  const { id } = await f.enqueue();
  const seen = await withTenantDatabaseTransaction(application, f.tenants[1], (tx) =>
    tx.accountEmailOutbox.findMany({ where: { id } }),
  );
  assert.deepEqual(seen, []);
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[1]), []);
  await assert.rejects(
    withTenantDatabaseTransaction(application, f.tenants[0], (tx) =>
      tx.accountEmailOutbox.deleteMany({ where: { id } }),
    ),
    /permission denied/,
  );
});

test.after(async () => {
  await owner.$disconnect();
  await application.$disconnect();
});
