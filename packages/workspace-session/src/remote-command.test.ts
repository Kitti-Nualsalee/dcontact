import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteCommandCoordinator, type DesiredStateCommand } from './remote-command.js';

test('remote command ยังเป็น PENDING จน authoritative result ยืนยันผล', async () => {
  const sent: DesiredStateCommand[] = [];
  const coordinator = new RemoteCommandCoordinator({
    send: async (command) => {
      sent.push(command);
    },
    reconcile: async () => ({ outcome: 'NOT_APPLIED', resourceVersion: 7 }),
  });
  const command: DesiredStateCommand = {
    commandId: 'cmd-hold-001',
    resourceId: 'interaction-42',
    resourceVersion: 7,
    action: 'HOLD',
    retry: 'once',
  };

  await coordinator.execute(command);

  assert.deepEqual(sent, [command]);
  assert.deepEqual(coordinator.current(), {
    phase: 'PENDING',
    commandId: 'cmd-hold-001',
    action: 'HOLD',
    resourceVersion: 7,
    attempts: 1,
  });

  coordinator.observe({
    commandId: 'cmd-hold-001',
    outcome: 'APPLIED',
    resourceVersion: 8,
  });

  assert.deepEqual(coordinator.current(), {
    phase: 'SUCCEEDED',
    commandId: 'cmd-hold-001',
    action: 'HOLD',
    resourceVersion: 8,
    attempts: 1,
  });
});

test('remote command reconcile ที่ 5 วินาทีและเข้า CONTROL_DEGRADED ที่ 15 วินาที', async () => {
  let now = 0;
  const sent: DesiredStateCommand[] = [];
  const reconciled: string[] = [];
  const coordinator = new RemoteCommandCoordinator(
    {
      send: async (command) => {
        sent.push(command);
      },
      reconcile: async (command) => {
        reconciled.push(command.commandId);
        return { outcome: 'NOT_APPLIED', resourceVersion: command.resourceVersion };
      },
    },
    { now: () => now },
  );
  const command: DesiredStateCommand = {
    commandId: 'cmd-hold-timeout-001',
    resourceId: 'interaction-42',
    resourceVersion: 7,
    action: 'HOLD',
    retry: 'once',
  };
  await coordinator.execute(command);

  now = 5_000;
  await coordinator.reconcileIfDue();

  assert.deepEqual(reconciled, ['cmd-hold-timeout-001']);
  assert.deepEqual(sent, [command, command]);
  assert.deepEqual(coordinator.current(), {
    phase: 'PENDING',
    commandId: 'cmd-hold-timeout-001',
    action: 'HOLD',
    resourceVersion: 7,
    attempts: 2,
  });

  now = 15_000;
  await coordinator.reconcileIfDue();

  assert.deepEqual(coordinator.current(), {
    phase: 'CONTROL_DEGRADED',
    commandId: 'cmd-hold-timeout-001',
    action: 'HOLD',
    resourceVersion: 7,
    attempts: 2,
    reason: 'authoritative result remained uncertain for 15000ms',
  });
});

test('remote command ตัวใหม่ทับ command ที่ยัง PENDING ไม่ได้', async () => {
  const sent: DesiredStateCommand[] = [];
  const coordinator = new RemoteCommandCoordinator({
    send: async (command) => {
      sent.push(command);
    },
    reconcile: async (command) => ({
      outcome: 'NOT_APPLIED',
      resourceVersion: command.resourceVersion,
    }),
  });
  const first: DesiredStateCommand = {
    commandId: 'cmd-hold-001',
    resourceId: 'interaction-42',
    resourceVersion: 7,
    action: 'HOLD',
    retry: 'once',
  };
  await coordinator.execute(first);

  await assert.rejects(
    coordinator.execute({
      ...first,
      commandId: 'cmd-hangup-002',
      action: 'HANGUP',
    }),
    /command cmd-hold-001 is still pending/,
  );
  assert.deepEqual(sent, [first]);
  assert.deepEqual(coordinator.current(), {
    phase: 'PENDING',
    commandId: 'cmd-hold-001',
    action: 'HOLD',
    resourceVersion: 7,
    attempts: 1,
  });
});
