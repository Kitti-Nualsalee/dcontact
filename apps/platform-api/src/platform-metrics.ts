/**
 * Owner: Platform operations — metrics ของ Platform API (A1.8 #413)
 *
 * นับการตัดสินใจของ guard จาก diagnostics เดิม (label = decision/reason/capability ที่เป็น enum เท่านั้น
 * ไม่มี subject หรือ correlation id) — `/metrics` อยู่บน port แยกจาก API สาธารณะ
 */
import { metricCode } from '@d-contact/platform-control';
import { Counter, type Registry } from 'prom-client';
import type { PlatformAuthDiagnostic, PlatformAuthDiagnosticSink } from './platform-auth.js';

export function meteredDiagnostics(
  sink: PlatformAuthDiagnosticSink,
  registry: Registry,
): PlatformAuthDiagnosticSink {
  const decisions = new Counter({
    name: 'dcontact_platform_api_auth_decisions_total',
    help: 'ผลของ PlatformAuthGuard ต่อ request',
    labelNames: ['decision', 'reason', 'capability'],
    registers: [registry],
  });
  return {
    write(diagnostic: PlatformAuthDiagnostic) {
      decisions.inc({
        decision: diagnostic.event === 'platform.request.authorized' ? 'authorized' : 'denied',
        reason: diagnostic.reason ? metricCode(diagnostic.reason) : 'none',
        capability: diagnostic.capability ? metricCode(diagnostic.capability) : 'none',
      });
      sink.write(diagnostic);
    },
  };
}
