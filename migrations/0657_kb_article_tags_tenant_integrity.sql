SET lock_timeout = '5s';
SET statement_timeout = '0';

ALTER TABLE kb_article_tags ADD COLUMN IF NOT EXISTS org_id TEXT;

UPDATE kb_article_tags relation
SET org_id = article.org_id
FROM kb_articles article
WHERE article.id = relation.article_id
  AND relation.org_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM kb_article_tags relation
    LEFT JOIN kb_articles article ON article.org_id = relation.org_id AND article.id = relation.article_id
    LEFT JOIN kb_tags tag ON tag.org_id = relation.org_id AND tag.id = relation.tag_id
    WHERE relation.org_id IS NULL OR article.id IS NULL OR tag.id IS NULL
  ) THEN
    RAISE EXCEPTION 'kb_article_tags contains unmappable or cross-tenant rows';
  END IF;
END $$;

ALTER TABLE kb_article_tags ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE kb_article_tags DROP CONSTRAINT IF EXISTS kb_article_tags_article_id_tag_id_pk;
ALTER TABLE kb_article_tags DROP CONSTRAINT IF EXISTS kb_article_tags_pkey;
ALTER TABLE kb_article_tags ADD CONSTRAINT kb_article_tags_pkey PRIMARY KEY (org_id, article_id, tag_id);

ALTER TABLE kb_article_tags
  ADD CONSTRAINT fk_kb_article_tags_org_article
  FOREIGN KEY (org_id, article_id) REFERENCES kb_articles (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE kb_article_tags
  ADD CONSTRAINT fk_kb_article_tags_org_tag
  FOREIGN KEY (org_id, tag_id) REFERENCES kb_tags (org_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE kb_article_tags VALIDATE CONSTRAINT fk_kb_article_tags_org_article;
ALTER TABLE kb_article_tags VALIDATE CONSTRAINT fk_kb_article_tags_org_tag;
CREATE INDEX IF NOT EXISTS idx_kb_article_tags_org_article ON kb_article_tags (org_id, article_id);
CREATE INDEX IF NOT EXISTS idx_kb_article_tags_org_tag ON kb_article_tags (org_id, tag_id);
