ALTER TABLE tasks ALTER COLUMN type TYPE text USING type::text;
ALTER TABLE deal_activities ALTER COLUMN type TYPE text USING type::text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

DROP TYPE IF EXISTS task_type CASCADE;
DROP TYPE IF EXISTS deal_activity_type CASCADE;
