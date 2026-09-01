-- AR-02: Promote misc module self-referential FKs to composite (org_id, child_id) -> (org_id, id).
-- Each composite FK uses NOT VALID / VALIDATE to avoid ACCESS EXCLUSIVE during backfill.
-- SET NULL cases use PG15+ column-list syntax so only the child col is nulled (org_id is NOT NULL).
-- CRM and Inventory are excluded from this migration by design (see PRD-IN-SCOPE.md §4).

SET lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- ledger_accounts: parent_account_id
-- ---------------------------------------------------------------------------
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_parent_account_id_ledger_accounts_id_fk;

ALTER TABLE ledger_accounts
  ADD CONSTRAINT fk_ledger_accounts_org_parent
  FOREIGN KEY (org_id, parent_account_id)
  REFERENCES ledger_accounts (org_id, id)
  ON DELETE SET NULL (parent_account_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_ledger_accounts_org_parent;

-- ---------------------------------------------------------------------------
-- journal_entries: reversed_entry_id
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_reversed_entry_id_journal_entries_id_fk;

ALTER TABLE journal_entries
  ADD CONSTRAINT fk_je_org_reversed
  FOREIGN KEY (org_id, reversed_entry_id)
  REFERENCES journal_entries (org_id, id)
  ON DELETE SET NULL (reversed_entry_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_je_org_reversed;

-- ---------------------------------------------------------------------------
-- documents: parent_document_id
-- ---------------------------------------------------------------------------
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_parent_document_id_documents_id_fk;

ALTER TABLE documents
  ADD CONSTRAINT fk_documents_org_parent
  FOREIGN KEY (org_id, parent_document_id)
  REFERENCES documents (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_documents_org_parent;

-- ---------------------------------------------------------------------------
-- goals (HR performance): parent_goal_id
-- ---------------------------------------------------------------------------
ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_parent_goal_id_goals_id_fk;

ALTER TABLE goals
  ADD CONSTRAINT fk_goals_org_parent
  FOREIGN KEY (org_id, parent_goal_id)
  REFERENCES goals (org_id, id)
  ON DELETE SET NULL (parent_goal_id)
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_goals_org_parent;

-- ---------------------------------------------------------------------------
-- kb_article_comments: parent_id
-- ---------------------------------------------------------------------------
ALTER TABLE kb_article_comments DROP CONSTRAINT IF EXISTS fk_kb_article_comments_parent;

ALTER TABLE kb_article_comments
  ADD CONSTRAINT fk_kb_article_comments_org_parent
  FOREIGN KEY (org_id, parent_id)
  REFERENCES kb_article_comments (org_id, id)
  ON DELETE CASCADE
  NOT VALID;
--> statement-breakpoint
VALIDATE CONSTRAINT fk_kb_article_comments_org_parent;
