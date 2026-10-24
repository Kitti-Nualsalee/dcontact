import { coreTeamNameError } from '@d-contact/shared/src/core-settings.js';
import {
  CoreApiError,
  type CoreApi,
  type CoreTeamsApi,
  type CoreReceipt,
  type Team,
  type CoreCapabilities,
} from './api.js';
import type { CoreState } from './model.js';
/** ร่างอยู่ใน memory; storage ของแต่ละ resource มีเพียง commandId เพื่อกู้ผลเดิม */
export class CoreTeamModel {
  state: CoreState = 'LOADING';
  teams: Team[] = [];
  cursor: string | null = null;
  current?: Team;
  baseline?: Team;
  caps?: CoreCapabilities;
  name = '';
  message = '';
  error = false;
  blockers: { kind: string; count: number }[] = [];
  pending?: string;
  narrow = false;
  creating = false;
  committed?: Team;
  private sequence = 0;
  private listeners = new Set<() => void>();
  get storageKey() {
    return `dc:core-settings:command:${this.identityKey}:team:${this.resourceId}`;
  }
  constructor(
    readonly api: CoreApi & { teams: CoreTeamsApi },
    readonly identityKey: string,
    public resourceId: string,
    readonly storage: Storage,
    private readonly onCreateCommand?: (id: string) => void,
  ) {
    this.creating = resourceId === 'new';
    if (this.creating) this.resourceId = crypto.randomUUID();
    try {
      const id = storage.getItem(this.storageKey);
      if (id && /^[a-f0-9-]{36}$/.test(id)) this.pending = id;
    } catch {}
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private emit() {
    for (const fn of this.listeners) fn();
  }
  get dirty() {
    return this.creating ? !!this.name : !!this.baseline && this.name !== this.baseline.name;
  }
  get editable() {
    return (
      !this.narrow &&
      !this.pending &&
      ![
        'LOADING',
        'READ_ONLY',
        'REAUTH',
        'CONFLICT',
        'UNKNOWN',
        'SUBMITTING',
        'VERIFYING',
      ].includes(this.state) &&
      !!(this.creating ? this.caps?.teams?.create : this.caps?.teams?.rename)
    );
  }
  private remember(id?: string) {
    try {
      if (id) this.storage.setItem(this.storageKey, id);
      else this.storage.removeItem(this.storageKey);
      return true;
    } catch {
      return false;
    }
  }
  async list(more = false) {
    const seq = this.sequence;
    const result = await this.api.teams.list(more ? (this.cursor ?? undefined) : undefined);
    if (seq !== this.sequence) return;
    this.teams = more ? [...this.teams, ...result.teams] : result.teams;
    this.cursor = result.nextCursor;
    this.emit();
  }
  async load() {
    const seq = ++this.sequence,
      dirty = this.dirty,
      rev = this.baseline?.revision;
    this.state = 'LOADING';
    this.emit();
    try {
      const caps = await this.api.capabilities();
      if (seq !== this.sequence) return;
      this.caps = caps;
      if (this.pending && caps.teams?.rename) {
        await this.checkPending();
        return;
      }
      const current =
        !this.creating && this.resourceId ? await this.api.teams.read(this.resourceId) : undefined;
      const result = await this.api.teams.list();
      if (seq !== this.sequence) return;
      this.caps = caps;
      this.current = current;
      this.teams = result.teams;
      this.cursor = result.nextCursor;
      if (!dirty) {
        this.baseline = current;
        this.name = current?.name ?? '';
      }
      this.message = '';
      this.state = !(this.creating ? caps.teams?.create : caps.teams?.rename)
        ? 'READ_ONLY'
        : dirty
          ? rev === current?.revision
            ? 'DIRTY'
            : 'CONFLICT'
          : 'CLEAN';
      if (this.state === 'CONFLICT') this.message = 'REVISION_CONFLICT';
    } catch (e) {
      if (seq === this.sequence) this.failure(e);
    }
    this.emit();
  }
  edit(name: string) {
    if (!this.editable) return;
    this.name = name;
    this.error = false;
    this.message = '';
    this.state = this.dirty ? 'DIRTY' : 'CLEAN';
    this.emit();
  }
  async setNarrow(narrow: boolean) {
    if (this.narrow === narrow) return;
    this.narrow = narrow;
    this.emit();
    if (!narrow) await this.load();
  }
  async loadLatest() {
    this.baseline = undefined;
    this.name = '';
    await this.load();
  }
  clear() {
    ++this.sequence;
    this.remember();
    this.pending = undefined;
    this.blockers = [];
    this.committed = undefined;
    this.current = this.baseline = undefined;
    this.teams = [];
    this.caps = undefined;
    this.name = '';
    this.state = 'READ_ONLY';
    this.emit();
  }
  private failure(e: unknown) {
    if (e instanceof CoreApiError && e.status === 401) {
      this.state = 'REAUTH';
      this.message = 'REAUTH';
    } else if (e instanceof CoreApiError && [403, 404].includes(e.status)) {
      ++this.sequence;
      this.blockers = [];
      this.committed = undefined;
      this.current = this.baseline = undefined;
      this.name = '';
      this.teams = [];
      this.caps = undefined;
      this.state = 'READ_ONLY';
      this.message = e.status === 404 ? 'RESOURCE_NOT_FOUND' : 'FORBIDDEN';
    } else {
      this.state = this.pending ? 'UNKNOWN' : 'DIRTY';
      this.message = this.pending
        ? e instanceof CoreApiError && e.code === 'CONFIG_BUSY'
          ? 'CONFIG_BUSY'
          : 'UNKNOWN'
        : 'REQUEST_FAILED';
    }
  }
  async save() {
    if (!this.editable || !this.dirty) return;
    if (coreTeamNameError(this.name.trim())) {
      this.error = true;
      this.message = 'VALIDATION';
      this.emit();
      return;
    }
    await this.execute(this.creating ? 'TEAM_CREATE' : 'TEAM_RENAME');
  }
  async deactivate() {
    if (!this.editable || this.dirty || !this.current?.isActive || !this.caps?.teams?.deactivate)
      return;
    await this.execute('TEAM_DEACTIVATE');
  }
  private async execute(action: string) {
    const commandId = crypto.randomUUID();
    if (!this.remember(commandId)) {
      this.message = 'STORAGE';
      this.emit();
      return;
    }
    if (this.creating) this.onCreateCommand?.(this.resourceId);
    this.pending = commandId;
    this.state = 'SUBMITTING';
    this.message = '';
    this.blockers = [];
    this.emit();
    try {
      const result =
        action === 'TEAM_CREATE'
          ? await this.api.teams.create({
              commandId,
              teamId: this.resourceId,
              name: this.name.trim(),
            })
          : action === 'TEAM_RENAME'
            ? await this.api.teams.rename(this.resourceId, {
                commandId,
                expectedRevision: this.baseline!.revision,
                patch: { name: this.name.trim() },
              })
            : await this.api.teams.deactivate(this.resourceId, {
                commandId,
                expectedRevision: this.baseline!.revision,
              });
      if (this.pending === commandId) await this.verify(result);
    } catch (e) {
      if (this.pending !== commandId) return;
      if (e instanceof CoreApiError && e.receipt) {
        try {
          await this.verify(e.receipt as unknown as CoreReceipt<Team>);
        } catch (v) {
          this.failure(v);
        }
      } else if (e instanceof CoreApiError && e.status === 400) {
        this.pending = undefined;
        this.remember();
        this.state = 'DIRTY';
        this.message = 'REQUEST_FAILED';
      } else this.failure(e);
    }
    this.emit();
  }
  async checkPending() {
    const id = this.pending;
    if (!id) return;
    this.state = 'VERIFYING';
    this.emit();
    try {
      let result;
      try {
        result = await this.api.teams.command(id);
      } catch (e) {
        if (e instanceof CoreApiError && e.status === 404 && e.code === 'COMMAND_UNKNOWN')
          result = await this.api.teams.reconcile(id);
        else throw e;
      }
      if (this.pending !== id) return;
      if ('state' in result) result = await this.api.teams.reconcile(id);
      if (this.pending !== id) return;
      if ('state' in result) {
        this.state = 'UNKNOWN';
        this.message = 'PENDING';
      } else await this.verify(result);
    } catch (e) {
      if (this.pending === id) this.failure(e);
    }
    this.emit();
  }
  private async verify(receipt: CoreReceipt<Team>) {
    const seq = this.sequence;
    const id = this.pending,
      c = receipt.command;
    if (
      !id ||
      c.id !== id ||
      (!['TEAM_CREATE', 'TEAM_RENAME', 'TEAM_DEACTIVATE'].includes(c.action ?? '') &&
        !(c.action === null && c.outcome === 'NOT_APPLIED')) ||
      (!this.creating && c.resourceId !== this.resourceId && c.outcome !== 'NOT_APPLIED')
    )
      throw Error('receipt mismatch');
    if (['REJECTED', 'NOT_APPLIED'].includes(c.outcome)) {
      this.pending = undefined;
      this.remember();
      this.message = c.error?.code ?? 'NOT_APPLIED';
      this.blockers = c.error?.blockers ?? [];
      this.error = c.error?.code === 'VALIDATION_FAILED';
      this.state = this.error || c.error?.code === 'TEAM_NAME_CONFLICT' ? 'DIRTY' : 'CONFLICT';
      return;
    }
    this.state = 'VERIFYING';
    this.emit();
    if (!c.resourceId) throw Error('resource missing');
    const current = await this.api.teams.read(c.resourceId);
    if (this.pending !== id || seq !== this.sequence) return;
    if (
      !c.committedRevision ||
      !c.resourceSnapshot ||
      !/^\d+$/.test(current.revision) ||
      !/^\d+$/.test(c.committedRevision) ||
      current.id !== c.resourceSnapshot.id ||
      current.id !== c.resourceId
    )
      throw Error('invalid readback');
    const expected = BigInt(c.committedRevision),
      actual = BigInt(current.revision);
    if (
      actual < expected ||
      (actual === expected &&
        (current.name !== c.resourceSnapshot.name ||
          current.isActive !== c.resourceSnapshot.isActive ||
          current.revision !== c.resourceSnapshot.revision))
    )
      throw Error('inconsistent readback');
    await this.list();
    if (this.pending !== id || seq !== this.sequence) return;
    this.current = this.baseline = current;
    this.committed = c.resourceSnapshot;
    this.name = current.name;
    this.creating = false;
    this.pending = undefined;
    this.remember();
    this.resourceId = current.id;
    this.state = 'SAVED';
    this.message = actual > expected ? 'SAVED_LATER' : c.outcome === 'NO_OP' ? 'NO_OP' : 'SAVED';
  }
}
