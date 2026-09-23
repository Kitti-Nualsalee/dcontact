/**
 * entry ของ process LINE webhook สำหรับ S2 local pilot (S2.5 #369)
 *
 * ต้องการ env ที่ไม่ใช่ความลับเท่านั้น (ดู `lineWebhookConfigFromEnv`) — secret อ่านจาก Keychain
 * log เป็น JSON บรรทัดเดียว มีแค่ status/code/เวลา/จำนวน ไม่มี header, body หรือ event ID
 */
import { PrismaClient } from '@d-contact/db';
import { MacosKeychainSecretSource } from './line-keychain.js';
import { lineWebhookConfigFromEnv, startLineWebhookRuntime } from './line-webhook-runtime.js';

const config = lineWebhookConfigFromEnv(process.env);
const database = new PrismaClient();
const log = (entry: object) =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);

const runtime = await startLineWebhookRuntime(config, {
  database,
  secrets: new MacosKeychainSecretSource(),
  log,
});
log({ code: 'LINE_WEBHOOK_LISTENING', port: config.port });

const shutdown = async () => {
  await runtime.stop();
  await database.$disconnect();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
