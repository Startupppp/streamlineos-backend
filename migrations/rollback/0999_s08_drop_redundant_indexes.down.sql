-- 0999 DOWN -- recreates the 337 redundant indexes from the definitions they
-- carried in the catalog before the drop, so a structural comparison against a database
-- that never ran 0999 comes back identical.

SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bugs_org_assignee_membership ON build.bugs USING btree (org_id, assignee_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_feedbucket_submissions_org_assignee_membership ON build.feedbucket_submissions USING btree (org_id, assignee_membership_id) WHERE (deleted_at IS NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_workspace_members_org_membership ON build.project_workspace_members USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_projects_org_manager_membership ON build.projects USING btree (org_id, manager_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS affiliates_code_idx ON public.affiliates USING btree (referral_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS affiliates_user_idx ON public.affiliates USING btree (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_billing_products_slug ON public.billing_products USING btree (slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS billing_profiles_org_idx ON public.billing_profiles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_blog_categories_slug ON public.blog_categories USING btree (slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_import_rows_import ON public.crm_import_rows USING btree (organization_id, crm_import_id, row_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_data_quality_health_snapshots_series ON public.data_quality_health_snapshots USING btree (organization_id, captured_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_employee_salary_profiles_org_user_effective ON public.employee_salary_profiles USING btree (org_id, user_id, effective_from);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_feature_flags_key ON public.feature_flags USING btree (key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_payment_run_items_org_run_status ON public.fin_payment_run_items USING btree (org_id, run_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_health_score_config_org ON public.health_score_config USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_s01_hr_a36b1c9397e2b19b ON public.hr_case_notes USING btree (org_id, author_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_document_tags_parent ON public.hr_document_tags USING btree (organization_id, document_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_sensitive_disciplinary_parent ON public.hr_employee_sensitive_disciplinary_records USING btree (organization_id, sensitive_fields_id, source_ordinal);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_sensitive_grievance_parent ON public.hr_employee_sensitive_grievance_records USING btree (organization_id, sensitive_fields_id, source_ordinal);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_s01_hr_c32c5f12eb6efc88 ON public.hr_insurance_claims USING btree (org_id, decided_by_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mood_checkins_org_user_membership ON public.hr_mood_checkins USING btree (org_id, user_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_wf_delegations_org_delegator_membership ON public.hr_workflow_delegations USING btree (org_id, delegator_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_wf_delegations_org_delegate_membership ON public.hr_workflow_delegations USING btree (org_id, delegate_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_wf_actions_org_acted_by_membership ON public.hr_workflow_step_actions USING btree (org_id, acted_by_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_booking_links_token ON public.interview_booking_links USING btree (token);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_inv_product_uom_conversions_org_product_uom ON public.inv_product_uom_conversions USING btree (org_id, product_id, uom_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_settings_org ON public.inv_settings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_standard_costs_lookup ON public.inv_standard_costs USING btree (org_id, product_variant_id, effective_from);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_preferences_org_membership ON public.notification_preferences USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_queue_delivery ON public.notification_queue USING btree (delivery_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onboarding_task_dependencies_task ON public.onboarding_task_dependencies USING btree (organization_id, onboarding_task_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_ai_credits_org_idx ON public.org_ai_credits USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_reviews_org_reviewer_membership ON public.performance_reviews USING btree (org_id, reviewer_membership_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_portal_invitations_org_invitation ON public.portal_invitations USING btree (organization_id, portal_invitation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_client_grants_org_grant ON public.project_client_grants USING btree (organization_id, project_client_grant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recognitions_org_from_membership ON public.recognitions USING btree (org_id, from_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recognitions_org_to_membership ON public.recognitions USING btree (org_id, to_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_agent_avail_org_user_actor ON public.support_agent_availability USING btree (org_id, user_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_termination_reasons_parent ON public.termination_reasons USING btree (organization_id, termination_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_termination_supporting_documents_parent ON public.termination_supporting_documents USING btree (organization_id, termination_id, sort_order);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users USING btree (email);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS web_lead_forms_token_idx ON public.web_lead_forms USING btree (public_token);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_worker_engagements_org_engagement ON public.worker_engagements USING btree (organization_id, worker_engagement_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comment_drafts_org_member_membership ON build.comment_drafts USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_git_connections_org ON build.git_connections USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_git_ticket_links_ticket ON build.git_ticket_links USING btree (ticket_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_modules_org ON build.modules USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_okr_links_goal ON build.okr_links USING btree (goal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pages_org ON build.pages USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pm_ws_members_org_ws ON build.pm_workspace_memberships USING btree (org_id, pm_workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_approvals_org_approver_membership ON build.project_approvals USING btree (org_id, approver_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_automations_org_id ON build.project_automations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_team_assignments_org ON build.project_team_assignments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_team_assignments_project ON build.project_team_assignments USING btree (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_team_members_org ON build.project_team_members USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_views_org ON build.project_views USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_webhooks_org_id ON build.project_webhooks USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_workspace_members_org ON build.project_workspace_members USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_release_tickets_release ON build.release_tickets USING btree (release_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ticket_assignees_org_member_membership ON build.ticket_assignees USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ticket_comment_mentions_comment ON build.ticket_comment_mentions USING btree (comment_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment_id ON build.ticket_comment_reactions USING btree (comment_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ticket_custom_field_values_ticket ON build.ticket_custom_field_values USING btree (ticket_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tickets_org_assignee_membership ON build.tickets USING btree (org_id, assignee_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_work_item_relations_item ON build.work_item_relations USING btree (work_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_acc_asset_categories_org ON public.acc_asset_categories USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_acc_system_account_map_org ON public.acc_system_account_map USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_acc_tax_payments_org_type ON public.acc_tax_payments USING btree (org_id, tax_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_accounting_dim_values_org_dim ON public.accounting_dimension_values USING btree (org_id, dimension_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ai_credit_txns_org_idx ON public.ai_credit_transactions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alumni_org ON public.alumni_profiles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_announcement_reads_announcement ON public.announcement_reads USING btree (announcement_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_document_lines_document ON public.ap_document_lines USING btree (document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS app_installations_org_idx ON public.app_installations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_document_lines_document ON public.ar_document_lines USING btree (document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_id ON public.audit_logs USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_statement_lines_statement ON public.bank_statement_lines USING btree (statement_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_billing_plan_ent_plan ON public.billing_plan_entitlements USING btree (plan_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_billing_plans_product ON public.billing_plans USING btree (product_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_biometric_devices_org ON public.biometric_devices USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON public.blog_posts USING btree (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_broadcast_read_receipts_admin ON public.broadcast_read_receipts USING btree (org_id, broadcast_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cal_exc_org_event ON public.calendar_event_exceptions USING btree (org_id, event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cal_src_pref_org_membership ON public.calendar_source_preferences USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_calibration_sessions_org ON public.calibration_sessions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vault_org ON public.candidate_documents_vault USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidate_messages_org ON public.candidate_messages USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidate_offers_org ON public.candidate_offers USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reference_checks_org ON public.candidate_reference_checks USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_referrals_org ON public.candidate_referrals USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidate_resumes_org ON public.candidate_resumes USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sla_tracking_candidate ON public.candidate_sla_tracking USING btree (candidate_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidate_sources_org ON public.candidate_sources USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidates_org ON public.candidates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_career_ladders_org ON public.career_ladders USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_attachments_org ON public.chat_attachments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_channel_invite_links_org ON public.chat_channel_invite_links USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_channel_members_membership_id ON public.chat_channel_members USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_channel_members_org ON public.chat_channel_members USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_channels_org ON public.chat_channels USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_huddle_participants_org ON public.chat_huddle_participants USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_huddle_participants_huddle ON public.chat_huddle_participants USING btree (huddle_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_huddles_org ON public.chat_huddles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_message ON public.chat_message_reactions USING btree (org_id, message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_messages_org ON public.chat_messages USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_pinned_channel ON public.chat_pinned_messages USING btree (channel_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_pinned_messages_org ON public.chat_pinned_messages USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_saved_messages_membership_id ON public.chat_saved_messages USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_saved_messages_org ON public.chat_saved_messages USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_accounts_org ON public.client_accounts USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onboarding_items_org ON public.client_onboarding_items USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_onboarding_templates_org ON public.client_onboarding_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_client_opps_org ON public.client_opportunities USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contacts_org ON public.contacts USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON public.coupon_redemptions USING btree (coupon_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_org ON public.coupon_redemptions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coupons_org ON public.coupons USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_credit_note_items_org ON public.credit_note_items USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_commission_accrual_parts_earning ON public.crm_commission_accrual_parts USING btree (org_id, earning_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_consent_org_contact ON public.crm_contact_channel_consent USING btree (org_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_contact_roles_org ON public.crm_contact_roles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_deal_competitors_org ON public.crm_deal_competitors USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_deal_stakeholders_deal ON public.crm_deal_stakeholders USING btree (org_id, deal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_email_templates_org ON public.crm_email_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_organizations_org ON public.crm_organizations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_pricebooks_org ON public.crm_pricebooks USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_quote_templates_org ON public.crm_quote_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sla_breach_lead_idx ON public.crm_sla_breach_log USING btree (lead_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sla_breach_org_idx ON public.crm_sla_breach_log USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_sla_org ON public.crm_sla_policies USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_suppression_org_channel ON public.crm_suppression_hashes USING btree (org_id, channel);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_csat_surveys_org ON public.csat_surveys USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cfd_org_entity ON public.custom_field_definitions USING btree (org_id, entity_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_activities_org ON public.deal_activities USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_deal_meetings_org ON public.deal_meetings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_devices_user ON public.devices USING btree (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_document_type_roles_org ON public.document_type_roles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_document_type_roles_type ON public.document_type_roles USING btree (document_type_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_doc_types_org ON public.document_types USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dunning_attempts_org_sub_period ON public.dunning_attempts USING btree (org_id, subscription_id, period_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_email_sequences_org ON public.email_sequences USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_employee_salary_profile_components_org ON public.employee_salary_profile_components USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_employee_salary_profile_components_profile ON public.employee_salary_profile_components USING btree (profile_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_shift_assignments_org ON public.employee_shift_assignments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_event_attendees_org_event ON public.event_attendees USING btree (org_id, event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_external_referrals_org ON public.external_referrals USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_cash_flow_scenarios_org ON public.fin_cash_flow_scenarios USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_expense_policies_org ON public.fin_expense_policies USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_payment_allocations_org ON public.fin_payment_allocations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_recurring_bill_templates_org ON public.fin_recurring_bill_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_recurring_invoice_templates_org ON public.fin_recurring_invoice_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_recurring_journal_templates_org ON public.fin_recurring_journal_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_reminder_log_org_invoice ON public.fin_reminder_log USING btree (org_id, invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_reminder_policies_org ON public.fin_reminder_policies USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fin_vendor_payment_allocations_org ON public.fin_vendor_payment_allocations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gl_journal_lines_journal ON public.gl_journal_lines USING btree (journal_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_group_role_assignments_org_group ON public.group_role_assignments USING btree (org_id, principal_group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_handbook_org ON public.handbook_versions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_headcount_requests_org ON public.headcount_requests USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hiring_flows_org ON public.hiring_flows USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_acc_prov_org ON public.hr_access_provisioning USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_acc_prov_tmpl_org ON public.hr_access_provisioning_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_access_requests_org ON public.hr_access_requests USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_acc_req_org ON public.hr_accommodation_requests USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_acc_task_org ON public.hr_accommodation_tasks USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_audit_logs_org ON public.hr_audit_logs USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_badges_org ON public.hr_badges USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_benefit_enrollments_org_plan ON public.hr_benefit_enrollments USING btree (org_id, plan_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_calibration_entries_cycle ON public.hr_calibration_entries USING btree (cycle_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_calibration_entries_org ON public.hr_calibration_entries USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_case_notes_org ON public.hr_case_notes USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_communities_org ON public.hr_communities USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_community_members_community ON public.hr_community_members USING btree (community_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_email_templates_org ON public.hr_email_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_emerg_ev_org ON public.hr_emergency_events USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_sensitive_org ON public.hr_employee_sensitive_fields USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_employments_org ON public.hr_employments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_evstream_org ON public.hr_event_stream USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_headcount_plans_org ON public.hr_headcount_plans USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_helpdesk_routing_org ON public.hr_helpdesk_routing USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_job_levels_org ON public.hr_job_levels USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_job_roles_org ON public.hr_job_roles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_leave_ledger_org_user ON public.hr_leave_ledger USING btree (org_id, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_actor_e4f3eb227c726e23 ON public.hr_mood_checkins USING btree (org_id, user_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_people_org ON public.hr_people USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON public.hr_poll_votes USING btree (poll_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_position_statuses_org ON public.hr_position_statuses USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_positions_org ON public.hr_positions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_probation_reviews_org ON public.hr_probation_reviews USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_retention_policies_org ON public.hr_retention_policies USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_role_skill_req_org ON public.hr_role_skill_requirements USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_sim_org ON public.hr_simulations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_succession_org ON public.hr_succession_plans USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_templates_org_kind ON public.hr_templates USING btree (org_id, kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_union_memberships_org ON public.hr_union_memberships USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_wellness_org_user ON public.hr_wellness_checkins USING btree (org_id, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_wf_inst_attachments_org ON public.hr_workflow_instance_attachments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_incentives_org ON public.incentives USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_interview_questions_org ON public.interview_questions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scorecards_interview ON public.interview_scorecards USING btree (interview_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_carriers_org ON public.inv_carriers USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_categories_org ON public.inv_categories USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_channel_pools_org_channel ON public.inv_channel_pools USING btree (org_id, channel_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_pub_org_channel ON public.inv_channel_stock_publications USING btree (org_id, channel_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_dock_doors_org_warehouse ON public.inv_dock_doors USING btree (org_id, warehouse_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_landed_cost_allocations_org_voucher ON public.inv_landed_cost_allocations USING btree (org_id, voucher_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_locations_org ON public.inv_locations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_locations_warehouse ON public.inv_locations USING btree (warehouse_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_lots_org ON public.inv_lots USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_product_uom_conversions_product ON public.inv_product_uom_conversions USING btree (org_id, product_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_reorder_org ON public.inv_reorder_rules USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_serials_org ON public.inv_serial_numbers USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_adj_org ON public.inv_stock_adjustments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_stock_org ON public.inv_stock_levels USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_txn_org_variant ON public.inv_stock_transactions USING btree (org_id, product_variant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_uom_org ON public.inv_uom USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_user_warehouses_org_user ON public.inv_user_warehouses USING btree (org_id, user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_val_consumptions_org_txn ON public.inv_valuation_consumptions USING btree (org_id, stock_transaction_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_val_layers_remaining ON public.inv_valuation_layers USING btree (org_id, product_variant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_vendors_org ON public.inv_vendors USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_warehouses_org ON public.inv_warehouses USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_webhooks_org ON public.inv_webhooks USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_job_board_postings_org ON public.job_board_postings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_job_postings_org ON public.job_postings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_job_recruiters_job ON public.job_recruiters USING btree (job_posting_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_je_org_source ON public.journal_entries USING btree (org_id, source_type, source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_je_org_status ON public.journal_entries USING btree (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_article_tags_org_article ON public.kb_article_tags USING btree (org_id, article_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_articles_org_status ON public.kb_articles USING btree (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_chat_conversations_org_mbr ON public.kb_chat_conversations USING btree (org_id, user_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_events_org_type ON public.kb_events USING btree (org_id, event_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_page_templates_org ON public.kb_page_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_research_briefs_org ON public.kb_research_briefs USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_sources_org ON public.kb_sources USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_space_grants_org_space ON public.kb_space_grants USING btree (org_id, space_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_spaces_org ON public.kb_spaces USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_assignment_rules_org ON public.lead_assignment_rules USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_batches_org ON public.lead_import_batches USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lead_scoring_rules_org ON public.lead_scoring_rules USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_learning_paths_org ON public.learning_paths USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_balances_org_year ON public.leave_balances USING btree (org_id, year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_module_ownerships_org ON public.module_ownerships USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_module_checklist_items_checklist ON public.module_setup_checklist_items USING btree (checklist_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notif_audit_notification ON public.notification_audit_logs USING btree (notification_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_consents_org_membership ON public.notification_consents USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification ON public.notification_deliveries USING btree (notification_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_org_membership ON public.notification_deliveries USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_policy_org_scope ON public.notification_policy_defaults USING btree (org_id, scope_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_pref_rule_lookup ON public.notification_preference_rules USING btree (org_id, membership_id, scope_type, scope_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_pref_rules_org_membership ON public.notification_preference_rules USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_queue_org ON public.notification_queue USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_templates_org ON public.notification_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_offer_fulfillment_components_offer ON public.offer_fulfillment_components USING btree (org_id, crm_offer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_offer_letter_templates_org ON public.offer_letter_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onboarding_docs_org ON public.onboarding_documents USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onb_flow_sessions_org_membership ON public.onboarding_flow_sessions USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onboarding_templates_org ON public.onboarding_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_one_on_ones_org ON public.one_on_one_meetings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_org_custom_domains_org ON public.org_custom_domains USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_org_ent_overrides_org_key ON public.org_entitlement_overrides USING btree (org_id, feature_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_modules_org_idx ON public.org_modules USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_org_unit_members_unit ON public.org_unit_members USING btree (org_unit_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_org_units_org_kind ON public.org_units USING btree (org_id, kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_org_allowed_domains_org ON public.organization_allowed_email_domains USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_org_people_org ON public.organization_people USING btree (organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payment_providers_org ON public.payment_providers USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payroll_accounting_mappings_org ON public.payroll_accounting_mappings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payroll_bank_batch_items_org ON public.payroll_bank_batch_items USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payroll_inputs_run ON public.payroll_inputs USING btree (run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payroll_tax_windows_org ON public.payroll_tax_windows USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_payslip_templates_org ON public.payslip_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pipeline_automations_org ON public.pipeline_automations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_playbook_entries_org ON public.playbook_entries USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_principal_group_members_group ON public.principal_group_members USING btree (principal_group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_principal_groups_org ON public.principal_groups USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_surveys_org ON public.pulse_surveys USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recognitions_org ON public.recognitions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recruiter_activity_org ON public.recruiter_activity_log USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recruitment_vendors_org ON public.recruitment_vendors USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reimbursements_org ON public.reimbursements USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_participants_state ON public.relationship_participants USING btree (organization_id, relationship_state_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_relationship_threads_state ON public.relationship_threads USING btree (organization_id, relationship_state_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_resignations_org ON public.resignations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_resource_grants_resource ON public.resource_grants USING btree (org_id, resource_type, resource_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS revenue_events_org_idx ON public.revenue_events USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_review_cycles_org ON public.review_cycles USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rich_documents_org ON public.rich_documents USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_role_assignments_org_membership ON public.role_assignments USING btree (org_id, organization_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_role_permission_grants_org_role ON public.role_permission_grants USING btree (org_id, role_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_roles_org_module ON public.roles USING btree (org_id, module_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_loans_org ON public.salary_loans USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_salary_structure_templates_org ON public.salary_structure_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_org ON public.scheduled_reports USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scorecard_templates_org ON public.scorecard_templates USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_skill_assessments_org ON public.skill_assessments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sub_payments_org ON public.subscription_payments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON public.subscriptions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_agent_skills_org_user_actor ON public.support_agent_skills USING btree (org_id, user_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_business_hours_org ON public.support_business_hours USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_channels_org_type ON public.support_channels USING btree (org_id, type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_csat_requests_org ON public.support_csat_requests USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_knowledge_gaps_org ON public.support_knowledge_gaps USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_macros_org ON public.support_macros USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_message_mentions_message ON public.support_message_mentions USING btree (message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_ticket_attachments_org ON public.support_ticket_attachments USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_support_ticket_embeddings_org ON public.support_ticket_embeddings USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_survey_versions_survey ON public.survey_versions USING btree (survey_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_talent_pool_members_pool ON public.talent_pool_members USING btree (pool_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_talent_pools_org ON public.talent_pools USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_org ON public.tasks USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_gl_map_book ON public.tax_gl_map USING btree (book_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_team_events_org ON public.team_events USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_terminations_org ON public.terminations USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS territories_org_id_idx ON public.territories USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_territory_locations_territory ON public.territory_locations USING btree (territory_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_territory_reps_org ON public.territory_reps USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_territory_reps_territory ON public.territory_reps USING btree (territory_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_audit_events_org_created ON public.timesheet_audit_events USING btree (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_exports_org_created ON public.timesheet_exports USING btree (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_periods_org_status ON public.timesheet_periods USING btree (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_periods_user_membership_start ON public.timesheet_periods USING btree (org_id, user_membership_id, period_start);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheet_rate_cards_org ON public.timesheet_rate_cards USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_timesheets_org_status ON public.timesheets USING btree (org_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_module_access_org_membership ON public.user_module_access USING btree (org_id, organization_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_permission_grants_org_membership ON public.user_permission_grants USING btree (org_id, organization_membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_tour_progress_org_membership ON public.user_tour_progress USING btree (org_id, membership_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_credit_items_org ON public.vendor_credit_items USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS web_lead_forms_org_id_idx ON public.web_lead_forms USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org ON public.webhook_endpoints USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_worker_engagements_org ON public.worker_engagements USING btree (organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workers_org ON public.workers USING btree (organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_audit_logs_org ON public.workflow_audit_logs USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_execution_steps_execution ON public.workflow_execution_steps USING btree (execution_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_executions_org ON public.workflow_executions USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_secrets_org ON public.workflow_secrets USING btree (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow ON public.workflow_versions USING btree (workflow_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflows_org ON public.workflows USING btree (org_id);
