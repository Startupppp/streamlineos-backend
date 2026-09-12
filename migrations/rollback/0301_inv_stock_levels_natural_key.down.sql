-- 0301.down — Drop the stock-level natural-key uniqueness.
--
-- 0301 did two things: it merged duplicate stock rows into one, and it added a
-- unique index so they could not come back. Only the second is reversible. The
-- merge summed on_hand/committed/on_order across the rows it collapsed and
-- deleted the losers; nothing records what they were, so reversing this does not
-- restore them and never can.
--
-- Note also that 0582 later WIDENED this index to include handling_unit_id and
-- ownership. Executed at head, this drops the wider index, not the one 0301
-- created. That is correct in a contiguous descent (0582's own rollback runs
-- first) and misleading out of one.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_inv_stock_levels_natural_key";
