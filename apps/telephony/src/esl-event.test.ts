import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEslEvent } from './esl-event.js';

test('parses FreeSWITCH plain event payload after ESL framing headers', () => {
  assert.deepEqual(
    parseEslEvent(
      'Content-Type: text/event-plain\nContent-Length: 80\n\nEvent-Name: CHANNEL_CREATE\nUnique-ID: call-1\nvariable_domain_name: demo.local\n\n',
    ),
    {
      'Event-Name': 'CHANNEL_CREATE',
      'Unique-ID': 'call-1',
      variable_domain_name: 'demo.local',
    },
  );
});
