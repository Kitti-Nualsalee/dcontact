import { expect, test, type Page } from '@playwright/test';
import { th } from './support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const READY_AGENT = 'Somying Jaidee';
const [ITEM_HEAD, ITEM_TAIL] = th('recordings:itemTitle', {
  time: '{TIME}',
  agent: READY_AGENT,
}).split('{TIME}');
const LISTEN_READY = new RegExp(
  `^${escapeRegExp(th('recordings:listen'))}${escapeRegExp(ITEM_HEAD!)}.*${escapeRegExp(ITEM_TAIL!)}`,
);
test.use({ locale: 'th-TH' });

const RATE = 8000;
const SECONDS = 12;
const ready = '0b7f8f0e-6a4f-4a7e-9a3e-0f5d6f2a9c11';
const archiving = '3c2d1b0a-9f8e-4d7c-8b6a-5e4f3d2c1b0a';
const session = '6f1e2d3c-4b5a-4978-8a6b-7c8d9e0f1a2b';

interface Fixture {
  chunks: { startFrame: number; frameCount: number; url: string; authorization?: string }[];
  opened: number;
  closed: number;
  /** permission revoked: the next chunk answers 404 */
  revoked: boolean;
}

/** WAV mono 16 bit of a 440 Hz tone for the requested frame range */
function wav(startFrame: number, frameCount: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + frameCount * 2, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(frameCount * 2, 40);
  const pcm = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame++) {
    const sample = Math.sin(((startFrame + frame) / RATE) * 2 * Math.PI * 440) * 8000;
    pcm.writeInt16LE(Math.round(sample), frame * 2);
  }
  return Buffer.concat([header, pcm]);
}

const item = (recordingId: string, status: 'READY' | 'ARCHIVING', agentName: string) => ({
  recordingId,
  interactionId: recordingId,
  status,
  startedAt: '2026-11-20T03:00:00.000Z',
  endedAt: '2026-11-20T03:00:12.000Z',
  durationSec: SECONDS,
  channelLayout: 'STEREO',
  queueName: 'Support',
  agentName,
  capabilities: { play: status === 'READY' },
});

async function mockRecordings(page: Page, fixture: Fixture) {
  await page.route('**/api/v1/recordings/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1/recordings', '');
    if (request.method() === 'GET' && path === '/history')
      return route.fulfill({
        json: {
          asOf: '2026-11-22T00:00:00.000Z',
          items: [item(archiving, 'ARCHIVING', 'Pakorn Srisuk'), item(ready, 'READY', READY_AGENT)],
          nextCursor: null,
        },
      });
    if (path === `/${ready}/playback-sessions`) {
      fixture.opened += 1;
      if (fixture.revoked)
        return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      return route.fulfill({
        status: 201,
        json: {
          sessionId: session,
          expiresAt: '2026-11-22T00:05:00.000Z',
          transport: 'API_CHUNKS',
          format: {
            sampleRate: RATE,
            channels: 1,
            bitsPerSample: 16,
            totalFrames: RATE * SECONDS,
            maxChunkFrames: RATE * 2,
          },
        },
      });
    }
    if (path === `/${ready}/playback-sessions/${session}/chunks`) {
      if (fixture.revoked)
        return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
      const body = request.postDataJSON() as { startFrame: number; frameCount: number };
      fixture.chunks.push({
        ...body,
        url: request.url(),
        authorization: request.headers().authorization,
      });
      return route.fulfill({
        contentType: 'audio/wav',
        body: wav(body.startFrame, body.frameCount),
      });
    }
    if (path === `/${ready}/playback-sessions/${session}/close`) {
      fixture.closed += 1;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404, json: { code: 'RESOURCE_NOT_FOUND' } });
  });
}

const newFixture = (): Fixture => ({ chunks: [], opened: 0, closed: 0, revoked: false });
const requestedSeconds = (fixture: Fixture) =>
  Math.max(0, ...fixture.chunks.map((chunk) => chunk.startFrame + chunk.frameCount)) / RATE;

