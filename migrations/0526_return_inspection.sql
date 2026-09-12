SET lock_timeout = '5s';
--> statement-breakpoint
-- INV-209. A customer return had to declare each line's disposition at the
-- moment it was created -- restock, quarantine or scrap -- which is before
-- anybody has opened the box. In practice that means the disposition is a guess
-- made from the customer's description, and the guess is what posts stock.
--
-- These columns record the decision as a separate act with an author and a
-- time, so "who decided this was resaleable" has an answer. Posting now
-- requires every line to have been inspected.
ALTER TABLE "inv_customer_return_lines"
  ADD COLUMN IF NOT EXISTS "inspected_at" timestamp;
--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines"
  ADD COLUMN IF NOT EXISTS "inspected_by" text REFERENCES "users"("id");
--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines"
  ADD COLUMN IF NOT EXISTS "inspection_notes" text;
--> statement-breakpoint
-- "What is waiting to be looked at" is the query this workflow exists to
-- answer, and an uninspected line is the rare row once a warehouse is keeping
-- up.
CREATE INDEX IF NOT EXISTS "idx_inv_customer_return_lines_uninspected"
  ON "inv_customer_return_lines" ("org_id", "return_id")
  WHERE "inspected_at" IS NULL;
