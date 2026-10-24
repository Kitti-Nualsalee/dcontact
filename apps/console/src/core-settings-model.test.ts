import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreOrganizationModel } from './core-settings/model.js';
import { CoreTeamModel } from './core-settings/team-model.js';
import {
  CoreApiError,
  type CoreApi,
  type Organization,
  type CoreReceipt,
  type CoreTeamsApi,
  type Team,
} from './core-settings/api.js';
const original: Organization = {
  id: 'f7e4aba1-dc3c-4f02-9f3b-e050ee5ef7a0',
  displayName: 'องค์กรเดิม',
  defaults: null,
  revision: '0',
};
const receipt: CoreReceipt = {
  command: {
    id: '2a71963f-8f34-4c70-8111-9ca6fa1818cf',
    action: 'ORGANIZATION_UPDATE',
    resourceId: original.id,
    outcome: 'APPLIED',
    committedRevision: '1',
    resourceSnapshot: { ...original, displayName: 'ชื่อใหม่', revision: '1' },
    error: null,
  },
};
test('หน้าทีม: pending ของ Admin ไม่ขวาง Supervisor อ่าน own Team หลังเปลี่ยนสิทธิ์', async () => {
  const team: Team = { id: original.id, name: 'ทีมของฉัน', isActive: true, revision: '1' };
  const saved = storage();
  saved.setItem(`dc:core-settings:command:identity:team:${team.id}`, receipt.command.id);
  const forbidden = async () => {
    throw new CoreApiError(403, 'CORE_ACCESS_DENIED');
  };
  const api: CoreApi & { teams: CoreTeamsApi } = {
    ...fixture().api,
    capabilities: async () => ({
      organization: { read: true, write: false },
      teams: { read: true, create: false, rename: false, deactivate: false },
    }),
    teams: {
      list: async () => ({ teams: [team], nextCursor: null }),
      read: async () => team,
      create: forbidden,
      rename: forbidden,
      deactivate: forbidden,
      command: forbidden,
      reconcile: forbidden,
    },
  };
  const model = new CoreTeamModel(api, 'identity', team.id, {
    ...saved,
    clear: () => saved.map.clear(),
    key: (index) => [...saved.map.keys()][index] ?? null,
    get length() {
      return saved.map.size;
    },
  });
  for (let retry = 0; retry < 2; retry++) {
    await model.load();
    assert.equal(model.state, 'READ_ONLY');
    assert.deepEqual(model.current, team);
    assert.deepEqual(model.teams, [team]);
    assert.equal(model.message, '');
    assert.equal(model.editable, false);
    assert.equal(saved.getItem(model.storageKey), receipt.command.id);
  }
});
function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    map,
  };
}
function fixture() {
  let resource = { ...original };
  const api: CoreApi = {
    capabilities: async () => ({ organization: { read: true, write: true } }),
    organization: async () => resource,
    save: async () => {
      resource = receipt.command.resourceSnapshot!;
      return receipt;
    },
    command: async () => receipt,
    reconcile: async () => receipt,
  };
  return {
    api,
    setResource: (value: Organization) => {
      resource = value;
    },
  };
}
test('หน้าองค์กร: แจ้งบันทึกแล้วเมื่อ readback ตรง receipt และไม่สร้าง defaults จากการแก้ชื่อ', async () => {
  const f = fixture(),
    saved = storage();
  const model = new CoreOrganizationModel(
    f.api,
    'verified-identity',
    saved,
    () => receipt.command.id,
  );
  await model.load();
  model.edit({ displayName: 'ชื่อใหม่' });
  await model.save();
  assert.equal(model.state, 'SAVED');
  assert.equal(model.current?.revision, '1');
  assert.equal(model.current?.defaults, null);
  assert.equal(saved.map.size, 0);
});

test('หน้าองค์กร: response หลุดแล้ว reload เก็บเฉพาะ commandId และกู้ receipt/readback ก่อนแก้ใหม่', async () => {
  const f = fixture(),
    saved = storage();
  f.api.save = async () => {
    f.setResource(receipt.command.resourceSnapshot!);
    throw new TypeError('connection lost');
  };
  const model = new CoreOrganizationModel(
    f.api,
    'verified-identity',
    saved,
    () => receipt.command.id,
  );
  await model.load();
  model.edit({ displayName: 'ชื่อใหม่' });
  await model.save();
  assert.equal(model.state, 'UNKNOWN');
  assert.deepEqual([...saved.map.values()], [receipt.command.id]);
  const reloaded = new CoreOrganizationModel(f.api, 'verified-identity', saved);
  await reloaded.load();
  assert.equal(reloaded.state, 'SAVED');
  assert.equal(reloaded.current?.displayName, 'ชื่อใหม่');
  assert.equal(saved.map.size, 0);
});

