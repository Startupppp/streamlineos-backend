-- Custom SQL migration file, put your code below! --

-- A third reason to open a conversation: the customer wants more.
--
-- CRM-P2-07. `customer_lifecycle_triggers.kind` was constrained to the two
-- reasons the book had -- the calendar (`renewal-due`) and the evidence
-- overruling it (`churn-risk`). Both are about revenue leaving.
-- `expansion-interest` has been a first-class lifecycle signal since the risk
-- model shipped, worth -20 against churn, and nothing ever opened a conversation
-- off it: the product could tell you a customer had asked for more and had no
-- way to act on it until their renewal came round.
--
-- Widening a CHECK is additive -- every row that satisfied the old constraint
-- satisfies this one -- so the swap is a drop and re-add rather than a rewrite,
-- and it takes no table lock beyond the validation scan.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers"
  DROP CONSTRAINT IF EXISTS "chk_customer_lifecycle_triggers_kind";

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers"
  ADD CONSTRAINT "chk_customer_lifecycle_triggers_kind"
  CHECK (kind = ANY (ARRAY['renewal-due'::text, 'churn-risk'::text, 'expansion-ready'::text]))
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "customer_lifecycle_triggers"
  VALIDATE CONSTRAINT "chk_customer_lifecycle_triggers_kind";
