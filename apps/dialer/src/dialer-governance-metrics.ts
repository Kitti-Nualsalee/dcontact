import type { DialerGovernanceMetrics } from './dialer-governance.js';

/** JSON metrics ไม่มี identifier ของลูกค้า, action หรือ reservation. */
export class JsonDialerGovernanceMetrics implements DialerGovernanceMetrics {
  increment(name: string): void {
    console.info(JSON.stringify({ metric: name, kind: 'counter', value: 1 }));
  }

  observe(name: string, value: number): void {
    console.info(JSON.stringify({ metric: name, kind: 'histogram', value }));
  }
}
