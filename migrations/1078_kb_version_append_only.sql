-- 1078 — kb_page_versions and kb_article_versions become append-only at the database boundary.
--
-- WHY. Version history is the only record of what a page or article said before an edit. The
-- services only ever INSERT into these two tables — no service path issues an UPDATE or a DELETE
-- against them — so today the invariant holds by convention. A raw SQL statement, a future
-- refactor or a compromised app role can rewrite history and nothing notices, which is exactly
-- the gap 0492 (invoices), 0565 (billing snapshots), 0793 (journal entries) and 0930 (audit
-- logs) closed for the other immutable ledgers. This migration applies the same shape here.
--
-- WHAT IS BLOCKED. Any UPDATE that changes the substance of a recorded version — org_id,
-- page_id/article_id, version_number, title, content, content_text/excerpt, change_summary,
-- created_at, id — and any DELETE issued directly against the version table.
--
-- WHAT IS DELIBERATELY STILL ALLOWED, AND WHY A BLANKET TRIGGER WOULD BREAK PRODUCTION.
--
--   1. DELETE via ON DELETE CASCADE. fk_kb_page_versions_org_page and
--      fk_kb_article_versions_org_article are ON DELETE CASCADE, and kb-page-tree.service.ts
--      hard-deletes pages in three places (hardDelete, emptyTrash, purgeExpired), as does
--      support-kb.service.ts deleteArticle. A row-level DELETE trigger that refuses
--      unconditionally would make every purge fail. The trigger therefore allows a DELETE that
--      arrives from inside another trigger (pg_trigger_depth() > 1 — a referential action is a
--      system trigger, so a cascade always fires the child trigger nested) OR whose parent row
--      is already gone. Both conditions are true only under a cascade; a direct
--      DELETE FROM kb_page_versions is depth 1 with its parent still present, and is refused.
--      The two conditions are independent on purpose: if the depth check ever stops holding,
--      purge still works and the guard has not become a production outage.
--
--   2. UPDATE of author_id. kb_page_versions.author_id and kb_article_versions.author_id
--      reference users(id) ON DELETE SET NULL, so deleting a user makes Postgres UPDATE these
--      rows. Locking that column would make user deletion fail.
--
--   3. UPDATE of author_membership_id. MEMBERSHIP_ARTIFACTS
--      (modules/organization/core/membership-artifacts.ts, ids "kb_page_versions" and
--      "kb_article_versions") rules both columns as mechanism "database-write", onRemoval
--      "set-null": on membership removal the revocation path MUST clear them so the version
--      survives with the membership reference redacted. A blanket UPDATE block would break
--      membership revocation and the DPDP/GDPR erasure duty behind it. Attribution is redactable;
--      the content is not.
--
-- ERRCODE is 42501 (insufficient_privilege), matching 0930, so a violation reads as a permission
-- failure rather than a constraint failure and never surfaces as a 500 with a constraint name.
--
-- LOCKING. Function and trigger creation only — no table rewrite. CREATE TRIGGER takes
-- ACCESS EXCLUSIVE briefly; lock_timeout makes that fail fast instead of queueing in front of
-- the KB tables.

