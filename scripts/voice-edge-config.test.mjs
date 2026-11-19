// #923 / ADR-038: กติกาของ Kamailio voice edge ที่ต้องไม่หายไปเมื่อแก้ config
// พฤติกรรมจริงทดสอบด้วย `bash infra/voice-edge/test/run.sh` (ต้องมี Docker)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const cfg = read('infra/voice-edge/kamailio/kamailio.cfg');
const route = (name) => {
  const start = cfg.indexOf(`route[${name}] {`);
  assert.ok(start >= 0, `ต้องมี route[${name}]`);
  const next = cfg.indexOf('\nroute[', start + 1);
  const failure = cfg.indexOf('\nfailure_route[', start + 1);
  const ends = [next, failure].filter((index) => index > 0);
  return cfg.slice(start, ends.length ? Math.min(...ends) : undefined);
};

test('สายจาก trunk ลบ X-DContact- จากภายนอกก่อนใส่ domain ของ tenant เอง', () => {
  const trunk = route('FROM_TRUNK');
  const removed = trunk.indexOf('remove_hf_re("^X-DContact-")');
  assert.ok(removed >= 0);
  assert.ok(removed < trunk.indexOf('append_hf("X-DContact-Domain'));
  assert.ok(removed < trunk.indexOf('sql_xquery'));
});

test('ค่าที่ผู้โทรกำหนดผ่าน regex ก่อนอยู่ใน SQL', () => {
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
      `${name} ฝังตัวแปรใน SQL ได้เฉพาะค่าที่ตรวจแล้ว`,
    );
  }
});

test('สายออกต้องใช้เบอร์ของ tenant และ trunk ที่เบอร์นั้นผูกอยู่', () => {
  const media = route('FROM_MEDIA');
  assert.match(media, /JOIN trunk t ON t\.id = n\.trunk_id/);
  assert.match(media, /n\.e164 = '\$fU' AND n\.tenant_domain = '\$var\(tenant\)'/);
  assert.match(media, /\$du = "sip:" \+ \$xavp\(outb=>host\)/);
});

test('สายเข้าและสายออกนับเพดานสายพร้อมกันต่อ tenant ก่อน relay', () => {
  for (const name of ['FROM_TRUNK', 'FROM_MEDIA']) {
    const body = route(name);
    assert.ok(body.indexOf('route(TENANT_LIMIT)') >= 0, name);
    assert.ok(body.indexOf('route(TENANT_LIMIT)') < body.indexOf('route(RELAY)'), name);
  }
  assert.match(route('TENANT_LIMIT'), /set_dlg_profile\("tenant_calls", "\$var\(tenant\)"\)/);
});

test('แยกสายออกจากสายเข้าด้วยรายชื่อ FreeSWITCH ใน dispatcher เท่านั้น', () => {
  assert.match(
    cfg,
    /if \(ds_is_from_list\(DS_MEDIA\)\) \{\s*route\(FROM_MEDIA\);\s*\} else \{\s*route\(FROM_TRUNK\);/,
  );
});

test('Kamailio อ่านฐาน voice edge ด้วย role อ่านอย่างเดียว และไม่มีรหัสผ่านใน repo', () => {
  const grant = read('infra/voice-edge/grant-kamailio.sql');
  assert.match(grant, /default_transaction_read_only = on/);
  assert.match(grant, /GRANT SELECT ON tenant_edge, trunk, number TO kamailio_ro/);
  assert.doesNotMatch(grant, /GRANT (INSERT|UPDATE|DELETE|ALL)/i);
  assert.match(grant, /PASSWORD :'kamailio_password'/);
  assert.doesNotMatch(cfg, /postgres:\/\/[^"\s]*:[^"\s]*@/);
});
