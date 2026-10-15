import { PrismaClient } from '@d-contact/db';
import { runE1VoiceControl } from './e1-voice-control.js';

async function main() {
  if (process.env.E1_SANDBOX_ENABLED !== 'true') throw new Error('E1_SANDBOX_REQUIRED');
  const database = new PrismaClient();
  try {
    console.log(
      JSON.stringify(
        await runE1VoiceControl(
          database,
          process.argv.slice(2),
          process.env.E1_VOICE_TENANT_ID ?? '',
          process.env.TELEPHONY_NODE_ID ?? '',
        ),
      ),
    );
  } finally {
    await database.$disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('E1_VOICE_CONTROL_FAILED; ตรวจ arguments/scope ผ่าน operator โดยไม่พิมพ์ secret');
    process.exitCode = 1;
  });
}
