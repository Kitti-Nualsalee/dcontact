import assert from 'node:assert/strict';
import test from 'node:test';
import { smtpServerRepresentation } from './keycloak-provisioning-setup.mjs';

test('dev: the Keycloak SMTP points at mailpit with no auth and the sender name D-Contact', () => {
  assert.deepEqual(smtpServerRepresentation({}), {
    host: 'mailpit',
    port: '1025',
    from: 'no-reply@dcontact.local',
    fromDisplayName: 'D-Contact',
    ssl: 'false',
    starttls: 'true',
    auth: 'false',
  });
});

test('AC3 (#596): uses the same SMTP set as the API - the name in FROM is replaced by D-Contact, auth when there is a user', () => {
  assert.deepEqual(
    smtpServerRepresentation({
      KEYCLOAK_SMTP_HOST: 'osd-co-th.mail.protection.outlook.com',
      KEYCLOAK_SMTP_PORT: '25',
      KEYCLOAK_SMTP_FROM: '"OSD Exercise Event" <osd-event@osd.co.th>',
      KEYCLOAK_SMTP_SECURE: 'false',
    }),
    {
      host: 'osd-co-th.mail.protection.outlook.com',
      port: '25',
      from: 'osd-event@osd.co.th',
      fromDisplayName: 'D-Contact',
      ssl: 'false',
      starttls: 'true',
      auth: 'false',
    },
  );
  const secure = smtpServerRepresentation({
    KEYCLOAK_SMTP_HOST: 'smtp.example.test',
    KEYCLOAK_SMTP_PORT: '465',
    KEYCLOAK_SMTP_FROM: 'no-reply@example.test',
    KEYCLOAK_SMTP_SECURE: 'true',
    KEYCLOAK_SMTP_USER: 'relay',
    KEYCLOAK_SMTP_PASSWORD: 'secret',
  });
  assert.deepEqual(
    [secure.ssl, secure.starttls, secure.auth, secure.user, secure.password],
    ['true', 'false', 'true', 'relay', 'secret'],
  );
});
