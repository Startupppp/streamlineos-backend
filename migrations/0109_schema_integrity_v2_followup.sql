-- Schema integrity follow-up: enum/bool/int/text NOT NULL backfills
-- + org_id FK cascade conversion.
-- All NOT NULL adds are gated on a backfill that sets NULLs to the column default.

------------------------------------------------------------------------------
-- 1. Backfill NULLs and set NOT NULL on enum columns with defaults
------------------------------------------------------------------------------
UPDATE review_cycles         SET status = 'DRAFT'       WHERE status IS NULL;
UPDATE performance_reviews   SET status = 'DRAFT'       WHERE status IS NULL;
UPDATE one_on_one_meetings   SET status = 'SCHEDULED'   WHERE status IS NULL;
UPDATE training_programs     SET status = 'DRAFT'       WHERE status IS NULL;
UPDATE training_enrollments  SET status = 'ENROLLED'    WHERE status IS NULL;
UPDATE resignations          SET status = 'SUBMITTED'   WHERE status IS NULL;
UPDATE exit_checklists       SET status = 'PENDING'     WHERE status IS NULL;
UPDATE terminations          SET status = 'DRAFT'       WHERE status IS NULL;
UPDATE onboarding_documents  SET status = 'SUBMITTED'   WHERE status IS NULL;
UPDATE policy_acknowledgments SET status = 'PENDING'    WHERE status IS NULL;
UPDATE performance_improvement_plans SET status = 'ACTIVE' WHERE status IS NULL;
UPDATE pulse_surveys         SET status = 'DRAFT'       WHERE status IS NULL;
UPDATE wfh_requests          SET status = 'PENDING'     WHERE status IS NULL;
UPDATE employee_devices      SET status = 'ACTIVE'      WHERE status IS NULL;
UPDATE helpdesk_tickets      SET priority = 'MEDIUM'    WHERE priority IS NULL;
UPDATE helpdesk_tickets      SET status = 'TODO'        WHERE status IS NULL;
UPDATE job_postings          SET status = 'DRAFT'       WHERE status IS NULL;
UPDATE candidates            SET status = 'NEW'         WHERE status IS NULL;
UPDATE candidate_applications SET status = 'APPLIED'    WHERE status IS NULL;
UPDATE interviews            SET type = 'VIDEO'         WHERE type IS NULL;
UPDATE interviews            SET result = 'PENDING'     WHERE result IS NULL;
UPDATE crm_leads             SET status = 'lead'        WHERE status IS NULL;
UPDATE crm_events            SET status = 'planning'    WHERE status IS NULL;
UPDATE crm_support_tickets   SET priority = 'medium'    WHERE priority IS NULL;
UPDATE crm_support_tickets   SET status = 'new'         WHERE status IS NULL;

ALTER TABLE review_cycles         ALTER COLUMN status   SET NOT NULL;
ALTER TABLE performance_reviews   ALTER COLUMN status   SET NOT NULL;
ALTER TABLE one_on_one_meetings   ALTER COLUMN status   SET NOT NULL;
ALTER TABLE training_programs     ALTER COLUMN status   SET NOT NULL;
ALTER TABLE training_enrollments  ALTER COLUMN status   SET NOT NULL;
ALTER TABLE resignations          ALTER COLUMN status   SET NOT NULL;
ALTER TABLE exit_checklists       ALTER COLUMN status   SET NOT NULL;
ALTER TABLE terminations          ALTER COLUMN status   SET NOT NULL;
ALTER TABLE onboarding_documents  ALTER COLUMN status   SET NOT NULL;
ALTER TABLE policy_acknowledgments ALTER COLUMN status  SET NOT NULL;
ALTER TABLE performance_improvement_plans ALTER COLUMN status SET NOT NULL;
ALTER TABLE pulse_surveys         ALTER COLUMN status   SET NOT NULL;
ALTER TABLE wfh_requests          ALTER COLUMN status   SET NOT NULL;
ALTER TABLE employee_devices      ALTER COLUMN status   SET NOT NULL;
ALTER TABLE helpdesk_tickets      ALTER COLUMN priority SET NOT NULL;
ALTER TABLE helpdesk_tickets      ALTER COLUMN status   SET NOT NULL;
ALTER TABLE job_postings          ALTER COLUMN status   SET NOT NULL;
ALTER TABLE candidates            ALTER COLUMN status   SET NOT NULL;
ALTER TABLE candidate_applications ALTER COLUMN status  SET NOT NULL;
ALTER TABLE interviews            ALTER COLUMN type     SET NOT NULL;
ALTER TABLE interviews            ALTER COLUMN result   SET NOT NULL;
ALTER TABLE crm_leads             ALTER COLUMN status   SET NOT NULL;
ALTER TABLE crm_events            ALTER COLUMN status   SET NOT NULL;
ALTER TABLE crm_support_tickets   ALTER COLUMN priority SET NOT NULL;
ALTER TABLE crm_support_tickets   ALTER COLUMN status   SET NOT NULL;

