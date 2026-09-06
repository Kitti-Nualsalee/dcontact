import { expect, test } from '@playwright/test';

test('ผู้ตรวจฟัง signed playback เห็น transcript gap และ publish หลัง server ยืนยัน', async ({
  page,
}) => {
  let status: 'DRAFT' | 'PUBLISHED' = 'DRAFT';
  let publishBody: Record<string, unknown> | undefined;
  await page.route('**/api/v1/qm/console-contexts/e5e94bea-4a4f-4f45-a4fb-d0d1db07e899', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        interaction: { id: 'interaction-100', channel: 'VOICE', queueName: 'บริการลูกค้า' },
        recording: {
          id: 'recording-100',
          status: 'AVAILABLE',
          pauseIntervals: [{ startMs: 8000, endMs: 12000, reason: 'PCI' }],
        },
        transcript: {
          id: 'transcript-100',
          language: 'th-TH',
          segments: [
            { id: 'segment-1', speaker: 'AGENT', startMs: 0, endMs: 4000, text: 'สวัสดีค่ะ' },
            {
              id: 'segment-2',
              speaker: 'CUSTOMER',
              startMs: 13000,
              endMs: 17000,
              text: 'ขอบคุณครับ',
            },
          ],
        },
        evaluation: { id: 'evaluation-100', status, source: 'AUTO', answers: { score: 86 } },
      }),
    }),
  );
  await page.route('**/api/v1/recordings/recording-100/playback', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        url: 'https://media.example/signed-recording.wav',
        expiresAt: '2026-09-06T08:05:00.000Z',
      }),
    }),
  );
  await page.route('**/api/v1/qm/evaluations/evaluation-100/publish', async (route) => {
    publishBody = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = 'PUBLISHED';
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/?context=e5e94bea-4a4f-4f45-a4fb-d0d1db07e899');
  await expect(page.getByRole('heading', { name: 'Interaction interaction-100' })).toBeVisible();
  await expect(page.getByText('ช่วง PCI ไม่มีหลักฐานเสียง')).toBeVisible();
  await expect(page.getByText('สวัสดีค่ะ')).toBeVisible();
  await page.getByRole('button', { name: 'ขอสิทธิ์ฟัง recording' }).click();
  await expect(page.locator('audio')).toHaveAttribute(
    'src',
    'https://media.example/signed-recording.wav',
  );

  await page.getByRole('button', { name: 'Publish evaluation' }).click();
  await expect(page.getByRole('dialog')).toContainText('Agent จะเห็นผลประเมินนี้');
  await page.getByRole('button', { name: 'ยืนยัน Publish' }).click();
  await expect(page.getByText('กำลังรอ server ยืนยัน')).toBeVisible();
  await expect(page.getByText('PUBLISHED')).toBeVisible();
  expect(publishBody?.commandId).toEqual(expect.any(String));
});

test('ลบ media แล้ว transcript และ evaluation ยังแสดงอยู่', async ({ page }) => {
  await page.route('**/api/v1/qm/console-contexts/48ef8d3d-c90e-4e71-a5e0-ebd58d78de59', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        interaction: { id: 'interaction-deleted', channel: 'VOICE', queueName: 'VIP' },
        recording: { id: 'recording-deleted', status: 'DELETED', pauseIntervals: [] },
        transcript: {
          id: 'transcript-kept',
          language: 'th-TH',
          segments: [
            { id: 's1', speaker: 'AGENT', startMs: 0, endMs: 1000, text: 'หลักฐานที่เก็บไว้' },
          ],
        },
        evaluation: {
          id: 'evaluation-kept',
          status: 'PUBLISHED',
          source: 'HUMAN',
          answers: { score: 92 },
        },
      }),
    }),
  );

  await page.goto('/?context=48ef8d3d-c90e-4e71-a5e0-ebd58d78de59');
  await expect(page.getByText('ไฟล์เสียงถูกลบตาม retention แล้ว')).toBeVisible();
  await expect(page.getByText('หลักฐานที่เก็บไว้')).toBeVisible();
  await expect(page.getByText('92')).toBeVisible();
});
