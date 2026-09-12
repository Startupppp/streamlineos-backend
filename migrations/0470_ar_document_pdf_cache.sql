-- Where a posted invoice's rendered PDF lives.
--
-- `09-feature-backlog.md` §F asks for "Invoices + PDF store". A posted document
-- is immutable, so its PDF is too: render once, keep the R2 key, and every
-- later download hands back the same bytes the customer already holds. Without
-- somewhere to keep the key, "store it in R2" degrades into re-rendering and
-- re-uploading on every request.
--
-- Separate from 0469 because it is a separate purpose (backend/CLAUDE.md §3:
-- one purpose per migration). Hand-authored for the same reason 0469 is —
-- `migrations/meta` stops at 0231 and `drizzle-kit generate` would re-propose
-- every migration since.
--
-- Two nullable text columns: no table rewrite, no constraint, nothing to
-- backfill. Null means "not rendered yet", which is also the permanent state
-- when R2 is not configured.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "ar_documents" ADD COLUMN IF NOT EXISTS "pdf_storage_key" text;
--> statement-breakpoint
ALTER TABLE "ar_documents" ADD COLUMN IF NOT EXISTS "pdf_storage_url" text;
