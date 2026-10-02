import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

test('FreeSWITCH dialplan ปฏิเสธ agent direct outbound นอก internal sandbox routes', () => {
  const dialplan = readFileSync(
    resolve(process.cwd(), '../../infra/freeswitch/conf/dialplan/default.xml'),
    'utf8',
  );
  assert.match(dialplan, /extension name="deny-agent-direct-outbound"/);
  assert.match(dialplan, /caller_id_number" expression="\^1\[0-9\]\{3\}\$"/);
  assert.match(dialplan, /application="hangup" data="CALL_REJECTED"/);
});
