ALTER TABLE tenant_people_step_receipts ADD COLUMN reason_code text
  CHECK(reason_code IS NULL OR (outcome='UNKNOWN' AND reason_code IN ('CORRELATION_CONFLICT','IDENTITY_MAPPING_CONFLICT')));
