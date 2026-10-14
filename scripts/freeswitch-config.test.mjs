import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const param = (xml, name) => xml.match(new RegExp(`<param name="${name}" value="([^"]*)"`))?.[1];

test('#667: synthetic inbound รอ Router โดยไม่ bridge แข่งกับ local dialplan', () => {
  const dialplan = read('infra/uat/e1-freeswitch/conf/dialplan/default.xml');
  const extensions = [...dialplan.matchAll(/<extension name="([^"]+)">([\s\S]*?)<\/extension>/g)];
  const inbound = extensions[0];
  assert.equal(extensions.length, 3);
  assert.equal(inbound?.[1], 'e1-synthetic-router-inbound');
  assert.match(
    inbound[2],
    /^\s*<condition field="caller_id_number" expression="\^1102\$"\/>\s*<condition field="destination_number" expression="\^1101\$">\s*(?:<action\b[^>]*\/>\s*){3}<\/condition>\s*$/,
  );
  assert.deepEqual(
    [...inbound[2].matchAll(/<condition field="([^"]+)" expression="([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
    [
      ['caller_id_number', '^1102$'],
      ['destination_number', '^1101$'],
    ],
  );
  assert.deepEqual(
    [...inbound[2].matchAll(/application="([^"]+)"/g)].map((match) => match[1]),
    ['set', 'set', 'park'],
  );
  assert.match(inbound[2], /data="domain_name=\$\$\{domain\}"/);
  assert.match(inbound[2], /data="park_timeout=30:NORMAL_TEMPORARY_FAILURE"/);
  assert.doesNotMatch(inbound[0], /continue="true"|break="never"|anti-action/);
  assert.equal(extensions[1]?.[1], 'e1-local-extensions');
  assert.match(
    extensions[1][2],
    /<condition field="destination_number" expression="\^\(1\[0-9\]\{3\}\)\$">/,
  );
  assert.match(extensions[1][2], /application="export" data="dialed_extension=\$1"/);
  assert.match(
    extensions[1][2],
    /application="bridge" data="user\/\$\{dialed_extension\}@\$\$\{domain\}"/,
  );
  assert.equal(extensions[2]?.[1], 'e1-deny-external-outbound');
  assert.match(extensions[2][2], /<condition field="destination_number" expression="\.\+">/);
  assert.match(extensions[2][2], /application="hangup" data="CALL_REJECTED"/);
});

test('#657: UAT WSS proxy ไม่ทำให้ FreeSWITCH advertise media เป็น Docker IP', () => {
  const profile = read('infra/uat/e1-freeswitch/conf/sip_profiles/internal.xml');
  assert.equal(param(profile, 'local-network-acl'), 'none');
  assert.equal(param(profile, 'ext-rtp-ip'), '$${external_rtp_ip}');
  assert.equal(param(profile, 'auth-calls'), 'true');
  assert.equal(param(profile, 'apply-candidate-acl'), 'dcontact_webrtc_candidates');
  assert.match(read('infra/uat/e1-freeswitch/conf/vars.xml'), /external_rtp_ip=192\.168\.102\.112/);
  assert.match(read('infra/uat/docker-compose.uat.yml'), /internal:\s*\n\s*internal: true/);
});

test('#562: trunk จำลอง pstn-sim รับสายเฉพาะ ACL บน 5080 และไม่รับ register', () => {
  const profile = read('infra/freeswitch/conf/sip_profiles/pstn-sim.xml');
  assert.equal(param(profile, 'sip-port'), '5080');
  assert.equal(param(profile, 'context'), 'pstn');
  assert.equal(param(profile, 'auth-calls'), 'true');
  assert.equal(param(profile, 'apply-inbound-acl'), 'dcontact_pstn_sim');
  assert.equal(param(profile, 'disable-register'), 'true');
  assert.equal(param(profile, 'accept-blind-auth'), 'false');
  assert.equal(param(profile, 'ws-binding'), undefined);

  const acl = read('infra/freeswitch/conf/autoload_configs/acl.conf.xml');
  const list = acl.match(/<list name="dcontact_pstn_sim" default="deny">([\s\S]*?)<\/list>/)?.[1];
  assert.ok(list, 'ต้องมี ACL dcontact_pstn_sim แบบ default deny');
  assert.match(list, /type="deny" cidr="172\.17\.0\.1\/32"/);
  assert.doesNotMatch(list, /0\.0\.0\.0\/0|default="allow"/);
});

test('#562: context pstn route ได้แค่ DID 2000/2001 ไป park ไม่มี bridge', () => {
  const dialplan = read('infra/freeswitch/conf/dialplan/pstn.xml');
  const context = dialplan.match(/<context name="pstn">([\s\S]*?)<\/context>/)?.[1];
  assert.ok(context);
  const expressions = [...context.matchAll(/expression="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(expressions, ['^200[01]$']);
  const applications = [...context.matchAll(/application="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(applications, ['set', 'park']);
});

test('#562: พอร์ต trunk จำลองไม่ publish ออก host', () => {
  const compose = read('infra/docker/docker-compose.dev.yml');
  const freeswitch = compose.slice(compose.indexOf('  freeswitch:'));
  assert.doesNotMatch(freeswitch.slice(0, freeswitch.indexOf('volumes:')), /5080/);
});

test('E1.10/#562: ไม่มี static SIP user หรือรหัสผ่าน dev ใน FreeSWITCH config และ SIPp fixture', () => {
  assert.doesNotMatch(read('infra/freeswitch/conf/directory/default.xml'), /<user\b/);
  const files = [
    ...readdirSync(resolve(root, 'infra/freeswitch/conf'), { recursive: true })
      .filter((file) => file.endsWith('.xml'))
      .map((file) => `infra/freeswitch/conf/${file}`),
    ...readdirSync(resolve(root, 'scripts/fixtures'))
      .filter((file) => file.endsWith('-uac.xml'))
      .map((file) => `scripts/fixtures/${file}`),
  ];
  assert.ok(files.length > 5);
  for (const file of files) {
    const content = read(file);
    assert.doesNotMatch(content, /DContactDev1|default_password/, file);
    assert.doesNotMatch(content, /\[authentication /, file);
  }
});
