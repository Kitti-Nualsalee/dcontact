import { PrismaClient } from '@d-contact/db';
import { createDlqPublisher, createProducer } from '@d-contact/kafka';
import { CasesEnsureCaseService } from './cases-ensure-case-service.js';
import { createCasesOwnerCommandConsumer } from './cases-owner-command-consumer.js';

const database = new PrismaClient();
const producer = await createProducer('dcontact-cases-publisher');
const dlq = await createDlqPublisher('dcontact-cases-dlq');
// J2.8 (#136): Cases รับ ENSURE_CASE จาก Journey ทาง Kafka และตอบผลกลับ dc.case.events
const consumer = await createCasesOwnerCommandConsumer({
  owner: new CasesEnsureCaseService(database),
  producer,
  clientId: 'dcontact-cases-owner-command-consumer',
  groupId: process.env.CASES_OWNER_COMMAND_CONSUMER_GROUP_ID ?? 'dcontact-cases-owner-commands-v1',
  dlq,
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.all([
    consumer.disconnect(),
    producer.disconnect(),
    dlq.disconnect(),
    database.$disconnect(),
  ]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
