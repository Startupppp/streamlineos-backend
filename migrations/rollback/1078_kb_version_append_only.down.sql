-- Rollback for 1078 — fully reversible, no data was touched.
--
-- 1078 created two trigger functions and two triggers and changed no row (the probes in its
-- verification block either roll back to their own savepoint or write a value identical to the
-- one already stored). Dropping the triggers and the functions returns the database exactly to
-- its pre-1078 state.
--
-- WHAT THIS GIVES BACK. After this rollback kb_page_versions and kb_article_versions are again
-- freely UPDATE-able and DELETE-able by anyone holding write privilege on them, so version
-- history is rewritable and the only remaining protection is that no service path does it.

SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS kb_page_versions_append_only ON public.kb_page_versions;
DROP TRIGGER IF EXISTS kb_article_versions_append_only ON public.kb_article_versions;
DROP TRIGGER IF EXISTS kb_page_versions_no_truncate ON public.kb_page_versions;
DROP TRIGGER IF EXISTS kb_article_versions_no_truncate ON public.kb_article_versions;

DROP FUNCTION IF EXISTS app.prevent_kb_page_version_mutation();
DROP FUNCTION IF EXISTS app.prevent_kb_article_version_mutation();
DROP FUNCTION IF EXISTS app.prevent_kb_version_truncate();

RESET lock_timeout;
