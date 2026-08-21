-- 0409: Transfers must carry cost, not just quantity.
-- With cost layers keyed per location (0400), issuing at A and receiving at B are
-- no longer cost-neutral: without this the receipt at B has no unit cost, creates
-- no layer, and the next issue at B fails for want of a cost basis.
-- Dispatch stamps the cost the layers at A were actually consumed at; completion
-- uses it to build the layer at B.

SET statement_timeout = 0;
SET lock_timeout = '5s';

ALTER TABLE "inv_stock_transfer_lines"
  ADD COLUMN "dispatched_unit_cost" numeric(18, 4);
