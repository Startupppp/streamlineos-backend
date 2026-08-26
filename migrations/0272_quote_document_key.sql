-- Where a quote's generated document lives.
--
-- Ticket 14's last criterion: a quote is generated from its deal, line items and
-- pricing, and stored as a document in the organisation's region. The rendering
-- and the storage exist; this is the column that remembers the result, so a
-- quote already sent is re-sent as the same artefact rather than re-rendered
-- from figures that may have moved since.
--
-- Distinct from `signed_document_ref`, which is deliberately a different thing:
-- that is the counter-signed copy that came back, and conflating the two would
-- lose the difference between what was offered and what was agreed.
--
-- Nullable, because a draft quote has no document until one is generated, and a
-- quote created before this shipped has none either. There is no sensible
-- default — a key pointing at an object that was never written is worse than an
-- absent one, because a reader would try to fetch it.
--
-- Authored via `generate --custom`; `db:generate` cannot run in this repo.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "document_key" text;
