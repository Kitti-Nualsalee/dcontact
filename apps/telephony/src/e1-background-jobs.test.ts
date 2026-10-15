import assert from 'node:assert/strict';
import test from 'node:test';
import { E1BackgroundJobs } from './e1-background-jobs.js';

test('FreeSWITCH failure ที่มาถึงก่อน command reply ยังจับคู่ delivery ได้ ไม่ settle เมื่อสำเร็จ', async () => {
  const failures: string[] = [];
  const jobs = new E1BackgroundJobs(async (jobUuid, callUuid) => {
    failures.push(`${jobUuid}:${callUuid}`);
  });
  await jobs.completed('early-failure', false);
  assert.deepEqual(failures, []);
  await jobs.accepted('early-failure', 'call-1');
  await jobs.accepted('normal-failure', 'call-2');
  await jobs.completed('normal-failure', false);
  await jobs.completed('early-success', true);
  await jobs.accepted('early-success', 'call-3');
  await jobs.accepted('normal-success', 'call-4');
  await jobs.completed('normal-success', true);
  assert.deepEqual(failures, ['early-failure:call-1', 'normal-failure:call-2']);
});
