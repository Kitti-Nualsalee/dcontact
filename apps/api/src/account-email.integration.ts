/**
 * AC3 (#596) on real Postgres with the app role (`dcontact_app`, RLS) and the dev stack's mailpit:
 * sent successfully (sender name D-Contact, a fixed Message-ID), a repeated dedupeKey adds no work, SMTP fails then retries with backoff,
 * 5xx/attempts exhausted = DEAD, no duplicate send even when two dispatchers compete, an expired lease can be claimed again,
 * the recipient/token is cleared when finished, the log has no email or token, and RLS separates tenants
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
/** a port nobody listens on — simulates SMTP being down */
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
  assert.equal(response.status, 200, 'mailpit must be running (dev stack)');
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

/** waits for a condition with a time ceiling — the test does not hang if the condition never happens */
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `waiting for ${label} exceeded 5 seconds`);
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
  // available_at is set with Postgres time at insert — the test clock starts slightly ahead so the new job is due immediately
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

test('sends through SMTP successfully: sender D-Contact, a fixed Message-ID, a Console link, and the recipient/token cleared when finished', async (t) => {
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

  // calling again: no pending work, no duplicate send
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), []);
  assert.equal((await inbox(job.recipient)).length, 1);
});

test('a repeated dedupeKey adds no work (can be called again without a duplicate result)', async (t) => {
  const f = await setup(t);
  const first = await f.enqueue({ dedupeKey: 'password:1' });
  const again = await f.enqueue({ dedupeKey: 'password:1', recipient: first.job.recipient });
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);
  assert.equal(await owner.accountEmailOutbox.count({ where: { tenantId: f.tenants[0] } }), 1);
  // another tenant can use the same key
  const other = await f.enqueue({ tenantId: f.tenants[1], dedupeKey: 'password:1' });
  assert.equal(other.created, true);

  await f.dispatcher(mailpit).drainTenant(f.tenants[0]);
  assert.equal((await inbox(first.job.recipient)).length, 1);
});

test('SMTP down: retry with backoff then sent successfully once SMTP is back — sent once', async (t) => {
  const f = await setup(t);
  const { id, job } = await f.enqueue();
  const down = f.dispatcher(unreachable);

  assert.deepEqual(await down.drainTenant(f.tenants[0]), ['RETRY']);
  let failed = await f.row(id);
  assert.equal(failed.status, 'PENDING');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastErrorCode, 'SMTP_UNAVAILABLE');
  assert.ok(failed.recipient, 'not finished yet, the recipient must be kept for the next round');
  const firstRetryAt = failed.availableAt.getTime();

  // not due yet = no retry
  assert.deepEqual(await down.drainTenant(f.tenants[0]), []);
  f.advance(30_000);
  assert.deepEqual(await down.drainTenant(f.tenants[0]), ['RETRY']);
  failed = await f.row(id);
  assert.equal(failed.attempts, 2);
  assert.equal(failed.availableAt.getTime() - firstRetryAt, 60_000, 'backoff doubles');

  f.advance(60_000);
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), ['SENT']);
  assert.equal((await f.row(id)).attempts, 3);
  assert.equal((await inbox(job.recipient)).length, 1);
});

test('5xx = DEAD at once; failing the full number of attempts = DEAD; both cases clear the recipient/token', async (t) => {
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

test('two dispatchers compete for the same job: sent once; the lease expires (process dies) and can be claimed again', async (t) => {
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
  // wait until the first one has claimed the row
  await until(() => sent.length > 0, 'the first dispatcher claims the job');
  assert.deepEqual(await f.dispatcher(slow).drainTenant(f.tenants[0]), []);
  release();
  assert.deepEqual(await first, ['SENT']);
  assert.deepEqual(sent, [messageIdFor(id)]);

  // claimed then the process dies (the job is not closed) → the lease expires, a new one can claim it, and the old one coming back cannot close over it
  const crashed = await f.enqueue();
  const hung: EmailSender = { send: () => new Promise(() => undefined) };
  void f.dispatcher(hung).dispatchNext(f.tenants[0]);
  await until(async () => (await f.row(crashed.id)).status === 'SENDING', 'the job is claimed');
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), []);
  f.advance(60_001);
  assert.deepEqual(await f.dispatcher(mailpit).drainTenant(f.tenants[0]), ['SENT']);
  const reclaimed = await f.row(crashed.id);
  assert.deepEqual([reclaimed.status, reclaimed.attempts], ['SENT', 2]);
});

test('the log has no recipient email or token', async (t) => {
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

test('RLS: another tenant cannot see the outbox, and the app role cannot delete rows', async (t) => {
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
