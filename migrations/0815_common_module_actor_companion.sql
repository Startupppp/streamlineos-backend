SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE ai_chat_conversations ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE ai_feedback ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE ai_summary_snapshots ADD COLUMN IF NOT EXISTS generated_by_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_envelopes ADD COLUMN IF NOT EXISTS sender_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_envelopes ADD COLUMN IF NOT EXISTS voided_by_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_bulk_send_jobs ADD COLUMN IF NOT EXISTS sender_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_documents ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_recipients ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_public_forms ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE sign_templates ADD COLUMN IF NOT EXISTS owner_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE survey_forms ADD COLUMN IF NOT EXISTS owner_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE survey_forms ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE survey_versions ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE survey_participants ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE survey_live_sessions ADD COLUMN IF NOT EXISTS host_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE mail_message_metadata ADD COLUMN IF NOT EXISTS user_membership_id INTEGER;
--> statement-breakpoint

ALTER TABLE ai_chat_conversations DROP CONSTRAINT IF EXISTS fk_ai_chat_conv_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_chat_conversations
  ADD CONSTRAINT fk_ai_chat_conv_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE ai_chat_messages DROP CONSTRAINT IF EXISTS fk_ai_chat_msg_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_chat_messages
  ADD CONSTRAINT fk_ai_chat_msg_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE ai_action_proposals DROP CONSTRAINT IF EXISTS fk_ai_proposals_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_action_proposals
  ADD CONSTRAINT fk_ai_proposals_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE ai_feedback DROP CONSTRAINT IF EXISTS fk_ai_feedback_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_feedback
  ADD CONSTRAINT fk_ai_feedback_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE ai_jobs DROP CONSTRAINT IF EXISTS fk_ai_jobs_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_jobs
  ADD CONSTRAINT fk_ai_jobs_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE ai_summary_snapshots DROP CONSTRAINT IF EXISTS fk_ai_summary_org_gen_mbr;
--> statement-breakpoint

