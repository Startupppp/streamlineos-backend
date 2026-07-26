-- 0303: tenant-scoped uniqueness for category & channel names (audit S-15, S-22).
-- Additive & safe: verified no existing (org_id, name) duplicates before applying.
-- Paired service changes catch Postgres 23505 and return a 409 ConflictException.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_categories_org_name ON inv_categories (org_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_channels_org_name ON inv_channels (org_id, name);
