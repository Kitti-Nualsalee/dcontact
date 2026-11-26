-- test data: two tenants, each with its own trunk; t1 accepts one call at a time to test the ceiling
INSERT INTO tenant_edge (tenant_domain, max_channels) VALUES
  ('t1.sip.test', 1),
  ('t2.sip.test', 5);
INSERT INTO trunk (id, name, tenant_domain, source_ip, host) VALUES
  ('trunk-a', 'trunk ของ t1', 't1.sip.test', '172.30.50.40', '172.30.50.40'), -- allow-thai: seed data
  ('trunk-b', 'trunk ของ t2', 't2.sip.test', '172.30.50.41', '172.30.50.41'); -- allow-thai: seed data
INSERT INTO number (e164, tenant_domain, trunk_id, route_to) VALUES
  ('021000001', 't1.sip.test', 'trunk-a', '2000'),
  ('021000002', 't2.sip.test', 'trunk-b', '2000');
