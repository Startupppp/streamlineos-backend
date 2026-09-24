-- @data-loss the 'expired' status is collapsed into 'pending'; overdue is derived at read time
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_page_reviews') IS NULL THEN
    RAISE EXCEPTION '1170 precondition: public.kb_page_reviews is absent — this is not a Knowledge database';
  END IF;
END $$;
--> statement-breakpoint

UPDATE "public"."kb_page_reviews"
  SET "status" = 'pending', "updated_at" = now()
  WHERE "status" = 'expired';
--> statement-breakpoint

ALTER TABLE "public"."kb_page_reviews"
  ADD CONSTRAINT "chk_kb_page_reviews_status"
  CHECK ("status" IN ('pending', 'approved', 'rejected')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "public"."kb_page_reviews"
  VALIDATE CONSTRAINT "chk_kb_page_reviews_status";
