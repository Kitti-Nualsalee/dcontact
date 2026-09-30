-- E1.17 (#519): VIEW is independent from WORK and CONTACT so screen-pop can
-- authorize disclosure without broadening outbound delivery permissions.
ALTER TYPE "IamScopePermission" ADD VALUE IF NOT EXISTS 'VIEW';