SET lock_timeout = '5s';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.prevent_kb_page_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
       OR NOT EXISTS (SELECT 1 FROM public.kb_pages WHERE id = OLD.page_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'kb_page_versions is append-only; delete the page instead (page %, version %)',
      OLD.page_id, OLD.version_number
      USING ERRCODE = '42501';
  END IF;

  IF OLD.id             IS DISTINCT FROM NEW.id
     OR OLD.org_id         IS DISTINCT FROM NEW.org_id
     OR OLD.page_id        IS DISTINCT FROM NEW.page_id
     OR OLD.version_number IS DISTINCT FROM NEW.version_number
     OR OLD.title          IS DISTINCT FROM NEW.title
     OR OLD.content        IS DISTINCT FROM NEW.content
     OR OLD.content_text   IS DISTINCT FROM NEW.content_text
     OR OLD.change_summary IS DISTINCT FROM NEW.change_summary
     OR OLD.created_at     IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION
      'kb_page_versions is append-only; a recorded version may not be rewritten (page %, version %)',
      OLD.page_id, OLD.version_number
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.prevent_kb_page_version_mutation() FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.prevent_kb_article_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
       OR NOT EXISTS (SELECT 1 FROM public.kb_articles WHERE id = OLD.article_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION
      'kb_article_versions is append-only; delete the article instead (article %, version %)',
      OLD.article_id, OLD.version_number
      USING ERRCODE = '42501';
  END IF;

  IF OLD.id             IS DISTINCT FROM NEW.id
     OR OLD.org_id         IS DISTINCT FROM NEW.org_id
     OR OLD.article_id     IS DISTINCT FROM NEW.article_id
     OR OLD.version_number IS DISTINCT FROM NEW.version_number
     OR OLD.title          IS DISTINCT FROM NEW.title
     OR OLD.content        IS DISTINCT FROM NEW.content
     OR OLD.excerpt        IS DISTINCT FROM NEW.excerpt
     OR OLD.change_summary IS DISTINCT FROM NEW.change_summary
     OR OLD.created_at     IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION
      'kb_article_versions is append-only; a recorded version may not be rewritten (article %, version %)',
      OLD.article_id, OLD.version_number
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.prevent_kb_article_version_mutation() FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER IF EXISTS kb_page_versions_append_only ON public.kb_page_versions;
--> statement-breakpoint

CREATE TRIGGER kb_page_versions_append_only
BEFORE UPDATE OR DELETE ON public.kb_page_versions
FOR EACH ROW EXECUTE FUNCTION app.prevent_kb_page_version_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS kb_article_versions_append_only ON public.kb_article_versions;
--> statement-breakpoint

CREATE TRIGGER kb_article_versions_append_only
BEFORE UPDATE OR DELETE ON public.kb_article_versions
FOR EACH ROW EXECUTE FUNCTION app.prevent_kb_article_version_mutation();
--> statement-breakpoint

-- TRUNCATE bypasses a FOR EACH ROW trigger entirely — it never produces a row event — so the
-- two guards above would let one statement erase every recorded version. TRUNCATE is a
-- statement-level event and needs its own statement-level trigger.
CREATE OR REPLACE FUNCTION app.prevent_kb_version_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; TRUNCATE would erase every recorded version', TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.prevent_kb_version_truncate() FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER IF EXISTS kb_page_versions_no_truncate ON public.kb_page_versions;
--> statement-breakpoint

CREATE TRIGGER kb_page_versions_no_truncate
BEFORE TRUNCATE ON public.kb_page_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_kb_version_truncate();
--> statement-breakpoint

DROP TRIGGER IF EXISTS kb_article_versions_no_truncate ON public.kb_article_versions;
--> statement-breakpoint

CREATE TRIGGER kb_article_versions_no_truncate
BEFORE TRUNCATE ON public.kb_article_versions
FOR EACH STATEMENT EXECUTE FUNCTION app.prevent_kb_version_truncate();
--> statement-breakpoint

DO $$
DECLARE
  probe_id integer;
  blocked boolean;
BEGIN
  PERFORM 1 FROM pg_trigger
   WHERE tgrelid = 'public.kb_page_versions'::regclass
     AND tgname = 'kb_page_versions_append_only'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1078: kb_page_versions_append_only was not created';
  END IF;

  PERFORM 1 FROM pg_trigger
   WHERE tgrelid = 'public.kb_article_versions'::regclass
     AND tgname = 'kb_article_versions_append_only'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1078: kb_article_versions_append_only was not created';
  END IF;

  SELECT id INTO probe_id FROM public.kb_page_versions LIMIT 1;
  IF probe_id IS NOT NULL THEN
    blocked := false;
    BEGIN
      UPDATE public.kb_page_versions SET title = title || ' probe' WHERE id = probe_id;
    EXCEPTION WHEN insufficient_privilege THEN
      blocked := true;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION '1078: the guard on kb_page_versions did not bite — history is still rewritable';
    END IF;

    blocked := false;
    BEGIN
      UPDATE public.kb_page_versions
         SET author_membership_id = author_membership_id
       WHERE id = probe_id;
    EXCEPTION WHEN insufficient_privilege THEN
      blocked := true;
    END;
    IF blocked THEN
      RAISE EXCEPTION '1078: the guard refuses an author_membership_id redaction — membership revocation would fail';
    END IF;
  END IF;

  SELECT id INTO probe_id FROM public.kb_article_versions LIMIT 1;
  IF probe_id IS NOT NULL THEN
    blocked := false;
    BEGIN
      UPDATE public.kb_article_versions SET title = title || ' probe' WHERE id = probe_id;
    EXCEPTION WHEN insufficient_privilege THEN
      blocked := true;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION '1078: the guard on kb_article_versions did not bite — history is still rewritable';
    END IF;
  END IF;
END
$$;