------------------------------------------------------------------------------
-- 2. Backfill NULLs and set NOT NULL on boolean columns with defaults
------------------------------------------------------------------------------
UPDATE resignations             SET willing_for_exit_interview = true  WHERE willing_for_exit_interview IS NULL;
UPDATE terminations             SET notice_period_waived = false       WHERE notice_period_waived IS NULL;
UPDATE document_types           SET is_mandatory = true                WHERE is_mandatory IS NULL;
UPDATE document_types           SET is_active = true                   WHERE is_active IS NULL;
UPDATE recognitions             SET is_public = true                   WHERE is_public IS NULL;
UPDATE certifications           SET reminder_sent = false              WHERE reminder_sent IS NULL;
UPDATE assessment_attempts      SET passed = false                     WHERE passed IS NULL;
UPDATE pulse_surveys            SET is_anonymous = true                WHERE is_anonymous IS NULL;
UPDATE enps_scores              SET is_anonymous = true                WHERE is_anonymous IS NULL;
UPDATE feedback_requests        SET is_completed = false               WHERE is_completed IS NULL;
UPDATE alumni_profiles          SET is_opted_in = true                 WHERE is_opted_in IS NULL;
UPDATE holidays                 SET notification_sent = false          WHERE notification_sent IS NULL;
UPDATE rich_documents           SET is_published = false               WHERE is_published IS NULL;
UPDATE custom_field_definitions SET is_required = false                WHERE is_required IS NULL;
UPDATE custom_field_definitions SET is_active = true                   WHERE is_active IS NULL;
UPDATE territories              SET is_active = true                   WHERE is_active IS NULL;
UPDATE web_lead_forms           SET is_active = true                   WHERE is_active IS NULL;

ALTER TABLE resignations             ALTER COLUMN willing_for_exit_interview SET NOT NULL;
ALTER TABLE terminations             ALTER COLUMN notice_period_waived SET NOT NULL;
ALTER TABLE document_types           ALTER COLUMN is_mandatory SET NOT NULL;
ALTER TABLE document_types           ALTER COLUMN is_active SET NOT NULL;
ALTER TABLE recognitions             ALTER COLUMN is_public SET NOT NULL;
ALTER TABLE certifications           ALTER COLUMN reminder_sent SET NOT NULL;
ALTER TABLE assessment_attempts      ALTER COLUMN passed SET NOT NULL;
ALTER TABLE pulse_surveys            ALTER COLUMN is_anonymous SET NOT NULL;
ALTER TABLE enps_scores              ALTER COLUMN is_anonymous SET NOT NULL;
ALTER TABLE feedback_requests        ALTER COLUMN is_completed SET NOT NULL;
ALTER TABLE alumni_profiles          ALTER COLUMN is_opted_in SET NOT NULL;
ALTER TABLE holidays                 ALTER COLUMN notification_sent SET NOT NULL;
ALTER TABLE rich_documents           ALTER COLUMN is_published SET NOT NULL;
ALTER TABLE custom_field_definitions ALTER COLUMN is_required SET NOT NULL;
ALTER TABLE custom_field_definitions ALTER COLUMN is_active SET NOT NULL;
ALTER TABLE territories              ALTER COLUMN is_active SET NOT NULL;
ALTER TABLE web_lead_forms           ALTER COLUMN is_active SET NOT NULL;

