import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLineTeamTrialContentRef,
  lineTeamTrialFailureCode,
  normalizeLineTrialText,
} from './line-team-trial.js';

test('#567 reply text: trim, 1–500 code points, newline allowed but other control characters not', () => {
  assert.equal(normalizeLineTrialText('  Hello\r\nthere  '), 'Hello\nthere');
  assert.equal(normalizeLineTrialText('😀'.repeat(500))?.length, 1000);
  for (const bad of ['', '   ', 'x'.repeat(501), 'a\u0000b', 'tab\there', 7, null, undefined]) {
    assert.equal(normalizeLineTrialText(bad), null, JSON.stringify(bad));
  }
});

test('#567 trial content ref and the code the screen sees', () => {
  assert.equal(isLineTeamTrialContentRef('trial-text:6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f'), true);
  assert.equal(isLineTeamTrialContentRef('fixture:service-notification/v1'), false);
  assert.equal(isLineTeamTrialContentRef('trial-text:../x'), false);
  assert.equal(lineTeamTrialFailureCode('LINE_GATE_KILLED'), 'KILLED');
  assert.equal(lineTeamTrialFailureCode('CONTACT_WINDOW_CAP_EXCEEDED'), 'CAP_EXCEEDED');
  assert.equal(lineTeamTrialFailureCode('RUN_AUTHORIZATION_EXPIRED'), 'TRIAL_NOT_ACTIVE');
  assert.equal(lineTeamTrialFailureCode('SOMETHING_INTERNAL'), 'DENIED');
});
