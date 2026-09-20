SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "public"."impersonation_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "actor_user_id" text NOT NULL,
  "target_user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "original_session_id" text NOT NULL,
  "is_revoked" boolean NOT NULL DEFAULT false,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "ended_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "impersonation_sessions_session_id_unique" ON "public"."impersonation_sessions" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonation_sessions_actor_org_idx" ON "public"."impersonation_sessions" ("actor_user_id", "org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "impersonation_sessions_target_org_idx" ON "public"."impersonation_sessions" ("target_user_id", "org_id");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "public"."impersonation_sessions" TO "streamline_app";
