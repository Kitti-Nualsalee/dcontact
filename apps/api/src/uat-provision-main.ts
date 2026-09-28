/**
 * Entrypoint ของ CLI provision tenant/บัญชี/fixture pack ของ UAT (U1.8 #502) — one-shot ใน ops image
 * (`docker compose --profile ops run --rm uat-provision --input /run/uat-provision.json [--check]`)
 * ไม่ใช่ส่วนของ API server และไม่ถูก import จาก `uat-main.ts`/`main.ts`
 */
import { runUatProvisionCli } from './uat-provision.js';

void runUatProvisionCli(process.argv.slice(2), process.env, (line) => {
  process.stdout.write(`${line}\n`);
}).then((code) => {
  process.exitCode = code;
});