test('หน้าองค์กร: lookup404 ไม่สรุปว่าล้มเหลว และ reconcile ยัง PENDING จึงไม่ส่งคำสั่งใหม่', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  f.api.save = async () => {
    throw Error('transport');
  };
  f.api.command = async () => {
    throw new CoreApiError(404, 'COMMAND_UNKNOWN');
  };
  f.api.reconcile = async () => ({ state: 'PENDING', commandId: receipt.command.id });
  await model.load();
  model.edit({ displayName: 'ร่างยังอยู่' });
  await model.save();
  await model.checkPending();
  assert.equal(model.state, 'UNKNOWN');
  assert.equal(model.draft.displayName, 'ร่างยังอยู่');
  assert.equal(model.pending, receipt.command.id);
  assert.equal(model.editable, false);
});
test('หน้าองค์กร: NOT_APPLIED เป็น fence ให้ตรวจค่าปัจจุบันก่อนเริ่ม command ใหม่', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  f.api.save = async () => {
    throw Error('transport');
  };
  f.api.command = async () => ({ state: 'ADMITTED', commandId: receipt.command.id });
  f.api.reconcile = async () => ({
    command: {
      ...receipt.command,
      outcome: 'NOT_APPLIED',
      committedRevision: null,
      resourceSnapshot: null,
    },
  });
  await model.load();
  model.edit({ displayName: 'ร่างยังอยู่' });
  await model.save();
  await model.checkPending();
  assert.equal(model.state, 'CONFLICT');
  assert.equal(model.message, 'NOT_APPLIED');
  assert.equal(model.draft.displayName, 'ร่างยังอยู่');
  assert.equal(saved.map.size, 0);
  await model.loadLatest();
  assert.equal(model.draft.displayName, 'องค์กรเดิม');
  assert.equal(model.state, 'CLEAN');
});
test('หน้าองค์กร: readback ล้มเหลว/เก่ากว่า receipt ห้ามแจ้งสำเร็จ และเก็บ command เดิม', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  f.api.save = async () => receipt;
  await model.load();
  model.edit({ displayName: 'ชื่อใหม่' });
  await model.save();
  assert.equal(model.state, 'UNKNOWN');
  assert.equal(model.pending, receipt.command.id);
  assert.equal(saved.map.size, 1);
  f.setResource(receipt.command.resourceSnapshot!);
  await model.checkPending();
  assert.equal(model.state, 'SAVED');
});
test('หน้าองค์กร: readback ใหม่กว่า receipt แสดงค่าที่ commit แยกจาก current values', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  f.api.save = async () => {
    f.setResource({
      ...receipt.command.resourceSnapshot!,
      displayName: 'อีกคนแก้ต่อ',
      revision: '2',
    });
    return receipt;
  };
  await model.load();
  model.edit({ displayName: 'ชื่อใหม่' });
  await model.save();
  assert.equal(model.state, 'SAVED');
  assert.equal(model.message, 'SAVED_LATER');
  assert.equal(model.current?.displayName, 'อีกคนแก้ต่อ');
  assert.equal(model.committed?.displayName, 'ชื่อใหม่');
});
test('หน้าองค์กร: same identity reauth คงร่าง และ revision ชนไม่เขียนทับอัตโนมัติ', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  await model.load();
  model.edit({ displayName: 'ร่างของฉัน' });
  f.api.capabilities = async () => {
    throw new CoreApiError(401, 'CORE_ACCESS_DENIED');
  };
  await model.load();
  assert.equal(model.state, 'REAUTH');
  assert.equal(model.draft.displayName, 'ร่างของฉัน');
  f.api.capabilities = async () => ({ organization: { read: true, write: true } });
  await model.load();
  assert.equal(model.state, 'DIRTY');
  f.setResource({ ...original, revision: '1', displayName: 'อีกคนบันทึก' });
  await model.load();
  assert.equal(model.state, 'CONFLICT');
  assert.equal(model.draft.displayName, 'ร่างของฉัน');
  assert.equal(model.editable, false);
});
test('หน้าองค์กร: narrow เก็บร่างแล้วขยายจอต้องตรวจค่า/สิทธิ์ใหม่ และ forbidden ล้างข้อมูล', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved);
  await model.load();
  model.edit({ displayName: 'ร่างของฉัน' });
  await model.setNarrow(true);
  assert.equal(model.editable, false);
  f.api.capabilities = async () => {
    throw new CoreApiError(403, 'CORE_ACCESS_DENIED');
  };
  await model.setNarrow(false);
  assert.equal(model.current, undefined);
  assert.equal(model.draft.displayName, '');
  assert.equal(model.state, 'READ_ONLY');
});

