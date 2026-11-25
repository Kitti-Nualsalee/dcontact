import type { DialerGovernanceMetrics } from './dialer-governance.js';

/** JSON metrics contain no customer, action or reservation identifier. */
export class JsonDialerGovernanceMetrics implements DialerGovernanceMetrics {
  increment(name: string): void {
    console.info(JSON.stringify({ metric: name, kind: 'counter', value: 1 }));
  }

  observe(name: string, value: number): void {
    console.info(JSON.stringify({ metric: name, kind: 'histogram', value }));
  }
}
