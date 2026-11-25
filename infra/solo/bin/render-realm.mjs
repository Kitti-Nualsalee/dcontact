#!/usr/bin/env node
// #923: the UAT Solo realm = the dev realm (infra/keycloak/realm-dcontact.dev.json) with the redirect/web origin
// of the agent-desktop client changed to the Solo domains for both Console and Workspace
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
if (!desktop) throw new Error('the dev realm has no agent-desktop client');
desktop.redirectUris = origins.map((origin) => `${origin}/*`);
desktop.webOrigins = origins;
desktop.attributes = {
  ...desktop.attributes,
  'post.logout.redirect.uris': origins.map((origin) => `${origin}/*`).join('##'),
};

// #977: Tenant People sends invitations through the realm SMTP — Solo uses Mailpit in the stack network (nothing leaves the stack)
// only takes effect when the realm is first imported; an existing realm must be configured through the Admin API (see docs/solo-uat.md)
realm.smtpServer = {
  host: 'mailpit',
  port: '1025',
  from: 'no-reply@dcontact.local',
  fromDisplayName: 'D-Contact',
  ssl: 'false',
  starttls: 'false',
  auth: 'false',
};

if (JSON.stringify(realm).includes('localhost')) {
  throw new Error('the Solo realm still contains localhost');
}
process.stdout.write(`${JSON.stringify(realm, null, 2)}\n`);
