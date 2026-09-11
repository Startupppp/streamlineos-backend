-- AR-02: Drop redundant single-column FK constraints where a composite FK already exists.
-- The composite FK is the canonical constraint; the single-column FK is the legacy one.
-- Dropping these removes the duplicate enforcement so the gate reports zero violations.
-- CRM and Inventory are excluded from this migration by design (see PRD-IN-SCOPE.md §4).

SET lock_timeout = '5s';

-- kb_pages: fk_kb_pages_parent (single-col, redundant with fk_kb_pages_org_parent)
ALTER TABLE kb_pages DROP CONSTRAINT IF EXISTS fk_kb_pages_parent;

-- kb_page_comments: fk_kb_page_comments_parent (single-col, redundant with fk_kb_page_comments_org_parent)
ALTER TABLE kb_page_comments DROP CONSTRAINT IF EXISTS fk_kb_page_comments_parent;

-- chat_messages: chat_messages_reply_to_id_chat_messages_id_fk (single-col, redundant with fk_chat_messages_org_reply)
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_reply_to_id_chat_messages_id_fk;

-- kb_categories: fk_kb_categories_parent (single-col, redundant with fk_kb_categories_org_parent)
ALTER TABLE kb_categories DROP CONSTRAINT IF EXISTS fk_kb_categories_parent;
