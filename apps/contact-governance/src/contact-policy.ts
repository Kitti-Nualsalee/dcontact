import type { ContactPolicyTraceEntry, ContactDecision } from '@d-contact/cxa-contracts';
export type { ContactPolicyTraceEntry, ContactDecision } from '@d-contact/cxa-contracts';

export interface ContactPolicyFacts {
  policyVersion: number;
  identityResolution: 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';
  activeRestriction?: {
    type: 'DNC' | 'OBJECTION' | 'CONSENT_REVOKED' | 'INBOUND_SAFETY' | 'REGULATORY';
    reasonCode: string;
    overridable: boolean;
  };
  consent?: {
    status: 'GRANTED' | 'REVOKED' | 'EXPIRED';
    lawfulBasis: string;
  };
}

export interface ContactPolicyResult {
  decision: ContactDecision;
  reasonCode: string;
  policyVersion: number;
  trace: ContactPolicyTraceEntry[];
}

export function evaluateContactPolicy(facts: ContactPolicyFacts): ContactPolicyResult {
  if (facts.identityResolution === 'AMBIGUOUS') {
    return {
      decision: 'REVIEW',
      reasonCode: 'IDENTITY_AMBIGUOUS',
      policyVersion: facts.policyVersion,
      trace: [{ gate: 'IDENTITY', outcome: 'REVIEW', reasonCode: 'IDENTITY_AMBIGUOUS' }],
    };
  }

  if (facts.identityResolution === 'NOT_FOUND') {
    return {
      decision: 'REVIEW',
      reasonCode: 'IDENTITY_NOT_FOUND',
      policyVersion: facts.policyVersion,
      trace: [{ gate: 'IDENTITY', outcome: 'REVIEW', reasonCode: 'IDENTITY_NOT_FOUND' }],
    };
  }

  const trace: ContactPolicyTraceEntry[] = [{ gate: 'IDENTITY', outcome: 'PASS' }];
  if (facts.activeRestriction) {
    trace.push({
      gate: 'HARD_RESTRICTION',
      outcome: 'BLOCK',
      reasonCode: facts.activeRestriction.reasonCode,
    });
    return {
      decision: 'BLOCK',
      reasonCode: facts.activeRestriction.reasonCode,
      policyVersion: facts.policyVersion,
      trace,
    };
  }

  trace.push({ gate: 'HARD_RESTRICTION', outcome: 'PASS' });
  if (facts.consent?.status === 'REVOKED') {
    trace.push({ gate: 'CONSENT', outcome: 'BLOCK', reasonCode: 'CONSENT_REVOKED' });
    return {
      decision: 'BLOCK',
      reasonCode: 'CONSENT_REVOKED',
      policyVersion: facts.policyVersion,
      trace,
    };
  }

  if (facts.consent?.status === 'EXPIRED') {
    trace.push({ gate: 'CONSENT', outcome: 'BLOCK', reasonCode: 'CONSENT_EXPIRED' });
    return {
      decision: 'BLOCK',
      reasonCode: 'CONSENT_EXPIRED',
      policyVersion: facts.policyVersion,
      trace,
    };
  }

  if (facts.consent?.status === 'GRANTED') {
    trace.push({ gate: 'CONSENT', outcome: 'ALLOW', reasonCode: 'POLICY_PASSED' });
    return {
      decision: 'ALLOW',
      reasonCode: 'POLICY_PASSED',
      policyVersion: facts.policyVersion,
      trace,
    };
  }

  trace.push({ gate: 'CONSENT', outcome: 'BLOCK', reasonCode: 'CONSENT_REQUIRED' });
  return {
    decision: 'BLOCK',
    reasonCode: 'CONSENT_REQUIRED',
    policyVersion: facts.policyVersion,
    trace,
  };
}
