/** ล้าง reference ของ lifecycle/identity เดิม; ไม่มีร่างหรือ token ใน namespace นี้ */
export function clearCoreCommandReferences(keepKey?: string) {
  try {
    const storage = window.sessionStorage;
    for (const key of Object.keys(storage))
      if (key.startsWith('dc:core-settings:command:') && key !== keepKey) storage.removeItem(key);
  } catch {}
}
