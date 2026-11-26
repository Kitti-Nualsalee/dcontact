#!/usr/bin/env node
/**
 * Example client of the External customer API (#954): request a client_credentials token → create a customer →
 * read it back → search by email. Uses the public HTTP API only, with no database credentials
 *
 *   API_BASE_URL=http://localhost:3000 \
 *   TOKEN_URL=http://localhost:8081/realms/dcontact/protocol/openid-connect/token \
 *   CLIENT_ID=<service client> CLIENT_SECRET=<secret> \
 *   node examples/external-customer-api/client.mjs
 *
 * The output is a single JSON line; it never prints a token, secret or customer data
 */
import { randomUUID } from 'node:crypto';

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};
const api = `${need('API_BASE_URL').replace(/\/$/, '')}/api/v1/customer-360`;

async function accessToken() {
  const response = await fetch(need('TOKEN_URL'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: need('CLIENT_ID'),
      client_secret: need('CLIENT_SECRET'),
    }),
  });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

async function call(token, method, path, body) {
  const response = await fetch(`${api}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Resend the same commandId when the result is still uncertain (network drop, 429, 503): the server does not create the customer twice
 * Change the commandId only when you intend to create another customer
 */
async function createContact(token, profile) {
  const commandId = randomUUID();
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let result;
    try {
      result = await call(token, 'POST', 'contacts', { commandId, ...profile });
    } catch {
      result = { status: 0, body: null };
    }
    if (result.status === 201 || result.status === 200) return result.body.command;
    if (![0, 429, 503].includes(result.status))
      throw new Error(
        `creating the customer failed: HTTP ${result.status} ${result.body?.error?.code ?? ''}`,
      );
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(
    'creating the customer failed after retries; check the result with GET commands/:commandId',
  );
}

const token = await accessToken();
const email = `example-${randomUUID().slice(0, 8)}@example.test`;
const receipt = await createContact(token, {
  displayName: 'Sample customer from an external system',
  company: 'Example Co., Ltd.',
  points: [{ kind: 'EMAIL', value: email }],
});
// the receipt has no customer data, so read the current values back yourself
const contactId = receipt.resourceRefs[0]?.id;
if (!contactId) throw new Error('the receipt has no readable Contact');
const profile = await call(token, 'GET', `contacts/${contactId}`);
if (profile.status !== 200) throw new Error(`reading the customer failed: HTTP ${profile.status}`);
const search = await call(token, 'POST', 'contacts/search', { type: 'EMAIL', query: email });
if (search.status !== 200)
  throw new Error(`searching for the customer failed: HTTP ${search.status}`);
const found = search.body.items.some((item) => item.contactId === contactId);
if (!found) throw new Error('the email search did not find the customer that was just created');
console.log(JSON.stringify({ result: 'PASS', contactId, readback: true, searchFound: true }));
