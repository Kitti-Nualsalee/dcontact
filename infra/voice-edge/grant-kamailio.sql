-- role อ่านอย่างเดียวของ Kamailio ใช้กับ psql -v kamailio_password=... (ห้ามใส่รหัสใน repo)
-- รันด้วย superuser หรือ owner ของฐาน หลัง schema.sql
SELECT 'CREATE ROLE kamailio_ro LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamailio_ro') \gexec
ALTER ROLE kamailio_ro WITH LOGIN PASSWORD :'kamailio_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
ALTER ROLE kamailio_ro SET default_transaction_read_only = on;
SELECT format('GRANT CONNECT ON DATABASE %I TO kamailio_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO kamailio_ro;
GRANT SELECT ON tenant_edge, trunk, number TO kamailio_ro;
