/**
 * Entrypoint of the CLI that provisions a UAT tenant/accounts/fixture pack (U1.8 #502) — a one-shot in the ops image
 * (`docker compose --profile ops run --rm uat-provision --input /run/uat-provision.json [--check]`)
 * not part of the API server and never imported from `uat-main.ts`/`main.ts`
 */
import { runUatProvisionCli } from './uat-provision.js';

void runUatProvisionCli(process.argv.slice(2), process.env, (line) => {
  process.stdout.write(`${line}\n`);
}).then((code) => {
  process.exitCode = code;
});