test('หน้าองค์กร: validation ชุดเดียวกับ API ห้ามส่งชื่อ/เขตเวลาที่ผิด', async () => {
  const { coreNameFixtures, coreTimeZoneFixtures } =
    await import('@d-contact/shared/src/core-settings-fixtures.js');
  for (const { value, valid } of coreNameFixtures) {
    if (valid) continue;
    const f = fixture(),
      model = new CoreOrganizationModel(f.api, 'identity', storage());
    await model.load();
    model.edit({ displayName: value });
    await model.save();
    assert.equal(model.errors.displayName, 'name');
    assert.equal(model.pending, undefined);
  }
  for (const { value, valid } of coreTimeZoneFixtures) {
    if (valid) continue;
    const f = fixture(),
      model = new CoreOrganizationModel(f.api, 'identity', storage());
    await model.load();
    model.edit({ setDefaults: true, locale: 'th', timeZone: value });
    await model.save();
    assert.equal(model.errors.timeZone, 'timeZone');
    assert.equal(model.pending, undefined);
  }
});

test('หน้าองค์กร: response จาก load เก่าที่มาช้าต้องไม่เขียนทับร่าง/ค่าล่าสุด', async () => {
  const f = fixture(),
    model = new CoreOrganizationModel(f.api, 'identity', storage());
  let release!: (value: Organization) => void,
    first = true;
  const delayed = new Promise<Organization>((resolve) => {
    release = resolve;
  });
  f.api.organization = () => {
    if (first) {
      first = false;
      return delayed;
    }
    return Promise.resolve({ ...original, displayName: 'ค่าล่าสุด', revision: '1' });
  };
  const old = model.load();
  await model.load();
  model.edit({ displayName: 'ร่างที่ยังไม่บันทึก' });
  release(original);
  await old;
  assert.equal(model.current?.revision, '1');
  assert.equal(model.draft.displayName, 'ร่างที่ยังไม่บันทึก');
});

test('หน้าองค์กร: ถอนหน้าเดิมระหว่างตรวจคำสั่งต้องไม่ reconcile ต่อหรือคืนข้อมูลเก่า', async () => {
  const f = fixture(),
    model = new CoreOrganizationModel(f.api, 'identity', storage(), () => receipt.command.id);
  f.api.save = async () => {
    throw Error('transport');
  };
  await model.load();
  model.edit({ displayName: 'ชื่อใหม่' });
  await model.save();
  let release!: (value: { state: 'ADMITTED'; commandId: string }) => void;
  f.api.command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.api.reconcile = async () => {
    assert.fail('ไม่ควร reconcile หลัง clear');
  };
  const checking = model.checkPending();
  model.clear();
  release({ state: 'ADMITTED', commandId: receipt.command.id });
  await checking;
  assert.equal(model.state, 'READ_ONLY');
  assert.equal(model.current, undefined);
});

test('หน้าองค์กร: save ที่ล้มเหลวหลัง clear ต้องไม่คืนสถานะของ identity เดิม', async () => {
  const f = fixture(),
    model = new CoreOrganizationModel(f.api, 'identity', storage(), () => receipt.command.id);
  let reject!: (error: unknown) => void;
  f.api.save = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  await model.load();
  model.edit({ displayName: 'ชื่อใหม่' });
  const saving = model.save();
  model.clear();
  reject(new CoreApiError(401, 'CORE_ACCESS_DENIED'));
  await saving;
  assert.equal(model.state, 'READ_ONLY');
  assert.equal(model.pending, undefined);
});
