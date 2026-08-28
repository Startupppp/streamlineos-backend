SET lock_timeout = '5s';

ALTER TABLE kb_sources ADD CONSTRAINT fk_kb_sources_org_space FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces (org_id, id) ON DELETE SET NULL NOT VALID;
ALTER TABLE kb_page_reviews ADD CONSTRAINT fk_kb_page_reviews_org_page FOREIGN KEY (org_id, page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE kb_sources VALIDATE CONSTRAINT fk_kb_sources_org_space;
ALTER TABLE kb_page_reviews VALIDATE CONSTRAINT fk_kb_page_reviews_org_page;