ALTER TABLE ai_summary_snapshots
  ADD CONSTRAINT fk_ai_summary_org_gen_mbr
    FOREIGN KEY (org_id, generated_by_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (generated_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_envelopes DROP CONSTRAINT IF EXISTS fk_sign_env_org_sender_mbr;
--> statement-breakpoint

ALTER TABLE sign_envelopes
  ADD CONSTRAINT fk_sign_env_org_sender_mbr
    FOREIGN KEY (org_id, sender_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (sender_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_envelopes DROP CONSTRAINT IF EXISTS fk_sign_env_org_voided_mbr;
--> statement-breakpoint

ALTER TABLE sign_envelopes
  ADD CONSTRAINT fk_sign_env_org_voided_mbr
    FOREIGN KEY (org_id, voided_by_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (voided_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_bulk_send_jobs DROP CONSTRAINT IF EXISTS fk_sign_bulk_org_sender_mbr;
--> statement-breakpoint

ALTER TABLE sign_bulk_send_jobs
  ADD CONSTRAINT fk_sign_bulk_org_sender_mbr
    FOREIGN KEY (org_id, sender_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (sender_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_documents DROP CONSTRAINT IF EXISTS fk_sign_doc_org_created_mbr;
--> statement-breakpoint

ALTER TABLE sign_documents
  ADD CONSTRAINT fk_sign_doc_org_created_mbr
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_recipients DROP CONSTRAINT IF EXISTS fk_sign_rcpt_org_user_mbr;
--> statement-breakpoint

ALTER TABLE sign_recipients
  ADD CONSTRAINT fk_sign_rcpt_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_public_forms DROP CONSTRAINT IF EXISTS fk_sign_pf_org_created_mbr;
--> statement-breakpoint

ALTER TABLE sign_public_forms
  ADD CONSTRAINT fk_sign_pf_org_created_mbr
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE sign_templates DROP CONSTRAINT IF EXISTS fk_sign_tpl_org_owner_mbr;
--> statement-breakpoint

ALTER TABLE sign_templates
  ADD CONSTRAINT fk_sign_tpl_org_owner_mbr
    FOREIGN KEY (org_id, owner_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (owner_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_forms DROP CONSTRAINT IF EXISTS fk_survey_forms_org_owner_mbr;
--> statement-breakpoint

ALTER TABLE survey_forms
  ADD CONSTRAINT fk_survey_forms_org_owner_mbr
    FOREIGN KEY (org_id, owner_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (owner_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_forms DROP CONSTRAINT IF EXISTS fk_survey_forms_org_creator_mbr;
--> statement-breakpoint

ALTER TABLE survey_forms
  ADD CONSTRAINT fk_survey_forms_org_creator_mbr
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_versions DROP CONSTRAINT IF EXISTS fk_survey_ver_org_creator_mbr;
--> statement-breakpoint

ALTER TABLE survey_versions
  ADD CONSTRAINT fk_survey_ver_org_creator_mbr
    FOREIGN KEY (org_id, created_by_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (created_by_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_participants DROP CONSTRAINT IF EXISTS fk_survey_part_org_user_mbr;
--> statement-breakpoint

ALTER TABLE survey_participants
  ADD CONSTRAINT fk_survey_part_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE survey_live_sessions DROP CONSTRAINT IF EXISTS fk_survey_live_org_host_mbr;
--> statement-breakpoint

ALTER TABLE survey_live_sessions
  ADD CONSTRAINT fk_survey_live_org_host_mbr
    FOREIGN KEY (org_id, host_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (host_membership_id)
    NOT VALID;
--> statement-breakpoint

ALTER TABLE mail_message_metadata DROP CONSTRAINT IF EXISTS fk_mail_meta_org_user_mbr;
--> statement-breakpoint

ALTER TABLE mail_message_metadata
  ADD CONSTRAINT fk_mail_meta_org_user_mbr
    FOREIGN KEY (org_id, user_membership_id)
    REFERENCES organization_members(org_id, id)
    ON DELETE SET NULL (user_membership_id)
    NOT VALID;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_worker_engagements_created_actor' AND contype = 'f'
  ) THEN
    ALTER TABLE worker_engagements
      ADD CONSTRAINT fk_worker_engagements_created_actor
        FOREIGN KEY (organization_id, created_by_membership_id)
        REFERENCES organization_members(org_id, id)
        ON DELETE RESTRICT
        NOT VALID;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_chat_conversations' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_chat_conversations' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE ai_chat_conversations
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = ai_chat_conversations.org_id
          AND om.user_id = ai_chat_conversations.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_chat_messages' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_chat_messages' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE ai_chat_messages
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = ai_chat_messages.org_id
          AND om.user_id = ai_chat_messages.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_action_proposals' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_action_proposals' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE ai_action_proposals
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = ai_action_proposals.org_id
          AND om.user_id = ai_action_proposals.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_feedback' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_feedback' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE ai_feedback
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = ai_feedback.org_id
          AND om.user_id = ai_feedback.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_jobs' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_jobs' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE ai_jobs
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = ai_jobs.org_id
          AND om.user_id = ai_jobs.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_summary_snapshots' AND column_name = 'generated_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_summary_snapshots' AND column_name = 'generated_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE ai_summary_snapshots
      SET generated_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = ai_summary_snapshots.org_id
          AND om.user_id = ai_summary_snapshots.generated_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE generated_by_membership_id IS NULL AND generated_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_envelopes' AND column_name = 'sender_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_envelopes' AND column_name = 'sender_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_envelopes
      SET sender_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_envelopes.org_id
          AND om.user_id = sign_envelopes.sender_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE sender_membership_id IS NULL AND sender_user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_envelopes' AND column_name = 'voided_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_envelopes' AND column_name = 'voided_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_envelopes
      SET voided_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_envelopes.org_id
          AND om.user_id = sign_envelopes.voided_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE voided_by_membership_id IS NULL AND voided_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_bulk_send_jobs' AND column_name = 'sender_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_bulk_send_jobs' AND column_name = 'sender_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_bulk_send_jobs
      SET sender_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_bulk_send_jobs.org_id
          AND om.user_id = sign_bulk_send_jobs.sender_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE sender_membership_id IS NULL AND sender_user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_documents' AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_documents' AND column_name = 'created_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_documents
      SET created_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_documents.org_id
          AND om.user_id = sign_documents.created_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_recipients' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_recipients' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_recipients
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_recipients.org_id
          AND om.user_id = sign_recipients.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_public_forms' AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_public_forms' AND column_name = 'created_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_public_forms
      SET created_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_public_forms.org_id
          AND om.user_id = sign_public_forms.created_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_templates' AND column_name = 'owner_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sign_templates' AND column_name = 'owner_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE sign_templates
      SET owner_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = sign_templates.org_id
          AND om.user_id = sign_templates.owner_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE owner_membership_id IS NULL AND owner_user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_forms' AND column_name = 'owner_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_forms' AND column_name = 'owner_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE survey_forms
      SET owner_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = survey_forms.org_id
          AND om.user_id = survey_forms.owner_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE owner_membership_id IS NULL AND owner_user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_forms' AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_forms' AND column_name = 'created_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE survey_forms
      SET created_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = survey_forms.org_id
          AND om.user_id = survey_forms.created_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_versions' AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_versions' AND column_name = 'created_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE survey_versions
      SET created_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = survey_versions.org_id
          AND om.user_id = survey_versions.created_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_participants' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_participants' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE survey_participants
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = survey_participants.org_id
          AND om.user_id = survey_participants.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_live_sessions' AND column_name = 'host_user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'survey_live_sessions' AND column_name = 'host_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE survey_live_sessions
      SET host_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = survey_live_sessions.org_id
          AND om.user_id = survey_live_sessions.host_user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE host_membership_id IS NULL AND host_user_id IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'worker_engagements' AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'worker_engagements' AND column_name = 'created_by_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE worker_engagements
      SET created_by_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = worker_engagements.organization_id
          AND om.user_id = worker_engagements.created_by
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE created_by_membership_id IS NULL AND created_by IS NOT NULL
    $q$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mail_message_metadata' AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'mail_message_metadata' AND column_name = 'user_membership_id'
  ) THEN
    EXECUTE $q$
      UPDATE mail_message_metadata
      SET user_membership_id = (
        SELECT om.id FROM organization_members om
        WHERE om.org_id = mail_message_metadata.org_id
          AND om.user_id = mail_message_metadata.user_id
          AND om.status = 'ACTIVE'
        LIMIT 1
      )
      WHERE user_membership_id IS NULL AND user_id IS NOT NULL
    $q$;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE ai_chat_conversations VALIDATE CONSTRAINT fk_ai_chat_conv_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_chat_messages VALIDATE CONSTRAINT fk_ai_chat_msg_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_action_proposals VALIDATE CONSTRAINT fk_ai_proposals_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_feedback VALIDATE CONSTRAINT fk_ai_feedback_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_jobs VALIDATE CONSTRAINT fk_ai_jobs_org_user_mbr;
--> statement-breakpoint

ALTER TABLE ai_summary_snapshots VALIDATE CONSTRAINT fk_ai_summary_org_gen_mbr;
--> statement-breakpoint

ALTER TABLE sign_envelopes VALIDATE CONSTRAINT fk_sign_env_org_sender_mbr;
--> statement-breakpoint

ALTER TABLE sign_envelopes VALIDATE CONSTRAINT fk_sign_env_org_voided_mbr;
--> statement-breakpoint

ALTER TABLE sign_bulk_send_jobs VALIDATE CONSTRAINT fk_sign_bulk_org_sender_mbr;
--> statement-breakpoint

ALTER TABLE sign_documents VALIDATE CONSTRAINT fk_sign_doc_org_created_mbr;
--> statement-breakpoint

ALTER TABLE sign_recipients VALIDATE CONSTRAINT fk_sign_rcpt_org_user_mbr;
--> statement-breakpoint

ALTER TABLE sign_public_forms VALIDATE CONSTRAINT fk_sign_pf_org_created_mbr;
--> statement-breakpoint

ALTER TABLE sign_templates VALIDATE CONSTRAINT fk_sign_tpl_org_owner_mbr;
--> statement-breakpoint

ALTER TABLE survey_forms VALIDATE CONSTRAINT fk_survey_forms_org_owner_mbr;
--> statement-breakpoint

ALTER TABLE survey_forms VALIDATE CONSTRAINT fk_survey_forms_org_creator_mbr;
--> statement-breakpoint

ALTER TABLE survey_versions VALIDATE CONSTRAINT fk_survey_ver_org_creator_mbr;
--> statement-breakpoint

ALTER TABLE survey_participants VALIDATE CONSTRAINT fk_survey_part_org_user_mbr;
--> statement-breakpoint

ALTER TABLE survey_live_sessions VALIDATE CONSTRAINT fk_survey_live_org_host_mbr;
--> statement-breakpoint

ALTER TABLE mail_message_metadata VALIDATE CONSTRAINT fk_mail_meta_org_user_mbr;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_worker_engagements_created_actor' AND contype = 'f'
  ) THEN
    ALTER TABLE worker_engagements VALIDATE CONSTRAINT fk_worker_engagements_created_actor;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ai_chat_conv_org_user_mbr
  ON ai_chat_conversations (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ai_chat_msg_org_user_mbr
  ON ai_chat_messages (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ai_proposals_org_user_mbr
  ON ai_action_proposals (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ai_feedback_org_user_mbr
  ON ai_feedback (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ai_jobs_org_user_mbr
  ON ai_jobs (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_ai_summary_org_gen_mbr
  ON ai_summary_snapshots (org_id, generated_by_membership_id)
  WHERE generated_by_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_env_org_sender_mbr
  ON sign_envelopes (org_id, sender_membership_id)
  WHERE sender_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_env_org_voided_mbr
  ON sign_envelopes (org_id, voided_by_membership_id)
  WHERE voided_by_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_bulk_org_sender_mbr
  ON sign_bulk_send_jobs (org_id, sender_membership_id)
  WHERE sender_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_doc_org_created_mbr
  ON sign_documents (org_id, created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_rcpt_org_user_mbr
  ON sign_recipients (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_pf_org_created_mbr
  ON sign_public_forms (org_id, created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_sign_tpl_org_owner_mbr
  ON sign_templates (org_id, owner_membership_id)
  WHERE owner_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_survey_forms_org_owner_mbr
  ON survey_forms (org_id, owner_membership_id)
  WHERE owner_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_survey_forms_org_creator_mbr
  ON survey_forms (org_id, created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_survey_ver_org_creator_mbr
  ON survey_versions (org_id, created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_survey_part_org_user_mbr
  ON survey_participants (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_survey_live_org_host_mbr
  ON survey_live_sessions (org_id, host_membership_id)
  WHERE host_membership_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_mail_meta_org_user_mbr
  ON mail_message_metadata (org_id, user_membership_id)
  WHERE user_membership_id IS NOT NULL;
--> statement-breakpoint

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.conname, ', ') INTO bad
  FROM pg_constraint c
  WHERE c.conname IN (
    'fk_ai_chat_conv_org_user_mbr',
    'fk_ai_chat_msg_org_user_mbr',
    'fk_ai_proposals_org_user_mbr',
    'fk_ai_feedback_org_user_mbr',
    'fk_ai_jobs_org_user_mbr',
    'fk_ai_summary_org_gen_mbr',
    'fk_sign_env_org_sender_mbr',
    'fk_sign_env_org_voided_mbr',
    'fk_sign_bulk_org_sender_mbr',
    'fk_sign_doc_org_created_mbr',
    'fk_sign_rcpt_org_user_mbr',
    'fk_sign_pf_org_created_mbr',
    'fk_sign_tpl_org_owner_mbr',
    'fk_survey_forms_org_owner_mbr',
    'fk_survey_forms_org_creator_mbr',
    'fk_survey_ver_org_creator_mbr',
    'fk_survey_part_org_user_mbr',
    'fk_survey_live_org_host_mbr',
    'fk_mail_meta_org_user_mbr'
  )
    AND c.contype = 'f'
    AND c.confdeltype = 'n'
    AND (c.confdelsetcols IS NULL OR cardinality(c.confdelsetcols) <> 1);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0815: composite ON DELETE SET NULL without a single-column list would null org_id (23502): %', bad;
  END IF;
END $$;
