/**
 * Owner: Platform control plane — deterministic fake adapters of the provisioning ports (A1.3 #408)
 *
 * Replace the real Keycloak/bootstrap/email/readiness in the Fast PR gate (#393 §1/§4): no network and no real time
 * beyond what the caller dictates. Injectable faults match the fault matrix of #393 §4:
 * - `lostResponse`: the side effect happened but the caller got an error (must end in verified adoption)
 * - `transient`: fails before any side effect
 * - `hang`: does not answer until the signal aborts (timeout)
 * - `permanent`: fails permanently
 * - `foreign(...)`: a resource with the same name but a mismatching correlation (never adopt)
 */
import type {
  ExternalProvisioningStepKey,
  ProvisioningAdoption,
  ProvisioningStepContext,
  ProvisioningStepPort,
  ProvisioningStepPorts,
} from './provisioning-saga.js';
import { ProvisioningStepError } from './provisioning-saga.js';

export type FakeFault = 'lostResponse' | 'transient' | 'hang' | 'permanent';

interface FakeResource {
  externalRef: string;
  tenantId: string;
  requestId: string;
}

export class FakeProvisioningSystem implements ProvisioningStepPort {
  /** resources the "external system" really holds, keyed by operationKey */
  readonly resources = new Map<string, FakeResource>();
  readonly faults: FakeFault[] = [];
  executeCalls = 0;
  findCalls = 0;
  compensated: string[] = [];
  /** only steps that can really be compensated — invitation/bootstrap have none (#390: no destructive default) */
  readonly compensate?: (context: ProvisioningStepContext, externalRef: string) => Promise<void>;
  private sequence = 0;

  constructor(
    readonly stepKey: ExternalProvisioningStepKey,
    options: { compensable?: boolean } = {},
  ) {
    if (options.compensable !== false) {
      this.compensate = async (context, externalRef) => {
        const resource = this.resources.get(context.operationKey);
        if (resource?.externalRef !== externalRef) {
          throw new ProvisioningStepError('PERMANENT', 'NOT_OWNED');
        }
        this.resources.delete(context.operationKey);
        this.compensated.push(externalRef);
      };
    }
  }

  /** the next fault of execute (in order) */
  fail(...faults: FakeFault[]): this {
    this.faults.push(...faults);
    return this;
  }

  /** simulates a resource with the same name that belongs to another tenant/request */
  foreign(context: Pick<ProvisioningStepContext, 'operationKey'>): this {
    this.resources.set(context.operationKey, {
      externalRef: `foreign-${this.stepKey}`,
      tenantId: '00000000-0000-4000-8000-000000000000',
      requestId: '00000000-0000-4000-8000-000000000000',
    });
    return this;
  }

  async find(context: ProvisioningStepContext): Promise<ProvisioningAdoption> {
    this.findCalls += 1;
    const resource = this.resources.get(context.operationKey);
    if (!resource) return { status: 'NOT_FOUND' };
    if (resource.tenantId !== context.tenantId || resource.requestId !== context.requestId) {
      return { status: 'MISMATCH', code: 'CORRELATION_MISMATCH' };
    }
    return { status: 'FOUND', externalRef: resource.externalRef };
  }

  async execute(
    context: ProvisioningStepContext,
    signal: AbortSignal,
  ): Promise<{ externalRef: string }> {
    this.executeCalls += 1;
    const fault = this.faults.shift();
    if (fault === 'transient')
      throw new ProvisioningStepError('TRANSIENT', 'DEPENDENCY_UNAVAILABLE');
    if (fault === 'permanent') throw new ProvisioningStepError('PERMANENT', 'DEPENDENCY_REJECTED');
    if (fault === 'hang') {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new ProvisioningStepError('AMBIGUOUS', 'EXTERNAL_TIMEOUT');
    }
    // a good real system would not create again if it already exists, but the saga must not rely on that — the fake counts every creation
    this.sequence += 1;
    const resource = {
      externalRef: `${this.stepKey.toLowerCase()}-${this.sequence}`,
      tenantId: context.tenantId,
      requestId: context.requestId,
    };
    this.resources.set(context.operationKey, resource);
    if (fault === 'lostResponse') throw new ProvisioningStepError('AMBIGUOUS', 'RESPONSE_LOST');
    return { externalRef: resource.externalRef };
  }

  /** total number of resources actually created — used to confirm there is no duplicate */
  get created(): number {
    return this.sequence;
  }
}

/** readiness is a check, not a resource — find never finds it so it runs again on every attempt */
export class FakeReadinessCheck implements ProvisioningStepPort {
  result: 'PASS' | 'FAIL' = 'PASS';
  executeCalls = 0;

  async find(): Promise<ProvisioningAdoption> {
    return { status: 'NOT_FOUND' };
  }

  async execute(context: ProvisioningStepContext): Promise<{ externalRef: string }> {
    this.executeCalls += 1;
    if (this.result === 'FAIL') throw new ProvisioningStepError('PERMANENT', 'READINESS_FAILED');
    return { externalRef: `readiness:${context.requestId}` };
  }
}

export function createFakeProvisioningPorts() {
  const systems = {
    KEYCLOAK_ORGANIZATION: new FakeProvisioningSystem('KEYCLOAK_ORGANIZATION'),
    PLAN_BOOTSTRAP: new FakeProvisioningSystem('PLAN_BOOTSTRAP', { compensable: false }),
    FIRST_ADMIN: new FakeProvisioningSystem('FIRST_ADMIN'),
    // an invitation already sent cannot be recalled — ambiguous must reconcile, never blind resend
    INVITATION: new FakeProvisioningSystem('INVITATION', { compensable: false }),
    READINESS: new FakeReadinessCheck(),
  };
  const ports: ProvisioningStepPorts = systems;
  return { systems, ports };
}
