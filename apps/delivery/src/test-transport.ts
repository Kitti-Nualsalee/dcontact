/**
 * Owner: Channels/Dialer — transport of the TEST_ADAPTER
 *
 * C1 opens no provider traffic: this transport has no credential, opens no socket and does not
 * import any provider SDK. Results come only from the script the test feeds in; every request
 * must declare `adapter: 'TEST_ADAPTER'` — if someone wires this transport to another adapter
 * in the future, it breaks immediately instead of silently sending real traffic
 */
import type { ContactChannel } from '@d-contact/cxa-contracts';

export type DeliveryAdapterName = 'TEST_ADAPTER';

export const TEST_ADAPTER: DeliveryAdapterName = 'TEST_ADAPTER';

export interface TransportRequest {
  adapter: DeliveryAdapterName;
  deliveryId: string;
  providerRequestKey: string;
  channel: ContactChannel;
  /** a reference only — the transport never sees the content or the real destination */
  contentRef: string;
}

/** a provider result not yet normalized; `TIMEOUT` means the outcome is unknown, never guess it was not sent */
export type TransportResponse =
  { status: 'ACCEPTED' } | { status: 'REJECTED'; reasonCode: string } | { status: 'TIMEOUT' };

export interface DeliveryTransport {
  submit(request: TransportRequest): Promise<TransportResponse>;
}

export class ProviderTrafficNotAllowedError extends Error {
  readonly code = 'PROVIDER_TRAFFIC_NOT_ALLOWED';

  constructor(adapter: string) {
    super(`this transport accepts only TEST_ADAPTER, not ${adapter}`);
    this.name = 'ProviderTrafficNotAllowedError';
  }
}

/**
 * records every request that comes in so tests can confirm that a retry/crash does not cause a duplicate send
 * the default is ACCEPTED; `script` feeds per-call results in order
 */
export class ScriptedTestTransport implements DeliveryTransport {
  readonly requests: TransportRequest[] = [];
  private readonly script: TransportResponse[];

  constructor(script: TransportResponse[] = []) {
    this.script = [...script];
  }

  /** how many times this providerRequestKey was sent into the transport — must never exceed 1 */
  submissionsFor(providerRequestKey: string): number {
    return this.requests.filter((request) => request.providerRequestKey === providerRequestKey)
      .length;
  }

  async submit(request: TransportRequest): Promise<TransportResponse> {
    if (request.adapter !== TEST_ADAPTER) throw new ProviderTrafficNotAllowedError(request.adapter);
    this.requests.push(request);
    return this.script.shift() ?? { status: 'ACCEPTED' };
  }
}
