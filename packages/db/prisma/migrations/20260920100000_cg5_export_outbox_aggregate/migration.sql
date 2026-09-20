-- CG5.8 (#292): export changes use the existing durable Governance outbox.
ALTER TYPE "CgAggregateType" ADD VALUE IF NOT EXISTS 'EXPORT';
