export class E1BackgroundJobs {
  private readonly commands = new Map<string, { callUuid: string; at: number }>();
  private readonly earlyResults = new Map<string, { succeeded: boolean; at: number }>();

  constructor(private readonly failure: (jobUuid: string, callUuid: string) => Promise<unknown>) {}

  async accepted(jobUuid: string, callUuid: string) {
    this.prune();
    const result = this.earlyResults.get(jobUuid);
    if (result) {
      this.earlyResults.delete(jobUuid);
      if (!result.succeeded) await this.failure(jobUuid, callUuid);
      return;
    }
    this.commands.set(jobUuid, { callUuid, at: Date.now() });
  }

  async completed(jobUuid: string, succeeded: boolean) {
    this.prune();
    const command = this.commands.get(jobUuid);
    if (command) {
      if (!succeeded) await this.failure(jobUuid, command.callUuid);
      this.commands.delete(jobUuid);
    } else {
      this.earlyResults.set(jobUuid, { succeeded, at: Date.now() });
    }
  }

  private prune() {
    const cutoff = Date.now() - 60_000;
    for (const [key, value] of this.commands) if (value.at < cutoff) this.commands.delete(key);
    for (const [key, value] of this.earlyResults)
      if (value.at < cutoff) this.earlyResults.delete(key);
    if (this.earlyResults.size >= 100)
      this.earlyResults.delete(this.earlyResults.keys().next().value!);
  }
}
