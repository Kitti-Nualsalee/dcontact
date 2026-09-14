export type WorkspaceGovernanceState = 'READY' | 'BLOCK_NEXT_OUTBOUND' | 'STALE';

export interface WorkspaceGovernanceAlert {
  state: WorkspaceGovernanceState;
  aggregateVersion?: number;
  message: string;
}

const SUPPORTED_CONTRACT_VERSION = 1;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * สถานะนี้เป็น projection เฉพาะ working tab: ห้ามใช้แทน canonical policy และเมื่อ
 * ลำดับ event ไม่ครบต้องปิด outbound ไว้ก่อนจนกว่าจะได้รับสถานะที่เชื่อถือได้ใหม่
 *
 * CG4.8 (#191): Workspace เป็นเพียง owner-local alert — ไม่เขียน canonical Governance state
 * - version เดียวกันแต่ state digest ต่าง หรือ contract version ที่ไม่รู้จัก → STALE
 * - relaxation ไม่ปลด gate เอง; ปลดได้ทางเดียวคือยืนยัน canonical version
 */
export class WorkspaceOutboundGate {
  private liveSequence?: number;
  private aggregateVersion?: number;
  private stateDigest?: string;
  private state: WorkspaceGovernanceState = 'READY';

  apply(event: unknown): WorkspaceGovernanceAlert | undefined {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return undefined;
    const candidate = event as {
      type?: unknown;
      sequence?: unknown;
      payload?: unknown;
    };
    if (
      candidate.type !== 'workspace.live' ||
      !Number.isSafeInteger(candidate.sequence) ||
      (candidate.sequence as number) < 1 ||
      !candidate.payload ||
      typeof candidate.payload !== 'object' ||
      Array.isArray(candidate.payload)
    ) {
      return undefined;
    }
    if (this.liveSequence !== undefined && candidate.sequence !== this.liveSequence + 1) {
      this.liveSequence = candidate.sequence as number;
      return this.stale();
    }
    this.liveSequence = candidate.sequence as number;
    const payload = candidate.payload as {
      event?: unknown;
      aggregateVersion?: unknown;
      action?: unknown;
      contractVersion?: unknown;
      stateDigest?: unknown;
      restrictiveness?: unknown;
    };
    if (payload.event !== 'contact_governance.invalidated') return undefined;
    if (
      payload.contractVersion !== undefined &&
      payload.contractVersion !== SUPPORTED_CONTRACT_VERSION
    ) {
      return this.stale();
    }
    if (
      !Number.isSafeInteger(payload.aggregateVersion) ||
      (payload.aggregateVersion as number) < 1
    ) {
      return undefined;
    }
    const version = payload.aggregateVersion as number;
    const digest =
      typeof payload.stateDigest === 'string' && SHA256_HEX.test(payload.stateDigest)
        ? payload.stateDigest
        : undefined;
    if (version === this.aggregateVersion) {
      // version ซ้ำเป็น no-op เว้นแต่ digest ต่าง ซึ่งแปลว่ามีสองความจริงสำหรับ version เดียว
      return digest && this.stateDigest && digest !== this.stateDigest ? this.stale() : undefined;
    }
    if (version < (this.aggregateVersion ?? 0)) return undefined;

    if (payload.restrictiveness === 'RELAXATION') {
      this.aggregateVersion = version;
      this.stateDigest = digest;
      if (this.state === 'READY') return undefined;
      return {
        state: this.state,
        aggregateVersion: version,
        message:
          'Governance ผ่อนเงื่อนไขแล้ว แต่ outbound ยังถูกบล็อกจนกว่าจะตรวจสอบ canonical policy ใหม่',
      };
    }
    if (payload.action !== 'BLOCK_NEXT_OUTBOUND') return undefined;
    this.aggregateVersion = version;
    this.stateDigest = digest;
    if (this.state !== 'STALE') this.state = 'BLOCK_NEXT_OUTBOUND';
    return {
      state: this.state,
      aggregateVersion: this.aggregateVersion,
      message:
        'การตั้งค่าการติดต่อเปลี่ยนแล้ว: บล็อก outbound ถัดไปจนกว่าจะตรวจสอบ canonical policy ใหม่',
    };
  }

  markDisconnected(): WorkspaceGovernanceAlert {
    return this.stale();
  }

  confirmCanonicalVersion(version: number): WorkspaceGovernanceAlert | undefined {
    if (!Number.isSafeInteger(version) || version < (this.aggregateVersion ?? 0)) return undefined;
    this.aggregateVersion = version;
    this.stateDigest = undefined;
    this.state = 'READY';
    return {
      state: this.state,
      aggregateVersion: version,
      message: 'ตรวจสอบ canonical policy ล่าสุดแล้ว',
    };
  }

  snapshot(): WorkspaceGovernanceState {
    return this.state;
  }

  private stale(): WorkspaceGovernanceAlert {
    this.state = 'STALE';
    return {
      state: this.state,
      aggregateVersion: this.aggregateVersion,
      message: 'สถานะ governance อาจไม่ครบ: บล็อก outbound ถัดไปและตรวจสอบสถานะใหม่ก่อนดำเนินการ',
    };
  }
}