------------------------------------------------------------------------------
-- 3. Backfill NULLs and set NOT NULL on integer columns with defaults
------------------------------------------------------------------------------
UPDATE organizations           SET fiscal_year_start = 4   WHERE fiscal_year_start IS NULL;
UPDATE email_campaigns         SET recipient_count = 0     WHERE recipient_count IS NULL;
UPDATE email_campaigns         SET sent_count = 0          WHERE sent_count IS NULL;
UPDATE email_campaigns         SET failed_count = 0        WHERE failed_count IS NULL;
UPDATE email_campaigns         SET open_count = 0          WHERE open_count IS NULL;
UPDATE email_campaigns         SET click_count = 0         WHERE click_count IS NULL;
UPDATE social_media_stats      SET posts_published = 0     WHERE posts_published IS NULL;
UPDATE social_media_stats      SET stories_reels = 0       WHERE stories_reels IS NULL;
UPDATE social_media_stats      SET followers_total = 0     WHERE followers_total IS NULL;
UPDATE social_media_stats      SET impressions = 0         WHERE impressions IS NULL;
UPDATE social_media_stats      SET reach = 0               WHERE reach IS NULL;
UPDATE social_media_stats      SET link_clicks = 0         WHERE link_clicks IS NULL;
UPDATE social_media_stats      SET profile_visits = 0      WHERE profile_visits IS NULL;
UPDATE deal_meetings           SET duration_minutes = 30   WHERE duration_minutes IS NULL;
UPDATE custom_field_definitions SET sort_order = 0         WHERE sort_order IS NULL;
UPDATE web_lead_forms          SET total_submissions = 0   WHERE total_submissions IS NULL;
UPDATE quote_line_items        SET display_order = 0       WHERE display_order IS NULL;
UPDATE one_on_one_meetings     SET duration = 30           WHERE duration IS NULL;
UPDATE resignations            SET notice_period_days = 30 WHERE notice_period_days IS NULL;
UPDATE document_types          SET sort_order = 0          WHERE sort_order IS NULL;
UPDATE onboarding_documents    SET version = 1             WHERE version IS NULL;
UPDATE employee_skills         SET level = 1               WHERE level IS NULL;
UPDATE skill_assessments       SET passing_score = 70      WHERE passing_score IS NULL;
UPDATE job_postings            SET openings = 1            WHERE openings IS NULL;
UPDATE candidate_sources       SET last_sync_count = 0     WHERE last_sync_count IS NULL;
UPDATE interviews              SET duration = 60           WHERE duration IS NULL;
UPDATE rich_documents          SET version = 1             WHERE version IS NULL;

ALTER TABLE organizations            ALTER COLUMN fiscal_year_start SET NOT NULL;
ALTER TABLE email_campaigns          ALTER COLUMN recipient_count SET NOT NULL;
ALTER TABLE email_campaigns          ALTER COLUMN sent_count SET NOT NULL;
ALTER TABLE email_campaigns          ALTER COLUMN failed_count SET NOT NULL;
ALTER TABLE email_campaigns          ALTER COLUMN open_count SET NOT NULL;
ALTER TABLE email_campaigns          ALTER COLUMN click_count SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN posts_published SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN stories_reels SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN followers_total SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN impressions SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN reach SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN link_clicks SET NOT NULL;
ALTER TABLE social_media_stats       ALTER COLUMN profile_visits SET NOT NULL;
ALTER TABLE deal_meetings            ALTER COLUMN duration_minutes SET NOT NULL;
ALTER TABLE custom_field_definitions ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE web_lead_forms           ALTER COLUMN total_submissions SET NOT NULL;
ALTER TABLE quote_line_items         ALTER COLUMN display_order SET NOT NULL;
ALTER TABLE one_on_one_meetings      ALTER COLUMN duration SET NOT NULL;
ALTER TABLE resignations             ALTER COLUMN notice_period_days SET NOT NULL;
ALTER TABLE document_types           ALTER COLUMN sort_order SET NOT NULL;
ALTER TABLE onboarding_documents     ALTER COLUMN version SET NOT NULL;
ALTER TABLE employee_skills          ALTER COLUMN level SET NOT NULL;
ALTER TABLE skill_assessments        ALTER COLUMN passing_score SET NOT NULL;
ALTER TABLE job_postings             ALTER COLUMN openings SET NOT NULL;
ALTER TABLE candidate_sources        ALTER COLUMN last_sync_count SET NOT NULL;
ALTER TABLE interviews               ALTER COLUMN duration SET NOT NULL;
ALTER TABLE rich_documents           ALTER COLUMN version SET NOT NULL;

