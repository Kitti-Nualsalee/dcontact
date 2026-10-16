export interface OwnerIdentity {
  tenant: string;
  hostOrigin: string;
}

export interface ControllerWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

interface AttachRequest extends OwnerIdentity {
  v: 1;
  type: 'dphone.owner.attach';
  connectionId: string;
}

interface Connection {
  source: ControllerWindow;
  connectionId: string;
}

function attachRequest(value: unknown): AttachRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).length !== 5 ||
    request.v !== 1 ||
    request.type !== 'dphone.owner.attach' ||
    typeof request.tenant !== 'string' ||
    typeof request.hostOrigin !== 'string' ||
    typeof request.connectionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.connectionId)
  )
    return null;
  return {
    v: 1,
    type: 'dphone.owner.attach',
    tenant: request.tenant,
    hostOrigin: request.hostOrigin,
    connectionId: request.connectionId,
  };
}

export class OwnerConnection {
  private generation = 0;
  private connection?: Connection;
  private pendingSource?: ControllerWindow;
  private pendingId?: string;
  private revoked = false;

  constructor(
    private readonly options: {
      identity: OwnerIdentity;
      dphoneOrigin: string;
      authorize(
        source: ControllerWindow,
        identity: OwnerIdentity,
        connectionId: string,
      ): Promise<boolean>;
    },
  ) {}

  get pending(): boolean {
    return this.pendingSource !== undefined;
  }

  async attach(event: {
    origin: string;
    source: ControllerWindow | null;
    data: unknown;
  }): Promise<boolean> {
    if (this.revoked || event.origin !== this.options.dphoneOrigin || !event.source) return false;
    const request = attachRequest(event.data);
    if (
      !request ||
      request.tenant !== this.options.identity.tenant ||
      request.hostOrigin !== this.options.identity.hostOrigin
    )
      return false;
    const generation = ++this.generation;
    this.connection = undefined;
    this.pendingSource = event.source;
    this.pendingId = request.connectionId;
    let allowed = false;
    try {
      allowed = await this.options.authorize(
        event.source,
        { ...this.options.identity },
        request.connectionId,
      );
    } catch {
      if (generation === this.generation) this.pendingSource = undefined;
      return false;
    }
    if (generation === this.generation) this.pendingSource = undefined;
    if (!allowed || this.revoked || generation !== this.generation) return false;
    this.connection = { source: event.source, connectionId: request.connectionId };
    return true;
  }

  accepts(event: { origin: string; source: unknown; connectionId: string }): boolean {
    return Boolean(
      !this.revoked &&
      this.connection &&
      event.origin === this.options.dphoneOrigin &&
      event.source === this.connection.source &&
      event.connectionId === this.connection.connectionId,
    );
  }

  detach(source: unknown, connectionId?: string): void {
    const active =
      this.connection &&
      this.connection.source === source &&
      (connectionId === undefined || this.connection.connectionId === connectionId);
    const pending =
      this.pendingSource === source &&
      (connectionId === undefined || this.pendingId === connectionId);
    if (!active && !pending) return;
    this.generation += 1;
    this.connection = undefined;
    this.pendingSource = undefined;
    this.pendingId = undefined;
  }

  revoke(): void {
    this.revoked = true;
    this.generation += 1;
    this.connection = undefined;
    this.pendingSource = undefined;
    this.pendingId = undefined;
  }
}
