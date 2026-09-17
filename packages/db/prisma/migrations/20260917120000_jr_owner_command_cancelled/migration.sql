-- J2.8 (#136): an owner action cancelled before its command ever left Journey
-- keeps the staged command row for audit but must never be dispatched (#123:
-- Journey terminal commit before the owner receives the command).
ALTER TYPE "JrOwnerCommandState" ADD VALUE IF NOT EXISTS 'CANCELLED';
