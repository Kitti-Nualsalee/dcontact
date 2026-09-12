export type WorkspaceGovernanceState = 'READY' | 'BLOCK_NEXT_OUTBOUND' | 'STALE';

export interface WorkspaceGovernanceAlert {
  state: WorkspaceGovernanceState;
  aggregateVersion?: number;
  message: string;
}

/**
 * สถานะนี้เป็น projection เฉพาะ working tab: ห้ามใช้แทน canonical policy และเมื่อ
 * ลำดับ event ไม่ครบต้องปิด outbound ไว้ก่อนจนกว่าจะได้รับสถานะที่เชื่อถือได้ใหม่
 */
export class WorkspaceOutboundGate {
  private liveSequence?: number;
  private aggregateVersion?: number;
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
    };
    if (
      payload.event !== 'contact_governance.invalidated' ||
      !Number.isSafeInteger(payload.aggregateVersion) ||
      (payload.aggregateVersion as number) < 1 ||
      payload.action !== 'BLOCK_NEXT_OUTBOUND'
    ) {
      return undefined;
    }
    if ((payload.aggregateVersion as number) <= (this.aggregateVersion ?? 0)) return undefined;
    this.aggregateVersion = payload.aggregateVersion as number;
    this.state = 'BLOCK_NEXT_OUTBOUND';
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
