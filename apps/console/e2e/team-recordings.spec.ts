import { expect, test, type Page } from '@playwright/test';
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
  /** สิทธิ์ถูกถอน: chunk ถัดไปตอบ 404 */
  revoked: boolean;
}

/** WAV mono 16 bit ของเสียง 440 Hz ตามช่วง frame ที่ขอ */
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
          items: [
            item(archiving, 'ARCHIVING', 'ปกรณ์ ศรีสุข'),
            item(ready, 'READY', 'สมหญิง ใจดี'),
          ],
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

test('Supervisor เปิดรายการ ฟังเสียงทีละช่วง หยุด และเลื่อนตำแหน่ง', async ({ page }) => {
  const fixture = newFixture();
  await mockRecordings(page, fixture);
  await page.goto('/?view=team-recordings&tenant=demo');

  await expect(page.getByRole('heading', { name: 'เสียงบันทึกของทีม', level: 1 })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'รายการเสียงบันทึกของทีม' });
  await expect(grid).toContainText('สมหญิง ใจดี');
  await expect(grid).toContainText('กำลังจัดเก็บ');
  // เสียงที่ยังจัดเก็บไม่เสร็จไม่มีปุ่มฟัง และไม่มีลิงก์ดาวน์โหลดในหน้า
  await expect(grid.getByRole('button', { name: /^ฟัง/ })).toHaveCount(1);
  await expect(page.getByRole('link', { name: /ดาวน์โหลด|download/i })).toHaveCount(0);

  await grid.getByRole('button', { name: /^ฟังสาย .*สมหญิง ใจดี/ }).click();
  const player = page.getByRole('region', { name: /สมหญิง ใจดี/ });
  await expect(player.getByRole('heading', { level: 2 })).toBeFocused();
  // ยังไม่ขอเสียงจนกว่าจะกดเล่น
  expect(fixture.opened).toBe(0);
  await player.getByRole('button', { name: 'เล่น', exact: true }).click();
  await expect(player.getByRole('status')).toHaveText('กำลังเล่น');
  await expect(player.getByRole('button', { name: 'หยุดชั่วคราว' })).toBeVisible();

  // เล่นไปราว 1 วินาที: ขอเสียงล่วงหน้าไม่เกิน 4 วินาที ไม่ใช่ทั้งไฟล์ 12 วินาที
  await expect
    .poll(() => page.getByRole('slider', { name: 'ตำแหน่งในเสียงบันทึก' }).inputValue())
    .not.toBe('0');
  expect(requestedSeconds(fixture)).toBeLessThanOrEqual(4);
  for (const chunk of fixture.chunks) {
    expect(chunk.frameCount).toBeLessThanOrEqual(RATE * 2);
    // token อยู่ใน header เท่านั้น ไม่อยู่ใน URL ของเสียง
    expect(new URL(chunk.url).search).toBe('');
    expect(chunk.authorization).toMatch(/^Bearer /);
  }

  await player.getByRole('button', { name: 'หยุดชั่วคราว' }).click();
  await expect(player.getByRole('status')).toHaveText('หยุดชั่วคราว');
  const requestedAtPause = fixture.chunks.length;
  await page.waitForTimeout(700);
  expect(fixture.chunks.length).toBe(requestedAtPause);

  // เลื่อนไปวินาทีที่ 8 แล้วเล่นต่อ: ขอช่วงใหม่จากตำแหน่งนั้น
  await page.getByRole('slider', { name: 'ตำแหน่งในเสียงบันทึก' }).fill('8');
  await player.getByRole('button', { name: 'เล่น', exact: true }).click();
  await expect(player.getByRole('status')).toHaveText('กำลังเล่น');
  expect(fixture.chunks.slice(requestedAtPause)[0]?.startFrame).toBe(RATE * 8);
  await expect(player.getByRole('status')).toHaveText('เล่นจบแล้ว', { timeout: 10_000 });
  expect(requestedSeconds(fixture)).toBe(SECONDS);

  await player.getByRole('button', { name: 'ปิดตัวเล่น' }).click();
  await expect(player).toHaveCount(0);
  await expect.poll(() => fixture.closed).toBe(1);
});

test('สิทธิ์ถูกถอนระหว่างฟัง: เสียงหยุดและแจ้งเหตุ ไม่ขอช่วงถัดไปต่อ', async ({ page }) => {
  const fixture = newFixture();
  await mockRecordings(page, fixture);
  await page.goto('/?view=team-recordings&tenant=demo');
  await page.getByRole('button', { name: /^ฟังสาย .*สมหญิง ใจดี/ }).click();
  const player = page.getByRole('region', { name: /สมหญิง ใจดี/ });
  await player.getByRole('button', { name: 'เล่น', exact: true }).click();
  await expect(player.getByRole('status')).toHaveText('กำลังเล่น');

  fixture.revoked = true;
  await expect(player.getByRole('alert')).toHaveText(
    'ไม่พบเสียงบันทึกนี้ หรือคุณไม่มีสิทธิ์ฟังแล้ว',
    { timeout: 10_000 },
  );
  // หยุดภายในเสียงที่กันไว้ล่วงหน้า (ไม่เกิน 4 วินาทีจากที่ขอไว้ก่อนถอนสิทธิ์)
  expect(requestedSeconds(fixture)).toBeLessThanOrEqual(4);
  await expect(player.getByRole('button', { name: 'เล่น', exact: true })).toBeVisible();
  const position = Number(
    await page.getByRole('slider', { name: 'ตำแหน่งในเสียงบันทึก' }).inputValue(),
  );
  await page.waitForTimeout(700);
  expect(
    Number(await page.getByRole('slider', { name: 'ตำแหน่งในเสียงบันทึก' }).inputValue()),
  ).toBe(position);
});
