-- CG5.6 (#290): alert changes use the existing durable Governance outbox.
ALTER TYPE "CgAggregateType" ADD VALUE IF NOT EXISTS 'ALERT';
