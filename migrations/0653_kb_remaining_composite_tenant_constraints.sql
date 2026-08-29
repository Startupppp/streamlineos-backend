SET lock_timeout = '5s';
SET statement_timeout = '0';

CREATE TABLE IF NOT EXISTS kb_tenant_backfill_issues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  row_id text NOT NULL,
  issue text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO kb_tenant_backfill_issues (table_name, row_id, issue)
SELECT 'kb_article_tags', concat(tags.article_id, ':', tags.tag_id), 'tag tenant differs from article tenant'
FROM kb_article_tags tags
JOIN kb_articles article ON article.id = tags.article_id
JOIN kb_tags tag ON tag.id = tags.tag_id
WHERE article.org_id <> tag.org_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM kb_tenant_backfill_issues) THEN
    RAISE EXCEPTION 'KB tenant backfill found % issue(s)', (SELECT count(*) FROM kb_tenant_backfill_issues);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_kb_article_tag_tenant() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  article_org text;
  tag_org text;
BEGIN
  SELECT org_id INTO article_org FROM kb_articles WHERE id = NEW.article_id;
  SELECT org_id INTO tag_org FROM kb_tags WHERE id = NEW.tag_id;
  IF article_org IS NULL OR tag_org IS NULL OR article_org <> tag_org THEN
    RAISE EXCEPTION 'KB article and tag must belong to the same organization';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_article_tags_tenant ON kb_article_tags;
CREATE TRIGGER trg_kb_article_tags_tenant
BEFORE INSERT OR UPDATE OF article_id, tag_id ON kb_article_tags
FOR EACH ROW EXECUTE FUNCTION enforce_kb_article_tag_tenant();

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('kb_categories', 'fk_kb_categories_org_space', 'FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces (org_id, id) ON DELETE CASCADE'),
      ('kb_categories', 'fk_kb_categories_org_parent', 'FOREIGN KEY (org_id, parent_id) REFERENCES kb_categories (org_id, id) ON DELETE SET NULL'),
      ('kb_articles', 'fk_kb_articles_org_category', 'FOREIGN KEY (org_id, category_id) REFERENCES kb_categories (org_id, id) ON DELETE SET NULL'),
      ('kb_articles', 'fk_kb_articles_org_space', 'FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces (org_id, id) ON DELETE CASCADE'),
      ('kb_article_feedback', 'fk_kb_article_feedback_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE'),
      ('kb_article_versions', 'fk_kb_article_versions_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE'),
      ('kb_article_translations', 'fk_kb_article_translations_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE'),
      ('kb_article_restrictions', 'fk_kb_article_restrictions_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE'),
      ('kb_article_attachments', 'fk_kb_article_attachments_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE'),
      ('kb_article_chunks', 'fk_kb_chunks_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE'),
      ('kb_article_chunks', 'fk_kb_chunks_org_page', 'FOREIGN KEY (org_id, page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE'),
      ('kb_article_chunks', 'fk_kb_chunks_org_attachment', 'FOREIGN KEY (org_id, attachment_id) REFERENCES kb_article_attachments (org_id, id) ON DELETE CASCADE'),
      ('kb_article_chunks', 'fk_kb_chunks_org_source', 'FOREIGN KEY (org_id, source_id) REFERENCES kb_sources (org_id, id) ON DELETE CASCADE'),
      ('kb_page_versions', 'fk_kb_page_versions_org_page', 'FOREIGN KEY (org_id, page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE'),
      ('kb_page_comments', 'fk_kb_page_comments_org_page', 'FOREIGN KEY (org_id, page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE'),
      ('kb_page_comments', 'fk_kb_page_comments_org_parent', 'FOREIGN KEY (org_id, parent_id) REFERENCES kb_page_comments (org_id, id) ON DELETE CASCADE'),
      ('kb_events', 'fk_kb_events_org_article', 'FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE SET NULL'),
      ('kb_research_briefs', 'fk_kb_research_briefs_org_space', 'FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces (org_id, id) ON DELETE SET NULL'),
      ('kb_chat_messages', 'fk_kb_chat_messages_org_conversation', 'FOREIGN KEY (org_id, conversation_id) REFERENCES kb_chat_conversations (org_id, id) ON DELETE CASCADE'),
      ('kb_export_jobs', 'fk_kb_export_jobs_org_page', 'FOREIGN KEY (org_id, scope_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE'),
      ('kb_pages', 'fk_kb_pages_org_source_article', 'FOREIGN KEY (org_id, source_article_id) REFERENCES kb_articles (org_id, id) ON DELETE SET NULL'),
      ('kb_pages', 'fk_kb_pages_org_project', 'FOREIGN KEY (org_id, project_id) REFERENCES projects (org_id, id) ON DELETE SET NULL')
    ) AS constraints(table_name, constraint_name, definition)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = item.table_name AND c.conname = item.constraint_name
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', item.table_name, item.constraint_name, item.definition);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('kb_categories', 'fk_kb_categories_org_space'), ('kb_categories', 'fk_kb_categories_org_parent'),
      ('kb_articles', 'fk_kb_articles_org_category'), ('kb_articles', 'fk_kb_articles_org_space'),
      ('kb_article_feedback', 'fk_kb_article_feedback_org_article'), ('kb_article_versions', 'fk_kb_article_versions_org_article'),
      ('kb_article_translations', 'fk_kb_article_translations_org_article'), ('kb_article_restrictions', 'fk_kb_article_restrictions_org_article'),
      ('kb_article_attachments', 'fk_kb_article_attachments_org_article'), ('kb_article_chunks', 'fk_kb_chunks_org_article'),
      ('kb_article_chunks', 'fk_kb_chunks_org_page'), ('kb_article_chunks', 'fk_kb_chunks_org_attachment'),
      ('kb_article_chunks', 'fk_kb_chunks_org_source'), ('kb_page_versions', 'fk_kb_page_versions_org_page'),
      ('kb_page_comments', 'fk_kb_page_comments_org_page'), ('kb_page_comments', 'fk_kb_page_comments_org_parent'),
      ('kb_events', 'fk_kb_events_org_article'), ('kb_research_briefs', 'fk_kb_research_briefs_org_space'),
      ('kb_chat_messages', 'fk_kb_chat_messages_org_conversation'), ('kb_export_jobs', 'fk_kb_export_jobs_org_page'),
      ('kb_pages', 'fk_kb_pages_org_source_article'), ('kb_pages', 'fk_kb_pages_org_project')
    ) AS constraints(table_name, constraint_name)
  LOOP
    EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', item.table_name, item.constraint_name);
  END LOOP;
END $$;
