import type { AgentWorkspaceSnapshot, WrapupIntentV1, WrapupResultV1 } from './agent-api.js';

type Interaction = NonNullable<AgentWorkspaceSnapshot['interaction']>;

export interface WrapupDraft {
  note: string;
  disposition?: string;
  pending: boolean;
  unknown: boolean;
  reconciling: boolean;
  error?: 'wrapupFailed';
  result?: WrapupResultV1;
  alreadyCompleted: boolean;
  intent?: WrapupIntentV1;
  inFlight: boolean;
  reported: boolean;
  interaction?: Interaction;
}

const empty: WrapupDraft = Object.freeze({
  note: '',
  pending: false,
  unknown: false,
  reconciling: false,
  alreadyCompleted: false,
  inFlight: false,
  reported: false,
});

export class WrapupRuntime {
  private owner?: string;
  private generation = 0;
  private revision = 0;
  private readonly drafts = new Map<string, WrapupDraft>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly version = () => this.revision;

  setOwner(owner: string): void {
    if (this.owner === owner) return;
    this.drafts.clear();
    this.owner = owner;
    this.generation += 1;
  }

  clear(): void {
    this.owner = undefined;
    this.drafts.clear();
    this.generation += 1;
  }

  select(owner: string, interaction?: Interaction | null) {
    const generation = this.generation;
    const pending = [...this.drafts.entries()].find(([, draft]) => draft.pending || draft.unknown);
    const saved = [...this.drafts.entries()].filter(([, draft]) => draft.result).at(-1);
    const key = pending?.[0] ?? interaction?.id ?? saved?.[0] ?? '';
    const valid = () => this.owner === owner && this.generation === generation;
    const read = () => (valid() ? (this.drafts.get(key) ?? empty) : empty);
    const update = (patch: Partial<WrapupDraft>) => {
      if (!valid() || !key) return;
      this.drafts.set(key, {
        ...read(),
        interaction: read().interaction ?? interaction ?? undefined,
        ...patch,
      });
      this.revision += 1;
      for (const listener of this.listeners) listener();
    };
    return { read, update, valid };
  }

  hasUnsavedWork(): boolean {
    return [...this.drafts.values()].some(
      (draft) =>
        !draft.result && Boolean(draft.note || draft.disposition || draft.pending || draft.unknown),
    );
  }

  latestCompleted(owner: string): WrapupDraft | undefined {
    if (this.owner !== owner) return;
    return [...this.drafts.values()].filter((draft) => draft.result).at(-1);
  }
}
