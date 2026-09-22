import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOURNEY_INTERACTION_OUTCOME_TYPES,
  JOURNEY_NODE_PORTS,
  JOURNEY_RESTRICTED_NODE_TYPES,
  JOURNEY_RUNTIME_NODE_TYPES,
  JOURNEY_TRIGGER_NODE_TYPES,
  type AuthoringDocumentV1,
} from '@d-contact/cxa-contracts';
import type { JourneySnapshot } from './journey-authoring/api.js';
import {
  AuthoringCommandRejected,
  INTERACTION_OUTCOME_TYPES,
  NODE_OUTPUT_PORTS,
  RESTRICTED_NODE_TYPES,
  RUNTIME_NODE_TYPES,
  TRIGGER_NODE_TYPES,
  applyCommand,
  blankDocument,
  changedNodeIds,
  edgeFrom,
  outlineOrder,
  replay,
  type AuthoringCommand,
} from './journey-authoring/model.js';
import {
  clearRecovery,
  editorDocument,
  editorReducer,
  initialEditorState,
  loadRecovery,
  recoveryKey,
  saveRecovery,
} from './journey-authoring/state.js';

const base = () =>
  blankDocument({
    name: 'synthetic',
    eventType: 'invoice.overdue',
    senderIdentityId: 'sender-1',
    purpose: 'SERVICE',
  });

const addAfter = (nodeId: string, portId: 'start' | 'next', newNode: string): AuthoringCommand => ({
  kind: 'ADD_NODE',
  nodeId: newNode,
  nodeType: 'SEND',
  edgeIds: [`edge-${newNode}-a`, `edge-${newNode}-b`],
  after: { nodeId, portId },
});

