-- 0941_ar02_drop_redundant_single_fks DOWN
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kb_pages
  ADD CONSTRAINT "fk_kb_pages_parent"
  FOREIGN KEY (parent_page_id) REFERENCES kb_pages (id) ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_page_comments
  ADD CONSTRAINT "fk_kb_page_comments_parent"
  FOREIGN KEY (parent_id) REFERENCES kb_page_comments (id) ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
ALTER TABLE chat_messages
  ADD CONSTRAINT "chat_messages_reply_to_id_chat_messages_id_fk"
  FOREIGN KEY (reply_to_id) REFERENCES chat_messages (id)
  NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_categories
  ADD CONSTRAINT "fk_kb_categories_parent"
  FOREIGN KEY (parent_id) REFERENCES kb_categories (id) ON DELETE SET NULL
  NOT VALID;
