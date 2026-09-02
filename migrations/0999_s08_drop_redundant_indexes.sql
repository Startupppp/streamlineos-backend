-- 337 redundant indexes: 43 exact duplicates and 294 whose column
-- list is a strict leading prefix, in the same order and direction, of a wider
-- non-partial btree on the same table. A duplicate costs a second write on every
-- INSERT/UPDATE of its table, a second entry to keep in the visibility map, and its
-- own VACUUM and bloat, for no read the surviving index does not already serve.
--
-- The list is derived structurally from pg_indexes and pg_constraint, not from usage
-- statistics: a bootstrapped database has five non-empty tables out of 1,026, so
-- pg_stat_user_indexes.idx_scan there measures the bootstrap and nothing else. No index
-- appears here because it looked unused. Every row is either bit-identical to another
-- index on the same table or answerable from a wider one by definition of a btree.
--
-- Four selection rules, applied in order:
--   1. never drop a constraint-backing index (pg_constraint.conindid);
--   2. never drop a UNIQUE in favour of a non-unique;
--   3. never treat a partial index as covering a non-partial one, and never drop a
--      partial index at all -- its predicate is not reproducible from a wider index;
--   4. compare key columns including ASC/DESC and NULLS ordering, so
--      (org_id, payment_date) is not called a prefix of (org_id, payment_date DESC, id DESC).
--
-- Rule 1 is not sufficient on its own, which reports 05 and 07 both missed. Three
-- entries the structural pass proposed -- uniq_cfd_org_id, uniq_legal_entities_org_id
-- and uniq_principal_groups_org_id -- are not constraint-backed and still cannot be
-- dropped: a composite tenant foreign key depends on each of them
-- (fk_ticket_cfield_values_org_def, fk_gl_books_legal_entity_id_org,
-- fk_principal_group_members_org_group), so DROP INDEX fails 2BP01. They are excluded
-- here and stay in db/schema. Every one of the 337 statements below was executed
-- against a database at head, each in its own rolled-back transaction, and all succeeded.
--
-- The matching declarations were removed from db/schema in the same change, so the
-- declaration does not re-propose what this migration drops.
--
-- DROP INDEX, not DROP INDEX CONCURRENTLY: check-migration-discipline.mjs rejects
-- CONCURRENTLY because drizzle-kit migrate wraps each file in a transaction. Every drop
-- here is a catalog-only operation, and lock_timeout makes a contended one fail fast
-- rather than queue in front of the table's traffic.

