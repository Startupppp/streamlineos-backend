SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE feature_flags ADD COLUMN owner text;
--> statement-breakpoint

UPDATE feature_flags SET owner = 'unassigned' WHERE owner IS NULL;
--> statement-breakpoint

UPDATE feature_flags SET expires_at = '2027-01-01 00:00:00' WHERE expires_at IS NULL;
--> statement-breakpoint

ALTER TABLE feature_flags ADD CONSTRAINT chk_ff_owner CHECK (owner IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE feature_flags ADD CONSTRAINT chk_ff_expires_at CHECK (expires_at IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE feature_flags VALIDATE CONSTRAINT chk_ff_owner;
--> statement-breakpoint

ALTER TABLE feature_flags VALIDATE CONSTRAINT chk_ff_expires_at;
--> statement-breakpoint

ALTER TABLE feature_flags ALTER COLUMN owner SET NOT NULL;
--> statement-breakpoint

ALTER TABLE feature_flags ALTER COLUMN expires_at SET NOT NULL;
--> statement-breakpoint

ALTER TABLE feature_flags DROP CONSTRAINT chk_ff_owner;
--> statement-breakpoint

ALTER TABLE feature_flags DROP CONSTRAINT chk_ff_expires_at;