test('a Supervisor opens the list, listens range by range, pauses, and seeks', async ({ page }) => {
  const fixture = newFixture();
  await mockRecordings(page, fixture);
  await page.goto('/?view=team-recordings&tenant=demo');

  await expect(page.getByRole('heading', { name: th('recordings:title'), level: 1 })).toBeVisible();
  const grid = page.getByRole('grid', { name: th('recordings:list') });
  await expect(grid).toContainText(READY_AGENT);
  await expect(grid).toContainText(th('recordings:recordingStatus.ARCHIVING'));
  // audio not yet stored has no listen button and no download link on the page
  await expect(
    grid.getByRole('button', { name: new RegExp(`^${escapeRegExp(th('recordings:listen'))}`) }),
  ).toHaveCount(1);
  await expect(page.getByRole('link', { name: /ดาวน์โหลด|download/i })).toHaveCount(0); // allow-thai: negative check for a Thai download label, not a catalog value

  await grid.getByRole('button', { name: LISTEN_READY }).click();
  const player = page.getByRole('region', { name: new RegExp(escapeRegExp(READY_AGENT)) });
  await expect(player.getByRole('heading', { level: 2 })).toBeFocused();
  // no audio is requested until play is pressed
  expect(fixture.opened).toBe(0);
  await player.getByRole('button', { name: th('recordings:player.play'), exact: true }).click();
  await expect(player.getByRole('status')).toHaveText(th('recordings:player.phase.playing'));
  await expect(player.getByRole('button', { name: th('recordings:player.pause') })).toBeVisible();

  // after playing about 1 second: audio is requested ahead by no more than 4 seconds, not the whole 12-second file
  await expect
    .poll(() => page.getByRole('slider', { name: th('recordings:player.position') }).inputValue())
    .not.toBe('0');
  expect(requestedSeconds(fixture)).toBeLessThanOrEqual(4);
  for (const chunk of fixture.chunks) {
    expect(chunk.frameCount).toBeLessThanOrEqual(RATE * 2);
    // the token is in the header only, not in the audio URL
    expect(new URL(chunk.url).search).toBe('');
    expect(chunk.authorization).toMatch(/^Bearer /);
  }

  await player.getByRole('button', { name: th('recordings:player.pause') }).click();
  await expect(player.getByRole('status')).toHaveText(th('recordings:player.phase.paused'));
  const requestedAtPause = fixture.chunks.length;
  await page.waitForTimeout(700);
  expect(fixture.chunks.length).toBe(requestedAtPause);

  // seek to second 8 then keep playing: a new range is requested from that position
  await page.getByRole('slider', { name: th('recordings:player.position') }).fill('8');
  await player.getByRole('button', { name: th('recordings:player.play'), exact: true }).click();
  await expect(player.getByRole('status')).toHaveText(th('recordings:player.phase.playing'));
  expect(fixture.chunks.slice(requestedAtPause)[0]?.startFrame).toBe(RATE * 8);
  await expect(player.getByRole('status')).toHaveText(th('recordings:player.phase.ended'), {
    timeout: 10_000,
  });
  expect(requestedSeconds(fixture)).toBe(SECONDS);

  await player.getByRole('button', { name: th('recordings:player.close') }).click();
  await expect(player).toHaveCount(0);
  // after closing, focus returns to the listen button of the original row
  await expect(grid.getByRole('button', { name: LISTEN_READY })).toBeFocused();
  await expect.poll(() => fixture.closed).toBe(1);
});

test('permission revoked while listening: the audio stops and states the reason, and does not request the next range', async ({
  page,
}) => {
  const fixture = newFixture();
  await mockRecordings(page, fixture);
  await page.goto('/?view=team-recordings&tenant=demo');
  await page.getByRole('button', { name: LISTEN_READY }).click();
  const player = page.getByRole('region', { name: new RegExp(escapeRegExp(READY_AGENT)) });
  await player.getByRole('button', { name: th('recordings:player.play'), exact: true }).click();
  await expect(player.getByRole('status')).toHaveText(th('recordings:player.phase.playing'));

  fixture.revoked = true;
  await expect(player.getByRole('alert')).toHaveText(th('recordings:player.error.gone'), {
    timeout: 10_000,
  });
  // stops within the audio buffered ahead (no more than 4 seconds from what was requested before revocation)
  expect(requestedSeconds(fixture)).toBeLessThanOrEqual(4);
  await expect(
    player.getByRole('button', { name: th('recordings:player.play'), exact: true }),
  ).toBeVisible();
  const position = Number(
    await page.getByRole('slider', { name: th('recordings:player.position') }).inputValue(),
  );
  await page.waitForTimeout(700);
  expect(
    Number(await page.getByRole('slider', { name: th('recordings:player.position') }).inputValue()),
  ).toBe(position);
});
