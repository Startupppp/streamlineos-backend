-- 1027 DOWN -- drops the read-path index. Reverting returns the tenant+assignee+recency reads to
-- `idx_tickets_org_updated_live` at the majority tenant: 1,801 rows scanned on `build.tickets` to
-- return ten, and `dashboard-my-issues` back to 261 buffers from 22.

SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS build.idx_tickets_org_assignee_updated_live;
