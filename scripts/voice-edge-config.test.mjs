// #923 / ADR-038: the Kamailio voice edge rules that must not disappear when the config is edited
// the real behavior is tested with `bash infra/voice-edge/test/run.sh` (needs Docker)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const cfg = read('infra/voice-edge/kamailio/kamailio.cfg');
const route = (name) => {
  const start = cfg.indexOf(`route[${name}] {`);
  assert.ok(start >= 0, `route[${name}] must exist`);
  const next = cfg.indexOf('\nroute[', start + 1);
  const failure = cfg.indexOf('\nfailure_route[', start + 1);
  const ends = [next, failure].filter((index) => index > 0);
  return cfg.slice(start, ends.length ? Math.min(...ends) : undefined);
};

test('a call from the trunk strips X-DContact- from outside before putting in the tenant own domain', () => {
  const trunk = route('FROM_TRUNK');
  const removed = trunk.indexOf('remove_hf_re("^X-DContact-")');
  assert.ok(removed >= 0);
  assert.ok(removed < trunk.indexOf('append_hf("X-DContact-Domain'));
  assert.ok(removed < trunk.indexOf('sql_xquery'));
});

test('values a caller sets go through a regex before being in SQL', () => {
  const trunk = route('FROM_TRUNK');
  assert.ok(trunk.indexOf('$rU =~ "^\\+?[0-9]{3,20}$"') < trunk.indexOf('sql_xquery'));
  const media = route('FROM_MEDIA');
  assert.ok(media.indexOf('$hdr(X-DContact-Domain) == $null') < media.indexOf('sql_xquery'));
  assert.ok(media.indexOf('$fU =~ "^\\+?[0-9]{3,20}$"') < media.indexOf('sql_xquery'));
  for (const [name, body] of [
    ['FROM_TRUNK', trunk],
    ['FROM_MEDIA', media],
  ]) {
    const sql = body.slice(
      body.indexOf('sql_xquery'),
      body.indexOf(');', body.indexOf('sql_xquery')),
    );
    const variables = [...sql.matchAll(/\$[a-zA-Z]+(?:\([^)]*\))?/g)].map((match) => match[0]);
    assert.deepEqual(
      [...new Set(variables)].sort(),
      name === 'FROM_TRUNK' ? ['$rU', '$si'] : ['$fU', '$var(tenant)'],
      `${name} embeds a variable in SQL only with a checked value`,
    );
  }
});

test('an outbound call must use the tenant number and the trunk that number is bound to', () => {
  const media = route('FROM_MEDIA');
  assert.match(media, /JOIN trunk t ON t\.id = n\.trunk_id/);
  assert.match(media, /n\.e164 = '\$fU' AND n\.tenant_domain = '\$var\(tenant\)'/);
  assert.match(media, /\$du = "sip:" \+ \$xavp\(outb=>host\)/);
});

test('inbound and outbound calls count the concurrent call ceiling per tenant before the relay', () => {
  for (const name of ['FROM_TRUNK', 'FROM_MEDIA']) {
    const body = route(name);
    assert.ok(body.indexOf('route(TENANT_LIMIT)') >= 0, name);
    assert.ok(body.indexOf('route(TENANT_LIMIT)') < body.indexOf('route(RELAY)'), name);
  }
  assert.match(route('TENANT_LIMIT'), /set_dlg_profile\("tenant_calls", "\$var\(tenant\)"\)/);
});

test('separate outbound from inbound using only the FreeSWITCH list in the dispatcher', () => {
  assert.match(
    cfg,
    /if \(ds_is_from_list\(DS_MEDIA\)\) \{\s*route\(FROM_MEDIA\);\s*\} else \{\s*route\(FROM_TRUNK\);/,
  );
});

test('Kamailio reads the voice edge database with a read-only role and there is no password in the repo', () => {
  const grant = read('infra/voice-edge/grant-kamailio.sql');
  assert.match(grant, /default_transaction_read_only = on/);
  assert.match(grant, /GRANT SELECT ON tenant_edge, trunk, number TO kamailio_ro/);
  assert.doesNotMatch(grant, /GRANT (INSERT|UPDATE|DELETE|ALL)/i);
  assert.match(grant, /PASSWORD :'kamailio_password'/);
  assert.doesNotMatch(cfg, /postgres:\/\/[^"\s]*:[^"\s]*@/);
});
