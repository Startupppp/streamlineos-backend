-- `kb_article_chunks` denormalises the owning page's ACL so retrieval can filter in an indexed
-- predicate rather than a join (backend/CLAUDE.md §4). It carried `page_visibility`,
-- `page_project_id` and `page_created_by_id` but NOT the membership id, so `chunkVisibleTo`
-- silently omitted the `createdByMembershipId` arm that `visibleTo` applies to pages: a page whose
-- creator is recorded only by membership lost its own chunks from its author's search. More
-- restrictive, so never a disclosure — but it worsens as the actor migration moves creators off
-- `users.id`.
--
-- Backfill is a single UPDATE, not a batched loop: db:migrate wraps each file in one transaction
-- (see 0475), so batches would hold exactly the same locks for exactly as long while adding
-- round trips. statement_timeout is lifted because Neon cancels a long cold-build statement.
SET lock_timeout = '5s';
--> statement-breakpoint
SET statement_timeout = 0;
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD COLUMN IF NOT EXISTS "page_created_by_membership_id" integer;
--> statement-breakpoint
UPDATE "kb_article_chunks" AS c
SET "page_created_by_membership_id" = p."created_by_membership_id"
FROM "kb_pages" AS p
WHERE c."page_id" = p."id"
  AND c."org_id" = p."org_id"
  AND c."page_id" IS NOT NULL
  AND c."page_created_by_membership_id" IS NULL
  AND p."created_by_membership_id" IS NOT NULL;
