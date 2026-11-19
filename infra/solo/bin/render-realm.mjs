#!/usr/bin/env node
// #923: realm ของ UAT Solo = realm dev (infra/keycloak/realm-dcontact.dev.json) ที่เปลี่ยน redirect/web origin
// ของ client agent-desktop เป็นโดเมนของ Solo ทั้ง Console และ Workspace
//
//   node infra/solo/bin/render-realm.mjs <console host> <workspace host> > realm-dcontact.json
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [consoleHost, workspaceHost] = process.argv.slice(2);
const hostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
if (!hostname.test(consoleHost ?? '') || !hostname.test(workspaceHost ?? '')) {
  console.error('usage: render-realm.mjs <console host> <workspace host>');
  process.exit(64);
}

const realm = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../keycloak/realm-dcontact.dev.json'), 'utf8'),
);
const origins = [`https://${consoleHost}`, `https://${workspaceHost}`];
const desktop = realm.clients.find((client) => client.clientId === 'agent-desktop');
if (!desktop) throw new Error('realm dev ไม่มี client agent-desktop');
desktop.redirectUris = origins.map((origin) => `${origin}/*`);
desktop.webOrigins = origins;
desktop.attributes = {
  ...desktop.attributes,
  'post.logout.redirect.uris': origins.map((origin) => `${origin}/*`).join('##'),
};

if (JSON.stringify(realm).includes('localhost')) {
  throw new Error('realm ของ Solo ยังมี localhost เหลืออยู่');
}
process.stdout.write(`${JSON.stringify(realm, null, 2)}\n`);
