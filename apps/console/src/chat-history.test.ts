import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentHistoryApi } from './agent-history/api.js';
import { channelFrom, filterHref, listQuery } from './agent-history/model.js';
import {
  closedByKey,
  isWorkTranscript,
  toTranscriptMessages,
  writtenCount,
  type WorkTranscript,
} from './chat-history/transcript.js';
import { createTeamHistoryApi, teamListQuery } from './team-history/api.js';

const transcript = (change: Partial<WorkTranscript> = {}): WorkTranscript => ({
  interactionId: '7f3c2e10-8b1d-4c2a-9e5f-a91e00000001',
  channel: 'WEBCHAT',
  endReason: 'AGENT_ENDED',
  customerLinked: true,
  messages: [
    { id: 'm1', at: '2026-11-27T03:29:00.000Z', from: 'visitor', text: 'Hello' },
    { id: 'm2', at: '2026-11-27T03:31:00.000Z', from: 'system', event: 'AGENT_JOINED' },
    { id: 'm3', at: '2026-11-27T03:31:30.000Z', from: 'agent', text: 'Hi, how can I help?' },
    { id: 'm4', at: '2026-11-27T03:39:00.000Z', from: 'system', event: 'AGENT_ENDED' },
  ],
  ...change,
});

test('the channel in the URL is one of the two channels, anything else means every channel', () => {
  assert.equal(channelFrom('VOICE'), 'VOICE');
  assert.equal(channelFrom('WEBCHAT'), 'WEBCHAT');
  assert.equal(channelFrom('webchat'), undefined);
  assert.equal(channelFrom(null), undefined);
});

test('the list asks for a channel only when one is chosen, for both history pages', () => {
  assert.equal(new URLSearchParams(listQuery({ from: null, to: null })).has('channel'), false);
  assert.equal(
    new URLSearchParams(listQuery({ from: null, to: null, channel: 'WEBCHAT' })).get('channel'),
    'WEBCHAT',
  );
  assert.equal(
    new URLSearchParams(
      teamListQuery({ from: null, to: null, channel: 'VOICE', teamId: 't1' }),
    ).get('channel'),
    'VOICE',
  );
});

test('the channel is kept in or removed from the page URL along with the other filters', () => {
  const href = 'https://console.test/?view=team-history&tenant=demo&period=30d';
  const chat = new URL(filterHref(href, '30d', undefined, 'WEBCHAT'));
  assert.equal(chat.searchParams.get('channel'), 'WEBCHAT');
  assert.equal(chat.searchParams.get('view'), 'team-history');
  const all = new URL(filterHref(chat.toString(), '30d', undefined));
  assert.equal(all.searchParams.has('channel'), false);
});

test('a conversation is read from the server only when it has the documented shape', () => {
  assert.equal(isWorkTranscript(transcript()), true);
  assert.equal(
    isWorkTranscript(transcript({ channel: 'VOICE', endReason: null, messages: [] })),
    true,
  );
  assert.equal(isWorkTranscript({ ...transcript(), endReason: 'SOMETHING' }), false);
  assert.equal(isWorkTranscript({ ...transcript(), messages: [{ id: 'x' }] }), false);
  assert.equal(isWorkTranscript(null), false);
});

test('visitor on the left, agent on the right, system lines centred, every line names its sender', () => {
  const lines = toTranscriptMessages(transcript(), {
    visitor: 'Visitor',
    agent: 'Pakorn',
    time: (at) => at.slice(11, 16),
    system: (event) => `system:${event}`,
  });
  assert.deepEqual(
    lines.map((line) => [line.side, line.author, line.text, line.time]),
    [
      ['other', 'Visitor', 'Hello', '03:29'],
      ['system', undefined, 'system:AGENT_JOINED', '03:31'],
      ['self', 'Pakorn', 'Hi, how can I help?', '03:31'],
      ['system', undefined, 'system:AGENT_ENDED', '03:39'],
    ],
  );
  assert.equal(writtenCount(transcript()), 2);
});

test('who closed the chat comes from how it ended', () => {
  assert.equal(closedByKey('AGENT_ENDED'), 'AGENT');
  assert.equal(closedByKey('CUSTOMER_ENDED'), 'CUSTOMER');
  assert.equal(closedByKey('CUSTOMER_LEFT'), 'CUSTOMER');
  assert.equal(closedByKey('IDLE_TIMEOUT'), 'IDLE');
  assert.equal(closedByKey(null), null);
});

test('the transcript is read from the endpoint of each page and a bad id never reaches the network', async () => {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    return new Response(JSON.stringify(transcript()), { status: 200 });
  }) as typeof fetch;
  try {
    const id = '7f3c2e10-8b1d-4c2a-9e5f-a91e00000001';
    const agent = createAgentHistoryApi({ baseUrl: 'https://api.test', accessToken: () => 't' });
    const team = createTeamHistoryApi({ baseUrl: 'https://api.test', accessToken: () => 't' });
    assert.equal((await agent.transcript(id)).channel, 'WEBCHAT');
    assert.equal((await team.transcript(id)).channel, 'WEBCHAT');
    assert.deepEqual(urls, [
      `https://api.test/api/v1/workspace/agent/history/${id}/transcript`,
      `https://api.test/api/v1/team-history/items/${id}/transcript`,
    ]);
    await assert.rejects(
      agent.transcript('not-an-id'),
      (error: unknown) => (error as { status: number }).status === 404,
    );
    await assert.rejects(
      team.transcript('../x'),
      (error: unknown) => (error as { status: number }).status === 404,
    );
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
