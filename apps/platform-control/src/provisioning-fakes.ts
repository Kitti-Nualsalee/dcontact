/**
 * Owner: Platform control plane — deterministic fake adapters ของ provisioning ports (A1.3 #408)
 *
 * ใช้แทน Keycloak/bootstrap/email/readiness จริงใน Fast PR gate (#393 §1/§4): ไม่มี network และไม่มีเวลา
 * จริงนอกจากที่ผู้เรียกสั่ง fault ที่ inject ได้ตรงกับ fault matrix ของ #393 §4:
 * - `lostResponse`: side effect เกิดแล้วแต่ผู้เรียกได้ error (ต้องจบด้วย verified adoption)
 * - `transient`: ล้มก่อนเกิด side effect
 * - `hang`: ไม่ตอบจนกว่า signal จะ abort (timeout)
 * - `permanent`: ล้มถาวร
 * - `foreign(...)`: มี resource ชื่อเดียวกันแต่ correlation ไม่ตรง (ห้ามยึด)
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
  /** resource ที่ "ระบบภายนอก" ถืออยู่จริง keyed ด้วย operationKey */
  readonly resources = new Map<string, FakeResource>();
  readonly faults: FakeFault[] = [];
  executeCalls = 0;
  findCalls = 0;
  compensated: string[] = [];
  /** มีเฉพาะ step ที่ชดเชยได้จริง — invitation/bootstrap ไม่มี (#390 ห้าม destructive เป็นค่าเริ่มต้น) */
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

  /** fault ถัดไปของ execute (เรียงตามลำดับ) */
  fail(...faults: FakeFault[]): this {
    this.faults.push(...faults);
    return this;
  }

  /** จำลอง resource ที่มีชื่อเดียวกันแต่เป็นของ tenant/request อื่น */
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
    // ระบบจริงที่ดีจะไม่สร้างซ้ำถ้ามีอยู่แล้ว แต่ saga ต้องไม่พึ่งพฤติกรรมนั้น — fake นับทุกการสร้าง
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

  /** จำนวน resource ที่ถูกสร้างจริงทั้งหมด — ใช้ยืนยันว่าไม่มี duplicate */
  get created(): number {
    return this.sequence;
  }
}

/** readiness เป็น check ไม่ใช่ resource — find ไม่พบเสมอเพื่อให้รันใหม่ทุก attempt */
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
    // invitation ที่ส่งไปแล้วเรียกคืนไม่ได้ — ambiguous ต้อง reconcile ห้าม blind resend
    INVITATION: new FakeProvisioningSystem('INVITATION', { compensable: false }),
    READINESS: new FakeReadinessCheck(),
  };
  const ports: ProvisioningStepPorts = systems;
  return { systems, ports };
}
