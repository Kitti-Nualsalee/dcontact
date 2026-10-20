/** เก็บเฉพาะชื่อ case/สถานะ/จำนวนจาก Playwright จริง ไม่มี DOM, URL auth, token หรือ storageState */
import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export default class CoreSettingsReporter implements Reporter {
  private planned = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private lines = ['TAP version 13'];
  onBegin(_config: FullConfig, suite: Suite) {
    this.planned = suite.allTests().length;
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const pass = result.status === 'passed' && test.expectedStatus === 'passed';
    if (result.status === 'skipped') this.skipped++;
    else if (pass) this.passed++;
    else this.failed++;
    const index = this.passed + this.failed + this.skipped;
    this.lines.push(
      `${pass ? 'ok' : 'not ok'} ${index} - ${test.title.replace(/[\r\n\x00-\x1f]/g, ' ')}${result.status === 'skipped' ? ' # SKIP' : ''}`,
    );
  }
  onEnd(result: FullResult) {
    const cancelled = Math.max(0, this.planned - this.passed - this.failed - this.skipped);
    if (result.status !== 'passed' && !this.failed && !cancelled) this.failed++;
    this.lines.push(
      `1..${this.planned}`,
      `# tests ${this.planned}`,
      `# pass ${this.passed}`,
      `# fail ${this.failed}`,
      `# cancelled ${cancelled}`,
      `# skipped ${this.skipped}`,
      '# todo 0',
    );
    const directory = resolve('../../artifacts/core-settings');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'browser.tap'), this.lines.join('\n') + '\n');
  }
}