function snapshot(document: AuthoringDocumentV1, revision = 1): JourneySnapshot {
  return {
    head: {
      journeyId: 'j-1',
      name: document.settings.name,
      ownerTeamId: 'team-1',
      lifecycle: 'DRAFT_ONLY',
      version: revision,
      currentDraftRevision: revision,
      currentDraftDigest: 'a'.repeat(64),
      activeVersion: null,
      activeRuntimeHash: null,
    },
    draft: { revision, digest: 'a'.repeat(64), basePublishedVersion: null, document },
    review: null,
    templateNotices: [],
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test('J5.6 ค่าคงที่ node/port ของ Console ตรงกับ contracts ทุกตัว', () => {
  assert.deepEqual([...TRIGGER_NODE_TYPES], [...JOURNEY_TRIGGER_NODE_TYPES]);
  assert.deepEqual([...RUNTIME_NODE_TYPES], [...JOURNEY_RUNTIME_NODE_TYPES]);
  assert.deepEqual([...RESTRICTED_NODE_TYPES], [...JOURNEY_RESTRICTED_NODE_TYPES]);
  assert.deepEqual(INTERACTION_OUTCOME_TYPES, [...JOURNEY_INTERACTION_OUTCOME_TYPES]);
  for (const [type, ports] of Object.entries(JOURNEY_NODE_PORTS)) {
    assert.deepEqual(
      [...NODE_OUTPUT_PORTS[type as keyof typeof NODE_OUTPUT_PORTS]],
      Object.keys(ports.outputs),
      type,
    );
  }
});

test('J5.6 แทรกขั้นตอนหลัง port ต่อสายเดิมให้ครบ และ connect แทนที่ edge เดิมของ port', () => {
  const inserted = applyCommand(base(), addAfter('trigger', 'start', 'send-1'));
  assert.equal(edgeFrom(inserted, 'trigger', 'start')?.target.nodeId, 'send-1');
  assert.equal(edgeFrom(inserted, 'send-1', 'next')?.target.nodeId, 'done');
  assert.deepEqual(outlineOrder(inserted), ['trigger', 'send-1', 'done']);
  assert.ok(inserted.layout.nodes['send-1']);

  const rewired = applyCommand(inserted, {
    kind: 'CONNECT',
    edgeId: 'edge-direct',
    source: { nodeId: 'trigger', portId: 'start' },
    targetNodeId: 'done',
  });
  assert.equal(rewired.edges.filter((edge) => edge.source.nodeId === 'trigger').length, 1);
  assert.deepEqual(outlineOrder(rewired), ['trigger', 'done', 'send-1']);

  assert.throws(
    () =>
      applyCommand(inserted, {
        kind: 'CONNECT',
        edgeId: 'x',
        source: { nodeId: 'send-1', portId: 'next' },
        targetNodeId: 'trigger',
      }),
    AuthoringCommandRejected,
  );
  assert.throws(
    () => applyCommand(inserted, { kind: 'DELETE_NODE', nodeId: 'trigger' }),
    AuthoringCommandRejected,
  );
  const deleted = applyCommand(inserted, { kind: 'DELETE_NODE', nodeId: 'send-1' });
  assert.equal(deleted.edges.length, 0);
  assert.equal(deleted.layout.nodes['send-1'], undefined);
});

test('J5.6 node ที่ไม่รู้จักเป็น read-only: แก้/ลบไม่ได้และ source เดิมอยู่ครบ', () => {
  const legacy: AuthoringDocumentV1 = {
    ...base(),
    nodes: [
      ...base().nodes,
      { nodeId: 'future', type: 'UNSUPPORTED', sourceType: 'AI_STEP', source: { secret: 'keep' } },
    ],
  };
  for (const command of [
    { kind: 'DELETE_NODE', nodeId: 'future' },
    { kind: 'SET_LABEL', nodeId: 'future', label: 'x' },
    { kind: 'SET_CONFIG', nodeId: 'future', key: 'reason', value: 'x' },
  ] as AuthoringCommand[]) {
    assert.throws(() => applyCommand(legacy, command), AuthoringCommandRejected);
  }
  assert.deepEqual(legacy.nodes.at(-1), {
    nodeId: 'future',
    type: 'UNSUPPORTED',
    sourceType: 'AI_STEP',
    source: { secret: 'keep' },
  });
});

test('J5.6 reducer: canvas/outline ใช้ command log เดียว, undo/redo และ keep-copy ตัดเฉพาะที่ใช้ไม่ได้', () => {
  let state = initialEditorState(snapshot(base()));
  state = editorReducer(state, {
    type: 'COMMAND',
    command: addAfter('trigger', 'start', 'send-1'),
  });
  assert.equal(state.selectedNodeId, 'send-1');
  state = editorReducer(state, {
    type: 'COMMAND',
    command: { kind: 'SET_CONFIG', nodeId: 'send-1', key: 'contentRef', value: 'content-a' },
  });
  state = editorReducer(state, {
    type: 'COMMAND',
    command: { kind: 'DELETE_NODE', nodeId: 'trigger' },
  });
  assert.equal(state.rejected, 'TRIGGER_REQUIRED');
  assert.equal(state.commands.length, 2);

  state = editorReducer(state, { type: 'UNDO' });
  assert.equal(state.commands.length, 1);
  state = editorReducer(state, { type: 'REDO' });
  const document = editorDocument(state);
  assert.deepEqual(document, replay(base(), state.commands));
  const send = document.nodes.find((node) => node.nodeId === 'send-1');
  assert.equal((send as { config: { contentRef: string } }).config.contentRef, 'content-a');

  // server มี revision ใหม่ที่ลบ done ไปแล้ว: command ที่ยังใช้ได้ถูกเก็บ ที่ใช้ไม่ได้ถูกนับและตัด
  const latest: AuthoringDocumentV1 = { ...base(), nodes: [], edges: [], layout: { nodes: {} } };
  const conflicted = editorReducer(state, { type: 'CONFLICT', latest: snapshot(latest, 2) });
  assert.ok(conflicted.conflict);
  const kept = editorReducer(conflicted, {
    type: 'SNAPSHOT',
    snapshot: snapshot(latest, 2),
    keepCommands: true,
  });
  assert.equal(kept.conflict, null);
  assert.equal(kept.commands.length, 2);
  assert.equal(kept.dropped, 0);
  assert.deepEqual(changedNodeIds(latest, editorDocument(kept)), ['trigger', 'send-1']);
  const reloaded = editorReducer(conflicted, { type: 'SNAPSHOT', snapshot: snapshot(latest, 2) });
  assert.equal(reloaded.commands.length, 0);
});

test('J5.6 session recovery ผูก scope/resource/base revision และล้างทั้ง scope ได้', () => {
  const storage = new MemoryStorage();
  const key = recoveryKey('tenant-a:session-1', 'j-1', 3);
  const commands: AuthoringCommand[] = [addAfter('trigger', 'start', 'send-1')];
  saveRecovery(storage, key, commands);
  assert.deepEqual(loadRecovery(storage, key), commands);
  assert.equal(loadRecovery(storage, recoveryKey('tenant-a:session-1', 'j-1', 4)), null);
  assert.equal(loadRecovery(storage, recoveryKey('tenant-b:session-1', 'j-1', 3)), null);

  storage.setItem(recoveryKey('tenant-a:session-1', 'j-2', 1), '{"version":1,"commands":[{}]}');
  assert.equal(loadRecovery(storage, recoveryKey('tenant-a:session-1', 'j-2', 1)), null);
  saveRecovery(storage, recoveryKey('tenant-b:session-1', 'j-9', 1), commands);
  clearRecovery(storage, 'tenant-a:session-1');
  assert.equal(storage.getItem(key), null);
  assert.ok(storage.getItem(recoveryKey('tenant-b:session-1', 'j-9', 1)));
  saveRecovery(storage, key, []);
  assert.equal(storage.getItem(key), null);
});