------------------------------------------------------------------------------
-- 4. Backfill NULLs and set NOT NULL on text columns with defaults
------------------------------------------------------------------------------
UPDATE organizations           SET timezone = 'Asia/Kolkata' WHERE timezone IS NULL;
UPDATE organizations           SET currency = 'INR'          WHERE currency IS NULL;
UPDATE crm_support_team_members SET status = 'online'        WHERE status IS NULL;
UPDATE crm_views               SET sort_dir = 'asc'          WHERE sort_dir IS NULL;
UPDATE branches                SET country = 'India'         WHERE country IS NULL;
UPDATE dm_leads                SET lead_quality = 'warm'     WHERE lead_quality IS NULL;
UPDATE web_lead_forms          SET submit_message = 'Thank you! We''ll be in touch soon.' WHERE submit_message IS NULL;
UPDATE review_cycles           SET type = 'QUARTERLY'        WHERE type IS NULL;
UPDATE recognitions            SET category = 'KUDOS'        WHERE category IS NULL;
UPDATE background_verifications SET status = 'PENDING'       WHERE status IS NULL;
UPDATE bonuses                 SET status = 'PENDING'        WHERE status IS NULL;
UPDATE team_events             SET type = 'TEAM_BUILDING'    WHERE type IS NULL;
UPDATE team_event_participants SET status = 'GOING'          WHERE status IS NULL;
UPDATE hr_email_templates      SET category = 'GENERAL'      WHERE category IS NULL;
UPDATE asset_returns           SET status = 'PENDING'        WHERE status IS NULL;
UPDATE job_postings            SET type = 'FULL_TIME'        WHERE type IS NULL;
UPDATE candidates              SET source = 'DIRECT'         WHERE source IS NULL;

ALTER TABLE organizations            ALTER COLUMN timezone SET NOT NULL;
ALTER TABLE organizations            ALTER COLUMN currency SET NOT NULL;
ALTER TABLE crm_support_team_members ALTER COLUMN status SET NOT NULL;
ALTER TABLE crm_views                ALTER COLUMN sort_dir SET NOT NULL;
ALTER TABLE branches                 ALTER COLUMN country SET NOT NULL;
ALTER TABLE dm_leads                 ALTER COLUMN lead_quality SET NOT NULL;
ALTER TABLE web_lead_forms           ALTER COLUMN submit_message SET NOT NULL;
ALTER TABLE review_cycles            ALTER COLUMN type SET NOT NULL;
ALTER TABLE recognitions             ALTER COLUMN category SET NOT NULL;
ALTER TABLE background_verifications ALTER COLUMN status SET NOT NULL;
ALTER TABLE bonuses                  ALTER COLUMN status SET NOT NULL;
ALTER TABLE team_events              ALTER COLUMN type SET NOT NULL;
ALTER TABLE team_event_participants  ALTER COLUMN status SET NOT NULL;
ALTER TABLE hr_email_templates       ALTER COLUMN category SET NOT NULL;
ALTER TABLE asset_returns            ALTER COLUMN status SET NOT NULL;
ALTER TABLE job_postings             ALTER COLUMN type SET NOT NULL;
ALTER TABLE candidates               ALTER COLUMN source SET NOT NULL;

------------------------------------------------------------------------------
-- 5. Convert ALL org_id FK constraints to ON DELETE CASCADE
--    Done programmatically: find existing constraint, drop, recreate with CASCADE.
------------------------------------------------------------------------------
DO $$
DECLARE
  rec RECORD;
  cname TEXT;
BEGIN
  FOR rec IN
    SELECT
      tc.table_name AS tbl,
      tc.constraint_name AS con
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
     AND tc.table_schema = rc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND kcu.column_name = 'org_id'
      AND rc.delete_rule <> 'CASCADE'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', rec.tbl, rec.con);
    cname := rec.tbl || '_org_id_fkey';
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE',
      rec.tbl, cname
    );
    RAISE NOTICE 'Converted % -> ON DELETE CASCADE', rec.tbl;
  END LOOP;
END $$;
