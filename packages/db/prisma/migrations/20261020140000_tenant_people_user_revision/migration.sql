ALTER TABLE users ADD COLUMN config_revision integer NOT NULL DEFAULT 1 CHECK(config_revision>=1);
