-- Rollback for 1173a_kb_article_constraint_names_before_1174 — deliberately a no-op.
--
-- 1173a renames five kb_article_* constraints to the names production already has, and drops
-- the superseded *_article_id_org foreign keys 0971/0972 already dropped on production. Undoing
-- either would put a cold build back into the state 1174 cannot run on. After 1174 has run the
-- kb_article_* tables no longer exist, so there is nothing for this file to act on; roll back
-- 1174 with its own rollback file first if that is the intent.

SELECT 1;
