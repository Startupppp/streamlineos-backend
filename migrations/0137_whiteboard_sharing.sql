CREATE TYPE "whiteboard_visibility" AS ENUM ('project', 'private', 'public');
--> statement-breakpoint
CREATE TYPE "whiteboard_share_role" AS ENUM ('viewer', 'editor');
--> statement-breakpoint
ALTER TABLE "project_whiteboards"
  ADD COLUMN "visibility" "whiteboard_visibility" NOT NULL DEFAULT 'project',
  ADD COLUMN "public_access" "whiteboard_share_role" NOT NULL DEFAULT 'viewer',
  ADD COLUMN "share_token" text,
  ADD COLUMN "link_expires_at" timestamp,
  ADD COLUMN "allow_export" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "project_whiteboards" ALTER COLUMN "data" SET DEFAULT '{"elements": []}'::jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_whiteboards_share_token" ON "project_whiteboards" ("share_token");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_whiteboard_shares" (
  "id" serial PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "whiteboard_id" integer NOT NULL,
  "user_id" text NOT NULL,
  "role" "whiteboard_share_role" NOT NULL DEFAULT 'viewer',
  "created_by" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares"
  ADD CONSTRAINT "project_whiteboard_shares_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares"
  ADD CONSTRAINT "project_whiteboard_shares_whiteboard_id_project_whiteboards_id_fk"
  FOREIGN KEY ("whiteboard_id") REFERENCES "project_whiteboards"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares"
  ADD CONSTRAINT "project_whiteboard_shares_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whiteboard_shares_board_user" ON "project_whiteboard_shares" ("whiteboard_id", "user_id");
--> statement-breakpoint
CREATE INDEX "idx_whiteboard_shares_org_board" ON "project_whiteboard_shares" ("org_id", "whiteboard_id");
