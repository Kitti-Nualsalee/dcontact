/** clears references of the old lifecycle/identity; this namespace holds no drafts or tokens */
export function clearCoreCommandReferences(keepKey?: string, keepPrefix?: string) {
  try {
    const storage = window.sessionStorage;
    for (const key of Object.keys(storage))
      if (
        key.startsWith('dc:core-settings:command:') &&
        key !== keepKey &&
        !(keepPrefix && key.startsWith(keepPrefix))
      )
        storage.removeItem(key);
  } catch {}
}
