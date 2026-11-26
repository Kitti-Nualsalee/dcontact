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
  displayName: 'Original Organization',
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
    resourceSnapshot: { ...original, displayName: 'New name', revision: '1' },
    error: null,
  },
};
test('teams page: an Admin pending state does not block a Supervisor reading own Team after permissions change', async () => {
  const team: Team = { id: original.id, name: 'My team', isActive: true, revision: '1' };
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
test('organization page: reports saved when the readback matches the receipt and does not create defaults from a rename', async () => {
  const f = fixture(),
    saved = storage();
  const model = new CoreOrganizationModel(
    f.api,
    'verified-identity',
    saved,
    () => receipt.command.id,
  );
  await model.load();
  model.edit({ displayName: 'New name' });
  await model.save();
  assert.equal(model.state, 'SAVED');
  assert.equal(model.current?.revision, '1');
  assert.equal(model.current?.defaults, null);
  assert.equal(saved.map.size, 0);
});

test('organization page: a lost response then reload keeps only the commandId and recovers the receipt/readback before a new edit', async () => {
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
  model.edit({ displayName: 'New name' });
  await model.save();
  assert.equal(model.state, 'UNKNOWN');
  assert.deepEqual([...saved.map.values()], [receipt.command.id]);
  const reloaded = new CoreOrganizationModel(f.api, 'verified-identity', saved);
  await reloaded.load();
  assert.equal(reloaded.state, 'SAVED');
  assert.equal(reloaded.current?.displayName, 'New name');
  assert.equal(saved.map.size, 0);
});

test('organization page: lookup404 does not conclude failure, and reconcile still PENDING so no new command is sent', async () => {
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
  model.edit({ displayName: 'Draft kept' });
  await model.save();
  await model.checkPending();
  assert.equal(model.state, 'UNKNOWN');
  assert.equal(model.draft.displayName, 'Draft kept');
  assert.equal(model.pending, receipt.command.id);
  assert.equal(model.editable, false);
});
test('organization page: NOT_APPLIED is a fence to check the current value before starting a new command', async () => {
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
  model.edit({ displayName: 'Draft kept' });
  await model.save();
  await model.checkPending();
  assert.equal(model.state, 'CONFLICT');
  assert.equal(model.message, 'NOT_APPLIED');
  assert.equal(model.draft.displayName, 'Draft kept');
  assert.equal(saved.map.size, 0);
  await model.loadLatest();
  assert.equal(model.draft.displayName, 'Original Organization');
  assert.equal(model.state, 'CLEAN');
});
test('organization page: a failed/older-than-receipt readback must not report success, and keeps the original command', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  f.api.save = async () => receipt;
  await model.load();
  model.edit({ displayName: 'New name' });
  await model.save();
  assert.equal(model.state, 'UNKNOWN');
  assert.equal(model.pending, receipt.command.id);
  assert.equal(saved.map.size, 1);
  f.setResource(receipt.command.resourceSnapshot!);
  await model.checkPending();
  assert.equal(model.state, 'SAVED');
});
test('organization page: a readback newer than the receipt shows the committed value separate from the current values', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  f.api.save = async () => {
    f.setResource({
      ...receipt.command.resourceSnapshot!,
      displayName: 'Edited by someone else',
      revision: '2',
    });
    return receipt;
  };
  await model.load();
  model.edit({ displayName: 'New name' });
  await model.save();
  assert.equal(model.state, 'SAVED');
  assert.equal(model.message, 'SAVED_LATER');
  assert.equal(model.current?.displayName, 'Edited by someone else');
  assert.equal(model.committed?.displayName, 'New name');
});
test('organization page: same-identity reauth keeps the draft, and a revision conflict does not overwrite automatically', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved, () => receipt.command.id);
  await model.load();
  model.edit({ displayName: 'My draft' });
  f.api.capabilities = async () => {
    throw new CoreApiError(401, 'CORE_ACCESS_DENIED');
  };
  await model.load();
  assert.equal(model.state, 'REAUTH');
  assert.equal(model.draft.displayName, 'My draft');
  f.api.capabilities = async () => ({ organization: { read: true, write: true } });
  await model.load();
  assert.equal(model.state, 'DIRTY');
  f.setResource({ ...original, revision: '1', displayName: 'Saved by someone else' });
  await model.load();
  assert.equal(model.state, 'CONFLICT');
  assert.equal(model.draft.displayName, 'My draft');
  assert.equal(model.editable, false);
});
test('organization page: narrow keeps the draft, then widening must re-check values/permission, and forbidden clears the data', async () => {
  const f = fixture(),
    saved = storage(),
    model = new CoreOrganizationModel(f.api, 'identity', saved);
  await model.load();
  model.edit({ displayName: 'My draft' });
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

test('organization page: the same validation as the API, a wrong name/timezone must not be sent', async () => {
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

test('organization page: a late response from an old load must not overwrite the draft/latest values', async () => {
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
    return Promise.resolve({ ...original, displayName: 'Latest value', revision: '1' });
  };
  const old = model.load();
  await model.load();
  model.edit({ displayName: 'Unsaved draft' });
  release(original);
  await old;
  assert.equal(model.current?.revision, '1');
  assert.equal(model.draft.displayName, 'Unsaved draft');
});

test('organization page: withdrawing the old page while checking a command must not keep reconciling or return old data', async () => {
  const f = fixture(),
    model = new CoreOrganizationModel(f.api, 'identity', storage(), () => receipt.command.id);
  f.api.save = async () => {
    throw Error('transport');
  };
  await model.load();
  model.edit({ displayName: 'New name' });
  await model.save();
  let release!: (value: { state: 'ADMITTED'; commandId: string }) => void;
  f.api.command = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.api.reconcile = async () => {
    assert.fail('must not reconcile after clear');
  };
  const checking = model.checkPending();
  model.clear();
  release({ state: 'ADMITTED', commandId: receipt.command.id });
  await checking;
  assert.equal(model.state, 'READ_ONLY');
  assert.equal(model.current, undefined);
});

test('organization page: a save that fails after clear must not return the state of the old identity', async () => {
  const f = fixture(),
    model = new CoreOrganizationModel(f.api, 'identity', storage(), () => receipt.command.id);
  let reject!: (error: unknown) => void;
  f.api.save = () =>
    new Promise((_resolve, fail) => {
      reject = fail;
    });
  await model.load();
  model.edit({ displayName: 'New name' });
  const saving = model.save();
  model.clear();
  reject(new CoreApiError(401, 'CORE_ACCESS_DENIED'));
  await saving;
  assert.equal(model.state, 'READ_ONLY');
  assert.equal(model.pending, undefined);
});
