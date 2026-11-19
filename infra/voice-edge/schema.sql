-- ฐานข้อมูล voice edge ที่ Kamailio อ่าน (ADR-038)
-- แยกจากฐานของแอป (Prisma) เพราะ Kamailio อ่านข้ามทุก tenant และไม่ผ่าน RLS ของแอป
-- รอบนี้ operator ใส่ข้อมูลด้วย SQL; หน้าจัดการใน Platform Console เป็นงานภายหลัง
-- รันด้วย owner ของฐาน: psql -v ON_ERROR_STOP=1 -d <voice edge db> -f schema.sql
-- role อ่านอย่างเดียวของ Kamailio สร้างด้วย grant-kamailio.sql

CREATE TABLE IF NOT EXISTS tenant_edge (
  tenant_domain text PRIMARY KEY CHECK (tenant_domain ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$'),
  max_channels integer NOT NULL CHECK (max_channels > 0),
  enabled boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE tenant_edge IS 'tenant ที่ Kamailio รับสาย ระบุด้วย SIP domain เดียวกับ Tenant.sipDomain ของแอป';

CREATE TABLE IF NOT EXISTS trunk (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,64}$'),
  name text NOT NULL,
  -- NULL = trunk กลางของเรา ใช้ร่วมหลาย tenant; มีค่า = trunk ของ tenant นั้นเท่านั้น
  tenant_domain text REFERENCES tenant_edge (tenant_domain),
  source_ip inet NOT NULL UNIQUE,
  host text NOT NULL CHECK (host ~ '^[A-Za-z0-9.:-]{1,253}$'),
  port integer NOT NULL DEFAULT 5060 CHECK (port BETWEEN 1 AND 65535),
  transport text NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp', 'tcp')),
  enabled boolean NOT NULL DEFAULT true
);
COMMENT ON COLUMN trunk.source_ip IS 'IP ต้นทางของสายเข้า ใช้ระบุ trunk';
COMMENT ON COLUMN trunk.host IS 'ปลายทางของสายออก';

CREATE TABLE IF NOT EXISTS number (
  e164 text PRIMARY KEY CHECK (e164 ~ '^\+?[0-9]{3,20}$'),
  tenant_domain text NOT NULL REFERENCES tenant_edge (tenant_domain),
  trunk_id text NOT NULL REFERENCES trunk (id),
  -- DID ภายในที่ FreeSWITCH park ให้ Router (context pstn รับ 2000 คิวตรง และ 2001 IVR)
  route_to text NOT NULL CHECK (route_to ~ '^[0-9]{3,10}$'),
  enabled boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS number_tenant_idx ON number (tenant_domain);

-- เบอร์บน trunk ของ tenant ต้องเป็นของ tenant เจ้าของ trunk
CREATE OR REPLACE FUNCTION number_matches_trunk_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner text;
BEGIN
  SELECT tenant_domain INTO owner FROM trunk WHERE id = NEW.trunk_id;
  IF owner IS NOT NULL AND owner <> NEW.tenant_domain THEN
    RAISE EXCEPTION 'number % belongs to %, but trunk % belongs to %',
      NEW.e164, NEW.tenant_domain, NEW.trunk_id, owner;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS number_matches_trunk_tenant ON number;
CREATE TRIGGER number_matches_trunk_tenant
  BEFORE INSERT OR UPDATE ON number
  FOR EACH ROW EXECUTE FUNCTION number_matches_trunk_tenant();

-- เปลี่ยนเจ้าของ trunk ไม่ได้ถ้ามีเบอร์ของ tenant อื่นผูกอยู่
CREATE OR REPLACE FUNCTION trunk_owner_matches_numbers() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_domain IS NOT NULL AND EXISTS (
    SELECT 1 FROM number WHERE trunk_id = NEW.id AND tenant_domain <> NEW.tenant_domain
  ) THEN
    RAISE EXCEPTION 'trunk % has numbers of other tenants', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trunk_owner_matches_numbers ON trunk;
CREATE TRIGGER trunk_owner_matches_numbers
  BEFORE UPDATE OF tenant_domain ON trunk
  FOR EACH ROW EXECUTE FUNCTION trunk_owner_matches_numbers();
