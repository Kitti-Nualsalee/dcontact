export async function runManagedVoiceDue(dependencies: {
  tenantIds(): Promise<string[]>;
  tick(tenantId: string): Promise<void>;
  onError(error: unknown): void;
}) {
  for (const tenantId of await dependencies.tenantIds()) {
    try {
      await dependencies.tick(tenantId);
    } catch (error) {
      dependencies.onError(error);
    }
  }
}

export async function runManagedVoiceReadiness(dependencies: {
  ready(): Promise<boolean>;
  setPortReady(ready: boolean): void;
  clearReadiness(): Promise<void>;
  tenantIds(): Promise<string[]>;
  heartbeat(tenantId: string): Promise<void>;
  onError(error: unknown): void;
}) {
  let ready = false;
  try {
    ready = await dependencies.ready();
  } catch (error) {
    dependencies.onError(error);
  }
  dependencies.setPortReady(ready);
  if (!ready) {
    try {
      await dependencies.clearReadiness();
    } catch (error) {
      dependencies.onError(error);
    }
  }
  for (const tenantId of await dependencies.tenantIds()) {
    if (ready) {
      try {
        await dependencies.heartbeat(tenantId);
      } catch (error) {
        dependencies.onError(error);
      }
    }
  }
}
