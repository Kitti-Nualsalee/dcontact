/**
 * Owner: Platform operations — metrics of the Platform API (A1.8 #413)
 *
 * Counts guard decisions from the existing diagnostics (labels are enums only: decision/reason/capability,
 * no subject or correlation id) — `/metrics` is on a separate port from the public API
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
    help: 'Outcome of PlatformAuthGuard per request',
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
