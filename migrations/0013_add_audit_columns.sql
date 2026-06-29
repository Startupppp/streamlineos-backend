-- Audit columns: created_by / updated_by tracking
-- Migration: 0013_add_audit_columns

ALTER TABLE leads    ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE leads    ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);

ALTER TABLE deals    ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE deals    ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);

ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE tickets  ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);

ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id);
ALTER TABLE payrolls ADD COLUMN IF NOT EXISTS updated_by TEXT REFERENCES users(id);
