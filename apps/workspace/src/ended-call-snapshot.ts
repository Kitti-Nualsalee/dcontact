import type { AgentWorkspaceSnapshot } from './agent-api.js';

export class EndedCallSnapshotReconciler {
  private generation = 0;
  private active?: { interactionId: string; promise: Promise<void> };

  constructor(
    private readonly options: {
      snapshot(): Promise<AgentWorkspaceSnapshot>;
      apply(snapshot: AgentWorkspaceSnapshot): void;
      onExhausted(): void;
      wait?: () => Promise<void>;
      attempts?: number;
    },
  ) {}

  start(interactionId: string): Promise<void> {
    if (this.active?.interactionId === interactionId) return this.active.promise;
    const generation = ++this.generation;
    const promise = this.reconcile(interactionId, generation);
    this.active = { interactionId, promise };
    return promise;
  }

  cancel(): void {
    this.generation += 1;
    this.active = undefined;
  }

  checkpoint(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }

  private async reconcile(interactionId: string, generation: number): Promise<void> {
    const attempts = this.options.attempts ?? 12;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (generation !== this.generation) return;
      try {
        const snapshot = await this.options.snapshot();
        if (generation !== this.generation) return;
        if (snapshot.interaction?.id !== interactionId || snapshot.interaction.state === 'WRAPUP') {
          this.options.apply(snapshot);
          return;
        }
      } catch {
        if (generation !== this.generation) return;
      }
      if (attempt + 1 < attempts) {
        await (this.options.wait?.() ?? new Promise((resolve) => setTimeout(resolve, 500)));
      }
    }
    if (generation === this.generation) this.options.onExhausted();
  }
}
