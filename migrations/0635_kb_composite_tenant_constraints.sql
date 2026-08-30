SET lock_timeout = '5s';

ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_space FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces (org_id, id) ON DELETE SET NULL NOT VALID;
ALTER TABLE kb_pages ADD CONSTRAINT fk_kb_pages_org_parent FOREIGN KEY (org_id, parent_page_id) REFERENCES kb_pages (org_id, id) ON DELETE SET NULL NOT VALID;
ALTER TABLE kb_space_members ADD CONSTRAINT fk_kb_space_members_org_space FOREIGN KEY (org_id, space_id) REFERENCES kb_spaces (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE kb_page_favorites ADD CONSTRAINT fk_kb_page_favorites_org_page FOREIGN KEY (org_id, page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE kb_page_visits ADD CONSTRAINT fk_kb_page_visits_org_page FOREIGN KEY (org_id, page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE kb_page_links ADD CONSTRAINT fk_kb_page_links_org_source FOREIGN KEY (org_id, source_page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE kb_page_links ADD CONSTRAINT fk_kb_page_links_org_target FOREIGN KEY (org_id, target_page_id) REFERENCES kb_pages (org_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE kb_pages VALIDATE CONSTRAINT fk_kb_pages_org_space;
ALTER TABLE kb_pages VALIDATE CONSTRAINT fk_kb_pages_org_parent;
ALTER TABLE kb_space_members VALIDATE CONSTRAINT fk_kb_space_members_org_space;
ALTER TABLE kb_page_favorites VALIDATE CONSTRAINT fk_kb_page_favorites_org_page;
ALTER TABLE kb_page_visits VALIDATE CONSTRAINT fk_kb_page_visits_org_page;
ALTER TABLE kb_page_links VALIDATE CONSTRAINT fk_kb_page_links_org_source;
ALTER TABLE kb_page_links VALIDATE CONSTRAINT fk_kb_page_links_org_target;
