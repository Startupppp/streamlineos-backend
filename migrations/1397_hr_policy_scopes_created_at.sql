SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE hr_policy_scopes
  ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now();