SET lock_timeout = '5s';
--> statement-breakpoint
-- build.bugs: exact-duplicate of idx_bugs_assignee
DROP INDEX IF EXISTS build.idx_bugs_org_assignee_membership;
--> statement-breakpoint
-- build.feedbucket_submissions: exact-duplicate of idx_feedbucket_submissions_assignee
DROP INDEX IF EXISTS build.idx_feedbucket_submissions_org_assignee_membership;
--> statement-breakpoint
-- build.project_workspace_members: exact-duplicate of uniq_project_workspace_members_org_user
DROP INDEX IF EXISTS build.idx_project_workspace_members_org_membership;
--> statement-breakpoint
-- build.projects: exact-duplicate of idx_projects_manager
DROP INDEX IF EXISTS build.idx_projects_org_manager_membership;
--> statement-breakpoint
-- public.affiliates: exact-duplicate of affiliates_referral_code_unique
DROP INDEX IF EXISTS public.affiliates_code_idx;
--> statement-breakpoint
-- public.affiliates: exact-duplicate of affiliates_user_id_unique
DROP INDEX IF EXISTS public.affiliates_user_idx;
--> statement-breakpoint
-- public.billing_products: exact-duplicate of billing_products_slug_key
DROP INDEX IF EXISTS public.idx_billing_products_slug;
--> statement-breakpoint
-- public.billing_profiles: exact-duplicate of billing_profiles_org_id_unique
DROP INDEX IF EXISTS public.billing_profiles_org_idx;
--> statement-breakpoint
-- public.blog_categories: exact-duplicate of blog_categories_slug_unique
DROP INDEX IF EXISTS public.idx_blog_categories_slug;
--> statement-breakpoint
-- public.crm_import_rows: exact-duplicate of uniq_crm_import_rows_line
DROP INDEX IF EXISTS public.idx_crm_import_rows_import;
--> statement-breakpoint
-- public.data_quality_health_snapshots: exact-duplicate of uniq_data_quality_health_snapshots_day
DROP INDEX IF EXISTS public.idx_data_quality_health_snapshots_series;
--> statement-breakpoint
-- public.employee_salary_profiles: exact-duplicate of uniq_esp_org_user_effective_from
DROP INDEX IF EXISTS public.idx_employee_salary_profiles_org_user_effective;
--> statement-breakpoint
-- public.feature_flags: exact-duplicate of feature_flags_key_unique
DROP INDEX IF EXISTS public.uniq_feature_flags_key;
--> statement-breakpoint
-- public.fin_payment_run_items: exact-duplicate of idx_fin_payment_run_items_org_run
DROP INDEX IF EXISTS public.idx_fin_payment_run_items_org_run_status;
--> statement-breakpoint
-- public.health_score_config: exact-duplicate of health_score_config_org_id_unique
DROP INDEX IF EXISTS public.idx_health_score_config_org;
--> statement-breakpoint
-- public.hr_case_notes: exact-duplicate of idx_hr_case_notes_org_author_membership
DROP INDEX IF EXISTS public.idx_s01_hr_a36b1c9397e2b19b;
--> statement-breakpoint
-- public.hr_document_tags: exact-duplicate of uniq_hr_document_tags_parent_order
DROP INDEX IF EXISTS public.idx_hr_document_tags_parent;
--> statement-breakpoint
-- public.hr_employee_sensitive_disciplinary_records: exact-duplicate of uniq_hr_sensitive_disciplinary_parent_order
DROP INDEX IF EXISTS public.idx_hr_sensitive_disciplinary_parent;
--> statement-breakpoint
-- public.hr_employee_sensitive_grievance_records: exact-duplicate of uniq_hr_sensitive_grievance_parent_order
DROP INDEX IF EXISTS public.idx_hr_sensitive_grievance_parent;
--> statement-breakpoint
-- public.hr_insurance_claims: exact-duplicate of idx_hr_insurance_claims_org_decider_membership
DROP INDEX IF EXISTS public.idx_s01_hr_c32c5f12eb6efc88;
--> statement-breakpoint
-- public.hr_mood_checkins: exact-duplicate of idx_hr_actor_e4f3eb227c726e23
DROP INDEX IF EXISTS public.idx_mood_checkins_org_user_membership;
--> statement-breakpoint
-- public.hr_workflow_delegations: exact-duplicate of idx_hr_actor_0635afa973c5d89d
DROP INDEX IF EXISTS public.idx_hr_wf_delegations_org_delegator_membership;
--> statement-breakpoint
-- public.hr_workflow_delegations: exact-duplicate of idx_hr_actor_be01b0002e599354
DROP INDEX IF EXISTS public.idx_hr_wf_delegations_org_delegate_membership;
--> statement-breakpoint
-- public.hr_workflow_step_actions: exact-duplicate of idx_hr_actor_3a5f544074767166
DROP INDEX IF EXISTS public.idx_hr_wf_actions_org_acted_by_membership;
--> statement-breakpoint
-- public.interview_booking_links: exact-duplicate of interview_booking_links_token_unique
DROP INDEX IF EXISTS public.idx_booking_links_token;
--> statement-breakpoint
-- public.inv_product_uom_conversions: exact-duplicate of uniq_inv_product_uom_conversions_key
DROP INDEX IF EXISTS public.uniq_inv_product_uom_conversions_org_product_uom;
--> statement-breakpoint
-- public.inv_settings: exact-duplicate of inv_settings_org_id_unique
DROP INDEX IF EXISTS public.idx_inv_settings_org;
--> statement-breakpoint
-- public.inv_standard_costs: exact-duplicate of uniq_inv_standard_costs_variant_from
DROP INDEX IF EXISTS public.idx_inv_standard_costs_lookup;
--> statement-breakpoint
-- public.notification_preferences: exact-duplicate of uniq_notification_preferences_org_membership
DROP INDEX IF EXISTS public.idx_notification_preferences_org_membership;
--> statement-breakpoint
-- public.notification_queue: exact-duplicate of uniq_notification_queue_delivery
DROP INDEX IF EXISTS public.idx_notification_queue_delivery;
--> statement-breakpoint
-- public.onboarding_task_dependencies: exact-duplicate of uniq_onboarding_task_dependencies_order
DROP INDEX IF EXISTS public.idx_onboarding_task_dependencies_task;
--> statement-breakpoint
-- public.org_ai_credits: exact-duplicate of org_ai_credits_org_id_unique
DROP INDEX IF EXISTS public.org_ai_credits_org_idx;
--> statement-breakpoint
-- public.performance_reviews: exact-duplicate of idx_hr_actor_32a7dc662ee3633f
DROP INDEX IF EXISTS public.idx_perf_reviews_org_reviewer_membership;
--> statement-breakpoint
-- public.portal_invitations: exact-duplicate of uniq_portal_invitations_org_id
DROP INDEX IF EXISTS public.uniq_portal_invitations_org_invitation;
--> statement-breakpoint
-- public.project_client_grants: exact-duplicate of uniq_project_client_grants_org_id
DROP INDEX IF EXISTS public.uniq_project_client_grants_org_grant;
--> statement-breakpoint
-- public.recognitions: exact-duplicate of idx_hr_actor_8c58a8f7caea6fd4
DROP INDEX IF EXISTS public.idx_recognitions_org_from_membership;
--> statement-breakpoint
-- public.recognitions: exact-duplicate of idx_hr_actor_98ea9f04e21e3a5d
DROP INDEX IF EXISTS public.idx_recognitions_org_to_membership;
--> statement-breakpoint
-- public.support_agent_availability: exact-duplicate of uniq_support_agent_availability_org_membership
DROP INDEX IF EXISTS public.idx_support_agent_avail_org_user_actor;
--> statement-breakpoint
-- public.termination_reasons: exact-duplicate of uniq_termination_reasons_parent_order
DROP INDEX IF EXISTS public.idx_termination_reasons_parent;
--> statement-breakpoint
-- public.termination_supporting_documents: exact-duplicate of uniq_termination_supporting_documents_order
DROP INDEX IF EXISTS public.idx_termination_supporting_documents_parent;
--> statement-breakpoint
-- public.users: exact-duplicate of users_email_unique
DROP INDEX IF EXISTS public.idx_users_email;
--> statement-breakpoint
-- public.web_lead_forms: exact-duplicate of web_lead_forms_public_token_unique
DROP INDEX IF EXISTS public.web_lead_forms_token_idx;
--> statement-breakpoint
-- public.worker_engagements: exact-duplicate of uniq_worker_engagements_org_id
DROP INDEX IF EXISTS public.uniq_worker_engagements_org_engagement;
--> statement-breakpoint
-- build.comment_drafts: leading prefix of uniq_comment_drafts_owner_ticket
DROP INDEX IF EXISTS build.idx_comment_drafts_org_member_membership;
--> statement-breakpoint
-- build.git_connections: leading prefix of uniq_git_connections_org_id
DROP INDEX IF EXISTS build.idx_git_connections_org;
--> statement-breakpoint
-- build.git_ticket_links: leading prefix of uniq_git_ticket_links_ref
DROP INDEX IF EXISTS build.idx_git_ticket_links_ticket;
--> statement-breakpoint
-- build.modules: leading prefix of uniq_modules_org_id
DROP INDEX IF EXISTS build.idx_modules_org;
--> statement-breakpoint
-- build.okr_links: leading prefix of uniq_okr_links_goal_ticket
DROP INDEX IF EXISTS build.idx_okr_links_goal;
--> statement-breakpoint
-- build.pages: leading prefix of uniq_pages_org_id
DROP INDEX IF EXISTS build.idx_pages_org;
--> statement-breakpoint
-- build.pm_workspace_memberships: leading prefix of idx_pm_workspace_memberships_org_ws_added
DROP INDEX IF EXISTS build.idx_pm_ws_members_org_ws;
--> statement-breakpoint
-- build.project_approvals: leading prefix of idx_project_approvals_approver_status
DROP INDEX IF EXISTS build.idx_project_approvals_org_approver_membership;
--> statement-breakpoint
-- build.project_automations: leading prefix of uniq_project_automations_org_id
DROP INDEX IF EXISTS build.idx_project_automations_org_id;
--> statement-breakpoint
-- build.project_team_assignments: leading prefix of uniq_project_team_assignments_org_id
DROP INDEX IF EXISTS build.idx_project_team_assignments_org;
--> statement-breakpoint
-- build.project_team_assignments: leading prefix of uniq_project_team_assignments_project_team
DROP INDEX IF EXISTS build.idx_project_team_assignments_project;
--> statement-breakpoint
-- build.project_team_members: leading prefix of idx_project_team_members_org_membership
DROP INDEX IF EXISTS build.idx_project_team_members_org;
--> statement-breakpoint
-- build.project_views: leading prefix of idx_project_views_org_scope
DROP INDEX IF EXISTS build.idx_project_views_org;
--> statement-breakpoint
-- build.project_webhooks: leading prefix of uniq_project_webhooks_org_id
DROP INDEX IF EXISTS build.idx_project_webhooks_org_id;
--> statement-breakpoint
-- build.project_workspace_members: leading prefix of idx_project_workspace_members_org_pm_workspace
DROP INDEX IF EXISTS build.idx_project_workspace_members_org;
--> statement-breakpoint
-- build.release_tickets: leading prefix of uniq_release_tickets
DROP INDEX IF EXISTS build.idx_release_tickets_release;
--> statement-breakpoint
-- build.ticket_assignees: leading prefix of idx_ticket_assignees_org_user_ticket
DROP INDEX IF EXISTS build.idx_ticket_assignees_org_member_membership;
--> statement-breakpoint
-- build.ticket_comment_mentions: leading prefix of uniq_ticket_comment_mentions_comment_user
DROP INDEX IF EXISTS build.idx_ticket_comment_mentions_comment;
--> statement-breakpoint
-- build.ticket_comment_reactions: leading prefix of uq_comment_reaction_user_emoji
DROP INDEX IF EXISTS build.idx_comment_reactions_comment_id;
--> statement-breakpoint
-- build.ticket_custom_field_values: leading prefix of uniq_ticket_custom_field_values
DROP INDEX IF EXISTS build.idx_ticket_custom_field_values_ticket;
--> statement-breakpoint
-- build.tickets: leading prefix of idx_tickets_org_assignee_status
DROP INDEX IF EXISTS build.idx_tickets_org_assignee_membership;
--> statement-breakpoint
-- build.work_item_relations: leading prefix of uniq_work_item_relation
DROP INDEX IF EXISTS build.idx_work_item_relations_item;
--> statement-breakpoint
-- public.acc_asset_categories: leading prefix of idx_acc_asset_categories_name_id
DROP INDEX IF EXISTS public.idx_acc_asset_categories_org;
--> statement-breakpoint
-- public.acc_system_account_map: leading prefix of uniq_acc_system_account_map_org_id
DROP INDEX IF EXISTS public.idx_acc_system_account_map_org;
--> statement-breakpoint
-- public.acc_tax_payments: leading prefix of uniq_acc_tax_payments_org_type_ref
DROP INDEX IF EXISTS public.idx_acc_tax_payments_org_type;
--> statement-breakpoint
-- public.accounting_dimension_values: leading prefix of uniq_accounting_dim_values_org_dim_code
DROP INDEX IF EXISTS public.idx_accounting_dim_values_org_dim;
--> statement-breakpoint
-- public.ai_credit_transactions: leading prefix of ai_credit_txns_org_created_idx
DROP INDEX IF EXISTS public.ai_credit_txns_org_idx;
--> statement-breakpoint
-- public.alumni_profiles: leading prefix of uniq_alumni_profiles_org_id
DROP INDEX IF EXISTS public.idx_alumni_org;
--> statement-breakpoint
-- public.announcement_reads: leading prefix of idx_announcement_reads_unique
DROP INDEX IF EXISTS public.idx_announcement_reads_announcement;
--> statement-breakpoint
-- public.ap_document_lines: leading prefix of uniq_ap_document_lines_no
DROP INDEX IF EXISTS public.idx_ap_document_lines_document;
--> statement-breakpoint
-- public.app_installations: leading prefix of app_installations_org_app_idx
DROP INDEX IF EXISTS public.app_installations_org_idx;
--> statement-breakpoint
-- public.ar_document_lines: leading prefix of uniq_ar_document_lines_no
DROP INDEX IF EXISTS public.idx_ar_document_lines_document;
--> statement-breakpoint
-- public.audit_logs: leading prefix of idx_audit_logs_org_action
DROP INDEX IF EXISTS public.idx_audit_logs_org_id;
--> statement-breakpoint
-- public.bank_statement_lines: leading prefix of idx_bank_statement_lines_date
DROP INDEX IF EXISTS public.idx_bank_statement_lines_statement;
--> statement-breakpoint
-- public.billing_plan_entitlements: leading prefix of uq_billing_plan_ent_plan_key_from
DROP INDEX IF EXISTS public.idx_billing_plan_ent_plan;
--> statement-breakpoint
-- public.billing_plans: leading prefix of uq_billing_plans_product_slug
DROP INDEX IF EXISTS public.idx_billing_plans_product;
--> statement-breakpoint
-- public.biometric_devices: leading prefix of uniq_biometric_devices_org_id
DROP INDEX IF EXISTS public.idx_biometric_devices_org;
--> statement-breakpoint
-- public.blog_posts: leading prefix of idx_blog_posts_status_published
DROP INDEX IF EXISTS public.idx_blog_posts_status;
--> statement-breakpoint
-- public.broadcast_read_receipts: leading prefix of uniq_broadcast_read_receipts_org_membership_broadcast
DROP INDEX IF EXISTS public.idx_broadcast_read_receipts_admin;
--> statement-breakpoint
-- public.calendar_event_exceptions: leading prefix of uniq_cal_exc_org_event_occ
DROP INDEX IF EXISTS public.idx_cal_exc_org_event;
--> statement-breakpoint
-- public.calendar_source_preferences: leading prefix of uniq_cal_src_pref_org_membership_key
DROP INDEX IF EXISTS public.idx_cal_src_pref_org_membership;
--> statement-breakpoint
-- public.calibration_sessions: leading prefix of idx_hr_actor_4f3228d35c7ad1e7
DROP INDEX IF EXISTS public.idx_calibration_sessions_org;
--> statement-breakpoint
-- public.candidate_documents_vault: leading prefix of idx_hr_actor_eb57cd9003c16d7d
DROP INDEX IF EXISTS public.idx_vault_org;
--> statement-breakpoint
-- public.candidate_messages: leading prefix of idx_hr_actor_01cff965db84045a
DROP INDEX IF EXISTS public.idx_candidate_messages_org;
--> statement-breakpoint
-- public.candidate_offers: leading prefix of idx_candidate_offers_org_status
DROP INDEX IF EXISTS public.idx_candidate_offers_org;
--> statement-breakpoint
-- public.candidate_reference_checks: leading prefix of idx_hr_actor_21686165fe2bb06d
DROP INDEX IF EXISTS public.idx_reference_checks_org;
--> statement-breakpoint
-- public.candidate_referrals: leading prefix of idx_hr_actor_8015b8868774e242
DROP INDEX IF EXISTS public.idx_referrals_org;
--> statement-breakpoint
-- public.candidate_resumes: leading prefix of idx_candidate_resumes_org_candidate
DROP INDEX IF EXISTS public.idx_candidate_resumes_org;
--> statement-breakpoint
-- public.candidate_sla_tracking: leading prefix of uniq_sla_tracking_candidate_stage
DROP INDEX IF EXISTS public.idx_sla_tracking_candidate;
--> statement-breakpoint
-- public.candidate_sources: leading prefix of idx_hr_actor_3f6bed1c407f364a
DROP INDEX IF EXISTS public.idx_candidate_sources_org;
--> statement-breakpoint
-- public.candidates: leading prefix of idx_candidates_org_created
DROP INDEX IF EXISTS public.idx_candidates_org;
--> statement-breakpoint
-- public.career_ladders: leading prefix of uniq_career_ladders_org_id
DROP INDEX IF EXISTS public.idx_career_ladders_org;
--> statement-breakpoint
-- public.chat_attachments: leading prefix of uniq_chat_attachments_org_id
DROP INDEX IF EXISTS public.idx_chat_attachments_org;
--> statement-breakpoint
-- public.chat_channel_invite_links: leading prefix of idx_chat_channel_invite_links_created_by_membership_id
DROP INDEX IF EXISTS public.idx_chat_channel_invite_links_org;
--> statement-breakpoint
-- public.chat_channel_members: leading prefix of idx_chat_channel_members_org_membership
DROP INDEX IF EXISTS public.idx_chat_channel_members_membership_id;
--> statement-breakpoint
-- public.chat_channel_members: leading prefix of idx_chat_channel_members_membership_id
DROP INDEX IF EXISTS public.idx_chat_channel_members_org;
--> statement-breakpoint
-- public.chat_channels: leading prefix of idx_chat_channels_created_by_membership_id
DROP INDEX IF EXISTS public.idx_chat_channels_org;
--> statement-breakpoint
-- public.chat_huddle_participants: leading prefix of idx_chat_huddle_participants_membership_id
DROP INDEX IF EXISTS public.idx_chat_huddle_participants_org;
--> statement-breakpoint
-- public.chat_huddle_participants: leading prefix of uniq_huddle_participant
DROP INDEX IF EXISTS public.idx_huddle_participants_huddle;
--> statement-breakpoint
-- public.chat_huddles: leading prefix of idx_chat_huddles_started_by_membership_id
DROP INDEX IF EXISTS public.idx_chat_huddles_org;
--> statement-breakpoint
-- public.chat_message_reactions: leading prefix of uniq_chat_message_reaction_actor_emoji
DROP INDEX IF EXISTS public.idx_chat_message_reactions_message;
--> statement-breakpoint
-- public.chat_messages: leading prefix of idx_chat_messages_sender_membership_id
DROP INDEX IF EXISTS public.idx_chat_messages_org;
--> statement-breakpoint
-- public.chat_pinned_messages: leading prefix of uniq_chat_pinned_msg
DROP INDEX IF EXISTS public.idx_chat_pinned_channel;
--> statement-breakpoint
-- public.chat_pinned_messages: leading prefix of idx_chat_pinned_messages_pinned_by_membership_id
DROP INDEX IF EXISTS public.idx_chat_pinned_messages_org;
--> statement-breakpoint
-- public.chat_saved_messages: leading prefix of uniq_chat_saved_msg_membership
DROP INDEX IF EXISTS public.idx_chat_saved_messages_membership_id;
--> statement-breakpoint
-- public.chat_saved_messages: leading prefix of idx_chat_saved_messages_membership_id
DROP INDEX IF EXISTS public.idx_chat_saved_messages_org;
--> statement-breakpoint
-- public.client_accounts: leading prefix of idx_client_accounts_lead_party_id
DROP INDEX IF EXISTS public.idx_client_accounts_org;
--> statement-breakpoint
-- public.client_onboarding_items: leading prefix of idx_client_onboarding_items_client_party_id
DROP INDEX IF EXISTS public.idx_onboarding_items_org;
--> statement-breakpoint
-- public.client_onboarding_templates: leading prefix of uniq_client_onboarding_templates_org_id
DROP INDEX IF EXISTS public.idx_client_onboarding_templates_org;
--> statement-breakpoint
-- public.client_opportunities: leading prefix of idx_client_opportunities_client_party_id
DROP INDEX IF EXISTS public.idx_client_opps_org;
--> statement-breakpoint
-- public.contacts: leading prefix of idx_contacts_name_email
DROP INDEX IF EXISTS public.idx_contacts_org;
--> statement-breakpoint
-- public.coupon_redemptions: leading prefix of uq_coupon_redemptions_coupon_org
DROP INDEX IF EXISTS public.idx_coupon_redemptions_coupon;
--> statement-breakpoint
-- public.coupon_redemptions: leading prefix of idx_coupon_redemptions_org_membership
DROP INDEX IF EXISTS public.idx_coupon_redemptions_org;
--> statement-breakpoint
-- public.coupons: leading prefix of coupons_org_id_id_uniq
DROP INDEX IF EXISTS public.idx_coupons_org;
--> statement-breakpoint
-- public.credit_note_items: leading prefix of idx_credit_note_items_org_cn
DROP INDEX IF EXISTS public.idx_credit_note_items_org;
--> statement-breakpoint
-- public.crm_commission_accrual_parts: leading prefix of uniq_crm_commission_accrual_parts_slot
DROP INDEX IF EXISTS public.idx_crm_commission_accrual_parts_earning;
--> statement-breakpoint
-- public.crm_contact_channel_consent: leading prefix of uniq_crm_consent_org_contact_channel
DROP INDEX IF EXISTS public.idx_crm_consent_org_contact;
--> statement-breakpoint
-- public.crm_contact_roles: leading prefix of idx_crm_contact_roles_contact_party_id
DROP INDEX IF EXISTS public.idx_crm_contact_roles_org;
--> statement-breakpoint
-- public.crm_deal_competitors: leading prefix of uniq_crm_deal_competitors_org_id
DROP INDEX IF EXISTS public.idx_crm_deal_competitors_org;
--> statement-breakpoint
-- public.crm_deal_stakeholders: leading prefix of uq_crm_deal_stakeholders_deal_contact
DROP INDEX IF EXISTS public.idx_crm_deal_stakeholders_deal;
--> statement-breakpoint
-- public.crm_email_templates: leading prefix of uniq_crm_email_templates_org_id
DROP INDEX IF EXISTS public.idx_crm_email_templates_org;
--> statement-breakpoint
-- public.crm_organizations: leading prefix of idx_crm_organizations_parent
DROP INDEX IF EXISTS public.idx_crm_organizations_org;
--> statement-breakpoint
-- public.crm_pricebooks: leading prefix of uniq_crm_pricebooks_org_id
DROP INDEX IF EXISTS public.idx_crm_pricebooks_org;
--> statement-breakpoint
-- public.crm_quote_templates: leading prefix of uniq_crm_quote_templates_org_id
DROP INDEX IF EXISTS public.idx_crm_quote_templates_org;
--> statement-breakpoint
-- public.crm_sla_breach_log: leading prefix of crm_sla_breach_log_lead_policy_unique
DROP INDEX IF EXISTS public.idx_sla_breach_lead_idx;
--> statement-breakpoint
-- public.crm_sla_breach_log: leading prefix of uniq_crm_sla_breach_log_org_id
DROP INDEX IF EXISTS public.idx_sla_breach_org_idx;
--> statement-breakpoint
-- public.crm_sla_policies: leading prefix of uniq_crm_sla_policies_org_id
DROP INDEX IF EXISTS public.idx_crm_sla_org;
--> statement-breakpoint
-- public.crm_suppression_hashes: leading prefix of uniq_crm_suppression_org_channel_hash
DROP INDEX IF EXISTS public.idx_crm_suppression_org_channel;
--> statement-breakpoint
-- public.csat_surveys: leading prefix of idx_csat_surveys_client_party_id
DROP INDEX IF EXISTS public.idx_csat_surveys_org;
--> statement-breakpoint
-- public.custom_field_definitions: leading prefix of idx_cfd_org_entity_project_active
DROP INDEX IF EXISTS public.idx_cfd_org_entity;
--> statement-breakpoint
-- public.deal_activities: leading prefix of idx_deal_activities_org_deal_created
DROP INDEX IF EXISTS public.idx_deal_activities_org;
--> statement-breakpoint
-- public.deal_meetings: leading prefix of uniq_deal_meetings_org_id
DROP INDEX IF EXISTS public.idx_deal_meetings_org;
--> statement-breakpoint
-- public.devices: leading prefix of uniq_devices_user_fingerprint
DROP INDEX IF EXISTS public.idx_devices_user;
--> statement-breakpoint
-- public.document_type_roles: leading prefix of uniq_document_type_roles_org_id
DROP INDEX IF EXISTS public.idx_document_type_roles_org;
--> statement-breakpoint
-- public.document_type_roles: leading prefix of uniq_document_type_roles_type_slug
DROP INDEX IF EXISTS public.idx_document_type_roles_type;
--> statement-breakpoint
-- public.document_types: leading prefix of idx_doc_types_org_country
DROP INDEX IF EXISTS public.idx_doc_types_org;
--> statement-breakpoint
-- public.dunning_attempts: leading prefix of uniq_dunning_attempt_cycle_milestone
DROP INDEX IF EXISTS public.idx_dunning_attempts_org_sub_period;
--> statement-breakpoint
-- public.email_sequences: leading prefix of idx_hr_actor_349c68a39a688fa3
DROP INDEX IF EXISTS public.idx_email_sequences_org;
--> statement-breakpoint
-- public.employee_salary_profile_components: leading prefix of uniq_employee_salary_profile_components_org_id
DROP INDEX IF EXISTS public.idx_employee_salary_profile_components_org;
--> statement-breakpoint
-- public.employee_salary_profile_components: leading prefix of uniq_esp_components_profile_component
DROP INDEX IF EXISTS public.idx_employee_salary_profile_components_profile;
--> statement-breakpoint
-- public.employee_shift_assignments: leading prefix of uniq_employee_shift_assignments_org_id
DROP INDEX IF EXISTS public.idx_shift_assignments_org;
--> statement-breakpoint
-- public.event_attendees: leading prefix of event_attendees_event_membership_unique
DROP INDEX IF EXISTS public.idx_event_attendees_org_event;
--> statement-breakpoint
-- public.external_referrals: leading prefix of uniq_external_referrals_org_id
DROP INDEX IF EXISTS public.idx_external_referrals_org;
--> statement-breakpoint
-- public.fin_cash_flow_scenarios: leading prefix of uniq_fin_cash_flow_scenarios_org_id
DROP INDEX IF EXISTS public.idx_fin_cash_flow_scenarios_org;
--> statement-breakpoint
-- public.fin_expense_policies: leading prefix of uniq_fin_expense_policies_org_id
DROP INDEX IF EXISTS public.idx_fin_expense_policies_org;
--> statement-breakpoint
-- public.fin_payment_allocations: leading prefix of uniq_fin_payment_allocations_org_id
DROP INDEX IF EXISTS public.idx_fin_payment_allocations_org;
--> statement-breakpoint
-- public.fin_recurring_bill_templates: leading prefix of idx_fin_recurring_bill_templates_name_id
DROP INDEX IF EXISTS public.idx_fin_recurring_bill_templates_org;
--> statement-breakpoint
-- public.fin_recurring_invoice_templates: leading prefix of idx_fin_recurring_invoice_templates_org_created_id
DROP INDEX IF EXISTS public.idx_fin_recurring_invoice_templates_org;
--> statement-breakpoint
-- public.fin_recurring_journal_templates: leading prefix of idx_fin_recurring_journal_templates_name_id
DROP INDEX IF EXISTS public.idx_fin_recurring_journal_templates_org;
--> statement-breakpoint
-- public.fin_reminder_log: leading prefix of uniq_fin_reminder_log_org_inv_offset
DROP INDEX IF EXISTS public.idx_fin_reminder_log_org_invoice;
--> statement-breakpoint
-- public.fin_reminder_policies: leading prefix of uniq_fin_reminder_policies_org_id
DROP INDEX IF EXISTS public.idx_fin_reminder_policies_org;
--> statement-breakpoint
-- public.fin_vendor_payment_allocations: leading prefix of uniq_fin_vendor_payment_allocations_org_id
DROP INDEX IF EXISTS public.idx_fin_vendor_payment_allocations_org;
--> statement-breakpoint
-- public.gl_journal_lines: leading prefix of uniq_gl_journal_lines_journal_line_no
DROP INDEX IF EXISTS public.idx_gl_journal_lines_journal;
--> statement-breakpoint
-- public.group_role_assignments: leading prefix of uniq_group_role_assignments_group_role
DROP INDEX IF EXISTS public.idx_group_role_assignments_org_group;
--> statement-breakpoint
-- public.handbook_versions: leading prefix of idx_s01_hr_49fe208ec6c3c6bc
DROP INDEX IF EXISTS public.idx_handbook_org;
--> statement-breakpoint
-- public.headcount_requests: leading prefix of idx_hr_actor_4019dc4b4777c1c8
DROP INDEX IF EXISTS public.idx_headcount_requests_org;
--> statement-breakpoint
-- public.hiring_flows: leading prefix of idx_hr_actor_8b89f970abb003f7
DROP INDEX IF EXISTS public.idx_hiring_flows_org;
--> statement-breakpoint
-- public.hr_access_provisioning: leading prefix of idx_hr_acc_prov_status
DROP INDEX IF EXISTS public.idx_hr_acc_prov_org;
--> statement-breakpoint
-- public.hr_access_provisioning_templates: leading prefix of uniq_hr_access_provisioning_templates_org_id
DROP INDEX IF EXISTS public.idx_hr_acc_prov_tmpl_org;
--> statement-breakpoint
-- public.hr_access_requests: leading prefix of uniq_hr_access_requests_org_id
DROP INDEX IF EXISTS public.idx_hr_access_requests_org;
--> statement-breakpoint
-- public.hr_accommodation_requests: leading prefix of idx_s01_hr_c67b5a94eebf54bf
DROP INDEX IF EXISTS public.idx_hr_acc_req_org;
--> statement-breakpoint
-- public.hr_accommodation_tasks: leading prefix of uniq_hr_accommodation_tasks_org_id
DROP INDEX IF EXISTS public.idx_hr_acc_task_org;
--> statement-breakpoint
-- public.hr_audit_logs: leading prefix of idx_hr_audit_logs_org_action
DROP INDEX IF EXISTS public.idx_hr_audit_logs_org;
--> statement-breakpoint
-- public.hr_badges: leading prefix of uniq_badge_org_name
DROP INDEX IF EXISTS public.idx_badges_org;
--> statement-breakpoint
-- public.hr_benefit_enrollments: leading prefix of uniq_hr_benefit_enrollments_org_plan_user
DROP INDEX IF EXISTS public.idx_hr_benefit_enrollments_org_plan;
--> statement-breakpoint
-- public.hr_calibration_entries: leading prefix of uniq_calibration_cycle_employee
DROP INDEX IF EXISTS public.idx_calibration_entries_cycle;
--> statement-breakpoint
-- public.hr_calibration_entries: leading prefix of uniq_hr_calibration_entries_org_id
DROP INDEX IF EXISTS public.idx_calibration_entries_org;
--> statement-breakpoint
-- public.hr_case_notes: leading prefix of idx_hr_case_notes_org_author_membership
DROP INDEX IF EXISTS public.idx_hr_case_notes_org;
--> statement-breakpoint
-- public.hr_communities: leading prefix of idx_hr_actor_0dcb73ed54fc59f3
DROP INDEX IF EXISTS public.idx_communities_org;
--> statement-breakpoint
-- public.hr_community_members: leading prefix of uniq_community_member
DROP INDEX IF EXISTS public.idx_community_members_community;
--> statement-breakpoint
-- public.hr_email_templates: leading prefix of idx_s01_hr_f69b80e736517097
DROP INDEX IF EXISTS public.idx_email_templates_org;
--> statement-breakpoint
-- public.hr_emergency_events: leading prefix of idx_hr_emerg_ev_status
DROP INDEX IF EXISTS public.idx_hr_emerg_ev_org;
--> statement-breakpoint
-- public.hr_employee_sensitive_fields: leading prefix of uniq_hr_employee_sensitive_fields_org_id
DROP INDEX IF EXISTS public.idx_hr_sensitive_org;
--> statement-breakpoint
-- public.hr_employments: leading prefix of idx_hr_employments_org_status
DROP INDEX IF EXISTS public.idx_hr_employments_org;
--> statement-breakpoint
-- public.hr_event_stream: leading prefix of idx_hr_evstream_entity
DROP INDEX IF EXISTS public.idx_hr_evstream_org;
--> statement-breakpoint
-- public.hr_headcount_plans: leading prefix of uniq_hr_headcount_plans_org_id
DROP INDEX IF EXISTS public.idx_hr_headcount_plans_org;
--> statement-breakpoint
-- public.hr_helpdesk_routing: leading prefix of uniq_helpdesk_routing_org_category
DROP INDEX IF EXISTS public.idx_hr_helpdesk_routing_org;
--> statement-breakpoint
-- public.hr_job_levels: leading prefix of uniq_hr_job_levels_org_id
DROP INDEX IF EXISTS public.idx_hr_job_levels_org;
--> statement-breakpoint
-- public.hr_job_roles: leading prefix of uniq_hr_job_roles_org_id
DROP INDEX IF EXISTS public.idx_hr_job_roles_org;
--> statement-breakpoint
-- public.hr_leave_ledger: leading prefix of idx_hr_leave_ledger_user_type_date
DROP INDEX IF EXISTS public.idx_hr_leave_ledger_org_user;
--> statement-breakpoint
-- public.hr_mood_checkins: leading prefix of uniq_mood_org_membership_date
DROP INDEX IF EXISTS public.idx_hr_actor_e4f3eb227c726e23;
--> statement-breakpoint
-- public.hr_people: leading prefix of uniq_hr_people_org_id
DROP INDEX IF EXISTS public.idx_hr_people_org;
--> statement-breakpoint
-- public.hr_poll_votes: leading prefix of uniq_poll_vote_poll_user
DROP INDEX IF EXISTS public.idx_poll_votes_poll;
--> statement-breakpoint
-- public.hr_position_statuses: leading prefix of uniq_hr_position_statuses_org_id
DROP INDEX IF EXISTS public.idx_hr_position_statuses_org;
--> statement-breakpoint
-- public.hr_positions: leading prefix of idx_hr_positions_org_status
DROP INDEX IF EXISTS public.idx_hr_positions_org;
--> statement-breakpoint
-- public.hr_probation_reviews: leading prefix of idx_hr_probation_reviews_status
DROP INDEX IF EXISTS public.idx_hr_probation_reviews_org;
--> statement-breakpoint
-- public.hr_retention_policies: leading prefix of uniq_hr_retention_policies_org_id
DROP INDEX IF EXISTS public.idx_hr_retention_policies_org;
--> statement-breakpoint
-- public.hr_role_skill_requirements: leading prefix of uniq_hr_role_skill_requirements_org_id
DROP INDEX IF EXISTS public.idx_role_skill_req_org;
--> statement-breakpoint
-- public.hr_simulations: leading prefix of idx_hr_sim_type
DROP INDEX IF EXISTS public.idx_hr_sim_org;
--> statement-breakpoint
-- public.hr_succession_plans: leading prefix of idx_hr_actor_1ed64ad625e21ca1
DROP INDEX IF EXISTS public.idx_succession_org;
--> statement-breakpoint
-- public.hr_templates: leading prefix of uniq_hr_templates_org_kind_name_ver
DROP INDEX IF EXISTS public.idx_hr_templates_org_kind;
--> statement-breakpoint
-- public.hr_union_memberships: leading prefix of idx_hr_union_memberships_org_user
DROP INDEX IF EXISTS public.idx_hr_union_memberships_org;
--> statement-breakpoint
-- public.hr_wellness_checkins: leading prefix of uniq_hr_wellness_org_user_date
DROP INDEX IF EXISTS public.idx_hr_wellness_org_user;
--> statement-breakpoint
-- public.hr_workflow_instance_attachments: leading prefix of uniq_hr_wf_inst_attachments_org_id
DROP INDEX IF EXISTS public.idx_hr_wf_inst_attachments_org;
--> statement-breakpoint
-- public.incentives: leading prefix of uniq_incentives_org_id
DROP INDEX IF EXISTS public.idx_incentives_org;
--> statement-breakpoint
-- public.interview_questions: leading prefix of idx_hr_actor_efa07ce389203eee
DROP INDEX IF EXISTS public.idx_interview_questions_org;
--> statement-breakpoint
-- public.interview_scorecards: leading prefix of uniq_scorecard_interview_interviewer
DROP INDEX IF EXISTS public.idx_scorecards_interview;
--> statement-breakpoint
-- public.inv_carriers: leading prefix of uniq_inv_carriers_org_code
DROP INDEX IF EXISTS public.idx_inv_carriers_org;
--> statement-breakpoint
-- public.inv_categories: leading prefix of uniq_inv_categories_org_id
DROP INDEX IF EXISTS public.idx_inv_categories_org;
--> statement-breakpoint
-- public.inv_channel_pools: leading prefix of uniq_inv_channel_pools_grain
DROP INDEX IF EXISTS public.idx_inv_channel_pools_org_channel;
--> statement-breakpoint
-- public.inv_channel_stock_publications: leading prefix of uniq_inv_pub_org_channel_variant
DROP INDEX IF EXISTS public.idx_inv_pub_org_channel;
--> statement-breakpoint
-- public.inv_dock_doors: leading prefix of uniq_inv_dock_doors_org_warehouse_code
DROP INDEX IF EXISTS public.idx_inv_dock_doors_org_warehouse;
--> statement-breakpoint
-- public.inv_landed_cost_allocations: leading prefix of uniq_inv_landed_cost_allocations_voucher_layer
DROP INDEX IF EXISTS public.idx_inv_landed_cost_allocations_org_voucher;
--> statement-breakpoint
-- public.inv_locations: leading prefix of uniq_inv_locations_org_id
DROP INDEX IF EXISTS public.idx_inv_locations_org;
--> statement-breakpoint
-- public.inv_locations: leading prefix of uniq_inv_locations_warehouse_code
DROP INDEX IF EXISTS public.idx_inv_locations_warehouse;
--> statement-breakpoint
-- public.inv_lots: leading prefix of idx_inv_lots_status
DROP INDEX IF EXISTS public.idx_inv_lots_org;
--> statement-breakpoint
-- public.inv_product_uom_conversions: leading prefix of uniq_inv_product_uom_conversions_key
DROP INDEX IF EXISTS public.idx_inv_product_uom_conversions_product;
--> statement-breakpoint
-- public.inv_reorder_rules: leading prefix of uniq_inv_reorder_org_variant_wh
DROP INDEX IF EXISTS public.idx_inv_reorder_org;
--> statement-breakpoint
-- public.inv_serial_numbers: leading prefix of idx_inv_serials_status
DROP INDEX IF EXISTS public.idx_inv_serials_org;
--> statement-breakpoint
-- public.inv_stock_adjustments: leading prefix of idx_inv_adj_org_ref
DROP INDEX IF EXISTS public.idx_inv_adj_org;
--> statement-breakpoint
-- public.inv_stock_levels: leading prefix of uniq_inv_stock_levels_natural_key
DROP INDEX IF EXISTS public.idx_inv_stock_org;
--> statement-breakpoint
-- public.inv_stock_transactions: leading prefix of idx_inv_txn_org_variant_type_created
DROP INDEX IF EXISTS public.idx_inv_txn_org_variant;
--> statement-breakpoint
-- public.inv_uom: leading prefix of uniq_inv_uom_org_id
DROP INDEX IF EXISTS public.idx_inv_uom_org;
--> statement-breakpoint
-- public.inv_user_warehouses: leading prefix of uniq_inv_user_warehouses_key
DROP INDEX IF EXISTS public.idx_inv_user_warehouses_org_user;
--> statement-breakpoint
-- public.inv_valuation_consumptions: leading prefix of uniq_inv_val_consumptions_txn_layer
DROP INDEX IF EXISTS public.idx_inv_val_consumptions_org_txn;
--> statement-breakpoint
-- public.inv_valuation_layers: leading prefix of idx_inv_val_layers_org_variant
DROP INDEX IF EXISTS public.idx_inv_val_layers_remaining;
--> statement-breakpoint
-- public.inv_vendors: leading prefix of idx_inv_vendors_client_party_id
DROP INDEX IF EXISTS public.idx_inv_vendors_org;
--> statement-breakpoint
-- public.inv_warehouses: leading prefix of uniq_inv_warehouses_org_code
DROP INDEX IF EXISTS public.idx_inv_warehouses_org;
--> statement-breakpoint
-- public.inv_webhooks: leading prefix of uniq_inv_webhooks_org_id
DROP INDEX IF EXISTS public.idx_inv_webhooks_org;
--> statement-breakpoint
-- public.job_board_postings: leading prefix of idx_hr_actor_331ec1da58ee61ae
DROP INDEX IF EXISTS public.idx_job_board_postings_org;
--> statement-breakpoint
-- public.job_postings: leading prefix of idx_hr_actor_a459ad4717553e7b
DROP INDEX IF EXISTS public.idx_job_postings_org;
--> statement-breakpoint
-- public.job_recruiters: leading prefix of uq_job_recruiters_job_user
DROP INDEX IF EXISTS public.idx_job_recruiters_job;
--> statement-breakpoint
-- public.journal_entries: leading prefix of uniq_je_idempotency
DROP INDEX IF EXISTS public.idx_je_org_source;
--> statement-breakpoint
-- public.journal_entries: leading prefix of idx_je_org_status_date
DROP INDEX IF EXISTS public.idx_je_org_status;
--> statement-breakpoint
-- public.kb_article_tags: leading prefix of kb_article_tags_pkey
DROP INDEX IF EXISTS public.idx_kb_article_tags_org_article;
--> statement-breakpoint
-- public.kb_articles: leading prefix of idx_kb_articles_org_status_views
DROP INDEX IF EXISTS public.idx_kb_articles_org_status;
--> statement-breakpoint
-- public.kb_chat_conversations: leading prefix of idx_kb_chat_conversations_org_mbr_updated
DROP INDEX IF EXISTS public.idx_kb_chat_conversations_org_mbr;
--> statement-breakpoint
-- public.kb_events: leading prefix of idx_kb_events_org_type_time
DROP INDEX IF EXISTS public.idx_kb_events_org_type;
--> statement-breakpoint
-- public.kb_page_templates: leading prefix of uniq_kb_page_templates_org_id
DROP INDEX IF EXISTS public.idx_kb_page_templates_org;
--> statement-breakpoint
-- public.kb_research_briefs: leading prefix of idx_kb_research_briefs_org_mbr
DROP INDEX IF EXISTS public.idx_kb_research_briefs_org;
--> statement-breakpoint
-- public.kb_sources: leading prefix of idx_kb_sources_org_space
DROP INDEX IF EXISTS public.idx_kb_sources_org;
--> statement-breakpoint
-- public.kb_space_grants: leading prefix of uniq_kb_space_grants
DROP INDEX IF EXISTS public.idx_kb_space_grants_org_space;
--> statement-breakpoint
-- public.kb_spaces: leading prefix of idx_kb_spaces_org_created_by_mbr
DROP INDEX IF EXISTS public.idx_kb_spaces_org;
--> statement-breakpoint
-- public.lead_assignment_rules: leading prefix of uniq_lead_assignment_rules_org_id
DROP INDEX IF EXISTS public.idx_lead_assignment_rules_org;
--> statement-breakpoint
-- public.lead_import_batches: leading prefix of uniq_lead_import_batches_org_id
DROP INDEX IF EXISTS public.idx_lead_batches_org;
--> statement-breakpoint
-- public.lead_scoring_rules: leading prefix of uniq_lead_scoring_rules_org_id
DROP INDEX IF EXISTS public.idx_lead_scoring_rules_org;
--> statement-breakpoint
-- public.learning_paths: leading prefix of uniq_learning_paths_org_id
DROP INDEX IF EXISTS public.idx_learning_paths_org;
--> statement-breakpoint
-- public.leave_balances: leading prefix of idx_leave_balances_org_year_type
DROP INDEX IF EXISTS public.idx_leave_balances_org_year;
--> statement-breakpoint
-- public.module_ownerships: leading prefix of uniq_module_ownerships_org_module
DROP INDEX IF EXISTS public.idx_module_ownerships_org;
--> statement-breakpoint
-- public.module_setup_checklist_items: leading prefix of uq_module_checklist_items_checklist_key
DROP INDEX IF EXISTS public.idx_module_checklist_items_checklist;
--> statement-breakpoint
-- public.notification_audit_logs: leading prefix of idx_notification_audit_logs_parent
DROP INDEX IF EXISTS public.idx_notif_audit_notification;
--> statement-breakpoint
-- public.notification_consents: leading prefix of uniq_notification_consents_current
DROP INDEX IF EXISTS public.idx_notification_consents_org_membership;
--> statement-breakpoint
-- public.notification_deliveries: leading prefix of idx_notification_deliveries_parent
DROP INDEX IF EXISTS public.idx_notification_deliveries_notification;
--> statement-breakpoint
-- public.notification_deliveries: leading prefix of idx_notification_deliveries_membership_channel
DROP INDEX IF EXISTS public.idx_notification_deliveries_org_membership;
--> statement-breakpoint
-- public.notification_policy_defaults: leading prefix of uq_notification_policy_scope
DROP INDEX IF EXISTS public.idx_notification_policy_org_scope;
--> statement-breakpoint
-- public.notification_preference_rules: leading prefix of uniq_notification_pref_rule
DROP INDEX IF EXISTS public.idx_notification_pref_rule_lookup;
--> statement-breakpoint
-- public.notification_preference_rules: leading prefix of idx_notification_pref_rule_lookup
DROP INDEX IF EXISTS public.idx_notification_pref_rules_org_membership;
--> statement-breakpoint
-- public.notification_queue: leading prefix of uniq_notification_queue_org_id
DROP INDEX IF EXISTS public.idx_notification_queue_org;
--> statement-breakpoint
-- public.notification_templates: leading prefix of uniq_notification_templates_org_id
DROP INDEX IF EXISTS public.idx_notification_templates_org;
--> statement-breakpoint
-- public.offer_fulfillment_components: leading prefix of uniq_offer_fulfillment_components_org_offer_sku
DROP INDEX IF EXISTS public.idx_offer_fulfillment_components_offer;
--> statement-breakpoint
-- public.offer_letter_templates: leading prefix of idx_hr_actor_956ee6b0cd235e4f
DROP INDEX IF EXISTS public.idx_offer_letter_templates_org;
--> statement-breakpoint
-- public.onboarding_documents: leading prefix of idx_s01_hr_536bfdf6e3a1e902
DROP INDEX IF EXISTS public.idx_onboarding_docs_org;
--> statement-breakpoint
-- public.onboarding_flow_sessions: leading prefix of idx_onb_flow_sessions_org_membership_type
DROP INDEX IF EXISTS public.idx_onb_flow_sessions_org_membership;
--> statement-breakpoint
-- public.onboarding_templates: leading prefix of idx_s01_hr_596e0055c24ac88d
DROP INDEX IF EXISTS public.idx_onboarding_templates_org;
--> statement-breakpoint
-- public.one_on_one_meetings: leading prefix of uniq_one_on_one_meetings_org_id
DROP INDEX IF EXISTS public.idx_one_on_ones_org;
--> statement-breakpoint
-- public.org_custom_domains: leading prefix of uniq_org_custom_domains_org_id
DROP INDEX IF EXISTS public.idx_org_custom_domains_org;
--> statement-breakpoint
-- public.org_entitlement_overrides: leading prefix of uq_org_ent_overrides_org_key_from
DROP INDEX IF EXISTS public.idx_org_ent_overrides_org_key;
--> statement-breakpoint
-- public.org_modules: leading prefix of org_modules_unique_idx
DROP INDEX IF EXISTS public.org_modules_org_idx;
--> statement-breakpoint
-- public.org_unit_members: leading prefix of uniq_org_unit_members_unit_membership
DROP INDEX IF EXISTS public.idx_org_unit_members_unit;
--> statement-breakpoint
-- public.org_units: leading prefix of uniq_org_units_org_kind_code
DROP INDEX IF EXISTS public.idx_org_units_org_kind;
--> statement-breakpoint
-- public.organization_allowed_email_domains: leading prefix of uniq_org_allowed_domains_org_domain
DROP INDEX IF EXISTS public.idx_org_allowed_domains_org;
--> statement-breakpoint
-- public.organization_people: leading prefix of uniq_org_people_org_person
DROP INDEX IF EXISTS public.idx_org_people_org;
--> statement-breakpoint
-- public.payment_providers: leading prefix of uniq_payment_providers_org_id
DROP INDEX IF EXISTS public.idx_payment_providers_org;
--> statement-breakpoint
-- public.payroll_accounting_mappings: leading prefix of uniq_payroll_accounting_mappings_org_id
DROP INDEX IF EXISTS public.idx_payroll_accounting_mappings_org;
--> statement-breakpoint
-- public.payroll_bank_batch_items: leading prefix of uniq_payroll_bank_batch_items_org_id
DROP INDEX IF EXISTS public.idx_payroll_bank_batch_items_org;
--> statement-breakpoint
-- public.payroll_inputs: leading prefix of uniq_payroll_inputs_run_user
DROP INDEX IF EXISTS public.idx_payroll_inputs_run;
--> statement-breakpoint
-- public.payroll_tax_windows: leading prefix of uniq_payroll_tax_windows_org_id
DROP INDEX IF EXISTS public.idx_payroll_tax_windows_org;
--> statement-breakpoint
-- public.payslip_templates: leading prefix of uniq_payslip_templates_org_id
DROP INDEX IF EXISTS public.idx_payslip_templates_org;
--> statement-breakpoint
-- public.pipeline_automations: leading prefix of idx_hr_actor_50ad17a697e4b235
DROP INDEX IF EXISTS public.idx_pipeline_automations_org;
--> statement-breakpoint
-- public.playbook_entries: leading prefix of uniq_playbook_entries_org_id
DROP INDEX IF EXISTS public.idx_playbook_entries_org;
--> statement-breakpoint
-- public.principal_group_members: leading prefix of uniq_principal_group_members_group_member
DROP INDEX IF EXISTS public.idx_principal_group_members_group;
--> statement-breakpoint
-- public.principal_groups: leading prefix of principal_groups_org_id_id_uniq
DROP INDEX IF EXISTS public.idx_principal_groups_org;
--> statement-breakpoint
-- public.pulse_surveys: leading prefix of idx_hr_actor_fe997934f8c669cb
DROP INDEX IF EXISTS public.idx_surveys_org;
--> statement-breakpoint
-- public.recognitions: leading prefix of idx_hr_actor_8c58a8f7caea6fd4
DROP INDEX IF EXISTS public.idx_recognitions_org;
--> statement-breakpoint
-- public.recruiter_activity_log: leading prefix of uniq_recruiter_activity_log_org_id
DROP INDEX IF EXISTS public.idx_recruiter_activity_org;
--> statement-breakpoint
-- public.recruitment_vendors: leading prefix of idx_hr_actor_2b4ae5046354212b
DROP INDEX IF EXISTS public.idx_recruitment_vendors_org;
--> statement-breakpoint
-- public.reimbursements: leading prefix of idx_reimbursements_org_approved_actor
DROP INDEX IF EXISTS public.idx_reimbursements_org;
--> statement-breakpoint
-- public.relationship_participants: leading prefix of uniq_relationship_participants_identity
DROP INDEX IF EXISTS public.idx_relationship_participants_state;
--> statement-breakpoint
-- public.relationship_threads: leading prefix of uniq_relationship_threads_thread
DROP INDEX IF EXISTS public.idx_relationship_threads_state;
--> statement-breakpoint
-- public.resignations: leading prefix of idx_resignations_org_user_membership
DROP INDEX IF EXISTS public.idx_resignations_org;
--> statement-breakpoint
-- public.resource_grants: leading prefix of uniq_resource_grants_principal
DROP INDEX IF EXISTS public.idx_resource_grants_resource;
--> statement-breakpoint
-- public.revenue_events: leading prefix of uniq_revenue_events_org_id
DROP INDEX IF EXISTS public.revenue_events_org_idx;
--> statement-breakpoint
-- public.review_cycles: leading prefix of idx_hr_actor_6ae81e8eecd6e612
DROP INDEX IF EXISTS public.idx_review_cycles_org;
--> statement-breakpoint
-- public.rich_documents: leading prefix of idx_rich_documents_org_updated
DROP INDEX IF EXISTS public.idx_rich_documents_org;
--> statement-breakpoint
-- public.role_assignments: leading prefix of uniq_role_assignments_org_membership_role
DROP INDEX IF EXISTS public.idx_role_assignments_org_membership;
--> statement-breakpoint
-- public.role_permission_grants: leading prefix of uniq_role_permission_grants_role_key
DROP INDEX IF EXISTS public.idx_role_permission_grants_org_role;
--> statement-breakpoint
-- public.roles: leading prefix of idx_roles_org_module_name_id
DROP INDEX IF EXISTS public.idx_roles_org_module;
--> statement-breakpoint
-- public.salary_loans: leading prefix of idx_salary_loans_org_user_actor
DROP INDEX IF EXISTS public.idx_loans_org;
--> statement-breakpoint
-- public.salary_structure_templates: leading prefix of idx_salary_structure_templates_org_active
DROP INDEX IF EXISTS public.idx_salary_structure_templates_org;
--> statement-breakpoint
-- public.scheduled_reports: leading prefix of uniq_scheduled_reports_org_id
DROP INDEX IF EXISTS public.idx_scheduled_reports_org;
--> statement-breakpoint
-- public.scorecard_templates: leading prefix of idx_hr_actor_920b32d217c60f43
DROP INDEX IF EXISTS public.idx_scorecard_templates_org;
--> statement-breakpoint
-- public.skill_assessments: leading prefix of idx_hr_actor_151ed356e6ac7b7b
DROP INDEX IF EXISTS public.idx_skill_assessments_org;
--> statement-breakpoint
-- public.subscription_payments: leading prefix of uniq_subscription_payments_org_id
DROP INDEX IF EXISTS public.idx_sub_payments_org;
--> statement-breakpoint
-- public.subscriptions: leading prefix of uniq_subscriptions_org_id
DROP INDEX IF EXISTS public.idx_subscriptions_org;
--> statement-breakpoint
-- public.support_agent_skills: leading prefix of uniq_support_agent_skills_org_membership_skill
DROP INDEX IF EXISTS public.idx_support_agent_skills_org_user_actor;
--> statement-breakpoint
-- public.support_business_hours: leading prefix of uniq_support_business_hours_org_id
DROP INDEX IF EXISTS public.idx_support_business_hours_org;
--> statement-breakpoint
-- public.support_channels: leading prefix of uniq_support_channels_org_type_name
DROP INDEX IF EXISTS public.idx_support_channels_org_type;
--> statement-breakpoint
-- public.support_csat_requests: leading prefix of uniq_support_csat_requests_org_id
DROP INDEX IF EXISTS public.idx_support_csat_requests_org;
--> statement-breakpoint
-- public.support_knowledge_gaps: leading prefix of idx_support_knowledge_gaps_org_status_created
DROP INDEX IF EXISTS public.idx_support_knowledge_gaps_org;
--> statement-breakpoint
-- public.support_macros: leading prefix of idx_support_macros_org_created_actor
DROP INDEX IF EXISTS public.idx_support_macros_org;
--> statement-breakpoint
-- public.support_message_mentions: leading prefix of uniq_support_message_mentions_message_membership
DROP INDEX IF EXISTS public.idx_support_message_mentions_message;
--> statement-breakpoint
-- public.support_ticket_attachments: leading prefix of uniq_support_ticket_attachments_org_id
DROP INDEX IF EXISTS public.idx_support_ticket_attachments_org;
--> statement-breakpoint
-- public.support_ticket_embeddings: leading prefix of uniq_support_ticket_embeddings_org_id
DROP INDEX IF EXISTS public.idx_support_ticket_embeddings_org;
--> statement-breakpoint
-- public.survey_versions: leading prefix of uq_survey_versions_survey_number
DROP INDEX IF EXISTS public.idx_survey_versions_survey;
--> statement-breakpoint
-- public.talent_pool_members: leading prefix of uq_talent_pool_members_pool_candidate
DROP INDEX IF EXISTS public.idx_talent_pool_members_pool;
--> statement-breakpoint
-- public.talent_pools: leading prefix of idx_hr_actor_c19d1de41b65926b
DROP INDEX IF EXISTS public.idx_talent_pools_org;
--> statement-breakpoint
-- public.tasks: leading prefix of uniq_tasks_org_id
DROP INDEX IF EXISTS public.idx_tasks_org;
--> statement-breakpoint
-- public.tax_gl_map: leading prefix of uniq_tax_gl_map_book_role_component
DROP INDEX IF EXISTS public.idx_tax_gl_map_book;
--> statement-breakpoint
-- public.team_events: leading prefix of idx_s01_hr_b8e8915b6ca9a901
DROP INDEX IF EXISTS public.idx_team_events_org;
--> statement-breakpoint
-- public.terminations: leading prefix of idx_s01_hr_12b5f6498309c431
DROP INDEX IF EXISTS public.idx_terminations_org;
--> statement-breakpoint
-- public.territories: leading prefix of uniq_territories_org_id
DROP INDEX IF EXISTS public.territories_org_id_idx;
--> statement-breakpoint
-- public.territory_locations: leading prefix of uniq_territory_locations_territory_kind_value
DROP INDEX IF EXISTS public.idx_territory_locations_territory;
--> statement-breakpoint
-- public.territory_reps: leading prefix of uniq_territory_reps_org_id
DROP INDEX IF EXISTS public.idx_territory_reps_org;
--> statement-breakpoint
-- public.territory_reps: leading prefix of uniq_territory_reps_territory_person
DROP INDEX IF EXISTS public.idx_territory_reps_territory;
--> statement-breakpoint
-- public.timesheet_audit_events: leading prefix of idx_ts_audit_org_created_id
DROP INDEX IF EXISTS public.idx_timesheet_audit_events_org_created;
--> statement-breakpoint
-- public.timesheet_exports: leading prefix of idx_ts_exports_org_created_id
DROP INDEX IF EXISTS public.idx_timesheet_exports_org_created;
--> statement-breakpoint
-- public.timesheet_periods: leading prefix of idx_ts_periods_org_status_submitted
DROP INDEX IF EXISTS public.idx_timesheet_periods_org_status;
--> statement-breakpoint
-- public.timesheet_periods: leading prefix of uniq_timesheet_periods_user_membership_range
DROP INDEX IF EXISTS public.idx_timesheet_periods_user_membership_start;
--> statement-breakpoint
-- public.timesheet_rate_cards: leading prefix of uniq_timesheet_rate_cards_org_id
DROP INDEX IF EXISTS public.idx_timesheet_rate_cards_org;
--> statement-breakpoint
-- public.timesheets: leading prefix of idx_timesheets_org_status_date
DROP INDEX IF EXISTS public.idx_timesheets_org_status;
--> statement-breakpoint
-- public.user_module_access: leading prefix of uniq_user_module_access_org_membership_module
DROP INDEX IF EXISTS public.idx_user_module_access_org_membership;
--> statement-breakpoint
-- public.user_permission_grants: leading prefix of uniq_user_permission_grants_membership_key
DROP INDEX IF EXISTS public.idx_user_permission_grants_org_membership;
--> statement-breakpoint
-- public.user_tour_progress: leading prefix of uq_user_tour_progress_org_membership_tour
DROP INDEX IF EXISTS public.idx_user_tour_progress_org_membership;
--> statement-breakpoint
-- public.vendor_credit_items: leading prefix of idx_vendor_credit_items_org_vc
DROP INDEX IF EXISTS public.idx_vendor_credit_items_org;
--> statement-breakpoint
-- public.web_lead_forms: leading prefix of uniq_web_lead_forms_org_id
DROP INDEX IF EXISTS public.web_lead_forms_org_id_idx;
--> statement-breakpoint
-- public.webhook_endpoints: leading prefix of uniq_webhook_endpoints_org_id
DROP INDEX IF EXISTS public.idx_webhook_endpoints_org;
--> statement-breakpoint
-- public.worker_engagements: leading prefix of idx_worker_engagements_org_starts
DROP INDEX IF EXISTS public.idx_worker_engagements_org;
--> statement-breakpoint
-- public.workers: leading prefix of idx_workers_org_status
DROP INDEX IF EXISTS public.idx_workers_org;
--> statement-breakpoint
-- public.workflow_audit_logs: leading prefix of idx_workflow_audit_logs_org_created
DROP INDEX IF EXISTS public.idx_workflow_audit_logs_org;
--> statement-breakpoint
-- public.workflow_execution_steps: leading prefix of idx_workflow_execution_steps_execution_node
DROP INDEX IF EXISTS public.idx_workflow_execution_steps_execution;
--> statement-breakpoint
-- public.workflow_executions: leading prefix of idx_workflow_executions_org_created
DROP INDEX IF EXISTS public.idx_workflow_executions_org;
--> statement-breakpoint
-- public.workflow_secrets: leading prefix of uniq_workflow_secrets_org_id
DROP INDEX IF EXISTS public.idx_workflow_secrets_org;
--> statement-breakpoint
-- public.workflow_versions: leading prefix of idx_workflow_versions_workflow_version
DROP INDEX IF EXISTS public.idx_workflow_versions_workflow;
--> statement-breakpoint
-- public.workflows: leading prefix of idx_workflows_org_status
DROP INDEX IF EXISTS public.idx_workflows_org;
