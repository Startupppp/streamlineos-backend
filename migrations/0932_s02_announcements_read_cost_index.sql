SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_announcements_org_pinned_created"
  ON "announcements" ("org_id", "is_pinned" DESC, "created_at" DESC, "id" DESC)
  INCLUDE ("title", "content", "expires_at", "author_id", "status")
  WHERE "status" <> 'DRAFT';
