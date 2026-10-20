import {
  coreOrganizationNameError,
  coreTimeZoneValid,
} from '@d-contact/shared/src/core-settings.js';
import {
  CoreApiError,
  type CoreApi,
  type Organization,
  type CoreCapabilities,
  type CoreReceipt,
  type OrganizationPatch,
} from './api.js';
export type CoreState =
  | 'LOADING'
  | 'CLEAN'
  | 'DIRTY'
  | 'SUBMITTING'
  | 'VERIFYING'
  | 'UNKNOWN'
  | 'CONFLICT'
  | 'REAUTH'
  | 'READ_ONLY'
  | 'SAVED';
interface Draft {
  displayName: string;
  locale: string;
  timeZone: string;
  setDefaults: boolean;
}
type CommandStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
function same(a: Organization, b: Organization) {
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.revision === b.revision &&
    a.defaults?.locale === b.defaults?.locale &&
    a.defaults?.timeZone === b.defaults?.timeZone &&
    a.defaults?.initializationSource === b.defaults?.initializationSource
  );
}
export class CoreOrganizationModel {
  state: CoreState = 'LOADING';
  current?: Organization;
  baseline?: Organization;
  caps?: CoreCapabilities;
  draft: Draft = { displayName: '', locale: '', timeZone: '', setDefaults: false };
  message = '';
  errors: Record<string, string> = {};
  pending?: string;
  committed?: Organization;
  narrow = false;
  private listeners = new Set<() => void>();
  private loadSequence = 0;
  readonly storageKey: string;
  constructor(
    readonly api: CoreApi,
    identityKey: string,
    private storage: CommandStorage,
    private commandId: () => string = () => crypto.randomUUID(),
  ) {
    this.storageKey = `dc:core-settings:command:${identityKey}:organization`;
    try {
      const id = this.storage.getItem(this.storageKey);
      if (
        id &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
      )
        this.pending = id;
    } catch {}
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    for (const listener of this.listeners) listener();
  }
  get dirty() {
    return (
      !!this.baseline &&
      (this.draft.displayName !== this.baseline.displayName ||
        this.draft.locale !== (this.baseline.defaults?.locale ?? '') ||
        this.draft.timeZone !== (this.baseline.defaults?.timeZone ?? '') ||
        this.draft.setDefaults !== !!this.baseline.defaults)
    );
  }
  get editable() {
    return (
      this.caps?.organization.write === true &&
      !this.narrow &&
      !this.pending &&
      ![
        'LOADING',
        'SUBMITTING',
        'VERIFYING',
        'UNKNOWN',
        'CONFLICT',
        'REAUTH',
        'READ_ONLY',
      ].includes(this.state)
    );
  }
  private fromCurrent() {
    if (!this.current) return;
    this.baseline = this.current;
    this.draft = {
      displayName: this.current.displayName,
      locale: this.current.defaults?.locale ?? '',
      timeZone: this.current.defaults?.timeZone ?? '',
      setDefaults: !!this.current.defaults,
    };
  }
  async load() {
    const sequence = ++this.loadSequence;
    const hadDraft = this.dirty,
      baselineRevision = this.baseline?.revision;
    this.state = 'LOADING';
    this.emit();
    try {
      const [caps, current] = await Promise.all([this.api.capabilities(), this.api.organization()]);
      if (sequence !== this.loadSequence) return;
      this.caps = caps;
      this.current = current;
      if (!hadDraft) this.fromCurrent();
      this.message = '';
      this.state = !this.caps.organization.write
        ? 'READ_ONLY'
        : hadDraft
          ? baselineRevision === this.current.revision
            ? 'DIRTY'
            : 'CONFLICT'
          : 'CLEAN';
      if (this.state === 'CONFLICT') this.message = 'REVISION_CONFLICT';
      if (this.pending && this.caps.organization.write) await this.checkPending();
    } catch (e) {
      if (sequence !== this.loadSequence) return;
      this.failure(e);
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
        result = await this.api.command(id);
      } catch (e) {
        if (e instanceof CoreApiError && e.status === 404 && e.code === 'COMMAND_UNKNOWN') {
          if (this.pending !== id) return;
          result = await this.api.reconcile(id);
        } else throw e;
      }
      if (this.pending !== id) return;
      if ('state' in result) result = await this.api.reconcile(id);
      if (this.pending !== id) return;
      if ('state' in result) {
        this.state = 'UNKNOWN';
        this.message = 'PENDING';
      } else await this.verify(result);
    } catch (e) {
      if (this.pending !== id) return;
      this.failure(e);
    }
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
    await this.load();
  }
  clear() {
    ++this.loadSequence;
    this.remember();
    this.pending = undefined;
    this.current = undefined;
    this.baseline = undefined;
    this.caps = undefined;
    this.draft = { displayName: '', locale: '', timeZone: '', setDefaults: false };
    this.state = 'READ_ONLY';
    this.emit();
  }

  edit(patch: Partial<Draft>) {
    if (!this.editable) return;
    this.draft = { ...this.draft, ...patch };
    this.state = this.dirty ? 'DIRTY' : 'CLEAN';
    this.errors = {};
    this.message = '';
    this.emit();
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
  private failure(error: unknown) {
    if (error instanceof CoreApiError && error.status === 401) {
      this.state = 'REAUTH';
      this.message = 'REAUTH';
      return;
    }
    if (error instanceof CoreApiError && error.status === 403) {
      this.current = undefined;
      this.baseline = undefined;
      this.caps = undefined;
      this.draft = { displayName: '', locale: '', timeZone: '', setDefaults: false };
      this.state = 'READ_ONLY';
      this.message = 'FORBIDDEN';
      return;
    }
    this.state = this.pending ? 'UNKNOWN' : 'DIRTY';
    this.message = this.pending ? 'UNKNOWN' : 'REQUEST_FAILED';
  }
  private patch(): OrganizationPatch | undefined {
    const patch: OrganizationPatch = {};
    this.errors = {};
    if (!this.baseline) return;
    if (this.draft.displayName !== this.baseline.displayName) {
      patch.displayName = this.draft.displayName.trim();
      if (coreOrganizationNameError(patch.displayName)) this.errors.displayName = 'name';
    }
    if (
      this.draft.setDefaults &&
      (this.draft.locale !== this.baseline.defaults?.locale ||
        this.draft.timeZone !== this.baseline.defaults?.timeZone)
    ) {
      patch.defaults = { locale: this.draft.locale, timeZone: this.draft.timeZone };
      if (!['th', 'en'].includes(this.draft.locale)) this.errors.locale = 'locale';
      if (!coreTimeZoneValid(this.draft.timeZone)) this.errors.timeZone = 'timeZone';
    }
    if (Object.keys(this.errors).length) {
      this.message = 'VALIDATION';
      return;
    }
    return patch;
  }
  async save() {
    if (!this.editable || !this.dirty || !this.baseline) return;
    const patch = this.patch();
    if (!patch) {
      this.emit();
      return;
    }
    if (!Object.keys(patch).length) {
      this.fromCurrent();
      this.state = 'CLEAN';
      this.emit();
      return;
    }
    const id = this.commandId();
    if (!this.remember(id)) {
      this.message = 'STORAGE';
      this.emit();
      return;
    }
    this.pending = id;
    this.state = 'SUBMITTING';
    this.message = '';
    this.emit();
    try {
      await this.verify(
        await this.api.save({ commandId: id, expectedRevision: this.baseline.revision, patch }),
      );
    } catch (e) {
      if (this.pending !== id) return;
      if (e instanceof CoreApiError && e.receipt) {
        try {
          await this.verify(e.receipt);
        } catch (verificationError) {
          this.failure(verificationError);
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
  private async verify(receipt: CoreReceipt) {
    const pending = this.pending;
    if (!pending) return;
    if (receipt.command.id !== pending) throw Error('receipt mismatch');
    const c = receipt.command;
    if (c.action !== 'ORGANIZATION_UPDATE' && !(c.action === null && c.outcome === 'NOT_APPLIED'))
      throw Error('resource mismatch');
    if (c.outcome === 'REJECTED' || c.outcome === 'NOT_APPLIED') {
      this.pending = undefined;
      this.remember();
      this.errors = c.error?.fieldErrors ?? {};
      this.message = c.error?.code ?? 'NOT_APPLIED';
      this.state = c.error?.code === 'VALIDATION_FAILED' ? 'DIRTY' : 'CONFLICT';
      return;
    }
    this.state = 'VERIFYING';
    this.emit();
    const current = await this.api.organization();
    if (this.pending !== pending) return;
    if (
      !c.committedRevision ||
      !/^\d+$/.test(c.committedRevision) ||
      !/^\d+$/.test(current.revision) ||
      current.id !== c.resourceId ||
      !c.resourceSnapshot
    )
      throw Error('invalid readback');
    const expected = BigInt(c.committedRevision),
      actual = BigInt(current.revision);
    if (actual < expected || (actual === expected && !same(current, c.resourceSnapshot)))
      throw Error('inconsistent readback');
    this.current = current;
    this.committed = c.resourceSnapshot;
    this.fromCurrent();
    this.pending = undefined;
    this.remember();
    this.state = 'SAVED';
    this.message = actual > expected ? 'SAVED_LATER' : c.outcome === 'NO_OP' ? 'NO_OP' : 'SAVED';
  }
}
