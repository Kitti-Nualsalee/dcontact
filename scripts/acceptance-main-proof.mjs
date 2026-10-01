import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ADR-032: marker ของ acceptance ออกได้เมื่อ commit ที่ทดสอบ **อยู่บน main แล้ว** (เป็น ancestor ของ
 * origin/main หรือตัวเดียวกัน) ไม่ต้องเป็น HEAD ของ main ตอนที่ run — chain S1 → J2/CG4 → J3 → J5 ใช้
 * เวลาหลายชั่วโมงขณะที่ main รับ commit ใหม่ตลอด กติกา HEAD เดิมทำให้ marker ออกไม่ได้เลย
 *
 * commit ที่ยังไม่ merge (PR/branch) ไม่ผ่านเพราะไม่ใช่ ancestor ของ origin/main
 */
export function commitOnMain(commitSha, run = spawnSync) {
  if (!/^[0-9a-f]{40}$/i.test(commitSha ?? '')) return false;
  const result = run('git', ['merge-base', '--is-ancestor', commitSha, 'origin/main'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  return result.status === 0 && !result.error;
}

/** context ที่ไม่มีผลตรวจ (เช่น fixture เก่า) ถือตามกติกาเดิม: commit ต้องเป็น HEAD ของ main */
export function contextOnMain(context) {
  return typeof context.commitOnMain === 'boolean'
    ? context.commitOnMain
    : context.commitSha === context.finalMainSha;
}
