-- ProjectOS: Teams entity + comment drafts (2026-07-22)
-- Apply via `pnpm -C backend db:push` (schema-diff) or run this file directly.

CREATE TABLE IF NOT EXISTS "project_teams" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "key" text NOT NULL,
  "icon" text,
  "color" text,
  "is_private" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_teams_org_key" ON "project_teams" ("org_id", "key");
CREATE INDEX IF NOT EXISTS "idx_project_teams_org" ON "project_teams" ("org_id");

CREATE TABLE IF NOT EXISTS "project_team_members" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "team_id" integer NOT NULL REFERENCES "project_teams"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member',
  "joined_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_team_members_team_user" ON "project_team_members" ("team_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_project_team_members_org" ON "project_team_members" ("org_id");
CREATE INDEX IF NOT EXISTS "idx_project_team_members_user" ON "project_team_members" ("user_id");

CREATE TABLE IF NOT EXISTS "comment_drafts" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "org_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "ticket_id" integer NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_comment_drafts_owner_ticket" ON "comment_drafts" ("org_id", "user_id", "ticket_id");
CREATE INDEX IF NOT EXISTS "idx_comment_drafts_org_user" ON "comment_drafts" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_comment_drafts_ticket" ON "comment_drafts" ("ticket_id");
