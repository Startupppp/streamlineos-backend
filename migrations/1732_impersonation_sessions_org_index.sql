SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_impersonation_sessions_org_actor" ON "public"."impersonation_sessions" ("org_id", "actor_user_id");
