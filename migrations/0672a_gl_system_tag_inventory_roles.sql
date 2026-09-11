-- Three account roles inventory needs and `gl_system_tag` does not offer:
-- `grni`, `inventory_write_off`, `inventory_adjustment`. See
-- `docs/inventory-gl-contract.md` §6.
--
-- Hand-authored for the reason given in 0464: `migrations/meta` snapshots stop
-- at 0231, so `drizzle-kit generate` is unusable in this repo.
--
-- `ADD VALUE` is safe inside a transaction on PG12+, but the new label cannot be
-- USED until that transaction commits. Nothing here writes a journal or tags an
-- account, so that restriction does not bite; the chart template in
-- `packs/coa-template.ts` seeds the accounts that carry these tags, and it runs
-- against a database where this migration has long since committed.
--
-- WHY `grni` MATTERS AND IS NOT COSMETIC. The goods receipt in
-- `inventory/purchase-orders/grn.service.ts` credits `ap_control` directly.
-- That puts a balance in the AP control account for which no bill exists, so
-- between receipt and invoice the AP subledger — which only knows about bills —
-- cannot reconcile to its own control account, and any period closed in that
-- window closes on an AP figure no aged-payables report can reproduce. With a
-- GRNI account the receipt credits GRNI, the bill debits GRNI and credits AP,
-- and GRNI nets to zero per PO line. Zoho Books and Odoo both accrue this way;
-- this is the clearest single correctness gap against them.
--
-- WHY ONE `inventory_adjustment` AND NOT A GAIN/LOSS PAIR. A cycle-count gain
-- credits it and a loss debits it, so the account's own balance IS the period's
-- net adjustment cost — which is the number an operations manager is judged on.
-- Splitting it across an income account and an expense account makes that net
-- invisible on both the P&L and the trial balance, recoverable only by a report
-- that adds them back. Nothing is lost: the sign of each posting still
-- distinguishes the two, and the account ledger lists them separately.
--
-- WHY THERE IS NO `landed_cost_clearing` HERE, though the seam's ticket names
-- one. There is no landed-cost feature anywhere on this branch — no module, no
-- schema, no service, checked. A tag with no writer would appear in the account
-- mapping screen as a role an operator is asked to fill for a capability the
-- product does not have, which is the same shape of untruth 0671 withdrew: an
-- offer nothing could ever apply. It lands with the landed-cost module, in the
-- migration that brings it.

SET lock_timeout = '5s';

--> statement-breakpoint
-- Goods received, not yet invoiced. Placed after `ap_control` because it is read
-- as AP's sibling wherever the two appear together.
ALTER TYPE "public"."gl_system_tag" ADD VALUE IF NOT EXISTS 'grni' AFTER 'ap_control';

--> statement-breakpoint
-- Scrap, quality write-off, recall destruction: stock that left without a sale.
ALTER TYPE "public"."gl_system_tag" ADD VALUE IF NOT EXISTS 'inventory_write_off' AFTER 'inventory';

--> statement-breakpoint
-- Cycle-count and physical-audit variance, both directions.
ALTER TYPE "public"."gl_system_tag" ADD VALUE IF NOT EXISTS 'inventory_adjustment' AFTER 'inventory_write_off';
