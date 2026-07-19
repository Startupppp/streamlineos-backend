CREATE TYPE "public"."account_type" AS ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');--> statement-breakpoint
CREATE TYPE "public"."ack_status" AS ENUM('PENDING', 'ACKNOWLEDGED', 'DECLINED');--> statement-breakpoint
CREATE TYPE "public"."affiliate_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."ai_credit_reservation_status" AS ENUM('RESERVED', 'SETTLED', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."ai_credit_txn_type" AS ENUM('PURCHASE', 'USAGE', 'REFUND', 'PLAN_GRANT', 'EXPIRY');--> statement-breakpoint
CREATE TYPE "public"."app_install_status" AS ENUM('TRIALING', 'ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('APPLIED', 'SHORTLISTED', 'INTERVIEWING', 'OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('AVAILABLE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."assignment_rule_type" AS ENUM('assign_user', 'round_robin', 'weighted_round_robin', 'least_loaded', 'territory');--> statement-breakpoint
CREATE TYPE "public"."blog_post_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."bonus_type" AS ENUM('PERFORMANCE', 'FESTIVAL', 'REFERRAL', 'SPOT', 'ANNUAL', 'JOINING', 'RETENTION', 'COMMISSION', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."branch_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."broadcast_status" AS ENUM('DRAFT', 'SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."candidate_status" AS ENUM('NEW', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."chat_message_type" AS ENUM('text', 'lead_submission', 'system');--> statement-breakpoint
CREATE TYPE "public"."client_account_status" AS ENUM('ACCOUNT_OPENING', 'QUERIES', 'PLAN_SELECTED', 'INVESTED');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('PENDING', 'APPROVED', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."crm_activity_type" AS ENUM('deal_won', 'meeting', 'proposal', 'call', 'email', 'ticket', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."crm_campaign_status" AS ENUM('active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."crm_deal_stage" AS ENUM('Discovery', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won');--> statement-breakpoint
CREATE TYPE "public"."crm_event_status" AS ENUM('planning', 'confirmed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."crm_health" AS ENUM('healthy', 'at_risk', 'critical');--> statement-breakpoint
CREATE TYPE "public"."crm_lead_status" AS ENUM('visitor', 'lead', 'mql', 'sql', 'opportunity');--> statement-breakpoint
CREATE TYPE "public"."crm_person_role" AS ENUM('sales_rep', 'csm');--> statement-breakpoint
CREATE TYPE "public"."crm_support_ticket_priority" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."crm_support_ticket_status" AS ENUM('new', 'in_progress', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."cycle_status" AS ENUM('draft', 'active', 'completed');--> statement-breakpoint
CREATE TYPE "public"."deal_activity_type" AS ENUM('stage_change', 'note', 'call', 'email', 'meeting', 'document');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('QUEUED', 'PROCESSING', 'DELIVERED', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."device_status" AS ENUM('ACTIVE', 'INACTIVE', 'LOST', 'RETURNED');--> statement-breakpoint
CREATE TYPE "public"."doc_audit_action" AS ENUM('UPLOADED', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUESTED', 'RE_UPLOADED');--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('CONTRACT', 'CERTIFICATE', 'ID_PROOF', 'PAYSLIP', 'POLICY', 'OFFER_LETTER', 'RESUME', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."enterprise_quote_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."exit_checklist_status" AS ENUM('PENDING', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('DRAFT', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'REIMBURSEMENT_PENDING', 'REIMBURSED', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('SELF', 'PEER', 'MANAGER', 'SKIP_LEVEL');--> statement-breakpoint
CREATE TYPE "public"."fnf_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'HR_REVIEW', 'FINANCE_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('MALE', 'FEMALE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."guided_tour_progress_status" AS ENUM('not_started', 'in_progress', 'completed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."incentive_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'ADDED_TO_PAYROLL');--> statement-breakpoint
CREATE TYPE "public"."intake_source" AS ENUM('manual', 'web_form', 'email');--> statement-breakpoint
CREATE TYPE "public"."intake_status" AS ENUM('pending', 'accepted', 'declined', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."interview_result" AS ENUM('PENDING', 'PASSED', 'FAILED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."interview_type" AS ENUM('PHONE', 'VIDEO', 'ONSITE', 'TECHNICAL', 'HR', 'FINAL');--> statement-breakpoint
CREATE TYPE "public"."inv_3pl_status" AS ENUM('DISCONNECTED', 'CONNECTED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."inv_adj_reason" AS ENUM('PURCHASE', 'SALE', 'RETURN', 'DAMAGE', 'EXPIRY', 'THEFT', 'RECOUNT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."inv_ai_insight_status" AS ENUM('NEW', 'ACKNOWLEDGED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."inv_channel_pub_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."inv_channel_status" AS ENUM('ACTIVE', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."inv_channel_type" AS ENUM('INTERNAL', 'SHOPIFY', 'WOOCOMMERCE', 'MARKETPLACE', 'B2B', 'THREE_PL');--> statement-breakpoint
CREATE TYPE "public"."inv_costing_method" AS ENUM('STANDARD', 'WEIGHTED_AVERAGE', 'FIFO');--> statement-breakpoint
CREATE TYPE "public"."inv_customer_return_disposition" AS ENUM('RESTOCK', 'QUARANTINE', 'SCRAP');--> statement-breakpoint
CREATE TYPE "public"."inv_cycle_count_status" AS ENUM('PLANNED', 'COUNTING', 'REVIEW', 'POSTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_expiry_policy" AS ENUM('BLOCK', 'WARN', 'ALLOW');--> statement-breakpoint
CREATE TYPE "public"."inv_grn_quality" AS ENUM('ACCEPTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."inv_idempotency_status" AS ENUM('IN_FLIGHT', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."inv_job_status" AS ENUM('PENDING', 'VALIDATING', 'RUNNING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."inv_load_status" AS ENUM('DRAFT', 'DISPATCHED', 'ARRIVED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_location_type" AS ENUM('ZONE', 'AISLE', 'RACK', 'BIN', 'RECEIVING', 'SHIPPING', 'QUARANTINE', 'SCRAP', 'TRANSIT', 'RETURNS');--> statement-breakpoint
CREATE TYPE "public"."inv_lot_status" AS ENUM('ACTIVE', 'EXPIRED', 'BLOCKED', 'CONSUMED', 'RECALLED');--> statement-breakpoint
CREATE TYPE "public"."inv_package_status" AS ENUM('OPEN', 'CLOSED', 'SHIPPED');--> statement-breakpoint
CREATE TYPE "public"."inv_pick_list_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_po_status" AS ENUM('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_product_status" AS ENUM('ACTIVE', 'INACTIVE', 'DISCONTINUED');--> statement-breakpoint
CREATE TYPE "public"."inv_product_type" AS ENUM('STOCKABLE', 'CONSUMABLE', 'SERVICE');--> statement-breakpoint
CREATE TYPE "public"."inv_quality_disposition" AS ENUM('RELEASE_TO_AVAILABLE', 'QUARANTINE', 'RETURN_TO_VENDOR', 'SCRAP');--> statement-breakpoint
CREATE TYPE "public"."inv_quality_hold_status" AS ENUM('ACTIVE', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."inv_quality_inspection_status" AS ENUM('PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED', 'DISPOSITION_REQUIRED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_recall_status" AS ENUM('OPEN', 'IN_PROGRESS', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."inv_reservation_status" AS ENUM('ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."inv_reservation_strategy" AS ENUM('MANUAL', 'AUTO_ON_CONFIRM', 'FEFO', 'FIFO');--> statement-breakpoint
CREATE TYPE "public"."inv_serial_status" AS ENUM('IN_STOCK', 'RESERVED', 'SHIPPED', 'RETURNED', 'SCRAPPED', 'QUARANTINE');--> statement-breakpoint
CREATE TYPE "public"."inv_shipment_status" AS ENUM('DRAFT', 'PACKED', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_so_status" AS ENUM('DRAFT', 'CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED', 'PICKED', 'PACKED', 'SHIPPED', 'PARTIALLY_SHIPPED', 'INVOICED', 'CANCELLED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."inv_tracking_method" AS ENUM('NONE', 'LOT', 'SERIAL');--> statement-breakpoint
CREATE TYPE "public"."inv_transfer_status" AS ENUM('PENDING', 'RESERVED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."inv_txn_type" AS ENUM('PURCHASE', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_IN', 'RETURN_OUT', 'GRN', 'OPENING_BALANCE', 'VENDOR_RETURN', 'CUSTOMER_RETURN', 'CYCLE_COUNT_GAIN', 'CYCLE_COUNT_LOSS', 'SCRAP', 'QUARANTINE_IN', 'QUARANTINE_OUT', 'RESERVATION_CREATE', 'RESERVATION_RELEASE', 'RESERVATION_CONSUME');--> statement-breakpoint
CREATE TYPE "public"."inv_vendor_return_reason" AS ENUM('DAMAGED', 'WRONG_ITEM', 'EXCESS', 'EXPIRED', 'QUALITY_REJECTED');--> statement-breakpoint
CREATE TYPE "public"."inv_webhook_event_status" AS ENUM('PENDING', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'FAILED', 'VOIDED');--> statement-breakpoint
CREATE TYPE "public"."job_posting_status" AS ENUM('DRAFT', 'OPEN', 'PAUSED', 'CLOSED', 'FILLED');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."kb_audience" AS ENUM('internal', 'public', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."kb_space_role" AS ENUM('viewer', 'commenter', 'editor', 'publisher', 'admin');--> statement-breakpoint
CREATE TYPE "public"."kb_translation_status" AS ENUM('draft', 'in_progress', 'translated', 'published', 'outdated');--> statement-breakpoint
CREATE TYPE "public"."lead_email_direction" AS ENUM('sent', 'received');--> statement-breakpoint
CREATE TYPE "public"."lead_task_status" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TYPE "public"."leave_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."loan_status" AS ENUM('PENDING', 'APPROVED', 'ACTIVE', 'REPAID', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');--> statement-breakpoint
CREATE TYPE "public"."module_setup_checklist_status" AS ENUM('not_started', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."module_status" AS ENUM('backlog', 'planned', 'in-progress', 'completed', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."notification_category" AS ENUM('SECURITY', 'CRM', 'HRMS', 'BILLING', 'AI', 'PROJECTS', 'WORKFLOW', 'MARKETING', 'SYSTEM', 'CHAT', 'PAYROLL', 'RECRUITMENT', 'KNOWLEDGE', 'SIGN', 'INVENTORY', 'SURVEYS', 'CALENDAR', 'SUPPORT');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'EMAIL', 'PUSH', 'SMS', 'WHATSAPP', 'WEBHOOK');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('PENDING', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'CLICKED', 'FAILED', 'BOUNCED', 'SUPPRESSED', 'CANCELLED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."notification_policy_scope" AS ENUM('ORG', 'ROLE', 'DEPARTMENT', 'TEAM', 'PROJECT');--> statement-breakpoint
CREATE TYPE "public"."notification_priority" AS ENUM('LOW', 'NORMAL', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."notification_provider" AS ENUM('SMTP', 'TWILIO', 'META_WHATSAPP', 'WEBHOOK', 'WEB_PUSH', 'INTERNAL', 'SANDBOX');--> statement-breakpoint
CREATE TYPE "public"."notification_queue_status" AS ENUM('PENDING', 'LOCKED', 'DONE', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."notification_quiet_hours_behavior" AS ENUM('respect', 'bypass_if_high', 'always_bypass');--> statement-breakpoint
CREATE TYPE "public"."notification_suppression_reason" AS ENUM('DEDUPE', 'MUTE', 'UNSUBSCRIBE', 'INVALID_RECIPIENT', 'RATE_LIMIT', 'QUIET_HOURS', 'NO_PROVIDER', 'CONSENT_MISSING', 'CHANNEL_DISABLED', 'COST_LIMIT');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('INFO', 'SUCCESS', 'WARNING', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."onboarding_doc_status" AS ENUM('PENDING', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED');--> statement-breakpoint
CREATE TYPE "public"."onboarding_document_status" AS ENUM('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RE_UPLOAD_REQUESTED');--> statement-breakpoint
CREATE TYPE "public"."onboarding_flow_session_status" AS ENUM('not_started', 'in_progress', 'completed', 'skipped', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."onboarding_flow_step_status" AS ENUM('todo', 'in_progress', 'done', 'skipped', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."onboarding_flow_task_category" AS ENUM('profile', 'document', 'training', 'system_access', 'equipment', 'policy', 'module_setup', 'guided_action', 'payment_setup');--> statement-breakpoint
CREATE TYPE "public"."onboarding_flow_task_status" AS ENUM('todo', 'in_progress', 'done', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."onboarding_flow_type" AS ENUM('org_setup', 'member_setup', 'employee_onboarding', 'module_setup', 'guided_tour', 'payment_setup');--> statement-breakpoint
CREATE TYPE "public"."onboarding_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."org_size" AS ENUM('1-10', '11-50', '51-200', '201-1000', '1000+');--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('MONTHLY', 'SEMI_MONTHLY', 'BI_WEEKLY', 'WEEKLY');--> statement-breakpoint
CREATE TYPE "public"."payment_environment" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."payment_manual_method_status" AS ENUM('enabled', 'missing_instructions', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."payment_provider_status" AS ENUM('not_configured', 'test_mode_ready', 'needs_credentials', 'needs_business_details', 'needs_kyc', 'kyc_pending', 'kyc_rejected', 'needs_webhook', 'webhook_failing', 'test_payment_required', 'ready_for_live', 'live', 'degraded', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."payment_test_transaction_status" AS ENUM('created', 'pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_webhook_endpoint_status" AS ENUM('not_verified', 'verified', 'failing');--> statement-breakpoint
CREATE TYPE "public"."payment_webhook_processing_status" AS ENUM('received', 'processed', 'failed', 'ignored_duplicate');--> statement-breakpoint
CREATE TYPE "public"."payroll_approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."payroll_bank_batch_status" AS ENUM('DRAFT', 'GENERATED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payroll_bank_item_status" AS ENUM('PENDING', 'SENT', 'PAID', 'FAILED', 'HELD');--> statement-breakpoint
CREATE TYPE "public"."payroll_calendar_event_type" AS ENUM('ATTENDANCE_CUTOFF', 'REIMBURSEMENT_CUTOFF', 'DECLARATION_CUTOFF', 'PREVIEW_DUE', 'APPROVAL_DEADLINE', 'PAY_DATE', 'PUBLISH_DATE');--> statement-breakpoint
CREATE TYPE "public"."payroll_exception_severity" AS ENUM('BLOCKER', 'WARNING', 'INFO');--> statement-breakpoint
CREATE TYPE "public"."payroll_exception_status" AS ENUM('OPEN', 'RESOLVED', 'OVERRIDDEN');--> statement-breakpoint
CREATE TYPE "public"."payroll_loan_adjustment_type" AS ENUM('SKIP_EMI', 'EXTRA_RECOVERY', 'FORECLOSURE', 'MANUAL_ADJUST');--> statement-breakpoint
CREATE TYPE "public"."payroll_policy_status" AS ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_status" AS ENUM('PREPARING', 'DRAFT', 'PREVIEW_READY', 'EXCEPTIONS_FOUND', 'PENDING_APPROVAL', 'APPROVED', 'LOCKED', 'PAID', 'PAYSLIPS_PUBLISHED', 'CLOSED', 'REOPENED');--> statement-breakpoint
CREATE TYPE "public"."payroll_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."payroll_worker_type" AS ENUM('EMPLOYEE', 'CONTRACTOR', 'CONSULTANT', 'INTERN', 'EOR');--> statement-breakpoint
CREATE TYPE "public"."payslip_layout" AS ENUM('CLASSIC', 'MODERN', 'COMPLIANCE');--> statement-breakpoint
CREATE TYPE "public"."payslip_publish_channel" AS ENUM('PORTAL', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."pip_status" AS ENUM('ACTIVE', 'EXTENDED', 'COMPLETED', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('ACTIVE', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('PENDING', 'SIGNED_UP', 'ACTIVATED', 'REWARDED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."reimbursement_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."resignation_status" AS ENUM('SUBMITTED', 'PENDING_HR', 'HR_APPROVED', 'CEO_APPROVED', 'IN_PROGRESS', 'APPROVED', 'WITHDRAWN', 'COMPLETED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."revenue_event_type" AS ENUM('new_subscription', 'upgrade', 'downgrade', 'churn', 'reactivation', 'addon_purchase', 'refund');--> statement-breakpoint
CREATE TYPE "public"."review_cycle_status" AS ENUM('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."salary_component_calc_method" AS ENUM('FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS', 'FORMULA', 'ATTENDANCE_BASED', 'TIMESHEET_BASED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."salary_component_type" AS ENUM('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT', 'TAX', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."salary_profile_status" AS ENUM('UPCOMING', 'ACTIVE', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."scoring_operator" AS ENUM('eq', 'gt', 'lt', 'contains', 'in');--> statement-breakpoint
CREATE TYPE "public"."sla_applies_to" AS ENUM('lead', 'deal', 'both');--> statement-breakpoint
CREATE TYPE "public"."sla_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."state_group" AS ENUM('backlog', 'unstarted', 'started', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."subscription_plan" AS ENUM('STARTER', 'PROFESSIONAL', 'ENTERPRISE');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_status" AS ENUM('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."survey_status" AS ENUM('DRAFT', 'ACTIVE', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."task_entity_type" AS ENUM('LEAD', 'DEAL', 'CONTACT', 'PROJECT');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('CALL', 'EMAIL', 'MEETING', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."tax_regime_type" AS ENUM('OLD', 'NEW');--> statement-breakpoint
CREATE TYPE "public"."termination_status" AS ENUM('DRAFT', 'PENDING_CEO', 'APPROVED', 'REJECTED', 'SENT', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('EPIC', 'STORY', 'TASK', 'BUG');--> statement-breakpoint
CREATE TYPE "public"."view_layout" AS ENUM('board', 'list', 'table', 'calendar', 'gantt');--> statement-breakpoint
CREATE TYPE "public"."wfh_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."work_item_relation_type" AS ENUM('blocks', 'blocked_by', 'duplicate_of', 'relates_to');--> statement-breakpoint
CREATE TYPE "public"."data_scope" AS ENUM('all', 'team', 'own', 'none');--> statement-breakpoint
CREATE TYPE "public"."principal_group_type" AS ENUM('department', 'team', 'custom');--> statement-breakpoint
CREATE TYPE "public"."okr_goal_level" AS ENUM('company', 'team', 'individual');--> statement-breakpoint
CREATE TYPE "public"."okr_goal_status" AS ENUM('not_started', 'on_track', 'at_risk', 'off_track', 'completed');--> statement-breakpoint
CREATE TYPE "public"."okr_kr_metric" AS ENUM('number', 'percentage', 'currency', 'boolean');--> statement-breakpoint
CREATE TYPE "public"."changelog_type" AS ENUM('feature', 'improvement', 'fix');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('open', 'planned', 'in_progress', 'completed', 'declined');--> statement-breakpoint
CREATE TYPE "public"."roadmap_status" AS ENUM('planned', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."whiteboard_share_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TYPE "public"."whiteboard_visibility" AS ENUM('project', 'private', 'public');--> statement-breakpoint
CREATE TYPE "public"."git_provider" AS ENUM('github', 'gitlab', 'bitbucket');--> statement-breakpoint
CREATE TYPE "public"."git_ref_type" AS ENUM('commit', 'pull_request', 'branch');--> statement-breakpoint
CREATE TYPE "public"."ticket_activity_action" AS ENUM('created', 'status_changed', 'priority_changed', 'assignee_changed', 'title_changed', 'sprint_changed', 'due_date_changed', 'comment_added', 'comment_updated', 'comment_deleted', 'label_changed', 'estimate_changed', 'cycle_changed', 'type_changed');--> statement-breakpoint
CREATE TYPE "public"."test_case_automation_status" AS ENUM('manual', 'automated', 'planned');--> statement-breakpoint
CREATE TYPE "public"."test_case_priority" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."test_result_status" AS ENUM('not_run', 'passed', 'failed', 'blocked', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."test_run_status" AS ENUM('not_started', 'in_progress', 'completed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."bug_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."bug_severity" AS ENUM('blocker', 'critical', 'major', 'minor', 'trivial');--> statement-breakpoint
CREATE TYPE "public"."bug_status" AS ENUM('new', 'triaged', 'assigned', 'in_progress', 'fixed', 'ready_for_qa', 'verified', 'reopened', 'closed');--> statement-breakpoint
CREATE TYPE "public"."change_request_status" AS ENUM('submitted', 'under_review', 'estimated', 'awaiting_approval', 'approved', 'rejected', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."approval_entity_type" AS ENUM('task', 'milestone', 'budget', 'release', 'change_request', 'document', 'timesheet', 'client_approval');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('requested', 'pending', 'approved', 'rejected', 'changes_requested', 'escalated', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('proposed', 'accepted', 'superseded', 'revisit');--> statement-breakpoint
CREATE TYPE "public"."risk_impact" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."risk_probability" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."risk_status" AS ENUM('open', 'mitigating', 'monitoring', 'accepted', 'closed');--> statement-breakpoint
CREATE TYPE "public"."action_item_status" AS ENUM('open', 'in_progress', 'done', 'converted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."meeting_type" AS ENUM('meeting', 'standup', 'retro', 'planning', 'review');--> statement-breakpoint
CREATE TYPE "public"."project_meeting_status" AS ENUM('scheduled', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('detected', 'investigating', 'mitigating', 'resolved', 'postmortem', 'closed');--> statement-breakpoint
CREATE TYPE "public"."form_submission_status" AS ENUM('submitted', 'processed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."form_type" AS ENUM('task_request', 'bug_report', 'feature_request', 'change_request', 'client_approval', 'risk_report', 'qa_issue', 'generic');--> statement-breakpoint
CREATE TYPE "public"."project_portfolio_health" AS ENUM('on_track', 'at_risk', 'off_track');--> statement-breakpoint
CREATE TYPE "public"."project_portfolio_status" AS ENUM('active', 'on_hold', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hr_custom_field_type" AS ENUM('text', 'number', 'date', 'select', 'multi_select', 'boolean', 'file', 'employee_ref', 'department_ref', 'currency');--> statement-breakpoint
CREATE TYPE "public"."hr_effective_dated_change_status" AS ENUM('draft', 'approved', 'applied');--> statement-breakpoint
CREATE TYPE "public"."hr_effective_dated_change_type" AS ENUM('department', 'manager', 'location', 'designation', 'job_level', 'employment_type', 'compensation', 'work_schedule', 'policy_assignment');--> statement-breakpoint
CREATE TYPE "public"."hr_employment_lifecycle_status" AS ENUM('CANDIDATE', 'PRE_JOINING', 'ONBOARDING', 'ACTIVE', 'PROBATION', 'CONFIRMED', 'NOTICE', 'EXITED', 'ALUMNI', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."hr_reporting_line_type" AS ENUM('primary', 'matrix', 'dotted');--> statement-breakpoint
CREATE TYPE "public"."hr_worker_type" AS ENUM('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'CONSULTANT', 'INTERN', 'TEMPORARY', 'AGENCY', 'FREELANCER');--> statement-breakpoint
CREATE TYPE "public"."hr_automation_run_status" AS ENUM('success', 'partial', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."hr_policy_scope_type" AS ENUM('organization', 'country', 'state', 'location', 'department', 'team', 'role', 'job_level', 'employment_type', 'employee');--> statement-breakpoint
CREATE TYPE "public"."hr_policy_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hr_policy_type" AS ENUM('leave', 'attendance', 'shift_roster', 'overtime', 'comp_off', 'probation', 'notice_period', 'document_requirement', 'approval', 'expense', 'travel', 'asset', 'wfh', 'remote_work', 'payroll_eligibility');--> statement-breakpoint
CREATE TYPE "public"."hr_workflow_action" AS ENUM('approved', 'rejected', 'reassigned', 'escalated', 'commented', 'cancelled', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."hr_workflow_approver_type" AS ENUM('direct_manager', 'managers_manager', 'hr_role', 'finance_role', 'department_head', 'location_hr', 'named_user', 'dynamic_expression');--> statement-breakpoint
CREATE TYPE "public"."hr_workflow_instance_status" AS ENUM('pending', 'in_progress', 'approved', 'rejected', 'cancelled', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."hr_workflow_object_type" AS ENUM('leave_request', 'attendance_regularization', 'overtime_request', 'comp_off_request', 'expense_reimbursement', 'travel_request', 'employee_data_change', 'document_review', 'asset_request', 'onboarding', 'offboarding', 'probation_confirmation', 'promotion', 'transfer', 'salary_revision', 'resignation', 'termination', 'grievance_case');--> statement-breakpoint
CREATE TYPE "public"."hr_workflow_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hr_workflow_step_mode" AS ENUM('serial', 'parallel_all', 'parallel_any');--> statement-breakpoint
CREATE TYPE "public"."hr_letter_type" AS ENUM('offer', 'appointment', 'confirmation', 'promotion', 'transfer', 'salary_revision', 'warning', 'experience', 'relieving', 'termination');--> statement-breakpoint
CREATE TYPE "public"."hr_template_kind" AS ENUM('onboarding_checklist', 'offboarding_checklist', 'probation_review', 'performance_review', 'goal', 'letter', 'document_request', 'email', 'notification', 'survey', 'training', 'asset_assignment', 'exit_interview');--> statement-breakpoint
CREATE TYPE "public"."hr_template_status" AS ENUM('draft', 'review', 'approved', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hr_payroll_adjustment_status" AS ENUM('pending', 'approved', 'applied');--> statement-breakpoint
CREATE TYPE "public"."hr_payroll_adjustment_type" AS ENUM('arrears', 'recovery', 'correction');--> statement-breakpoint
CREATE TYPE "public"."hr_payroll_input_section" AS ENUM('employee_master', 'compensation', 'attendance', 'leave', 'overtime', 'reimbursement', 'deduction', 'lifecycle');--> statement-breakpoint
CREATE TYPE "public"."hr_payroll_input_status" AS ENUM('open', 'building', 'built', 'locked');--> statement-breakpoint
CREATE TYPE "public"."hr_leave_ledger_source" AS ENUM('policy_accrual', 'request', 'cron', 'manual', 'import');--> statement-breakpoint
CREATE TYPE "public"."hr_leave_payroll_status" AS ENUM('pending', 'exported', 'locked');--> statement-breakpoint
CREATE TYPE "public"."hr_leave_txn_type" AS ENUM('accrual', 'consumption', 'carry_forward', 'encashment', 'expiry', 'adjustment', 'comp_off_earn', 'comp_off_use', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."succession_readiness" AS ENUM('ready_now', '1_2_years', '3_plus');--> statement-breakpoint
CREATE TYPE "public"."engagement_campaign_status" AS ENUM('draft', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."community_member_role" AS ENUM('member', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."hr_poll_status" AS ENUM('draft', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."reward_point_source" AS ENUM('kudos', 'badge', 'manual', 'redemption');--> statement-breakpoint
CREATE TYPE "public"."hr_case_category" AS ENUM('grievance', 'disciplinary', 'harassment', 'ethics', 'performance', 'workplace_conflict', 'policy_violation', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_case_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."hr_case_status" AS ENUM('open', 'under_investigation', 'resolved', 'closed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."hr_disciplinary_action_type" AS ENUM('verbal_warning', 'written_warning', 'final_warning', 'suspension', 'termination_recommended');--> statement-breakpoint
CREATE TYPE "public"."hr_safety_incident_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."hr_safety_incident_status" AS ENUM('open', 'investigating', 'mitigated', 'closed');--> statement-breakpoint
CREATE TYPE "public"."hr_safety_incident_type" AS ENUM('injury', 'accident', 'near_miss', 'hazard', 'environmental', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_benefit_category" AS ENUM('health', 'life', 'accident', 'retirement', 'wellness', 'perk', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_benefit_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hr_claim_payout_route" AS ENUM('payroll_payable', 'finance_payable', 'already_paid');--> statement-breakpoint
CREATE TYPE "public"."hr_claim_status" AS ENUM('submitted', 'in_review', 'approved', 'rejected', 'paid');--> statement-breakpoint
CREATE TYPE "public"."hr_dependent_relationship" AS ENUM('spouse', 'child', 'parent', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_enrollment_status" AS ENUM('pending', 'active', 'waived', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."hr_enrollment_window_status" AS ENUM('upcoming', 'open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."hr_loan_repayment_status" AS ENUM('pending', 'deducted', 'paid', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."hr_webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."hr_import_entity" AS ENUM('employees', 'leave_balances', 'attendance', 'assets', 'document_metadata');--> statement-breakpoint
CREATE TYPE "public"."hr_import_row_status" AS ENUM('valid', 'error', 'committed');--> statement-breakpoint
CREATE TYPE "public"."hr_import_status" AS ENUM('validating', 'previewed', 'committing', 'committed', 'rolled_back', 'failed');--> statement-breakpoint
CREATE TYPE "public"."hr_compliance_category" AS ENUM('statutory_filing', 'registration', 'posting', 'training', 'audit', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_compliance_event_status" AS ENUM('pending', 'done', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."hr_compliance_frequency" AS ENUM('once', 'monthly', 'quarterly', 'yearly');--> statement-breakpoint
CREATE TYPE "public"."hr_contract_status" AS ENUM('active', 'expiring', 'ended', 'renewed', 'converted');--> statement-breakpoint
CREATE TYPE "public"."hr_contract_type" AS ENUM('contractor', 'consultant', 'intern', 'temporary', 'agency', 'freelancer');--> statement-breakpoint
CREATE TYPE "public"."hr_work_auth_status" AS ENUM('active', 'expiring', 'expired', 'pending_renewal');--> statement-breakpoint
CREATE TYPE "public"."hr_work_auth_type" AS ENUM('work_permit', 'visa', 'right_to_work', 'citizenship_proof', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_form_audience" AS ENUM('internal', 'public');--> statement-breakpoint
CREATE TYPE "public"."hr_form_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."hr_form_submission_status" AS ENUM('submitted', 'in_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hr_collective_agreement_status" AS ENUM('active', 'expired', 'negotiating');--> statement-breakpoint
CREATE TYPE "public"."hr_data_request_status" AS ENUM('pending', 'approved', 'processing', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hr_data_request_type" AS ENUM('export', 'delete', 'anonymize');--> statement-breakpoint
CREATE TYPE "public"."hr_labor_case_status" AS ENUM('open', 'in_review', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."hr_legal_hold_item_type" AS ENUM('employee_profile', 'document', 'case_evidence');--> statement-breakpoint
CREATE TYPE "public"."hr_legal_hold_status" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."hr_position_status" AS ENUM('open', 'filled', 'frozen', 'future');--> statement-breakpoint
CREATE TYPE "public"."hr_proxy_scope" AS ENUM('approvals', 'hr_admin', 'manager_tasks');--> statement-breakpoint
CREATE TYPE "public"."hr_reorg_scenario_status" AS ENUM('draft', 'proposed', 'applied');--> statement-breakpoint
CREATE TYPE "public"."hr_retention_action" AS ENUM('delete', 'anonymize');--> statement-breakpoint
CREATE TYPE "public"."hr_retention_record_type" AS ENUM('employee', 'document', 'case', 'attendance', 'payroll');--> statement-breakpoint
CREATE TYPE "public"."hr_union_membership_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."hr_arrears_status" AS ENUM('pending', 'applied');--> statement-breakpoint
CREATE TYPE "public"."hr_comp_cycle_status" AS ENUM('draft', 'active', 'calibrating', 'approved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."hr_comp_recommendation_status" AS ENUM('draft', 'submitted', 'calibrated', 'approved');--> statement-breakpoint
CREATE TYPE "public"."hr_compliance_task_status" AS ENUM('pending', 'completed', 'overdue');--> statement-breakpoint
CREATE TYPE "public"."hr_device_sync_status" AS ENUM('success', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."hr_equity_grant_status" AS ENUM('active', 'exercised', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."hr_equity_grant_type" AS ENUM('ISO', 'NSO', 'RSU', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_time_device_status" AS ENUM('active', 'inactive', 'faulty');--> statement-breakpoint
CREATE TYPE "public"."hr_time_device_type" AS ENUM('biometric', 'rfid', 'mobile', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_variance_approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."hr_access_provisioning_action" AS ENUM('grant', 'revoke', 'review');--> statement-breakpoint
CREATE TYPE "public"."hr_access_provisioning_status" AS ENUM('pending', 'completed', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."hr_access_provisioning_trigger" AS ENUM('joiner', 'mover', 'leaver', 'manual');--> statement-breakpoint
CREATE TYPE "public"."hr_accommodation_status" AS ENUM('requested', 'under_review', 'approved', 'denied', 'implemented');--> statement-breakpoint
CREATE TYPE "public"."hr_accommodation_task_status" AS ENUM('pending', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."hr_accommodation_type" AS ENUM('equipment', 'schedule', 'workspace', 'medical_restriction', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_emergency_event_status" AS ENUM('active', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."hr_emergency_event_type" AS ENUM('office_closure', 'disaster', 'safety_check', 'other');--> statement-breakpoint
CREATE TYPE "public"."hr_emergency_response_status" AS ENUM('safe', 'need_help', 'no_response');--> statement-breakpoint
CREATE TYPE "public"."hr_simulation_type" AS ENUM('policy', 'leave', 'attendance', 'approval', 'payroll');--> statement-breakpoint
CREATE TYPE "public"."client_health_status" AS ENUM('healthy', 'at_risk', 'critical');--> statement-breakpoint
CREATE TYPE "public"."nps_category" AS ENUM('promoter', 'passive', 'detractor');--> statement-breakpoint
CREATE TYPE "public"."nps_survey_status" AS ENUM('draft', 'active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."acc_normal_balance" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."acc_basis" AS ENUM('ACCRUAL', 'CASH');--> statement-breakpoint
CREATE TYPE "public"."acc_period_status" AS ENUM('OPEN', 'CLOSING', 'CLOSED', 'LOCKED');--> statement-breakpoint
CREATE TYPE "public"."acc_system_purpose" AS ENUM('AR', 'AP', 'BANK_CLEARING', 'SALES_INCOME', 'DISCOUNT_GIVEN', 'TAX_PAYABLE', 'TAX_RECEIVABLE', 'PAYROLL_PAYABLE', 'EXPENSE_CLEARING', 'RETAINED_EARNINGS', 'OWNER_EQUITY', 'PAYMENT_FEES', 'REIMBURSEMENT_PAYABLE', 'FX_GAIN_LOSS', 'DEPRECIATION_EXPENSE', 'ACCUM_DEPRECIATION', 'SALARY_EXPENSE', 'ASSET_DISPOSAL_GAIN_LOSS');--> statement-breakpoint
CREATE TYPE "public"."fin_approval_record_type" AS ENUM('MANUAL_JOURNAL', 'PURCHASE_BILL', 'VENDOR_PAYMENT', 'EXPENSE', 'CREDIT_NOTE', 'PERIOD_REOPEN', 'BANK_ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."fin_approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."fin_recur_frequency" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."fin_collection_activity_type" AS ENUM('NOTE', 'PROMISE_TO_PAY', 'CALL', 'EMAIL');--> statement-breakpoint
CREATE TYPE "public"."fin_credit_note_status" AS ENUM('DRAFT', 'POSTED', 'APPLIED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."fin_payment_run_item_status" AS ENUM('PENDING', 'PAID', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."fin_payment_run_status" AS ENUM('DRAFT', 'APPROVED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."fin_reminder_channel" AS ENUM('EMAIL', 'WHATSAPP');--> statement-breakpoint
CREATE TYPE "public"."fin_bank_account_type" AS ENUM('BANK', 'CASH', 'CARD', 'WALLET');--> statement-breakpoint
CREATE TYPE "public"."fin_bank_import_format" AS ENUM('CSV', 'OFX', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."fin_bank_import_status" AS ENUM('PENDING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."fin_bank_txn_status" AS ENUM('UNMATCHED', 'SUGGESTED', 'MATCHED', 'RECONCILED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."fin_recon_match_type" AS ENUM('CUSTOMER_PAYMENT', 'VENDOR_PAYMENT', 'EXPENSE_REIMBURSEMENT', 'PAYROLL', 'BANK_FEE', 'TRANSFER', 'MANUAL_JOURNAL');--> statement-breakpoint
CREATE TYPE "public"."acc_tax_type" AS ENUM('GST', 'CGST_SGST', 'IGST', 'VAT', 'TDS', 'TCS', 'EXEMPT', 'ZERO_RATED');--> statement-breakpoint
CREATE TYPE "public"."fin_budget_dimension" AS ENUM('NONE', 'DEPARTMENT', 'PROJECT');--> statement-breakpoint
CREATE TYPE "public"."fin_budget_period" AS ENUM('MONTHLY', 'QUARTERLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."fin_budget_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."fin_scenario_kind" AS ENUM('CONSERVATIVE', 'EXPECTED', 'AGGRESSIVE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."acc_asset_status" AS ENUM('DRAFT', 'ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED');--> statement-breakpoint
CREATE TYPE "public"."acc_depreciation_line_status" AS ENUM('SCHEDULED', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."acc_depreciation_method" AS ENUM('STRAIGHT_LINE', 'DECLINING_BALANCE', 'UNITS_OF_PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."acc_depreciation_run_status" AS ENUM('DRAFT', 'POSTED');--> statement-breakpoint
CREATE TYPE "public"."fin_reimbursement_batch_status" AS ENUM('DRAFT', 'APPROVED', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."kb_article_status" AS ENUM('draft', 'in_review', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."kb_article_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TYPE "public"."support_activity_action" AS ENUM('created', 'status_changed', 'priority_changed', 'assignee_changed', 'replied', 'internal_note', 'resolved', 'reopened', 'merged', 'linked', 'split', 'snoozed', 'unsnoozed');--> statement-breakpoint
CREATE TYPE "public"."support_saved_view_visibility" AS ENUM('personal', 'team', 'global');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_link_relation" AS ENUM('duplicate', 'related', 'split');--> statement-breakpoint
CREATE TYPE "public"."support_channel_type" AS ENUM('email', 'chat', 'whatsapp', 'sms');--> statement-breakpoint
CREATE TYPE "public"."support_source_channel" AS ENUM('web', 'portal', 'email', 'chat', 'whatsapp', 'sms', 'api', 'internal');--> statement-breakpoint
CREATE TYPE "public"."support_suggestion_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."support_suggestion_type" AS ENUM('summary', 'sentiment', 'category', 'priority', 'spam', 'reply', 'macro', 'kb_article', 'duplicate', 'handoff_summary', 'root_cause_cluster');--> statement-breakpoint
CREATE TYPE "public"."support_external_entity_type" AS ENUM('project', 'invoice', 'calendar_event', 'chat_channel');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('success', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."automation_trigger" AS ENUM('lead.created', 'lead.status_changed', 'lead.assigned', 'lead.score_updated', 'deal.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'ticket.created', 'ticket.assigned', 'ticket.status_changed', 'ticket.priority_changed', 'ticket.message_received', 'ticket.escalated', 'invoice.overdue', 'invoice.paid', 'candidate.application_created', 'candidate.stage_changed', 'candidate.bgv_status_changed', 'interview.scheduled', 'interview.completed', 'scorecard.submitted', 'offer.sent', 'offer.accepted', 'offer.rejected', 'sla.breached', 'onboarding.started', 'onboarding.task_overdue', 'onboarding.document_submitted', 'onboarding.completed', 'leave.requested', 'leave.approved', 'leave.rejected', 'attendance.anomaly', 'attendance.late', 'resignation.submitted', 'resignation.approved', 'employee.onboarded', 'employee.terminated', 'employee.resignation', 'certification.expiring', 'document.review_requested', 'performance.review_cycle_started', 'review.cycle_started', 'expense.submitted', 'expense.approved', 'reimbursement.approved', 'reimbursement.rejected', 'sign.envelope.sent', 'sign.envelope.completed', 'sign.envelope.declined', 'sign.envelope.voided', 'sign.envelope.expired', 'sign.recipient.completed', 'sign.bulk_send.completed');--> statement-breakpoint
CREATE TYPE "public"."workflow_approval_status" AS ENUM('pending', 'approved', 'rejected', 'delegated', 'expired');--> statement-breakpoint
CREATE TYPE "public"."workflow_execution_status" AS ENUM('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."workflow_node_type" AS ENUM('trigger', 'condition', 'approval', 'action', 'delay', 'loop', 'ai_action', 'integration', 'script', 'end');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('draft', 'published', 'disabled', 'archived');--> statement-breakpoint
CREATE TYPE "public"."workflow_trigger_type" AS ENUM('event', 'schedule', 'webhook', 'api', 'manual');--> statement-breakpoint
CREATE TYPE "public"."payroll_input_source" AS ENUM('ATTENDANCE', 'LEAVE', 'TIMESHEET', 'UPLOAD', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_event_type" AS ENUM('GENERATED', 'RECALCULATED', 'APPROVAL_SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED', 'REOPENED', 'MARKED_PAID', 'PAYSLIPS_PUBLISHED', 'BANK_BATCH_GENERATED', 'BANK_BATCH_SENT', 'BANK_ITEM_PAID', 'BANK_ITEM_FAILED', 'EXCEPTION_OVERRIDDEN', 'INPUT_OVERRIDDEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."payroll_tax_window_status" AS ENUM('DRAFT', 'OPEN', 'CLOSED', 'LOCKED');--> statement-breakpoint
CREATE TYPE "public"."payroll_template_category" AS ENUM('INDIAN_STANDARD', 'INDIAN_STARTUP', 'CONTRACTOR', 'SALES_INCENTIVE', 'GLOBAL_REMOTE', 'HOURLY', 'MANUFACTURING', 'STAFFING', 'EXECUTIVE', 'CUSTOM', 'COUNTRY_STANDARD');--> statement-breakpoint
CREATE TYPE "public"."payslip_publication_status" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."survey_form_mode" AS ENUM('survey', 'assessment', 'live_session', 'lead_qualification', 'custom');--> statement-breakpoint
CREATE TYPE "public"."survey_form_status" AS ENUM('draft', 'testing', 'published', 'paused', 'closed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."survey_question_type" AS ENUM('short_text', 'long_text', 'single_select', 'multi_select', 'dropdown', 'rating', 'star_rating', 'nps', 'number', 'email', 'phone', 'date', 'matrix', 'likert', 'ranking', 'slider', 'yes_no', 'consent', 'content_block');--> statement-breakpoint
CREATE TYPE "public"."survey_collector_status" AS ENUM('active', 'paused', 'closed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."survey_collector_type" AS ENUM('public_link', 'email', 'qr', 'embed', 'popup', 'crm_campaign', 'hr_audience', 'support_trigger', 'live_session', 'manual_access_code');--> statement-breakpoint
CREATE TYPE "public"."survey_participant_status" AS ENUM('invited', 'delivered', 'opened', 'started', 'partial', 'completed', 'disqualified', 'bounced', 'unsubscribed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."survey_response_session_status" AS ENUM('in_progress', 'submitted', 'invalid', 'excluded', 'deleted_by_policy');--> statement-breakpoint
CREATE TYPE "public"."survey_assessment_attempt_status" AS ENUM('not_started', 'in_progress', 'submitted', 'passed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."survey_live_session_status" AS ENUM('draft', 'waiting', 'active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."survey_automation_event_status" AS ENUM('pending', 'processed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."feedbucket_submission_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."feedbucket_submission_status" AS ENUM('open', 'in_progress', 'resolved', 'archived');--> statement-breakpoint
CREATE TYPE "public"."feedbucket_submission_type" AS ENUM('bug', 'idea', 'feature', 'question', 'praise', 'other');--> statement-breakpoint
CREATE TYPE "public"."sign_actor_type" AS ENUM('internal_user', 'external_signer', 'system');--> statement-breakpoint
CREATE TYPE "public"."sign_audit_event_type" AS ENUM('envelope_created', 'envelope_updated', 'envelope_deleted', 'document_uploaded', 'recipient_added', 'recipient_updated', 'recipient_removed', 'field_added', 'field_updated', 'field_deleted', 'envelope_validated', 'envelope_sent', 'email_delivered', 'email_bounced', 'reminder_sent', 'signing_link_opened', 'authentication_passed', 'authentication_failed', 'consent_accepted', 'document_viewed', 'field_completed', 'signature_adopted', 'recipient_completed', 'recipient_declined', 'recipient_delegated', 'envelope_corrected', 'envelope_voided', 'envelope_expired', 'envelope_extended', 'envelope_completed', 'final_pdf_generated', 'certificate_generated', 'certificate_regenerated', 'document_downloaded', 'template_created', 'template_published', 'template_archived', 'bulk_job_created', 'bulk_job_completed', 'bulk_job_cancelled', 'public_form_published', 'public_form_submitted', 'admin_setting_changed');--> statement-breakpoint
CREATE TYPE "public"."sign_auth_method" AS ENUM('email_link', 'access_code', 'otp_email', 'otp_sms', 'sso', 'passkey', 'kba', 'id_verification');--> statement-breakpoint
CREATE TYPE "public"."sign_bulk_job_status" AS ENUM('pending', 'validating', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sign_bulk_row_status" AS ENUM('pending', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sign_cc_timing" AS ENUM('on_send', 'on_complete');--> statement-breakpoint
CREATE TYPE "public"."sign_conversion_status" AS ENUM('pending', 'converted', 'failed', 'not_needed');--> statement-breakpoint
CREATE TYPE "public"."sign_envelope_status" AS ENUM('draft', 'ready_to_send', 'sent', 'delivered', 'partially_completed', 'completed', 'declined', 'voided', 'expired', 'correction_required', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sign_field_type" AS ENUM('signature', 'initials', 'date_signed', 'text', 'multiline', 'email', 'name', 'company', 'title', 'checkbox', 'radio', 'dropdown', 'attachment', 'stamp', 'strikethrough', 'readonly_merge');--> statement-breakpoint
CREATE TYPE "public"."sign_public_form_status" AS ENUM('draft', 'published', 'unpublished');--> statement-breakpoint
CREATE TYPE "public"."sign_recipient_status" AS ENUM('pending', 'invited', 'viewed', 'authenticated', 'signing', 'completed', 'declined', 'delegated', 'bounced', 'expired');--> statement-breakpoint
CREATE TYPE "public"."sign_recipient_type" AS ENUM('signer', 'approver', 'cc', 'viewer', 'in_person_host', 'internal_reviewer');--> statement-breakpoint
CREATE TYPE "public"."sign_routing_mode" AS ENUM('parallel', 'sequential', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."sign_signature_asset_type" AS ENUM('signature', 'initials', 'stamp');--> statement-breakpoint
CREATE TYPE "public"."sign_signature_method" AS ENUM('drawn', 'typed', 'uploaded', 'saved');--> statement-breakpoint
CREATE TYPE "public"."sign_template_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."sign_watermark_scope" AS ENUM('tenant', 'template', 'envelope');--> statement-breakpoint
CREATE TYPE "public"."ai_job_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ai_feedback_rating" AS ENUM('UP', 'DOWN');--> statement-breakpoint
CREATE TYPE "public"."ai_proposal_status" AS ENUM('PROPOSED', 'CONFIRMED', 'EXECUTED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"description" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"browser" text,
	"os" text,
	"platform" text,
	"trusted" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_otp_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text DEFAULT 'ENGINEERING' NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"event" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"country" text,
	"city" text,
	"success" boolean DEFAULT true NOT NULL,
	"failure_reason" text,
	"device_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfa_backup_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"step_name" text NOT NULL,
	"status" "onboarding_status" DEFAULT 'PENDING' NOT NULL,
	"completed_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_custom_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"recurring" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text DEFAULT 'ENGINEERING' NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"website" text,
	"industry" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"fiscal_year_start" integer DEFAULT 4 NOT NULL,
	"settings" jsonb,
	"billing_email" text,
	"address" jsonb,
	"mfa_enforced" boolean DEFAULT false NOT NULL,
	"allowed_email_domains" text[] DEFAULT '{}',
	"max_concurrent_sessions" integer,
	"enabled_modules" text[],
	"onboarding_completed_at" timestamp,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"deleted_at" timestamp,
	"company_size" text,
	"country" text,
	"legal_name" text,
	"org_code" text,
	"registration_number" text,
	"tax_number" text,
	"support_email" text,
	"support_phone" text,
	"favicon" text,
	"secondary_color" text,
	"business_hours" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"permission_id" integer NOT NULL,
	"org_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"org_id" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"delegator_id" text NOT NULL,
	"delegatee_id" text NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"ends_at" timestamp NOT NULL,
	"reason" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "user_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"permission_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"granted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"last_active" timestamp DEFAULT now() NOT NULL,
	"device_id" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp,
	"first_name" text,
	"last_name" text,
	"gender" "gender",
	"joining_date" date,
	"date_of_birth" date,
	"tax_id" text,
	"bank_details" text,
	"image" text,
	"role" text DEFAULT 'ENGINEERING' NOT NULL,
	"department_id" integer,
	"designation" text,
	"phone" text,
	"whatsapp_number" text,
	"whatsapp_same_as_phone" boolean DEFAULT true NOT NULL,
	"monthly_salary" numeric(15, 2),
	"employee_id" text,
	"metadata" jsonb,
	"login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"user_status" text DEFAULT 'active' NOT NULL,
	"invited_at" timestamp,
	"activated_at" timestamp,
	"archived_at" timestamp,
	"deleted_at" timestamp,
	"has_dashboard_access" boolean DEFAULT false NOT NULL,
	"reporting_to" text,
	"team" text,
	"branch_id" integer,
	"emergency_contact" jsonb,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"google_refresh_token" text,
	"google_email" text,
	"is_profile_picture_required" boolean DEFAULT false NOT NULL,
	"bio" text,
	"linkedin_url" text,
	"twitter_url" text,
	"github_url" text,
	"website_url" text,
	"onboarding_doc_status" "onboarding_doc_status" DEFAULT 'PENDING' NOT NULL,
	"onboarding_completed_at" timestamp,
	"last_active_org_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_versions" (
	"org_id" text PRIMARY KEY NOT NULL,
	"permissions_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"group_type" "principal_group_type" NOT NULL,
	"group_id" integer NOT NULL,
	"role_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(36) NOT NULL,
	"module_key" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"enabled_at" timestamp DEFAULT now() NOT NULL,
	"enabled_by" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(36) NOT NULL,
	"resource_type" varchar(64) NOT NULL,
	"resource_id" varchar(36) NOT NULL,
	"principal_type" varchar(16) DEFAULT 'user' NOT NULL,
	"principal_id" varchar(36) NOT NULL,
	"permission_key" varchar(128) NOT NULL,
	"granted_by" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permission_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"role_id" integer NOT NULL,
	"permission_key" text NOT NULL,
	"scope" "data_scope" DEFAULT 'all' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_id" integer NOT NULL,
	"assigned_by" text,
	"expires_at" timestamp,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3B82F6' NOT NULL,
	"group" "state_group" NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "cycle_status" DEFAULT 'draft' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "module_status" DEFAULT 'backlog' NOT NULL,
	"lead_id" text,
	"start_date" date,
	"end_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_template_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'TASK' NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"estimated_hours" numeric(8, 2),
	"order" integer DEFAULT 0 NOT NULL,
	"phase" text
);
--> statement-breakpoint
CREATE TABLE "project_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text DEFAULT 'GENERAL' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"key" text NOT NULL,
	"client_id" text,
	"manager_id" text,
	"start_date" timestamp,
	"end_date" timestamp,
	"status" "project_status" DEFAULT 'ACTIVE' NOT NULL,
	"deal_id" integer,
	"budget" numeric(15, 2),
	"settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb,
	"created_by" text,
	"is_scheduled" boolean DEFAULT false NOT NULL,
	"schedule_config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"goal" text,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_automations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"trigger_event" varchar(100) NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_custom_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"options" text[],
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"release_date" date,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"url" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"release_id" integer NOT NULL,
	"ticket_id" integer NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_assignees" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	"assigned_by" text
);
--> statement-breakpoint
CREATE TABLE "ticket_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer,
	"mime_type" text,
	"uploaded_by" text,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_checklist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"checklist_id" integer NOT NULL,
	"text" text NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"assignee_id" text,
	"due_date" date,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_checklists" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"title" text DEFAULT 'Checklist' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_comment_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"comment_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"emoji" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"parent_comment_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_custom_field_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"field_id" integer NOT NULL,
	"value" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_label_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"label_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3B82F6' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_related_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_watchers" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" "ticket_type" DEFAULT 'TASK' NOT NULL,
	"status" text DEFAULT 'TODO' NOT NULL,
	"priority" "ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"project_id" integer,
	"ticket_number" integer NOT NULL,
	"sprint_id" integer,
	"epic_id" integer,
	"assignee_id" text,
	"reporter_id" text,
	"points" integer,
	"story_points" integer,
	"link" text,
	"order" integer DEFAULT 0 NOT NULL,
	"parent_ticket_id" integer,
	"original_estimate" numeric(10, 2),
	"time_spent" numeric(10, 2) DEFAULT '0' NOT NULL,
	"start_date" date,
	"due_date" date,
	"state_id" integer,
	"module_id" integer,
	"cycle_id" integer,
	"sequence_id" text,
	"estimate" integer,
	"completion_percentage" integer DEFAULT 0 NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"recurrence_rule" jsonb,
	"recurrence_parent_id" integer,
	"recurrence_next_run_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ticket_id" integer,
	"date" date NOT NULL,
	"hours" numeric(6, 2) DEFAULT '0' NOT NULL,
	"description" text,
	"image_url" text,
	"work_link" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"rejection_reason" text,
	"is_billable" boolean DEFAULT false NOT NULL,
	"payroll_status" text DEFAULT 'UNPROCESSED' NOT NULL,
	"payroll_export_id" integer,
	"project_id" integer,
	"timesheet_period_id" integer,
	"timer_session_id" integer,
	"billing_type" text DEFAULT 'BILLABLE' NOT NULL,
	"bill_rate" numeric(10, 2),
	"cost_rate" numeric(10, 2),
	"currency" text,
	"rate_source" text,
	"invoicing_status" text DEFAULT 'UNINVOICED' NOT NULL,
	"submitted_at" timestamp,
	"locked_at" timestamp,
	"locked_by" text,
	"voided_at" timestamp,
	"void_reason" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"webhook_id" integer NOT NULL,
	"event" varchar(100) NOT NULL,
	"payload" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"response_code" integer,
	"response_body" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_item_id" integer NOT NULL,
	"related_work_item_id" integer NOT NULL,
	"relation_type" "work_item_relation_type" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_exports" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"export_type" text DEFAULT 'PAYROLL' NOT NULL,
	"status" text DEFAULT 'COMPLETED' NOT NULL,
	"date_range_start" date NOT NULL,
	"date_range_end" date NOT NULL,
	"format" text NOT NULL,
	"filters" jsonb,
	"snapshot" jsonb NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"total_hours" numeric(10, 2) DEFAULT '0' NOT NULL,
	"file_url" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"work_week_start" integer DEFAULT 1 NOT NULL,
	"required_fields" jsonb,
	"rounding_rule" text DEFAULT 'NONE' NOT NULL,
	"max_hours_per_day" numeric(4, 2) DEFAULT '24' NOT NULL,
	"allow_overlapping_entries" boolean DEFAULT true NOT NULL,
	"allow_backdated_entries" boolean DEFAULT true NOT NULL,
	"backdate_limit_days" integer,
	"approval_mode" text DEFAULT 'MANAGER' NOT NULL,
	"client_approval_enabled" boolean DEFAULT false NOT NULL,
	"lock_after_approval" boolean DEFAULT true NOT NULL,
	"lock_after_invoice" boolean DEFAULT true NOT NULL,
	"reminder_rules" jsonb,
	"pay_period" text DEFAULT 'MONTHLY' NOT NULL,
	"overtime_daily_hours" numeric(4, 2) DEFAULT '8' NOT NULL,
	"overtime_weekly_hours" numeric(5, 2) DEFAULT '40' NOT NULL,
	"include_non_billable" boolean DEFAULT true NOT NULL,
	"payroll_mapping" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "timesheet_settings_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "timer_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" integer,
	"ticket_id" integer,
	"description" text,
	"billable" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"last_resumed_at" timestamp,
	"accumulated_seconds" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"source" text DEFAULT 'WEB' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer,
	"client_id" integer,
	"budget_type" text DEFAULT 'HOURS' NOT NULL,
	"budget_hours" numeric(10, 2),
	"budget_amount" numeric(12, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"alert_thresholds" jsonb DEFAULT '[50,80,100]'::jsonb NOT NULL,
	"starts_at" date,
	"ends_at" date,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"total_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"billable_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"non_billable_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"submitted_at" timestamp,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"locked_at" timestamp,
	"current_approver_id" text,
	"approved_by" text,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_rate_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rate_card_id" integer,
	"project_id" integer,
	"user_id" text,
	"client_id" integer,
	"task_id" integer,
	"billing_type" text DEFAULT 'BILLABLE' NOT NULL,
	"bill_rate" numeric(10, 2) NOT NULL,
	"cost_rate" numeric(10, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" jsonb,
	"source" "intake_source" DEFAULT 'manual' NOT NULL,
	"status" "intake_status" DEFAULT 'pending' NOT NULL,
	"submitter_email" text,
	"submitter_name" text,
	"priority" text,
	"request_type" text,
	"linked_work_item_id" integer,
	"decline_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb,
	"icon" text,
	"cover_image" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"parent_page_id" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'CONTRIBUTOR' NOT NULL,
	"hourly_rate" numeric(10, 2) DEFAULT '0' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_date" date NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_by" text,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"color" text,
	"type" text DEFAULT 'unstarted',
	"wip_limit" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer,
	"org_id" text NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_by" text,
	"order_by" text,
	"layout_type" "view_layout" DEFAULT 'board' NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"visibility" text DEFAULT 'shared' NOT NULL,
	"display_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" text DEFAULT 'project' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_daily_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"snapshot_date" date NOT NULL,
	"state_group" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okr_goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner_id" text,
	"level" "okr_goal_level" DEFAULT 'company' NOT NULL,
	"status" "okr_goal_status" DEFAULT 'not_started' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"start_date" date,
	"due_date" date,
	"parent_goal_id" integer,
	"project_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okr_key_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"goal_id" integer NOT NULL,
	"title" text NOT NULL,
	"metric_type" "okr_kr_metric" DEFAULT 'number' NOT NULL,
	"start_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"target_value" numeric(18, 2) NOT NULL,
	"current_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"unit" text,
	"status" "okr_goal_status" DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okr_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"goal_id" integer NOT NULL,
	"ticket_id" integer,
	"project_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "okr_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"goal_id" integer NOT NULL,
	"key_result_id" integer,
	"note" text,
	"previous_value" numeric(18, 2),
	"new_value" numeric(18, 2),
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "changelog_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"version" text,
	"type" "changelog_type" DEFAULT 'feature' NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"linked_roadmap_item_id" integer,
	"published_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "feedback_status" DEFAULT 'open' NOT NULL,
	"category" text,
	"votes" integer DEFAULT 0 NOT NULL,
	"submitted_by_name" text,
	"submitted_by_email" text,
	"linked_roadmap_item_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"feedback_post_id" integer NOT NULL,
	"voter_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "roadmap_status" DEFAULT 'planned' NOT NULL,
	"category" text,
	"is_public" boolean DEFAULT true NOT NULL,
	"project_id" integer,
	"epic_ticket_id" integer,
	"target_quarter" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"votes" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roadmap_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"roadmap_item_id" integer NOT NULL,
	"voter_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_whiteboard_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"whiteboard_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" "whiteboard_share_role" DEFAULT 'viewer' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_whiteboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"data" jsonb DEFAULT '{"elements":[]}'::jsonb NOT NULL,
	"visibility" "whiteboard_visibility" DEFAULT 'project' NOT NULL,
	"public_access" "whiteboard_share_role" DEFAULT 'viewer' NOT NULL,
	"share_token" text,
	"link_expires_at" timestamp,
	"allow_export" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer,
	"provider" "git_provider" NOT NULL,
	"repo_url" text NOT NULL,
	"repo_name" text,
	"webhook_secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_ticket_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"connection_id" integer,
	"provider" "git_provider" NOT NULL,
	"ref_type" "git_ref_type" NOT NULL,
	"external_id" text NOT NULL,
	"title" text,
	"url" text,
	"author" text,
	"status" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text,
	"action" "ticket_activity_action" NOT NULL,
	"from_value" text,
	"to_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_comment_mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"comment_id" integer NOT NULL,
	"mentioned_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"suite_id" integer,
	"case_number" integer NOT NULL,
	"title" text NOT NULL,
	"preconditions" text,
	"steps" jsonb DEFAULT '[]'::jsonb,
	"expected_result" text,
	"priority" "test_case_priority" DEFAULT 'medium' NOT NULL,
	"component" text,
	"linked_ticket_id" integer,
	"automation_status" "test_case_automation_status" DEFAULT 'manual' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "test_run_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"run_id" integer NOT NULL,
	"test_case_id" integer NOT NULL,
	"status" "test_result_status" DEFAULT 'not_run' NOT NULL,
	"notes" text,
	"executed_by" text,
	"executed_at" timestamp,
	"linked_bug_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"run_number" integer NOT NULL,
	"name" text NOT NULL,
	"sprint_id" integer,
	"release_id" integer,
	"environment" text,
	"browser_device" text,
	"tester_id" text,
	"status" "test_run_status" DEFAULT 'not_started' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "test_suites" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "bugs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"bug_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" "bug_severity" DEFAULT 'major' NOT NULL,
	"priority" "bug_priority" DEFAULT 'medium' NOT NULL,
	"status" "bug_status" DEFAULT 'new' NOT NULL,
	"steps_to_reproduce" text,
	"expected_result" text,
	"actual_result" text,
	"environment" text,
	"browser_device" text,
	"affected_release_id" integer,
	"fixed_release_id" integer,
	"assignee_id" text,
	"reporter_id" text,
	"qa_owner_id" text,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"linked_ticket_id" integer,
	"linked_test_case_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"cr_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"impact" text,
	"estimate_minutes" integer,
	"budget_impact_cents" integer,
	"timeline_impact_days" integer,
	"status" "change_request_status" DEFAULT 'submitted' NOT NULL,
	"requested_by_id" text,
	"approval_owner_id" text,
	"decision_comment" text,
	"decided_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "project_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"entity_type" "approval_entity_type" NOT NULL,
	"entity_id" integer NOT NULL,
	"title" text NOT NULL,
	"reason" text,
	"requested_by_id" text,
	"approver_id" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp,
	"decision_comment" text,
	"decided_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "project_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"decision_number" integer NOT NULL,
	"title" text NOT NULL,
	"context" text,
	"decision" text,
	"options_considered" text,
	"status" "decision_status" DEFAULT 'proposed' NOT NULL,
	"owner_id" text,
	"decided_at" timestamp,
	"revisit_at" timestamp,
	"linked_ticket_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "project_risks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"risk_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"probability" "risk_probability" DEFAULT 'medium' NOT NULL,
	"impact" "risk_impact" DEFAULT 'medium' NOT NULL,
	"status" "risk_status" DEFAULT 'open' NOT NULL,
	"owner_id" text,
	"mitigation" text,
	"linked_ticket_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "meeting_action_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"meeting_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assignee_id" text,
	"due_date" date,
	"status" "action_item_status" DEFAULT 'open' NOT NULL,
	"converted_ticket_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "meeting_attendees" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"meeting_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"attended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_standup_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"meeting_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"yesterday" text,
	"today" text,
	"blockers" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"meeting_number" integer NOT NULL,
	"title" text NOT NULL,
	"type" "meeting_type" DEFAULT 'meeting' NOT NULL,
	"status" "project_meeting_status" DEFAULT 'scheduled' NOT NULL,
	"agenda" text,
	"notes" text,
	"scheduled_at" timestamp,
	"end_at" timestamp,
	"duration_minutes" integer,
	"timezone" text,
	"recurrence_rule" jsonb,
	"sprint_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "incident_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" integer NOT NULL,
	"message" text NOT NULL,
	"new_status" "incident_status",
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"incident_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"severity" "incident_severity" DEFAULT 'medium' NOT NULL,
	"status" "incident_status" DEFAULT 'detected' NOT NULL,
	"impact" text,
	"owner_id" text,
	"root_cause" text,
	"customer_comms" text,
	"detected_at" timestamp,
	"responded_at" timestamp,
	"resolved_at" timestamp,
	"response_due_at" timestamp,
	"resolution_due_at" timestamp,
	"linked_ticket_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"form_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "form_submission_status" DEFAULT 'submitted' NOT NULL,
	"submitted_by_name" text,
	"submitted_by_id" text,
	"converted_ticket_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"form_number" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "form_type" DEFAULT 'generic' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"public_token" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "portfolio_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"portfolio_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"program_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_portfolios" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text,
	"status" "project_portfolio_status" DEFAULT 'active' NOT NULL,
	"health" "project_portfolio_health",
	"strategic_goal" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "project_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"portfolio_id" integer,
	"name" text NOT NULL,
	"description" text,
	"owner_id" text,
	"status" "project_portfolio_status" DEFAULT 'active' NOT NULL,
	"health" "project_portfolio_health",
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer NOT NULL,
	"from_status_id" integer,
	"to_status_id" integer NOT NULL,
	"name" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"required_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "department_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"department_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"manager_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_effective_dated_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"change_type" "hr_effective_dated_change_type" NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" "hr_effective_dated_change_status" DEFAULT 'draft' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"applied_at" timestamp,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_employee_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"bio" text,
	"linkedin_url" text,
	"twitter_url" text,
	"github_url" text,
	"website_url" text,
	"skills" text[] DEFAULT '{}',
	"languages" text[] DEFAULT '{}',
	"education" jsonb,
	"certifications" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_employee_sensitive_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"salary_amount_cents" integer,
	"salary_currency" text DEFAULT 'INR',
	"salary_frequency" text DEFAULT 'MONTHLY',
	"bank_details" jsonb,
	"tax_id" text,
	"pan_number" text,
	"national_id" text,
	"passport_number" text,
	"passport_expiry" date,
	"visa_type" text,
	"visa_expiry" date,
	"medical_notes" text,
	"blood_group" text,
	"disciplinary_records" jsonb,
	"grievance_records" jsonb,
	"bgv_status" text,
	"bgv_completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_employment_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"from_status" "hr_employment_lifecycle_status" NOT NULL,
	"to_status" "hr_employment_lifecycle_status" NOT NULL,
	"reason" text,
	"notes" text,
	"effective_date" date,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_employments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"person_id" integer NOT NULL,
	"employee_number" text NOT NULL,
	"lifecycle_status" "hr_employment_lifecycle_status" DEFAULT 'ACTIVE' NOT NULL,
	"worker_type" "hr_worker_type" DEFAULT 'FULL_TIME' NOT NULL,
	"department_id" integer,
	"job_role_id" integer,
	"job_level_id" integer,
	"employment_type_id" integer,
	"location_id" integer,
	"designation" text,
	"joining_date" date,
	"probation_end_date" date,
	"confirmation_date" date,
	"notice_start_date" date,
	"expected_last_day" date,
	"last_working_day" date,
	"exit_date" date,
	"exit_reason" text,
	"is_primary" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_people" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"work_email" text NOT NULL,
	"personal_email" text,
	"phone" text,
	"date_of_birth" date,
	"gender" text,
	"nationality" text,
	"address" jsonb,
	"emergency_contact" jsonb,
	"avatar_url" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_reporting_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"manager_employment_id" integer NOT NULL,
	"line_type" "hr_reporting_line_type" DEFAULT 'primary' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_custom_field_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"field_type" "hr_custom_field_type" NOT NULL,
	"options" jsonb,
	"settings" jsonb,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_custom_field_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"field_definition_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"value" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_job_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"grade" text,
	"rank" integer DEFAULT 0 NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_job_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"type" text DEFAULT 'OFFICE',
	"address" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"lead_user_id" text,
	"parent_team_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_event" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"webhook_secret" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rule_id" integer NOT NULL,
	"trigger_event" text NOT NULL,
	"event_payload" jsonb,
	"status" "hr_automation_run_status" NOT NULL,
	"action_results" jsonb,
	"error" text,
	"duration_ms" integer,
	"triggered_by_run_id" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_type" "hr_policy_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "hr_policy_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_policy_id" integer,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"rules" jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_policy_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_id" integer NOT NULL,
	"employee_id" text NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_policy_scopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_id" integer NOT NULL,
	"scope_type" "hr_policy_scope_type" NOT NULL,
	"scope_value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_workflow_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"object_type" "hr_workflow_object_type" NOT NULL,
	"name" text NOT NULL,
	"status" "hr_workflow_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_workflow_delegations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"delegator_user_id" text NOT NULL,
	"delegate_user_id" text NOT NULL,
	"object_type" "hr_workflow_object_type",
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_workflow_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"definition_id" integer NOT NULL,
	"definition_snapshot" jsonb NOT NULL,
	"object_type" "hr_workflow_object_type" NOT NULL,
	"object_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"subject_employee_id" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "hr_workflow_instance_status" DEFAULT 'pending' NOT NULL,
	"current_step_order" integer DEFAULT 1 NOT NULL,
	"due_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_workflow_step_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"instance_id" integer NOT NULL,
	"step_order" integer NOT NULL,
	"approver_user_id" text NOT NULL,
	"acted_by_user_id" text NOT NULL,
	"action" "hr_workflow_action" NOT NULL,
	"comment" text,
	"attachments" jsonb,
	"acted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_workflow_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"definition_id" integer NOT NULL,
	"step_order" integer NOT NULL,
	"name" text NOT NULL,
	"approver_type" "hr_workflow_approver_type" NOT NULL,
	"approver_value" text,
	"mode" "hr_workflow_step_mode" DEFAULT 'serial' NOT NULL,
	"sla_hours" integer,
	"escalation_approver_type" "hr_workflow_approver_type",
	"escalation_approver_value" text,
	"condition" jsonb
);
--> statement-breakpoint
CREATE TABLE "hr_template_renders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template_id" integer NOT NULL,
	"template_version" integer NOT NULL,
	"rendered_for_employee_id" integer,
	"rendered_by" text NOT NULL,
	"context_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_html" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "hr_template_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "hr_template_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_template_id" integer,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variables_used" text[] DEFAULT '{}' NOT NULL,
	"letter_type" "hr_letter_type",
	"created_by" text NOT NULL,
	"updated_by" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_id" integer,
	"user_id" text NOT NULL,
	"adjustment_type" "hr_payroll_adjustment_type" NOT NULL,
	"section" "hr_payroll_input_section" NOT NULL,
	"amount_cents" bigint,
	"days" numeric(8, 2),
	"reason" text NOT NULL,
	"source_change_ref" jsonb,
	"status" "hr_payroll_adjustment_status" DEFAULT 'pending' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_input_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_key" text NOT NULL,
	"status" "hr_payroll_input_status" DEFAULT 'open' NOT NULL,
	"cutoff_date" date,
	"built_at" timestamp,
	"locked_at" timestamp,
	"locked_by" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_input_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"section" "hr_payroll_input_section" NOT NULL,
	"payload" jsonb NOT NULL,
	"source_refs" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"check_in" timestamp,
	"check_out" timestamp,
	"status" text DEFAULT 'PRESENT' NOT NULL,
	"work_hours" numeric(6, 2),
	"break_hours" numeric(6, 2) DEFAULT '0' NOT NULL,
	"breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_data" jsonb,
	"is_overtime" boolean DEFAULT false NOT NULL,
	"auto_checked_out" boolean DEFAULT false NOT NULL,
	"location_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"device_type" text NOT NULL,
	"device_name" text NOT NULL,
	"serial_number" text,
	"brand" text,
	"model" text,
	"assigned_date" date,
	"return_date" date,
	"status" "device_status" DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"priority" "ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"status" "ticket_status" DEFAULT 'TODO' NOT NULL,
	"assignee_id" text,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"sla_due_at" timestamp,
	"resolved_at" timestamp,
	"resolution" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"date" date NOT NULL,
	"message" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"notification_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_helpdesk_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_helpdesk_routing" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category" text NOT NULL,
	"assignee_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wfh_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"reason" text,
	"status" "wfh_request_status" DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_attendance_regularizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"attendance_date" date NOT NULL,
	"requested_check_in" timestamp,
	"requested_check_out" timestamp,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"workflow_instance_id" text,
	"approved_by" text,
	"approved_at" timestamp,
	"rejected_by" text,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"attendance_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"balance" numeric(6, 2) DEFAULT '0' NOT NULL,
	"year" integer NOT NULL,
	CONSTRAINT "chk_leave_balance_non_negative" CHECK ("leave_balances"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "leave_blackout_dates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"applies_to" text DEFAULT 'ALL' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"status" "leave_status" DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"rejection_reason" text,
	"manager_comment" text,
	"attachment_url" text,
	"is_half_day" boolean DEFAULT false NOT NULL,
	"half_day_period" text,
	"covering_employee_id" text,
	"lop_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"days_per_year" integer NOT NULL,
	"carry_forward" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_leave_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"txn_type" "hr_leave_txn_type" NOT NULL,
	"days" numeric(8, 2) NOT NULL,
	"effective_date" date NOT NULL,
	"period" text,
	"source" "hr_leave_ledger_source" NOT NULL,
	"source_id" text,
	"note" text,
	"payroll_status" "hr_leave_payroll_status" DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"brand" text,
	"model" text,
	"serial_number" text,
	"assigned_to" text,
	"status" "asset_status" DEFAULT 'AVAILABLE' NOT NULL,
	"purchase_date" date,
	"purchase_cost" numeric(15, 2),
	"location" text,
	"notes" text,
	"expected_return_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"asset_id" integer,
	"asset_name" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"returned_at" timestamp,
	"condition" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bonuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "bonus_type" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reason" text,
	"month" text,
	"taxable" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"budget_limit" numeric(15, 2),
	"budget_period" text DEFAULT 'MONTHLY' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"ledger_account_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"category_id" integer,
	"category" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"description" text,
	"receipt_url" text,
	"receipt_file_name" text,
	"merchant" text,
	"receipt_number" text,
	"receipt_hash" text,
	"tax_amount" numeric(12, 2),
	"payment_method" text,
	"project_id" integer,
	"status" "expense_status" DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"approved_at" timestamp,
	"rejection_reason" text,
	"paid_at" timestamp,
	"transaction_ref" text,
	"reimbursement_batch_id" integer,
	"posted_journal_entry_id" integer,
	"policy_flag" text,
	"expense_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fnf_settlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"resignation_id" integer,
	"basic_dues" numeric(15, 2) DEFAULT '0' NOT NULL,
	"leave_encashment" numeric(15, 2) DEFAULT '0' NOT NULL,
	"bonus_due" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"loan_recovery" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net_payable" numeric(15, 2) DEFAULT '0' NOT NULL,
	"status" "fnf_status" DEFAULT 'DRAFT' NOT NULL,
	"approved_by" text,
	"notes" text,
	"reimbursements_due" numeric(15, 2) DEFAULT '0' NOT NULL,
	"asset_recovery" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notice_recovery" numeric(15, 2) DEFAULT '0' NOT NULL,
	"other_deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"statement_published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payrolls" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"month" text NOT NULL,
	"basic_salary" numeric(15, 2) NOT NULL,
	"hra" numeric(15, 2) DEFAULT '0' NOT NULL,
	"allowances" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"gross_salary" numeric(15, 2) NOT NULL,
	"net_salary" numeric(15, 2) NOT NULL,
	"status" "payroll_status" DEFAULT 'DRAFT' NOT NULL,
	"generated_by" text,
	"approved_by" text,
	"overtime_type" text,
	"overtime_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(6, 2) DEFAULT '0' NOT NULL,
	"overtime_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"payslip_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reimbursements" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"description" text,
	"receipt_url" text,
	"status" "reimbursement_status" DEFAULT 'PENDING' NOT NULL,
	"payroll_month" text,
	"approved_by" text,
	"approved_at" timestamp,
	"paid_at" timestamp,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_loans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"reason" text,
	"emi_amount" numeric(15, 2),
	"total_emis" integer,
	"paid_emis" integer DEFAULT 0 NOT NULL,
	"status" "loan_status" DEFAULT 'PENDING' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"disbursed_at" timestamp,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_structures" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"basic_salary" numeric(15, 2) NOT NULL,
	"hra_percentage" numeric(5, 2) DEFAULT '40' NOT NULL,
	"allowances" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_link_interviewers" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_link_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer,
	"scheduled_at" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"decision" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer NOT NULL,
	"status" "application_status" DEFAULT 'APPLIED' NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	"cover_letter" text,
	"notes" text,
	"tracking_token" text,
	"screening_answers" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_applications_tracking_token_unique" UNIQUE("tracking_token")
);
--> statement-breakpoint
CREATE TABLE "candidate_documents_vault" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"filename" text NOT NULL,
	"s3_key" text NOT NULL,
	"file_url" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"document_type" text,
	"av_result" text DEFAULT 'PENDING' NOT NULL,
	"expires_at" date,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"direction" text DEFAULT 'OUTBOUND' NOT NULL,
	"channel" text DEFAULT 'EMAIL' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"sent_by" text,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp,
	"external_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_offers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer,
	"offered_by" text,
	"offer_status" text DEFAULT 'DRAFT' NOT NULL,
	"offered_salary" numeric(15, 2),
	"offered_designation" text,
	"joining_date" date,
	"offer_letter_url" text,
	"valid_until" date,
	"notes" text,
	"sent_at" timestamp,
	"viewed_at" timestamp,
	"responded_at" timestamp,
	"approved_by" text,
	"approved_at" timestamp,
	"approval_remarks" text,
	"acceptance_token" text,
	"acceptance_token_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_offers_acceptance_token_unique" UNIQUE("acceptance_token")
);
--> statement-breakpoint
CREATE TABLE "candidate_reference_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"reference_name" text NOT NULL,
	"reference_designation" text,
	"reference_company" text,
	"reference_email" text,
	"reference_phone" text,
	"relationship" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"outcome" text,
	"notes" text,
	"contacted_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"referred_by" text NOT NULL,
	"job_posting_id" integer,
	"relationship" text,
	"notes" text,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"bonus_eligible" boolean DEFAULT true NOT NULL,
	"bonus_amount" numeric(12, 2),
	"bonus_paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_sla_tracking" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"stage" text NOT NULL,
	"entered_at" timestamp DEFAULT now() NOT NULL,
	"breached_at" timestamp,
	"status" text DEFAULT 'ON_TRACK' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"platform" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"oauth_token" text,
	"meta" jsonb,
	"last_synced_at" timestamp,
	"last_sync_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"resume_url" text,
	"linkedin_url" text,
	"portfolio_url" text,
	"current_company" text,
	"current_role" text,
	"experience_years" numeric(5, 2),
	"skills" text[],
	"source" text DEFAULT 'DIRECT' NOT NULL,
	"status" "candidate_status" DEFAULT 'NEW' NOT NULL,
	"notes" text,
	"rating" integer,
	"referred_by" text,
	"external_id" text,
	"duplicate_of_id" integer,
	"resume_text" text,
	"ai_score" integer,
	"ai_score_breakdown" jsonb,
	"ai_score_generated_at" timestamp,
	"bgv_status" text DEFAULT 'NOT_INITIATED',
	"bgv_agency" text,
	"bgv_notes" text,
	"bgv_initiated_at" timestamp,
	"bgv_completed_at" timestamp,
	"source_url" text,
	"location" text,
	"gender" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sequence_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer NOT NULL,
	"candidate_id" integer NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"next_send_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "email_sequence_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer NOT NULL,
	"step_order" integer NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"subject" text NOT NULL,
	"html_body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"trigger_type" text DEFAULT 'MANUAL' NOT NULL,
	"target_audience" jsonb DEFAULT '{}'::jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "headcount_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"department_id" integer,
	"requested_by" text NOT NULL,
	"requested_role" text NOT NULL,
	"level" text,
	"justification" text,
	"target_date" date,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"rejected_reason" text,
	"linked_job_posting_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_flow_rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"flow_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"round_type" text DEFAULT 'CUSTOM' NOT NULL,
	"mode" text DEFAULT 'VIDEO' NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"sla_days" integer,
	"question_bank_tag" text,
	"scorecard_template_id" integer,
	"interviewer_role_restriction" text,
	"auto_advance_threshold" integer,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hiring_flows" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_booking_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer,
	"token" text NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"interview_type" text DEFAULT 'VIDEO' NOT NULL,
	"available_slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"selected_slot" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_by" text NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "interview_booking_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "interview_panel_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"interview_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"question" text NOT NULL,
	"category" text DEFAULT 'GENERAL' NOT NULL,
	"role" text,
	"difficulty" text DEFAULT 'MEDIUM' NOT NULL,
	"tags" text[] DEFAULT '{}',
	"sample_answer" text,
	"keywords" text[] DEFAULT '{}',
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_scorecards" (
	"id" serial PRIMARY KEY NOT NULL,
	"interview_id" integer NOT NULL,
	"interviewer_id" text NOT NULL,
	"template_id" integer,
	"ratings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recommendation" text DEFAULT 'MAYBE' NOT NULL,
	"notes" text,
	"is_blind_mode" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_slas" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"stage" text NOT NULL,
	"max_hours" integer DEFAULT 48 NOT NULL,
	"warning_hours" integer DEFAULT 36 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer,
	"interviewer_id" text,
	"type" "interview_type" DEFAULT 'VIDEO' NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"duration" integer DEFAULT 60 NOT NULL,
	"location" text,
	"meeting_link" text,
	"result" "interview_result" DEFAULT 'PENDING' NOT NULL,
	"feedback" text,
	"rating" integer,
	"rubric" jsonb,
	"notes" text,
	"recording_url" text,
	"recording_platform" text,
	"reminders_sent" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"calendar_sync_token" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"department_id" integer,
	"hiring_flow_id" integer,
	"location" text,
	"type" text DEFAULT 'FULL_TIME' NOT NULL,
	"experience" text,
	"salary_min" numeric(15, 2),
	"salary_max" numeric(15, 2),
	"description" text,
	"requirements" text,
	"benefits" text,
	"status" "job_posting_status" DEFAULT 'DRAFT' NOT NULL,
	"openings" integer DEFAULT 1 NOT NULL,
	"application_deadline" date,
	"closing_date" timestamp,
	"posted_by" text,
	"external_posting_ids" jsonb,
	"is_internal" boolean DEFAULT false NOT NULL,
	"screening_questions" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_recruiters" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_posting_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_letter_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"html_content" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_negotiations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"offer_id" integer NOT NULL,
	"direction" text NOT NULL,
	"proposed_salary" numeric(15, 2),
	"proposed_joining_date" date,
	"message" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"offer_id" integer NOT NULL,
	"version_number" integer NOT NULL,
	"offered_salary" numeric(15, 2),
	"offered_designation" text,
	"joining_date" date,
	"valid_until" date,
	"notes" text,
	"change_reason" text,
	"changed_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_automations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"trigger" text NOT NULL,
	"trigger_conditions" jsonb DEFAULT '{}'::jsonb,
	"action" text NOT NULL,
	"action_payload" jsonb DEFAULT '{}'::jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recruiter_activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"recruiter_id" text NOT NULL,
	"action" text NOT NULL,
	"candidate_id" integer,
	"job_posting_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recruitment_vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"website" text,
	"fee_percent" numeric(5, 2),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"contract_type" text DEFAULT 'CONTINGENCY' NOT NULL,
	"sla_days" integer,
	"replacement_guarantee_days" integer,
	"portal_token" text,
	"portal_token_expires_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"report_config" jsonb NOT NULL,
	"schedule" text NOT NULL,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_run_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorecard_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_access_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"vault_document_id" integer NOT NULL,
	"accessed_by" text NOT NULL,
	"action" text DEFAULT 'VIEW' NOT NULL,
	"accessed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_candidate_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"placement_status" text DEFAULT 'SUBMITTED' NOT NULL,
	"invoice_status" text DEFAULT 'NOT_INVOICED' NOT NULL,
	"invoice_amount" numeric(15, 2),
	"invoice_date" date,
	"paid_at" date,
	"bill_rate" numeric(10, 2),
	"pay_rate" numeric(10, 2),
	"contract_start_date" date,
	"contract_end_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alumni_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"current_company" text,
	"current_role" text,
	"linkedin_url" text,
	"email" text,
	"left_date" date,
	"is_opted_in" boolean DEFAULT true NOT NULL,
	"rehire_eligibility" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"provider" text,
	"reference_number" text,
	"result" text,
	"notes" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"candidate_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"template_id" integer,
	"title" text NOT NULL,
	"html_content" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'GENERATED' NOT NULL,
	"external_doc_id" text,
	"sent_at" timestamp,
	"viewed_at" timestamp,
	"signed_at" timestamp,
	"declined_at" timestamp,
	"acceptance_deadline" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"issuing_organization" text,
	"issue_date" date,
	"expiry_date" date,
	"credential_id" text,
	"credential_url" text,
	"document_url" text,
	"reminder_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"onboarding_document_id" integer NOT NULL,
	"action" "doc_audit_action" NOT NULL,
	"performed_by" text NOT NULL,
	"remarks" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_template_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"html_content" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp DEFAULT now() NOT NULL,
	"archived_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'OFFER' NOT NULL,
	"html_content" text DEFAULT '' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"is_mandatory" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"applicable_roles" text[] DEFAULT '{}',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_checklists" (
	"id" serial PRIMARY KEY NOT NULL,
	"resignation_id" integer NOT NULL,
	"item" text NOT NULL,
	"assigned_to" text,
	"status" "exit_checklist_status" DEFAULT 'PENDING' NOT NULL,
	"completed_at" timestamp,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "onboarding_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"document_type_id" integer NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer,
	"mime_type" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "onboarding_document_status" DEFAULT 'SUBMITTED' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"remarks" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"template_step_id" integer,
	"title" text NOT NULL,
	"description" text,
	"owner_role" text DEFAULT 'NEW_HIRE' NOT NULL,
	"due_date" timestamp,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"completed_at" timestamp,
	"completed_by" text,
	"depends_on_task_ids" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_template_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner_role" text DEFAULT 'NEW_HIRE' NOT NULL,
	"due_offset_days" integer DEFAULT 0 NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"is_compliance_item" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"department_id" integer,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resignations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text,
	"reason_category" text,
	"last_working_date" date,
	"notice_period_days" integer DEFAULT 30 NOT NULL,
	"status" "resignation_status" DEFAULT 'SUBMITTED' NOT NULL,
	"resignation_letter_url" text,
	"approved_by" text,
	"approved_at" timestamp,
	"hr_reviewed_by" text,
	"hr_reviewed_at" timestamp,
	"hr_remarks" text,
	"ceo_reviewed_by" text,
	"ceo_reviewed_at" timestamp,
	"ceo_remarks" text,
	"willing_for_exit_interview" boolean DEFAULT true NOT NULL,
	"company_feedback" text,
	"exit_interview_notes" text,
	"exit_interview_date" timestamp,
	"exit_interview_conducted_by" text,
	"feedback" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"detailed_explanation" text NOT NULL,
	"effective_date" date NOT NULL,
	"severance_amount" numeric(15, 2),
	"notice_period_waived" boolean DEFAULT false NOT NULL,
	"termination_letter_url" text,
	"supporting_doc_urls" text[] DEFAULT '{}',
	"internal_notes" text,
	"status" "termination_status" DEFAULT 'DRAFT' NOT NULL,
	"initiated_by" text,
	"ceo_reviewed_by" text,
	"ceo_reviewed_at" timestamp,
	"ceo_remarks" text,
	"email_sent_at" timestamp,
	"email_status" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_board_postings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_posting_id" integer NOT NULL,
	"platform" text NOT NULL,
	"external_post_url" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"posted_by" text,
	"posted_at" timestamp,
	"expiry_date" timestamp,
	"spend" numeric(12, 2),
	"applicant_count" integer DEFAULT 0 NOT NULL,
	"qualified_count" integer DEFAULT 0 NOT NULL,
	"hired_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "talent_pool_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool_id" integer NOT NULL,
	"candidate_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"notes" text,
	"added_by" text,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "talent_pools" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"referrer_id" integer NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_posting_id" integer,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"reward_amount" numeric(12, 2),
	"reward_paid_at" timestamp,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_referrers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"referral_token" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"email_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"assessment_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"answers" jsonb,
	"score" integer,
	"passed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enps_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"score" integer NOT NULL,
	"comment" text,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"period" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"reviewer_user_id" text NOT NULL,
	"type" "feedback_type" NOT NULL,
	"cycle_id" integer,
	"ratings" jsonb,
	"strengths" text,
	"improvements" text,
	"overall_rating" integer,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'OKR' NOT NULL,
	"target_value" numeric(15, 2),
	"current_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"unit" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'IN_PROGRESS' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"parent_goal_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_calibration_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"cycle_id" integer NOT NULL,
	"employee_id" text NOT NULL,
	"pre_rating" numeric(3, 1),
	"post_rating" numeric(3, 1),
	"calibrated_by" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"goal_id" integer NOT NULL,
	"title" text NOT NULL,
	"target_value" numeric(15, 2),
	"current_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"unit" text,
	"progress" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_on_one_meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"duration" integer DEFAULT 30 NOT NULL,
	"status" "meeting_status" DEFAULT 'SCHEDULED' NOT NULL,
	"notes" text,
	"action_items" jsonb,
	"agenda" text,
	"meeting_link" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_improvement_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"manager_id" text NOT NULL,
	"hr_rep_id" text,
	"reason" text NOT NULL,
	"objectives" jsonb,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "pip_status" DEFAULT 'ACTIVE' NOT NULL,
	"outcome" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reviewer_id" text,
	"cycle_id" integer,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" "review_status" DEFAULT 'DRAFT' NOT NULL,
	"ratings" jsonb,
	"strengths" text,
	"improvements" text,
	"goals" jsonb,
	"overall_rating" numeric(4, 2),
	"comments" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pulse_surveys" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"questions" jsonb,
	"status" "survey_status" DEFAULT 'DRAFT' NOT NULL,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"closes_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recognitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"message" text NOT NULL,
	"category" text DEFAULT 'KUDOS' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'QUARTERLY' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"deadline" date,
	"status" "review_cycle_status" DEFAULT 'DRAFT' NOT NULL,
	"description" text,
	"template_id" integer,
	"template_version" integer,
	"rating_scale" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_assessments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"skill_name" text NOT NULL,
	"questions" jsonb,
	"passing_score" integer DEFAULT 70 NOT NULL,
	"time_limit" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"survey_id" integer NOT NULL,
	"user_id" text,
	"answers" jsonb,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_ladders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"department" text,
	"description" text,
	"levels" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"department_id" integer,
	"name" text NOT NULL,
	"description" text,
	"type" "document_type" NOT NULL,
	"category" text,
	"file_url" text NOT NULL,
	"file_name" text,
	"file_size" integer,
	"mime_type" text,
	"version" integer DEFAULT 1 NOT NULL,
	"parent_document_id" integer,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expiry_date" date,
	"expiry_reminder_sent" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"metadata" jsonb,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'GENERAL' NOT NULL,
	"variables" text[],
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handbook_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"version" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"document_id" integer,
	"document_url" text,
	"changelog" text,
	"published_at" timestamp,
	"published_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_role" text,
	"level" text,
	"estimated_hours" integer,
	"steps" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policy_acknowledgments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"document_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" "ack_status" DEFAULT 'PENDING' NOT NULL,
	"acknowledged_at" timestamp,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rich_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"content_json" jsonb,
	"template_type" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_event_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'GOING' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'TEAM_BUILDING' NOT NULL,
	"date" date NOT NULL,
	"time" text,
	"location" text,
	"max_participants" integer,
	"organized_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_shift_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"shift_id" integer NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_swap_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"requester_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"request_date" text NOT NULL,
	"target_date" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'FIXED' NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"break_minutes" integer DEFAULT 60 NOT NULL,
	"is_night_shift" boolean DEFAULT false NOT NULL,
	"grace_period_minutes" integer DEFAULT 15 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"roster_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"shift_id" integer,
	"date" date NOT NULL,
	"is_day_off" jsonb DEFAULT 'false'::jsonb,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rosters" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comp_off_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"earned_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"used_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"expiry_date" date,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"hours" numeric(5, 2) NOT NULL,
	"reason" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"convert_to_comp_off" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geofences" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"lat" numeric(10, 7) NOT NULL,
	"lng" numeric(10, 7) NOT NULL,
	"radius_meters" integer DEFAULT 200 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"ip_address" text NOT NULL,
	"port" integer DEFAULT 4370 NOT NULL,
	"vendor" text DEFAULT 'ZKTeco' NOT NULL,
	"location" text,
	"is_online" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" integer NOT NULL,
	"user_id" text,
	"biometric_user_id" text,
	"punch_time" timestamp NOT NULL,
	"punch_type" text DEFAULT 'IN' NOT NULL,
	"raw_data" jsonb,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "course_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'ENROLLED' NOT NULL,
	"progress_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"completed_at" timestamp,
	"score" numeric(5, 2),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category_id" integer,
	"title" text NOT NULL,
	"description" text,
	"instructor_id" text,
	"external_instructor" text,
	"type" text DEFAULT 'INTERNAL' NOT NULL,
	"format" text DEFAULT 'SELF_PACED' NOT NULL,
	"duration_hours" numeric(6, 2),
	"prerequisites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thumbnail_url" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'ENROLLED' NOT NULL,
	"feedback_rating" integer,
	"feedback_text" text,
	"certificate_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'MANDATORY' NOT NULL,
	"format" text DEFAULT 'CLASSROOM' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text,
	"venue" text,
	"virtual_link" text,
	"max_capacity" integer,
	"instructor_id" text,
	"external_instructor" text,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_requisitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"department" text,
	"location" text,
	"headcount" integer DEFAULT 1 NOT NULL,
	"budget_min" numeric(15, 2),
	"budget_max" numeric(15, 2),
	"hiring_manager_id" text,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"type" text DEFAULT 'FULL_TIME' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"requested_by" text NOT NULL,
	"approver_id" text,
	"approved_at" timestamp,
	"rejection_reason" text,
	"justification" text,
	"target_date" text,
	"linked_job_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"framework_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"weight" numeric(5, 2) DEFAULT '1' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competency_frameworks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rating_scale" integer DEFAULT 5 NOT NULL,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kpi_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"unit" text,
	"target" numeric(10, 2),
	"weight" numeric(5, 2) DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_cycle_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_id" integer NOT NULL,
	"subject_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"relationship" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"submitted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_cycle_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_rating" integer,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT '360' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"is_anonymous" boolean DEFAULT true NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"destination" text NOT NULL,
	"departure_date" text NOT NULL,
	"return_date" text NOT NULL,
	"flight_required" boolean DEFAULT false NOT NULL,
	"hotel_required" boolean DEFAULT false NOT NULL,
	"advance_required" boolean DEFAULT false NOT NULL,
	"advance_amount" numeric(15, 2),
	"estimated_cost" numeric(15, 2),
	"per_diem" numeric(15, 2),
	"itinerary" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"manager_approver_id" text,
	"manager_approved_at" timestamp,
	"finance_approver_id" text,
	"finance_approved_at" timestamp,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "career_paths" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"department" text,
	"levels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_career_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"path_id" integer,
	"current_level" integer DEFAULT 1 NOT NULL,
	"target_role" text,
	"target_date" text,
	"aspirations" text,
	"mentor_id" text,
	"milestones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"leave_type_id" integer NOT NULL,
	"name" text NOT NULL,
	"accrual_type" text DEFAULT 'ANNUAL' NOT NULL,
	"accrual_rate" numeric(6, 2) NOT NULL,
	"max_balance" numeric(6, 2),
	"carry_forward_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"carry_forward_expiry_months" integer,
	"encashable" boolean DEFAULT false NOT NULL,
	"probation_restricted" boolean DEFAULT false NOT NULL,
	"gender_restriction" text,
	"applies_to" text DEFAULT 'ALL' NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcement_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"announcement_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcement_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"announcement_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"author_id" text NOT NULL,
	"target_type" text DEFAULT 'ALL' NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"publish_at" timestamp,
	"expires_at" timestamp,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"attachment_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_structure_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"basic_salary" numeric(15, 2) NOT NULL,
	"hra_percent" numeric(5, 2) DEFAULT '40' NOT NULL,
	"special_allowance" numeric(15, 2) DEFAULT '0',
	"medical_allowance" numeric(15, 2) DEFAULT '0',
	"travel_allowance" numeric(15, 2) DEFAULT '0',
	"other_allowances" numeric(15, 2) DEFAULT '0',
	"pf_deduction_percent" numeric(5, 2) DEFAULT '12',
	"professional_tax" numeric(10, 2) DEFAULT '200',
	"effective_from" text NOT NULL,
	"effective_to" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allowance_types" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"formula_type" text DEFAULT 'FIXED' NOT NULL,
	"value" numeric(10, 4),
	"cap" numeric(15, 2),
	"is_taxable" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investment_proofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"declaration_id" integer NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"description" text,
	"proof_url" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_declarations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"financial_year" text NOT NULL,
	"regime" text DEFAULT 'NEW' NOT NULL,
	"hra" numeric(15, 2) DEFAULT '0' NOT NULL,
	"lta" numeric(15, 2) DEFAULT '0' NOT NULL,
	"section_80c" numeric(15, 2) DEFAULT '0' NOT NULL,
	"section_80d" numeric(15, 2) DEFAULT '0' NOT NULL,
	"section_80g" numeric(15, 2) DEFAULT '0' NOT NULL,
	"home_loan_interest" numeric(15, 2) DEFAULT '0' NOT NULL,
	"previous_employment_income" numeric(15, 2) DEFAULT '0' NOT NULL,
	"previous_employer_tds" numeric(15, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"verified_by" text,
	"verified_at" timestamp,
	"review_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"month" text NOT NULL,
	"total_amount" numeric(15, 2) NOT NULL,
	"employee_count" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"bank_file_url" text,
	"reference_no" text,
	"processed_at" timestamp,
	"created_by" text,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_accounting_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"component_id" integer,
	"category" text,
	"ledger_name" text NOT NULL,
	"cost_center_source" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_id" integer,
	"month" text,
	"type" "payroll_calendar_event_type" NOT NULL,
	"date" date NOT NULL,
	"title" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"status" "payroll_policy_status" DEFAULT 'DRAFT' NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"legal_entity_name" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"pay_frequency" "pay_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"pay_day" integer DEFAULT 28 NOT NULL,
	"employee_count" integer,
	"start_month" text NOT NULL,
	"active_version_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_policy_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_id" integer NOT NULL,
	"version" integer NOT NULL,
	"template_key" text,
	"toggles" jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"status" "payroll_policy_status" DEFAULT 'DRAFT' NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_template_activations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_version_id" integer NOT NULL,
	"template_key" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"activated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"stage" integer NOT NULL,
	"stage_name" text NOT NULL,
	"required_permission" text NOT NULL,
	"status" "payroll_approval_status" DEFAULT 'PENDING' NOT NULL,
	"acted_by" text,
	"acted_at" timestamp,
	"comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"run_employee_id" integer,
	"user_id" text,
	"code" text NOT NULL,
	"severity" "payroll_exception_severity" NOT NULL,
	"status" "payroll_exception_status" DEFAULT 'OPEN' NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"resolved_by" text,
	"resolved_at" timestamp,
	"override_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"run_employee_id" integer NOT NULL,
	"component_id" integer,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "salary_component_type" NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"calc_method" "salary_component_calc_method" NOT NULL,
	"calc_explain" jsonb NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_run_employees" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"profile_id" integer,
	"worker_type" "payroll_worker_type" DEFAULT 'EMPLOYEE' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"payout_currency" text,
	"fx_rate" numeric(12, 6),
	"scheduled_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"paid_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"lop_days" numeric(5, 1) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(6, 2) DEFAULT '0' NOT NULL,
	"gross" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total_deductions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"employer_contributions" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net_payout_currency" numeric(15, 2),
	"status" text DEFAULT 'PENDING' NOT NULL,
	"hold_reason" text,
	"inputs_snapshot" jsonb,
	"calculation_snapshot" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"policy_version_id" integer,
	"month" text NOT NULL,
	"status" "payroll_run_status" DEFAULT 'PREPARING' NOT NULL,
	"pay_date" date,
	"gross_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deduction_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"employer_cost_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net_total" numeric(15, 2) DEFAULT '0' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp,
	"locked_by" text,
	"approved_at" timestamp,
	"approved_by" text,
	"paid_at" timestamp,
	"paid_by" text,
	"published_at" timestamp,
	"published_by" text,
	"closed_at" timestamp,
	"closed_by" text,
	"reopened_at" timestamp,
	"reopened_by" text,
	"reopen_reason" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_bank_batch_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"run_employee_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"account_masked" text NOT NULL,
	"ifsc" text,
	"status" "payroll_bank_item_status" DEFAULT 'PENDING' NOT NULL,
	"failure_reason" text,
	"transaction_ref" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_bank_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"batch_number" text NOT NULL,
	"status" "payroll_bank_batch_status" DEFAULT 'DRAFT' NOT NULL,
	"format" text NOT NULL,
	"total_amount" numeric(15, 2) NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"file_key" text,
	"generated_by" text,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslip_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"layout" "payslip_layout" NOT NULL,
	"config" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_salary_profile_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"profile_id" integer NOT NULL,
	"component_id" integer NOT NULL,
	"calc_method_override" "salary_component_calc_method",
	"amount" numeric(15, 2),
	"percent" numeric(7, 4),
	"formula_override" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_salary_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"worker_type" "payroll_worker_type" DEFAULT 'EMPLOYEE' NOT NULL,
	"pay_frequency" "pay_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"payout_currency" text,
	"fx_source" text,
	"tax_regime" "tax_regime_type",
	"cost_center" text,
	"annual_ctc" numeric(15, 2) NOT NULL,
	"status" "salary_profile_status" DEFAULT 'ACTIVE' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"policy_version_id" integer,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_loan_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"run_id" integer,
	"type" "payroll_loan_adjustment_type" NOT NULL,
	"amount" numeric(15, 2),
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "salary_component_type" NOT NULL,
	"calc_method" "salary_component_calc_method" NOT NULL,
	"amount" numeric(15, 2),
	"percent" numeric(7, 4),
	"formula" text,
	"taxable" boolean DEFAULT false NOT NULL,
	"show_on_payslip" boolean DEFAULT true NOT NULL,
	"include_in_ctc" boolean DEFAULT true NOT NULL,
	"is_statutory" boolean DEFAULT false NOT NULL,
	"statutory_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"employee_id" text NOT NULL,
	"system_name" text NOT NULL,
	"access_level" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"granted_by" text,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_probation_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"probation_end_date" date NOT NULL,
	"status" text DEFAULT 'in_probation' NOT NULL,
	"extension_count" integer DEFAULT 0 NOT NULL,
	"extended_until" date,
	"review_template_id" integer,
	"review_notes" jsonb,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_mentorships" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mentor_id" text NOT NULL,
	"mentee_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" date,
	"ended_at" date,
	"goal" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_role_skill_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_role_id" integer,
	"role_name" text,
	"skill_name" text NOT NULL,
	"required_level" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_succession_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"role_name" text NOT NULL,
	"job_role_id" integer,
	"incumbent_id" text,
	"successor_id" text NOT NULL,
	"readiness" "succession_readiness" DEFAULT 'ready_now' NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_badge_awards" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"badge_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"awarded_by" text,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_badges" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"points" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"status" "engagement_campaign_status" DEFAULT 'draft' NOT NULL,
	"audience" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_communities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_community_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" "community_member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_mood_checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"mood" integer NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_poll_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"option_index" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_polls" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"status" "hr_poll_status" DEFAULT 'draft' NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"closes_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_reward_points_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"points" integer NOT NULL,
	"source" "reward_point_source" NOT NULL,
	"source_id" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_case_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"restricted" boolean DEFAULT false NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_case_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"author_id" text,
	"note" text NOT NULL,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"case_number" text NOT NULL,
	"category" "hr_case_category" NOT NULL,
	"subject_employee_id" text,
	"reported_by" text,
	"anonymous" boolean DEFAULT false NOT NULL,
	"confidential" boolean DEFAULT true NOT NULL,
	"severity" "hr_case_severity" NOT NULL,
	"status" "hr_case_status" DEFAULT 'open' NOT NULL,
	"summary" text NOT NULL,
	"details" text NOT NULL,
	"outcome" text,
	"resolved_at" timestamp,
	"assigned_to" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_disciplinary_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"case_id" integer,
	"employee_id" text NOT NULL,
	"action_type" "hr_disciplinary_action_type" NOT NULL,
	"letter_render_id" integer,
	"effective_date" timestamp NOT NULL,
	"issued_by" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_safety_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_number" text NOT NULL,
	"type" "hr_safety_incident_type" NOT NULL,
	"location" text NOT NULL,
	"occurred_at" timestamp NOT NULL,
	"reported_by" text NOT NULL,
	"description" text NOT NULL,
	"severity" "hr_safety_incident_severity" NOT NULL,
	"status" "hr_safety_incident_status" DEFAULT 'open' NOT NULL,
	"medical_attention" boolean DEFAULT false NOT NULL,
	"confidential_medical_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_wellness_checkins" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"score" integer NOT NULL,
	"flags" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_benefit_enrollment_windows" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" integer,
	"opens_at" timestamp NOT NULL,
	"closes_at" timestamp NOT NULL,
	"status" "hr_enrollment_window_status" DEFAULT 'upcoming' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_benefit_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" "hr_enrollment_status" DEFAULT 'pending' NOT NULL,
	"enrolled_at" timestamp DEFAULT now() NOT NULL,
	"effective_from" date,
	"dependents_covered" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_benefit_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"category" "hr_benefit_category" NOT NULL,
	"provider" text,
	"description" text,
	"coverage" jsonb,
	"premium_cents" integer,
	"employer_contribution_pct" integer DEFAULT 0 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" "hr_benefit_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_dependents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"relationship" "hr_dependent_relationship" NOT NULL,
	"date_of_birth" date,
	"is_covered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_insurance_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"plan_id" integer NOT NULL,
	"claim_number" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "hr_claim_status" DEFAULT 'submitted' NOT NULL,
	"documents" jsonb,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" text,
	"rejection_reason" text,
	"payout_route" "hr_claim_payout_route",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_loan_repayments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"installment_no" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "hr_loan_repayment_status" DEFAULT 'pending' NOT NULL,
	"payroll_period_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_travel_visit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"travel_request_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"visited_at" timestamp NOT NULL,
	"location" text NOT NULL,
	"lat" text,
	"lng" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subscription_id" integer NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "hr_webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"response_status" integer,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_webhook_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"entity" "hr_import_entity" NOT NULL,
	"file_name" text NOT NULL,
	"status" "hr_import_status" DEFAULT 'validating' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"valid_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"created_by" text,
	"committed_at" timestamp,
	"rolled_back_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "hr_import_row_status" DEFAULT 'valid' NOT NULL,
	"error" text,
	"created_record_ref" jsonb
);
--> statement-breakpoint
CREATE TABLE "hr_compliance_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"requirement_id" integer NOT NULL,
	"due_date" date NOT NULL,
	"status" "hr_compliance_event_status" DEFAULT 'pending' NOT NULL,
	"completed_by" text,
	"completed_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_compliance_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text,
	"state_code" text,
	"category" "hr_compliance_category" NOT NULL,
	"frequency" "hr_compliance_frequency" NOT NULL,
	"due_rule" jsonb NOT NULL,
	"reminder_days_before" integer DEFAULT 7 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"contract_type" "hr_contract_type" NOT NULL,
	"agency_vendor" text,
	"start_date" date NOT NULL,
	"end_date" date,
	"renewal_reminder_days" integer DEFAULT 30 NOT NULL,
	"stipend_cents" integer,
	"timesheet_based" boolean DEFAULT false NOT NULL,
	"status" "hr_contract_status" DEFAULT 'active' NOT NULL,
	"document_url" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_work_authorizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"employment_id" integer NOT NULL,
	"auth_type" "hr_work_auth_type" NOT NULL,
	"country_code" text NOT NULL,
	"document_number_masked" text,
	"valid_from" date,
	"valid_until" date,
	"status" "hr_work_auth_status" DEFAULT 'active' NOT NULL,
	"verified_by" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_headcount_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"department_id" integer,
	"budgeted_headcount" integer NOT NULL,
	"budgeted_cost_cents" integer,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_hiring_plan_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan_id" integer NOT NULL,
	"role_title" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"target_quarter" integer,
	"status" text DEFAULT 'planned' NOT NULL,
	"linked_requisition_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"form_id" integer NOT NULL,
	"form_schema_snapshot" jsonb NOT NULL,
	"submitted_by" text,
	"submitted_by_name" text,
	"subject_employee_id" integer,
	"data" jsonb NOT NULL,
	"status" "hr_form_submission_status" DEFAULT 'submitted' NOT NULL,
	"workflow_instance_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" "hr_form_status" DEFAULT 'draft' NOT NULL,
	"audience" "hr_form_audience" DEFAULT 'internal' NOT NULL,
	"workflow_object_type" text,
	"schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_collective_agreements" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"union_name" text NOT NULL,
	"title" text NOT NULL,
	"effective_from" timestamp NOT NULL,
	"expires_at" timestamp,
	"document_url" text,
	"status" "hr_collective_agreement_status" DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_data_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"type" "hr_data_request_type" NOT NULL,
	"status" "hr_data_request_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"approved_by" text,
	"reason" text,
	"completed_at" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_labor_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"union_name" text NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"status" "hr_labor_case_status" DEFAULT 'open' NOT NULL,
	"created_by" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_legal_hold_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"hold_id" integer NOT NULL,
	"item_type" "hr_legal_hold_item_type" NOT NULL,
	"item_ref" text NOT NULL,
	"locked" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_legal_holds" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subject_user_id" text,
	"reason" text NOT NULL,
	"status" "hr_legal_hold_status" DEFAULT 'active' NOT NULL,
	"placed_by" text,
	"placed_at" timestamp DEFAULT now() NOT NULL,
	"released_by" text,
	"released_at" timestamp,
	"restricted_export" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"department_id" integer,
	"job_level_id" integer,
	"status" "hr_position_status" DEFAULT 'open' NOT NULL,
	"budgeted_cost_cents" integer,
	"effective_from" timestamp NOT NULL,
	"incumbent_user_id" text,
	"future_dated" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_proxy_access" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"grantor_user_id" text NOT NULL,
	"proxy_user_id" text NOT NULL,
	"scope" "hr_proxy_scope" NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"disallow_sensitive" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_reorg_scenarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "hr_reorg_scenario_status" DEFAULT 'draft' NOT NULL,
	"changes" jsonb NOT NULL,
	"created_by" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_retention_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"record_type" "hr_retention_record_type" NOT NULL,
	"retention_months" integer NOT NULL,
	"country_code" text,
	"action" "hr_retention_action" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_union_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"union_name" text NOT NULL,
	"member_since" timestamp NOT NULL,
	"status" "hr_union_membership_status" DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_arrears_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source_period" text NOT NULL,
	"target_period" text NOT NULL,
	"status" "hr_arrears_status" DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_comp_budget_pools" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"cycle_id" integer NOT NULL,
	"department_id" integer,
	"allocated_cents" bigint NOT NULL,
	"used_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_comp_cycles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"status" "hr_comp_cycle_status" DEFAULT 'draft' NOT NULL,
	"budget_pool_cents" bigint NOT NULL,
	"merit_matrix" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_comp_recommendations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"cycle_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"current_salary_cents" bigint NOT NULL,
	"recommended_increase_cents" bigint NOT NULL,
	"recommended_pct" numeric(8, 4) NOT NULL,
	"rating" text,
	"manager_note" text,
	"hr_calibrated_cents" bigint,
	"status" "hr_comp_recommendation_status" DEFAULT 'draft' NOT NULL,
	"submitted_by" text,
	"calibrated_by" text,
	"approved_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_device_employee_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"biometric_id" text,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_device_sync_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" integer NOT NULL,
	"status" "hr_device_sync_status" NOT NULL,
	"records_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"synced_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_equity_exercises" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"grant_id" integer NOT NULL,
	"exercise_date" date NOT NULL,
	"units" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_equity_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"grant_type" "hr_equity_grant_type" NOT NULL,
	"units" integer NOT NULL,
	"strike_price_cents" bigint,
	"grant_date" date NOT NULL,
	"cliff_months" integer NOT NULL,
	"vesting_months" integer NOT NULL,
	"status" "hr_equity_grant_status" DEFAULT 'active' NOT NULL,
	"board_approved_at" timestamp,
	"document_url" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_equity_vesting_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"grant_id" integer NOT NULL,
	"vest_date" date NOT NULL,
	"units_vested" integer NOT NULL,
	"cumulative_vested" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_compliance_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"country_code" text NOT NULL,
	"name" text NOT NULL,
	"due_date" date NOT NULL,
	"status" "hr_compliance_task_status" DEFAULT 'pending' NOT NULL,
	"notes" text,
	"completed_by" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_payroll_variance_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"payroll_period_key" text NOT NULL,
	"variance_pct" numeric(8, 4) NOT NULL,
	"threshold_pct" numeric(8, 4) NOT NULL,
	"status" "hr_variance_approval_status" DEFAULT 'pending' NOT NULL,
	"approver_id" text,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_time_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"serial_number" text NOT NULL,
	"type" "hr_time_device_type" NOT NULL,
	"location_id" integer,
	"status" "hr_time_device_status" DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp,
	"effective_from" date,
	"effective_to" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_access_provisioning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"system_name" text NOT NULL,
	"action" "hr_access_provisioning_action" NOT NULL,
	"status" "hr_access_provisioning_status" DEFAULT 'pending' NOT NULL,
	"triggered_by" "hr_access_provisioning_trigger" NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"verified_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_access_provisioning_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"triggered_by" "hr_access_provisioning_trigger" NOT NULL,
	"systems_config" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_accommodation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "hr_accommodation_type" NOT NULL,
	"description" text NOT NULL,
	"confidential_medical_note" text,
	"status" "hr_accommodation_status" DEFAULT 'requested' NOT NULL,
	"reviewed_by" text,
	"review_date" date,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_accommodation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"title" text NOT NULL,
	"assignee_user_id" text,
	"status" "hr_accommodation_task_status" DEFAULT 'pending' NOT NULL,
	"due_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_emergency_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "hr_emergency_event_type" NOT NULL,
	"location_id" text,
	"status" "hr_emergency_event_status" DEFAULT 'active' NOT NULL,
	"message" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_emergency_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" "hr_emergency_response_status" DEFAULT 'no_response' NOT NULL,
	"responded_at" timestamp,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_event_stream" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_user_id" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"type" "hr_simulation_type" NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "crm_campaign_status" DEFAULT 'active' NOT NULL,
	"channel" text,
	"description" text,
	"start_date" date,
	"end_date" date,
	"target_audience" text,
	"leads" integer DEFAULT 0 NOT NULL,
	"spend" numeric(15, 2) DEFAULT '0' NOT NULL,
	"roi" numeric(8, 4) DEFAULT '0' NOT NULL,
	"budget_allocated" numeric(15, 2),
	"budget_spent" numeric(15, 2),
	"utm_campaign_key" text,
	"owner_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"campaign_id" integer,
	"email" text,
	"name" text,
	"status" "crm_lead_status" DEFAULT 'lead' NOT NULL,
	"channel" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_rule_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"last_assigned_index" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "assignment_rule_state_rule_id_unique" UNIQUE("rule_id")
);
--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" integer NOT NULL,
	"type" text NOT NULL,
	"date" timestamp NOT NULL,
	"duration" integer,
	"subject" text,
	"location" text,
	"location_link" text,
	"message_summary" text,
	"notes" text,
	"outcome" text,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_assignment_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb,
	"assignment_type" "assignment_rule_type" NOT NULL,
	"assign_to_user_id" text,
	"round_robin_user_ids" jsonb DEFAULT '[]'::jsonb,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignment_type_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"direction" "lead_email_direction" NOT NULL,
	"subject" text,
	"body" text,
	"from_email" text NOT NULL,
	"to_email" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"created_by" text NOT NULL,
	"filename" text NOT NULL,
	"status" text DEFAULT 'PROCESSING' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"error_report" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "lead_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_scoring_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"field" text NOT NULL,
	"operator" "scoring_operator" NOT NULL,
	"value" text NOT NULL,
	"points" integer NOT NULL,
	"dimension" text DEFAULT 'fit' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"due_date" date,
	"assignee_id" text,
	"status" "lead_task_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"whatsapp_number" text,
	"source" text DEFAULT 'other' NOT NULL,
	"campaign_id" integer,
	"status" text DEFAULT 'NEW' NOT NULL,
	"priority" text DEFAULT 'WARM' NOT NULL,
	"investment_interest" numeric(15, 2),
	"potential_value" numeric(15, 2),
	"notes" text,
	"assigned_to_id" text,
	"assigned_by_id" text,
	"verified_by_id" text,
	"assigned_at" timestamp,
	"converted_at" timestamp,
	"lost_reason" text,
	"company" text,
	"designation" text,
	"city" text,
	"referred_by" text,
	"tags" text[],
	"score" integer DEFAULT 0 NOT NULL,
	"sla_deadline" timestamp,
	"website" text,
	"sub_source" text,
	"dm_lead_id" integer,
	"follow_up_date" timestamp,
	"follow_up_notes" text,
	"custom_data" jsonb,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"ip_address" text,
	"referrer_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"merged_into_id" integer
);
--> statement-breakpoint
CREATE TABLE "web_lead_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"public_token" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"submit_message" text DEFAULT 'Thank you! We''ll be in touch soon.' NOT NULL,
	"redirect_url" text,
	"total_submissions" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "web_lead_forms_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"city" text,
	"state" text,
	"country" text DEFAULT 'India' NOT NULL,
	"pincode" text,
	"address" text,
	"phone" text,
	"email" text,
	"branch_manager_id" text,
	"branch_hr_id" text,
	"status" "branch_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_account_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"client_account_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"branch_id" integer,
	"lead_id" integer NOT NULL,
	"sales_rep_id" text NOT NULL,
	"assigned_crm_id" text,
	"client_name" text NOT NULL,
	"client_email" text,
	"client_phone" text,
	"client_whatsapp" text,
	"status" "client_account_status" DEFAULT 'ACCOUNT_OPENING' NOT NULL,
	"investment_amount" numeric(15, 2),
	"plan_name" text,
	"investment_date" timestamp,
	"transaction_ref" text,
	"conversion_notes" text,
	"estimated_investment" numeric(15, 2),
	"converted_at" timestamp DEFAULT now() NOT NULL,
	"invested_at" timestamp,
	"renewal_stage" text DEFAULT 'upcoming' NOT NULL,
	"renewal_date" date,
	"renewal_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_onboarding_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer NOT NULL,
	"template_id" integer,
	"title" text NOT NULL,
	"description" text,
	"assigned_to" text,
	"due_date" date,
	"completed_at" timestamp,
	"completed_by" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_onboarding_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'upsell' NOT NULL,
	"stage" text DEFAULT 'identified' NOT NULL,
	"value" numeric(15, 2),
	"notes" text,
	"expected_close_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" integer,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"designation" text,
	"city" text,
	"state" text,
	"gstin" text,
	"is_vendor" boolean DEFAULT false NOT NULL,
	"investment_value" numeric(15, 2),
	"status" text DEFAULT 'active' NOT NULL,
	"account_manager_id" text,
	"notes" text,
	"health_score" integer DEFAULT 50 NOT NULL,
	"health_status" "crm_health" DEFAULT 'healthy' NOT NULL,
	"last_health_check" timestamp,
	"churn_risk_score" integer,
	"churn_risk_reasoning" text,
	"converted_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"title" text,
	"department" text,
	"company" text,
	"organization_id" integer,
	"linkedin_url" text,
	"twitter_url" text,
	"website_url" text,
	"avatar_url" text,
	"lead_id" integer,
	"deal_id" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp,
	"merged_into_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"industry" text,
	"size" "org_size",
	"website" text,
	"linkedin_url" text,
	"description" text,
	"health_score" integer,
	"parent_id" integer,
	"notes" text,
	"deleted_at" timestamp,
	"merged_into_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csat_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"survey_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"respondent_name" text,
	"respondent_email" text,
	"submitted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csat_surveys" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"title" text NOT NULL,
	"question" text DEFAULT 'How satisfied are you with our service?' NOT NULL,
	"scale_max" integer DEFAULT 5 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"public_token" text NOT NULL,
	"sent_at" timestamp,
	"closed_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contact_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"contact_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"role_key" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'flat_percent' NOT NULL,
	"flat_rate" numeric(5, 2),
	"tiers" jsonb,
	"applies_to" text DEFAULT 'all' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"deal_id" integer NOT NULL,
	"rule_id" integer,
	"deal_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"commission_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"commission_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_deal_competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" integer NOT NULL,
	"competitor_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_deal_stakeholders" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"role_key" text,
	"influence" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_forecast_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period" text NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"created_by_id" text,
	"data" jsonb NOT NULL,
	"override_amount" numeric(15, 4),
	"override_note" text,
	"overridden_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sla_breach_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" integer NOT NULL,
	"policy_id" integer,
	"breached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"task_created" boolean DEFAULT false NOT NULL,
	"notified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"options" jsonb,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" integer NOT NULL,
	"type" text NOT NULL,
	"previous_value" text,
	"new_value" text,
	"subject" text,
	"notes" text,
	"duration" integer,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_approval_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"min_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"approver_role" text,
	"approver_type" text DEFAULT 'role' NOT NULL,
	"approver_user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" integer NOT NULL,
	"requested_by" text NOT NULL,
	"requested_stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by" text,
	"rejection_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "deal_meeting_attendees" (
	"id" serial PRIMARY KEY NOT NULL,
	"meeting_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"attendee_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_meetings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" integer NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"agenda" text,
	"notes" text,
	"action_items" text,
	"recording_link" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" integer,
	"client_id" integer,
	"name" text NOT NULL,
	"value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"stage" text DEFAULT 'LEAD' NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"contact_person" text,
	"contact_email" text,
	"contact_phone" text,
	"assigned_to_id" text,
	"last_contact_date" timestamp,
	"expected_close_date" date,
	"actual_close_date" date,
	"lost_reason" text,
	"notes" text,
	"sla_deadline" timestamp,
	"follow_up_date" timestamp,
	"follow_up_notes" text,
	"pipeline_id" text,
	"forecast_category" text,
	"next_step" text,
	"health_score" integer,
	"custom_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incentive_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"branch_id" integer,
	"incentive_rate" numeric(5, 2) NOT NULL,
	"effective_from" timestamp DEFAULT now() NOT NULL,
	"effective_to" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incentives" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"branch_id" integer,
	"client_account_id" integer NOT NULL,
	"sales_rep_id" text NOT NULL,
	"investment_amount" numeric(15, 2) NOT NULL,
	"incentive_rate" numeric(5, 2) NOT NULL,
	"calculated_amount" numeric(15, 2) NOT NULL,
	"approved_amount" numeric(15, 2),
	"status" "incentive_status" DEFAULT 'PENDING' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"payroll_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_quotas" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"period" text DEFAULT 'monthly' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"target_revenue" numeric(15, 2) DEFAULT '0' NOT NULL,
	"actual_revenue" numeric(15, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"set_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"target_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"changed_by_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"metric_type" text NOT NULL,
	"target_value" numeric(15, 2) NOT NULL,
	"current_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"period" text DEFAULT 'daily' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"set_by_id" text,
	"branch_id" integer,
	"parent_target_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_sequence_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'CUSTOM' NOT NULL,
	"notes" text,
	"offset_days" integer DEFAULT 0 NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"entity_type" "task_entity_type",
	"entity_id" integer,
	"type" text DEFAULT 'CUSTOM' NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"assignee_id" text,
	"created_by" text,
	"due_date" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"timezone" text,
	"recurrence" jsonb,
	"parent_task_id" integer,
	"is_template" boolean DEFAULT false NOT NULL,
	"template_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "territories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"states" text[] DEFAULT '{}',
	"cities" text[] DEFAULT '{}',
	"assigned_reps" integer[] DEFAULT '{}',
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"description" text NOT NULL,
	"hsn_sac_code" text,
	"quantity" numeric(18, 4) NOT NULL,
	"rate" numeric(18, 4) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"line_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"project_id" integer,
	"invoice_number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"due_date" date,
	"notes" text,
	"sent_at" timestamp,
	"paid_at" timestamp,
	"viewed_at" timestamp,
	"terms" text,
	"place_of_supply" text,
	"customer_gstin" text,
	"supplier_gstin" text,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"tax_inclusive" boolean DEFAULT false NOT NULL,
	"cgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"recurring_interval" text,
	"next_recurring_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"amount_paid" numeric(18, 4) DEFAULT '0' NOT NULL,
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"collection_owner_id" text,
	"promise_to_pay_date" date,
	"next_reminder_at" timestamp,
	"recurring_template_id" integer
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"invoice_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"payment_date" date NOT NULL,
	"payment_method" text NOT NULL,
	"reference_number" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_bill_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"bill_id" integer NOT NULL,
	"description" text NOT NULL,
	"hsn_sac_code" text,
	"quantity" numeric(18, 4) NOT NULL,
	"rate" numeric(18, 4) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"line_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_bills" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"vendor_id" integer,
	"bill_number" text NOT NULL,
	"vendor_bill_number" text,
	"bill_date" date NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"place_of_supply" text,
	"vendor_gstin" text,
	"supplier_gstin" text,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"notes" text,
	"expense_account_code" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"exchange_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"recurring_template_id" integer
);
--> statement-breakpoint
CREATE TABLE "quote_line_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_id" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 2) NOT NULL,
	"unit_price" numeric(15, 2) NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" integer,
	"client_id" integer,
	"quote_number" text NOT NULL,
	"subject" text NOT NULL,
	"description" text,
	"status" "quote_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"total_amount" numeric(15, 2) NOT NULL,
	"tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(15, 2) NOT NULL,
	"valid_until" date NOT NULL,
	"terms_and_conditions" text,
	"created_by_id" text NOT NULL,
	"sent_at" timestamp,
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"pricebook_id" text,
	"template_id" text,
	"approval_status" text,
	"approved_by_id" text,
	"approved_at" timestamp,
	"signed_at" timestamp,
	"signed_document_ref" text,
	"converted_invoice_id" integer
);
--> statement-breakpoint
CREATE TABLE "support_ticket_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"source_channel" text DEFAULT 'web' NOT NULL,
	"source_message_id" text,
	"source_contact_email" text,
	"source_contact_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"assignee_id" text,
	"title" text NOT NULL,
	"category" text,
	"description" text,
	"requester_email" text,
	"requester_name" text,
	"status" "support_ticket_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "support_ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"sla_deadline" timestamp,
	"first_response_due_at" timestamp,
	"first_responded_at" timestamp,
	"sla_paused_at" timestamp,
	"sla_paused_minutes" integer DEFAULT 0 NOT NULL,
	"sla_escalation_level" integer DEFAULT 0 NOT NULL,
	"resolved_at" timestamp,
	"closed_at" timestamp,
	"queue_id" integer,
	"merged_into_ticket_id" integer,
	"snoozed_until" timestamp,
	"snoozed_by" text,
	"created_by" text NOT NULL,
	"source_channel" text DEFAULT 'web' NOT NULL,
	"source_message_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"bill_id" integer NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"payment_date" date NOT NULL,
	"payment_method" text NOT NULL,
	"reference_number" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" "crm_activity_type" NOT NULL,
	"message" text NOT NULL,
	"time" text NOT NULL,
	"person" text,
	"person_id" integer,
	"category" text DEFAULT 'sales' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"health" "crm_health" DEFAULT 'healthy' NOT NULL,
	"revenue" numeric(15, 2) DEFAULT '0' NOT NULL,
	"renewal_date" date,
	"renewal_value" numeric(15, 2) DEFAULT '0' NOT NULL,
	"customer_since" text,
	"csm_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_name" text NOT NULL,
	"value" numeric(15, 2) NOT NULL,
	"stage" "crm_deal_stage" NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"close_date" date,
	"sales_rep_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_monthly_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"month" text NOT NULL,
	"revenue" numeric(15, 2) DEFAULT '0' NOT NULL,
	"mqls" integer DEFAULT 0 NOT NULL,
	"retention" numeric(5, 2) DEFAULT '0' NOT NULL,
	"csat" numeric(4, 2) DEFAULT '0' NOT NULL,
	"ticket_volume" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_people" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"initials" text NOT NULL,
	"role" "crm_person_role" NOT NULL,
	"title" text NOT NULL,
	"department" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"location" text,
	"join_date" text,
	"bio" text,
	"skills" text[],
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sla_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"applies_to" "sla_applies_to" NOT NULL,
	"priority" "sla_priority" NOT NULL,
	"first_response_hours" integer NOT NULL,
	"resolution_hours" integer NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_minutes" integer,
	"business_hours" boolean DEFAULT false NOT NULL,
	"applies_to_text" text,
	"priority_text" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text,
	"priority" "crm_support_ticket_priority" DEFAULT 'medium' NOT NULL,
	"status" "crm_support_ticket_status" DEFAULT 'new' NOT NULL,
	"assignee_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_team_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"person_id" integer NOT NULL,
	"month" text NOT NULL,
	"value" numeric(15, 2) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb,
	"sort_by" text,
	"sort_dir" text DEFAULT 'asc' NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_health_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_account_id" integer NOT NULL,
	"score" integer NOT NULL,
	"status" "client_health_status" NOT NULL,
	"breakdown" jsonb NOT NULL,
	"computed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_score_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"weights" jsonb NOT NULL,
	"thresholds" jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "health_score_config_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "nps_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"score" integer NOT NULL,
	"category" "nps_category" NOT NULL,
	"comment" text,
	"respondent_name" text,
	"respondent_email" text,
	"client_account_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nps_surveys" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"status" "nps_survey_status" DEFAULT 'draft' NOT NULL,
	"public_token" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nps_surveys_public_token_unique" UNIQUE("public_token")
);
--> statement-breakpoint
CREATE TABLE "playbook_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"content" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"graph" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"is_draft" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"cooldown_minutes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sku" text,
	"category" text,
	"unit_price" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"tax_rate" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_pricebook_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pricebook_id" text NOT NULL,
	"product_id" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"min_quantity" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_pricebooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_quote_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"max_discount_percent" integer,
	"require_pricebook_price" boolean DEFAULT false NOT NULL,
	"default_expiry_days" integer DEFAULT 30 NOT NULL,
	"allow_price_override" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_quote_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"branding" jsonb,
	"terms" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_automation_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"config_schema" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_automation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"entity_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_blueprint_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"from_stage_key" text NOT NULL,
	"to_stage_key" text NOT NULL,
	"required_fields" jsonb,
	"required_activity_type_keys" jsonb,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"requires_quote" boolean DEFAULT false NOT NULL,
	"auto_task_templates" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pipeline_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_options" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"color" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system_default" boolean DEFAULT false NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_pipeline_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pipeline_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"color" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"probability" integer DEFAULT 0 NOT NULL,
	"stage_type" text DEFAULT 'open' NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"sla_hours" integer,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"required_fields" jsonb,
	"allowed_next_stage_keys" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_system_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_pipelines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_ui_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope" text NOT NULL,
	"config" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_validation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"field" text NOT NULL,
	"rule_type" text NOT NULL,
	"config" jsonb,
	"pipeline_id" text,
	"stage_key" text,
	"source_key" text,
	"error_message" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rule_id" integer NOT NULL,
	"event_key" text NOT NULL,
	"entity_type" text DEFAULT '' NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"steps" jsonb,
	"error" text,
	"triggered_by" text DEFAULT 'system' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_sequence_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sequence_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp,
	"stop_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_sequence_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"sort_order" integer NOT NULL,
	"step_type" text NOT NULL,
	"config" jsonb,
	"wait_hours" integer
);
--> statement-breakpoint
CREATE TABLE "crm_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"entity_type" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stop_on" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "crm_lead_touchpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"lead_id" integer NOT NULL,
	"campaign_id" integer,
	"source_key" text NOT NULL,
	"medium" text,
	"utm_data" jsonb,
	"touch_type" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text NOT NULL,
	"file_key" text NOT NULL,
	"file_size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_channel_invite_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"token" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "chat_channel_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'MEMBER' NOT NULL,
	"last_read_at" timestamp DEFAULT now() NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"muted_until" timestamp,
	"archived_at" timestamp,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"notification_preference" text DEFAULT 'DEFAULT' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'GROUP' NOT NULL,
	"description" text,
	"avatar_url" text,
	"created_by" text NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"linked_deal_id" integer,
	"last_message_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_huddle_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"huddle_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp,
	"is_muted" boolean DEFAULT false NOT NULL,
	"hand_raised" boolean DEFAULT false NOT NULL,
	"is_camera_off" boolean DEFAULT false NOT NULL,
	"is_screen_sharing" boolean DEFAULT false NOT NULL,
	"is_deafened" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_huddles" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"started_by" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"calendar_event_id" integer,
	"has_video" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"sender_id" text NOT NULL,
	"content" text,
	"reply_to_id" integer,
	"is_edited" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"message_type" "chat_message_type" DEFAULT 'text' NOT NULL,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"action_status" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_org_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"default_notification_preference" text DEFAULT 'ALL' NOT NULL,
	"max_attachment_size_mb" integer DEFAULT 25 NOT NULL,
	"max_huddle_participants" integer DEFAULT 50 NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_pinned_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"pinned_by" text NOT NULL,
	"pinned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_reply_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"recipient_user_id" text NOT NULL,
	"sender_user_id" text NOT NULL,
	"remind_at" timestamp NOT NULL,
	"sent_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_saved_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"saved_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_user_presence" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text DEFAULT 'OFFLINE' NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6),
	"metadata" jsonb,
	"latency_ms" integer,
	"correlation_id" varchar(64),
	"outcome" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text,
	"target_id" text,
	"target_type" text,
	"actor_user_id" text,
	"resource_type" text,
	"resource_id" text,
	"metadata" jsonb,
	"ip_address" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"type" "notification_type" DEFAULT 'INFO' NOT NULL,
	"priority" "notification_priority" DEFAULT 'NORMAL' NOT NULL,
	"category" "notification_category" DEFAULT 'SYSTEM' NOT NULL,
	"channels" jsonb DEFAULT '["IN_APP"]'::jsonb NOT NULL,
	"audience" jsonb NOT NULL,
	"status" "broadcast_status" DEFAULT 'DRAFT' NOT NULL,
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"meeting_url" text,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"color" text,
	"category" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"created_by" text NOT NULL,
	"attendee_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"recurring_rule" text,
	"agenda" text,
	"post_meeting_notes" text,
	"linked_deal_id" integer,
	"linked_lead_id" integer,
	"reminder_15min_sent" boolean DEFAULT false NOT NULL,
	"integration_connection_id" integer,
	"external_event_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"coupon_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"amount" numeric(15, 2),
	"redeemed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_coupon_redemptions_coupon_org" UNIQUE("coupon_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"type" text NOT NULL,
	"value" numeric(15, 2) NOT NULL,
	"min_purchase" numeric(15, 2),
	"max_uses" integer,
	"used_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"applicable_plans" jsonb,
	"expires_at" timestamp,
	"org_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coupons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "event_attendees_event_user_unique" UNIQUE("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"notification_id" integer,
	"broadcast_id" integer,
	"actor_id" text,
	"action" text NOT NULL,
	"source_module" text,
	"channel" text,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"in_app_enabled" boolean DEFAULT true NOT NULL,
	"whatsapp_enabled" boolean DEFAULT false NOT NULL,
	"sound_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"quiet_hours_timezone" text DEFAULT 'UTC',
	"digest_mode" text DEFAULT 'disabled' NOT NULL,
	"quiet_hours_weekends" boolean DEFAULT true NOT NULL,
	"allow_critical_override" boolean DEFAULT true NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"module_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"category" "notification_category" DEFAULT 'SYSTEM' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_notification_templates_key_locale_version" UNIQUE("org_id","template_key","locale","version")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"type" "notification_type" DEFAULT 'INFO' NOT NULL,
	"priority" "notification_priority" DEFAULT 'NORMAL' NOT NULL,
	"category" "notification_category" DEFAULT 'SYSTEM' NOT NULL,
	"source_module" text,
	"event_key" text,
	"entity_type" text,
	"entity_id" text,
	"actor_user_id" text,
	"reason" text,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"link" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"channel" text DEFAULT 'IN_APP' NOT NULL,
	"sound" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp,
	"snoozed_until" timestamp,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "subscription_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"subscription_id" integer NOT NULL,
	"razorpay_payment_id" text,
	"razorpay_order_id" text,
	"amount" numeric(15, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text NOT NULL,
	"paid_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan" "subscription_plan" DEFAULT 'STARTER' NOT NULL,
	"status" "subscription_status" DEFAULT 'TRIAL' NOT NULL,
	"razorpay_subscription_id" text,
	"razorpay_customer_id" text,
	"razorpay_plan_id" text,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"trial_ends_at" timestamp,
	"cancelled_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"description" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"endpoint_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb,
	"status_code" integer,
	"response_body" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blog_authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"email" varchar(320),
	"avatar" text,
	"bio" text,
	"role" varchar(100),
	"twitter" varchar(100),
	"linkedin" varchar(200),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blog_authors_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "blog_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"color" varchar(7),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blog_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "blog_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(256) NOT NULL,
	"slug" varchar(256) NOT NULL,
	"excerpt" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb,
	"cover_image" text NOT NULL,
	"category_id" uuid,
	"author_id" uuid,
	"status" "blog_post_status" DEFAULT 'draft' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"reading_time" integer,
	"meta_title" varchar(256),
	"meta_description" varchar(320),
	"published_at" timestamp,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "platform_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_code" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"company" text,
	"phone" text,
	"topic" text DEFAULT 'sales' NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"replied_at" timestamp,
	"replied_by_id" text,
	"reply_body" text,
	"ip_address" text,
	"user_agent" text,
	"referrer_url" text,
	"utm" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_messages_public_code_unique" UNIQUE("public_code")
);
--> statement-breakpoint
CREATE TABLE "platform_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"razorpay_payment_id" text NOT NULL,
	"razorpay_order_id" text,
	"razorpay_signature" text,
	"org_id" text,
	"customer_email" text,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text NOT NULL,
	"method" text,
	"description" text,
	"invoice_url" text,
	"metadata" jsonb,
	"captured_at" timestamp,
	"refunded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"plan" text NOT NULL,
	"seat_count" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"razorpay_subscription_id" text,
	"current_period_start" timestamp,
	"current_period_end" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_token" text NOT NULL,
	"path" text NOT NULL,
	"referrer" text,
	"user_agent" text,
	"country" text,
	"is_first_visit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indian_states" (
	"state_code" text PRIMARY KEY NOT NULL,
	"state_name" text NOT NULL,
	"gst_state_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entry_number" text NOT NULL,
	"entry_date" date NOT NULL,
	"posting_date" date,
	"description" text,
	"period_id" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_event" text,
	"status" "journal_entry_status" DEFAULT 'POSTED' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"posted_by" text,
	"posted_at" timestamp,
	"reversed_entry_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_je_org_number" UNIQUE("org_id","entry_number"),
	CONSTRAINT "uniq_je_idempotency" UNIQUE("org_id","source_type","source_id","source_event")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"org_id" text,
	"debit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"description" text,
	"line_order" integer NOT NULL,
	"currency" text,
	"exchange_rate" numeric(18, 8),
	"base_debit" numeric(18, 4),
	"base_credit" numeric(18, 4),
	"client_id" integer,
	"vendor_id" integer,
	"project_id" integer,
	"department_id" integer,
	"employee_id" integer,
	"tax_code_id" integer,
	"dimension_values" jsonb
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" "account_type" NOT NULL,
	"parent_account_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"normal_balance" "acc_normal_balance",
	"is_system" boolean DEFAULT false NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_ledger_accounts_org_code" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "acc_number_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"prefix" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"padding" integer DEFAULT 4 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_system_account_map" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"purpose" "acc_system_purpose" NOT NULL,
	"account_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_dimension_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"dimension_id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_dimensions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"required_for_account_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "acc_period_status" DEFAULT 'OPEN' NOT NULL,
	"closed_by" text,
	"closed_at" timestamp,
	"locked_by" text,
	"locked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"base_currency" text DEFAULT 'INR' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 4 NOT NULL,
	"accounting_basis" "acc_basis" DEFAULT 'ACCRUAL' NOT NULL,
	"tax_registration" jsonb,
	"coa_template" text,
	"setup_completed_at" timestamp,
	"retained_earnings_account_id" integer,
	"payment_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_approval_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"record_type" "fin_approval_record_type" NOT NULL,
	"min_amount" numeric(18, 4),
	"approver_role" text,
	"approver_user_id" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_approval_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"record_type" "fin_approval_record_type" NOT NULL,
	"record_id" integer NOT NULL,
	"status" "fin_approval_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" text NOT NULL,
	"note" text,
	"decided_by" text,
	"decided_at" timestamp,
	"decision_comment" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_exchange_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"as_of_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_recurring_journal_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"frequency" "fin_recur_frequency" NOT NULL,
	"next_run_date" date,
	"last_run_date" date,
	"end_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"lines" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_note_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"credit_note_id" integer NOT NULL,
	"description" text NOT NULL,
	"hsn_sac_code" text,
	"quantity" numeric(18, 4) NOT NULL,
	"rate" numeric(18, 4) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"line_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"credit_note_number" text NOT NULL,
	"client_id" integer,
	"invoice_id" integer,
	"status" "fin_credit_note_status" DEFAULT 'DRAFT' NOT NULL,
	"reason" text,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"cgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"sgst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"igst_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"applied_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"place_of_supply" text,
	"customer_gstin" text,
	"supplier_gstin" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_collection_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer NOT NULL,
	"invoice_id" integer,
	"type" "fin_collection_activity_type" NOT NULL,
	"note" text,
	"promised_date" date,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"payment_id" integer NOT NULL,
	"invoice_id" integer NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_payment_run_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"bill_id" integer NOT NULL,
	"vendor_id" integer,
	"amount" numeric(18, 4) NOT NULL,
	"status" "fin_payment_run_item_status" DEFAULT 'PENDING' NOT NULL,
	"vendor_payment_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_payment_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "fin_payment_run_status" DEFAULT 'DRAFT' NOT NULL,
	"scheduled_date" date,
	"total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_recurring_bill_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"vendor_id" integer,
	"frequency" "fin_recur_frequency" NOT NULL,
	"next_run_date" date,
	"last_run_date" date,
	"end_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_recurring_invoice_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"client_id" integer,
	"frequency" "fin_recur_frequency" NOT NULL,
	"next_run_date" date,
	"last_run_date" date,
	"end_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_reminder_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"invoice_id" integer NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"channel" "fin_reminder_channel" NOT NULL,
	"offset_days" integer NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_reminder_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"offsets" jsonb NOT NULL,
	"channel" "fin_reminder_channel" DEFAULT 'EMAIL' NOT NULL,
	"template" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_vendor_payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"vendor_payment_id" integer NOT NULL,
	"bill_id" integer NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_credit_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_credit_id" integer NOT NULL,
	"description" text NOT NULL,
	"hsn_sac_code" text,
	"quantity" numeric(18, 4) NOT NULL,
	"rate" numeric(18, 4) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"line_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"vendor_credit_number" text NOT NULL,
	"vendor_id" integer,
	"bill_id" integer,
	"status" "fin_credit_note_status" DEFAULT 'DRAFT' NOT NULL,
	"reason" text,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"applied_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"account_type" "fin_bank_account_type" DEFAULT 'BANK' NOT NULL,
	"account_number_masked" text,
	"bank_name" text,
	"ifsc" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"ledger_account_id" integer,
	"opening_balance" numeric(18, 4) DEFAULT '0' NOT NULL,
	"current_balance" numeric(18, 4) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_bank_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"bank_account_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"format" "fin_bank_import_format" NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"status" "fin_bank_import_status" DEFAULT 'PENDING' NOT NULL,
	"column_mapping" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_bank_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"bank_account_id" integer NOT NULL,
	"import_id" integer,
	"txn_date" date NOT NULL,
	"description" text,
	"reference" text,
	"amount" numeric(18, 4) NOT NULL,
	"balance_after" numeric(18, 4),
	"counterparty" text,
	"fingerprint" text NOT NULL,
	"status" "fin_bank_txn_status" DEFAULT 'UNMATCHED' NOT NULL,
	"matched_journal_entry_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_bank_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"from_bank_account_id" integer NOT NULL,
	"to_bank_account_id" integer NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"transfer_date" date NOT NULL,
	"reference" text,
	"journal_entry_id" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_reconciliation_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"bank_transaction_id" integer NOT NULL,
	"journal_entry_id" integer,
	"matched_type" "fin_recon_match_type" NOT NULL,
	"matched_record_id" integer,
	"amount" numeric(18, 4) NOT NULL,
	"confidence" numeric(5, 2),
	"is_confirmed" boolean DEFAULT false NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_reconciliation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_tax_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"tax_type" "acc_tax_type" NOT NULL,
	"is_reverse_charge" boolean DEFAULT false NOT NULL,
	"collected_account_id" integer,
	"paid_account_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_tax_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"tax_type" "acc_tax_type" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"paid_date" date,
	"reference" text,
	"journal_entry_id" integer,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_budget_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"budget_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"account_id" integer NOT NULL,
	"department_id" integer,
	"project_id" integer,
	"period_key" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_budget_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"budget_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"fiscal_year" text NOT NULL,
	"period_type" "fin_budget_period" DEFAULT 'MONTHLY' NOT NULL,
	"dimension_type" "fin_budget_dimension" DEFAULT 'NONE',
	"status" "fin_budget_status" DEFAULT 'DRAFT' NOT NULL,
	"total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_cash_flow_scenarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "fin_scenario_kind" DEFAULT 'EXPECTED' NOT NULL,
	"assumptions" jsonb,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_asset_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"asset_account_id" integer NOT NULL,
	"depreciation_expense_account_id" integer NOT NULL,
	"accumulated_depreciation_account_id" integer NOT NULL,
	"default_method" "acc_depreciation_method" DEFAULT 'STRAIGHT_LINE' NOT NULL,
	"default_useful_life_months" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_depreciation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_key" text NOT NULL,
	"status" "acc_depreciation_run_status" DEFAULT 'DRAFT' NOT NULL,
	"total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" integer,
	"created_by" text NOT NULL,
	"posted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_depreciation_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"asset_id" integer NOT NULL,
	"period_key" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"run_id" integer,
	"journal_entry_id" integer,
	"status" "acc_depreciation_line_status" DEFAULT 'SCHEDULED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "acc_fixed_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"asset_number" text NOT NULL,
	"name" text NOT NULL,
	"category_id" integer NOT NULL,
	"acquisition_date" date NOT NULL,
	"acquisition_cost" numeric(18, 4) NOT NULL,
	"salvage_value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" "acc_depreciation_method" DEFAULT 'STRAIGHT_LINE' NOT NULL,
	"vendor_id" integer,
	"bill_id" integer,
	"status" "acc_asset_status" DEFAULT 'DRAFT' NOT NULL,
	"accumulated_depreciation" numeric(18, 4) DEFAULT '0' NOT NULL,
	"disposed_at" timestamp,
	"disposal_amount" numeric(18, 4),
	"disposal_journal_entry_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_expense_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"category_id" integer,
	"max_amount" numeric(12, 2),
	"requires_receipt_above" numeric(12, 2),
	"requires_approval_above" numeric(12, 2),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fin_reimbursement_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "fin_reimbursement_batch_status" DEFAULT 'DRAFT' NOT NULL,
	"total_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"paid_date" date,
	"journal_entry_id" integer,
	"bank_account_id" integer,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"helpful" boolean NOT NULL,
	"comment" text,
	"visitor_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_articles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category_id" integer,
	"space_id" integer,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"excerpt" text,
	"content" text DEFAULT '' NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"status" "kb_article_status" DEFAULT 'draft' NOT NULL,
	"visibility" "kb_article_visibility" DEFAULT 'internal' NOT NULL,
	"author_id" text,
	"owner_id" text,
	"views" integer DEFAULT 0 NOT NULL,
	"helpful_count" integer DEFAULT 0 NOT NULL,
	"not_helpful_count" integer DEFAULT 0 NOT NULL,
	"tags" text[],
	"seo_title" text,
	"seo_description" text,
	"review_interval_days" integer,
	"last_verified_at" timestamp,
	"published_at" timestamp,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" integer,
	"parent_id" integer,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_key" text NOT NULL,
	"file_url" text,
	"file_size" integer,
	"mime_type" text,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer,
	"page_id" integer,
	"attachment_id" integer,
	"source_id" integer,
	"source" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"tokens" integer,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_macros" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"visibility" text DEFAULT 'org' NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignee_id" text,
	"set_priority" text,
	"assignment_mode" text DEFAULT 'static' NOT NULL,
	"candidate_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"author_id" text,
	"parent_id" integer,
	"content" text NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_activity" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"support_ticket_id" integer NOT NULL,
	"user_id" text,
	"action" "support_activity_action" NOT NULL,
	"from_value" text,
	"to_value" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_queues" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_saved_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" "support_saved_view_visibility" DEFAULT 'personal' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"linked_ticket_id" integer NOT NULL,
	"relation" "support_ticket_link_relation" NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_tags" (
	"ticket_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "support_ticket_tags_ticket_id_tag_id_pk" PRIMARY KEY("ticket_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "support_ticket_watchers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_business_hours" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"weekly_schedule" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_24x7" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_sla_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"priority" "support_ticket_priority",
	"category" text,
	"business_hours_id" integer,
	"first_response_target_mins" integer NOT NULL,
	"resolution_target_mins" integer NOT NULL,
	"pause_statuses" jsonb DEFAULT '["WAITING"]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" "support_channel_type" NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inbound_secret" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_csat_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"token" text NOT NULL,
	"score" integer,
	"comment" text,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ai_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"confidence_threshold" numeric(4, 3) DEFAULT '0.7' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ai_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"type" "support_suggestion_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"status" "support_suggestion_status" DEFAULT 'pending' NOT NULL,
	"feedback" text,
	"resolved_at" timestamp,
	"resolved_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_custom_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"options" jsonb,
	"required" boolean DEFAULT false NOT NULL,
	"category" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_custom_field_values" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"field_id" integer NOT NULL,
	"value" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_settings_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"changes" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_agent_availability" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_agent_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"skill" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_vip_clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_message_mentions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"mentioned_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_ticket_external_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ticket_id" integer NOT NULL,
	"entity_type" "support_external_entity_type" NOT NULL,
	"entity_id" integer NOT NULL,
	"label" text NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_knowledge_gaps" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"cluster_key" varchar(500) NOT NULL,
	"representative_question" text NOT NULL,
	"ticket_count" integer DEFAULT 0 NOT NULL,
	"sample_ticket_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"proposed_article_id" integer,
	"drafted_by" text,
	"reviewed_by" text,
	"evidence" jsonb DEFAULT '{"searchQueries":[],"relatedTicketIds":[]}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_space_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" integer NOT NULL,
	"user_id" text,
	"role" text,
	"team" text,
	"space_role" "kb_space_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_spaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"audience" "kb_audience" DEFAULT 'internal' NOT NULL,
	"icon" text,
	"branding" jsonb,
	"is_public_help_center" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"type" text DEFAULT 'team' NOT NULL,
	"color" text,
	"default_visibility" text DEFAULT 'org' NOT NULL,
	"owning_team_id" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kb_article_restrictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"user_id" text,
	"role" text,
	"team" text,
	"level" text DEFAULT 'view' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"version_number" integer NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"excerpt" text,
	"change_summary" text,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_text" text DEFAULT '' NOT NULL,
	"excerpt" text,
	"status" "kb_translation_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_article_tags" (
	"article_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "kb_article_tags_article_id_tag_id_pk" PRIMARY KEY("article_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "kb_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_id" text,
	"article_id" integer,
	"query" text,
	"metadata" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_ai_credit_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" text NOT NULL,
	"feature" text,
	"actor_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_ai_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"monthly_allowance" integer DEFAULT 0 NOT NULL,
	"last_reset_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_ai_credits_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "kb_page_favorites" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_page_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_page_id" integer NOT NULL,
	"target_page_id" integer,
	"target_type" text DEFAULT 'page' NOT NULL,
	"target_id" text,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_page_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"visited_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" integer,
	"parent_page_id" integer,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"cover_image" text,
	"content" jsonb,
	"content_text" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"last_edited_by_id" text,
	"deleted_at" timestamp with time zone,
	"deleted_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"visibility" text DEFAULT 'org' NOT NULL,
	"public_token" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"content_type" text DEFAULT 'note' NOT NULL,
	"trust_state" text DEFAULT 'unverified' NOT NULL,
	"owner_user_id" text,
	"verified_by_id" text,
	"verified_until" timestamp with time zone,
	"next_review_at" timestamp with time zone,
	"public_slug" text,
	"source_article_id" integer
);
--> statement-breakpoint
CREATE TABLE "kb_page_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"author_id" text,
	"parent_id" integer,
	"content" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_page_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"description" text,
	"content" jsonb,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_page_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"version_number" integer NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" jsonb,
	"content_text" text,
	"change_summary" text,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" integer,
	"format" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_key" text,
	"expires_at" timestamp with time zone,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_type" text NOT NULL,
	"file_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"succeeded_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"duplicate_items" integer DEFAULT 0 NOT NULL,
	"error_report" jsonb,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_page_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"page_id" integer NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by_id" text,
	"reviewer_id" text,
	"due_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space_id" integer,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"file_key" text,
	"file_url" text,
	"mime_type" text,
	"file_size" integer,
	"note_text" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "kb_chat_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"conversation_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"trash_retention_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_research_briefs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"topic" text NOT NULL,
	"space_id" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" integer,
	"source_count" integer DEFAULT 0 NOT NULL,
	"report" text,
	"citations" jsonb,
	"error_message" text,
	"rating" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_event" "automation_trigger" NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"rule_id" integer NOT NULL,
	"trigger_event" text NOT NULL,
	"status" "automation_run_status" NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_category_id" integer,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_product_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_id" integer NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"cost_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"selling_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"attribute_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category_id" integer,
	"uom_id" integer,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"description" text,
	"status" "inv_product_status" DEFAULT 'ACTIVE' NOT NULL,
	"product_type" "inv_product_type" DEFAULT 'STOCKABLE',
	"tracking_method" "inv_tracking_method" DEFAULT 'NONE',
	"costing_method" "inv_costing_method" DEFAULT 'WEIGHTED_AVERAGE',
	"standard_cost" numeric(18, 4),
	"purchase_uom_id" integer,
	"sales_uom_id" integer,
	"default_vendor_id" integer,
	"reorder_enabled" boolean DEFAULT false,
	"cost_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"selling_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"reorder_point" numeric(18, 4) DEFAULT '0' NOT NULL,
	"min_stock_level" numeric(18, 4) DEFAULT '0' NOT NULL,
	"max_stock_level" numeric(18, 4) DEFAULT '0' NOT NULL,
	"has_variants" boolean DEFAULT false NOT NULL,
	"image_url" text,
	"custom_fields" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_uom" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"abbreviation" text NOT NULL,
	"category" text,
	"ratio_to_base" numeric(18, 8) DEFAULT '1',
	"rounding_precision" integer DEFAULT 2,
	"is_base" boolean DEFAULT false,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"warehouse_id" integer NOT NULL,
	"parent_location_id" integer,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"location_type" "inv_location_type" NOT NULL,
	"is_pickable" boolean DEFAULT true,
	"is_receivable" boolean DEFAULT true,
	"is_sellable" boolean DEFAULT true,
	"capacity" numeric(18, 4),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"branch_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"manager_user_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_stock_adjustment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"adjustment_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"quantity_change" numeric(18, 4) NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "inv_stock_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reference_number" text NOT NULL,
	"reason" "inv_adj_reason" NOT NULL,
	"notes" text,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"posted_by" text,
	"posted_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_stock_levels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"on_hand" numeric(18, 4) DEFAULT '0' NOT NULL,
	"committed" numeric(18, 4) DEFAULT '0' NOT NULL,
	"on_order" numeric(18, 4) DEFAULT '0' NOT NULL,
	"blocked_qty" numeric(18, 4) DEFAULT '0',
	"quality_hold_qty" numeric(18, 4) DEFAULT '0',
	"outgoing_qty" numeric(18, 4) DEFAULT '0',
	"average_cost" numeric(18, 4),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_stock_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer,
	"transaction_type" "inv_txn_type" NOT NULL,
	"quantity_change" numeric(18, 4) NOT NULL,
	"quantity_before" numeric(18, 4) NOT NULL,
	"quantity_after" numeric(18, 4) NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"unit_cost" numeric(18, 4),
	"total_cost" numeric(18, 4),
	"idempotency_key" text,
	"reason" text,
	"metadata" jsonb,
	"reference_type" text,
	"reference_id" text,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_stock_transfer_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"transfer_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"quantity_received" numeric(18, 4) DEFAULT '0' NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "inv_stock_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"reference_number" text NOT NULL,
	"from_location_id" integer NOT NULL,
	"to_location_id" integer NOT NULL,
	"from_warehouse_id" integer,
	"to_warehouse_id" integer,
	"status" "inv_transfer_status" DEFAULT 'PENDING' NOT NULL,
	"notes" text,
	"reserved_at" timestamp,
	"dispatched_at" timestamp,
	"created_by" text NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_grn_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"grn_id" integer NOT NULL,
	"po_line_id" integer NOT NULL,
	"quantity_received" numeric(18, 4) NOT NULL,
	"quality_status" "inv_grn_quality" DEFAULT 'ACCEPTED' NOT NULL,
	"rejection_reason" text
);
--> statement-breakpoint
CREATE TABLE "inv_grns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"po_id" integer NOT NULL,
	"grn_number" text NOT NULL,
	"received_date" date NOT NULL,
	"location_id" integer,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_po_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"quantity_received" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"vendor_id" integer NOT NULL,
	"po_number" text NOT NULL,
	"status" "inv_po_status" DEFAULT 'DRAFT' NOT NULL,
	"order_date" date NOT NULL,
	"expected_delivery_date" date,
	"warehouse_id" integer,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"sent_at" timestamp,
	"approved_by" text,
	"approved_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_vendors" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"gstin" text,
	"lead_time_days" integer DEFAULT 7 NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_sales_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"client_id" integer,
	"so_number" text NOT NULL,
	"status" "inv_so_status" DEFAULT 'DRAFT' NOT NULL,
	"order_date" date NOT NULL,
	"required_date" date,
	"shipping_address" text,
	"warehouse_id" integer,
	"subtotal" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"discount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"invoice_id" integer,
	"confirmed_at" timestamp,
	"shipped_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_so_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"so_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"quantity_shipped" numeric(18, 4) DEFAULT '0' NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"cost_at_time" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_stock_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_line_id" text,
	"product_variant_id" integer NOT NULL,
	"warehouse_id" integer,
	"location_id" integer,
	"lot_id" integer,
	"serial_id" integer,
	"reserved_qty" numeric(18, 4) NOT NULL,
	"status" "inv_reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_lots" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"lot_number" text NOT NULL,
	"manufacture_date" date,
	"expiry_date" date,
	"supplier_lot_number" text,
	"status" "inv_lot_status" DEFAULT 'ACTIVE' NOT NULL,
	"quality_status" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_serial_numbers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"serial_number" text NOT NULL,
	"lot_id" integer,
	"status" "inv_serial_status" DEFAULT 'IN_STOCK' NOT NULL,
	"current_location_id" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_customer_return_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"quantity" numeric(18, 4) NOT NULL,
	"disposition" "inv_customer_return_disposition",
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "inv_customer_returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"return_number" text NOT NULL,
	"so_id" integer,
	"shipment_id" integer,
	"client_id" integer,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"approved_by" text,
	"posted_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_cycle_count_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"cycle_count_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"lot_id" integer,
	"system_qty" numeric(18, 4) NOT NULL,
	"counted_qty" numeric(18, 4),
	"variance_qty" numeric(18, 4)
);
--> statement-breakpoint
CREATE TABLE "inv_cycle_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"count_number" text NOT NULL,
	"warehouse_id" integer NOT NULL,
	"location_id" integer,
	"category_id" integer,
	"status" "inv_cycle_count_status" DEFAULT 'PLANNED' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"posted_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_physical_audit_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"audit_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"lot_id" integer,
	"system_qty" numeric(18, 4) NOT NULL,
	"counted_qty" numeric(18, 4),
	"variance_qty" numeric(18, 4)
);
--> statement-breakpoint
CREATE TABLE "inv_physical_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"audit_number" text NOT NULL,
	"warehouse_id" integer NOT NULL,
	"status" "inv_cycle_count_status" DEFAULT 'PLANNED' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"posted_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_pick_list_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"pick_list_id" integer NOT NULL,
	"so_line_id" integer,
	"product_variant_id" integer NOT NULL,
	"location_id" integer,
	"lot_id" integer,
	"serial_id" integer,
	"quantity_to_pick" numeric(18, 4) NOT NULL,
	"quantity_picked" numeric(18, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_pick_lists" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"pick_number" text NOT NULL,
	"so_id" integer,
	"warehouse_id" integer,
	"status" "inv_pick_list_status" DEFAULT 'PENDING' NOT NULL,
	"created_by" text NOT NULL,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_vendor_return_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"return_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"quantity" numeric(18, 4) NOT NULL,
	"reason" "inv_vendor_return_reason" NOT NULL,
	"unit_cost" numeric(18, 4)
);
--> statement-breakpoint
CREATE TABLE "inv_vendor_returns" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"return_number" text NOT NULL,
	"vendor_id" integer NOT NULL,
	"po_id" integer,
	"grn_id" integer,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"created_by" text NOT NULL,
	"approved_by" text,
	"posted_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_valuation_layers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"stock_transaction_id" integer,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"total_value" numeric(18, 4) NOT NULL,
	"remaining_quantity" numeric(18, 4) NOT NULL,
	"remaining_value" numeric(18, 4) NOT NULL,
	"costing_method" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_quality_holds" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"location_id" integer,
	"lot_id" integer,
	"serial_id" integer,
	"quantity" numeric(18, 4) NOT NULL,
	"reason" text NOT NULL,
	"status" "inv_quality_hold_status" DEFAULT 'ACTIVE' NOT NULL,
	"released_by" text,
	"released_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_quality_inspection_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"inspection_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"quantity" numeric(18, 4) NOT NULL,
	"result" text,
	"notes" text,
	"disposition" "inv_quality_disposition"
);
--> statement-breakpoint
CREATE TABLE "inv_quality_inspections" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"inspection_number" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"status" "inv_quality_inspection_status" DEFAULT 'PENDING' NOT NULL,
	"inspector_user_id" text,
	"notes" text,
	"completed_at" timestamp,
	"created_by" text NOT NULL,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_recall_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"recall_number" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "inv_recall_status" DEFAULT 'OPEN' NOT NULL,
	"created_by" text NOT NULL,
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_recall_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"recall_id" integer NOT NULL,
	"product_variant_id" integer,
	"lot_id" integer,
	"serial_id" integer,
	"status" text DEFAULT 'OPEN' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_carriers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"tracking_url_template" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_load_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"load_id" integer NOT NULL,
	"shipment_id" integer,
	"transfer_id" integer
);
--> statement-breakpoint
CREATE TABLE "inv_loads" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"load_number" text NOT NULL,
	"source_warehouse_id" integer,
	"destination" text,
	"carrier_id" integer,
	"vehicle_ref" text,
	"status" "inv_load_status" DEFAULT 'DRAFT' NOT NULL,
	"dispatch_date" date,
	"arrival_date" date,
	"created_by" text NOT NULL,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_package_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"package_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"lot_id" integer,
	"serial_id" integer,
	"quantity" numeric(18, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_packages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"package_number" text NOT NULL,
	"shipment_id" integer,
	"weight" numeric(18, 4),
	"dimensions_l" numeric(10, 2),
	"dimensions_w" numeric(10, 2),
	"dimensions_h" numeric(10, 2),
	"status" "inv_package_status" DEFAULT 'OPEN' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_shipment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"so_line_id" integer,
	"product_variant_id" integer NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"lot_id" integer,
	"serial_id" integer
);
--> statement-breakpoint
CREATE TABLE "inv_shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"shipment_number" text NOT NULL,
	"so_id" integer,
	"warehouse_id" integer,
	"carrier_id" integer,
	"tracking_number" text,
	"status" "inv_shipment_status" DEFAULT 'DRAFT' NOT NULL,
	"shipped_at" timestamp,
	"created_by" text NOT NULL,
	"approved_by" text,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_3pl_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"status" "inv_3pl_status" DEFAULT 'DISCONNECTED' NOT NULL,
	"external_warehouse_ref" text,
	"sku_mapping" jsonb,
	"last_sync_at" timestamp,
	"last_sync_status" text,
	"settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_channel_stock_publications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"published_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"available_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"status" "inv_channel_pub_status" DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_type" "inv_channel_type" NOT NULL,
	"status" "inv_channel_status" DEFAULT 'ACTIVE' NOT NULL,
	"safety_buffer" numeric(18, 4) DEFAULT '0',
	"publish_threshold" numeric(18, 4),
	"warehouse_ids" jsonb DEFAULT '[]'::jsonb,
	"settings" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_ai_insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"insight_type" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"source_refs" jsonb,
	"status" "inv_ai_insight_status" DEFAULT 'NEW' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_reorder_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"product_variant_id" integer NOT NULL,
	"warehouse_id" integer,
	"min_qty" numeric(18, 4) NOT NULL,
	"max_qty" numeric(18, 4),
	"reorder_qty" numeric(18, 4),
	"vendor_id" integer,
	"lead_time_days" integer,
	"safety_stock" numeric(18, 4) DEFAULT '0',
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_type" text NOT NULL,
	"status" "inv_job_status" DEFAULT 'PENDING' NOT NULL,
	"file_name" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"result_url" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_idempotency_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text,
	"status" "inv_idempotency_status" DEFAULT 'IN_FLIGHT' NOT NULL,
	"response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"job_type" text NOT NULL,
	"status" "inv_job_status" DEFAULT 'PENDING' NOT NULL,
	"file_name" text,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"error_rows" integer DEFAULT 0 NOT NULL,
	"errors" jsonb,
	"result_url" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_number_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"doc_type" text NOT NULL,
	"prefix" text NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"padding" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"allow_negative_stock" boolean DEFAULT false NOT NULL,
	"allow_backorders" boolean DEFAULT false NOT NULL,
	"reservation_strategy" "inv_reservation_strategy" DEFAULT 'AUTO_ON_CONFIRM' NOT NULL,
	"default_costing_method" "inv_costing_method" DEFAULT 'WEIGHTED_AVERAGE' NOT NULL,
	"expiry_reservation_policy" "inv_expiry_policy" DEFAULT 'BLOCK' NOT NULL,
	"inspection_on_receipt" boolean DEFAULT false NOT NULL,
	"inspection_on_return" boolean DEFAULT false NOT NULL,
	"over_receipt_tolerance_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"require_po_approval" boolean DEFAULT false NOT NULL,
	"adjustment_approval_threshold" numeric(18, 4),
	"auto_reserve_on_confirm" boolean DEFAULT true NOT NULL,
	"allow_partial_shipment" boolean DEFAULT true NOT NULL,
	"package_required_for_shipping" boolean DEFAULT false NOT NULL,
	"channel_publish_policy" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inv_settings_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "inv_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"webhook_id" integer,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "inv_webhook_event_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inv_webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"secret" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp,
	"last_delivery_status" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_branches" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"business_unit_id" text,
	"manager_user_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"phone" text,
	"email" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_org_branches_org_code" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "org_business_units" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_org_bus_org_code" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "org_cost_centers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_org_cc_org_code" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "org_departments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"branch_id" text,
	"head_user_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_org_depts_org_code" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "org_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'OFFICE' NOT NULL,
	"address" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "org_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"department_id" text,
	"lead_user_id" text,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"capacity" integer,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "uniq_org_teams_org_code" UNIQUE("org_id","code")
);
--> statement-breakpoint
CREATE TABLE "user_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"business_unit_id" text,
	"branch_id" integer,
	"department_id" integer,
	"team_id" text,
	"manager_user_id" text,
	"is_primary" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"date_format" text DEFAULT 'DD/MM/YYYY' NOT NULL,
	"time_format" text DEFAULT '12h' NOT NULL,
	"number_format" text DEFAULT '1,234.56',
	"week_start_day" text DEFAULT 'monday',
	"accent_color" text,
	"density" text DEFAULT 'comfortable',
	"font_size" text DEFAULT 'medium',
	"reduced_motion" boolean DEFAULT false,
	"high_contrast" boolean DEFAULT false,
	"notification_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dashboard_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percentage" integer DEFAULT 0 NOT NULL,
	"org_overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"updated_by_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flags_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "affiliate_commissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"affiliate_id" integer NOT NULL,
	"referred_org_id" integer NOT NULL,
	"subscription_id" integer,
	"amount_in_paise" integer NOT NULL,
	"status" "commission_status" DEFAULT 'PENDING' NOT NULL,
	"paid_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"referral_code" varchar(20) NOT NULL,
	"status" "affiliate_status" DEFAULT 'PENDING' NOT NULL,
	"commission_type" varchar(20) DEFAULT 'PERCENTAGE' NOT NULL,
	"commission_rate" integer DEFAULT 10 NOT NULL,
	"total_earned" integer DEFAULT 0 NOT NULL,
	"total_paid" integer DEFAULT 0 NOT NULL,
	"pending_payout" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"signup_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "affiliates_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "affiliates_referral_code_unique" UNIQUE("referral_code")
);
--> statement-breakpoint
CREATE TABLE "ai_credit_packs" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"credits" integer NOT NULL,
	"bonus_credits" integer DEFAULT 0 NOT NULL,
	"price_in_paise" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credit_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"feature" varchar(100) NOT NULL,
	"credits" integer NOT NULL,
	"status" "ai_credit_reservation_status" DEFAULT 'RESERVED' NOT NULL,
	"idempotency_key" varchar(120),
	"model" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credit_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"type" "ai_credit_txn_type" NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"feature" varchar(100),
	"model" varchar(100),
	"reference_id" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"app_id" integer NOT NULL,
	"installed_by" integer NOT NULL,
	"status" "app_install_status" DEFAULT 'ACTIVE' NOT NULL,
	"trial_ends_at" timestamp,
	"installed_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "billing_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"gstin" varchar(15),
	"pan" varchar(10),
	"billing_name" varchar(255),
	"billing_email" varchar(255),
	"address_line1" text,
	"address_line2" text,
	"city" varchar(100),
	"state" varchar(100),
	"pincode" varchar(10),
	"country" varchar(2) DEFAULT 'IN',
	"is_tax_exempt" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_profiles_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "enterprise_quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"quote_ref" text NOT NULL,
	"subject" text NOT NULL,
	"plan_tier" text DEFAULT 'ENTERPRISE' NOT NULL,
	"requested_seats" integer DEFAULT 0 NOT NULL,
	"negotiated_seats" integer DEFAULT 0 NOT NULL,
	"price_per_seat_in_paise" integer DEFAULT 0 NOT NULL,
	"contract_term_months" integer DEFAULT 12 NOT NULL,
	"contract_terms" text,
	"status" "enterprise_quote_status" DEFAULT 'DRAFT' NOT NULL,
	"approver_id" text,
	"approval_notes" text,
	"approved_at" timestamp,
	"sent_at" timestamp,
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"valid_until" date NOT NULL,
	"notes" text,
	"deal_id" integer,
	"client_id" integer,
	"created_by_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(50) NOT NULL,
	"icon_url" text,
	"screenshot_urls" jsonb DEFAULT '[]'::jsonb,
	"features" jsonb DEFAULT '[]'::jsonb,
	"pricing_type" varchar(20) DEFAULT 'free' NOT NULL,
	"monthly_price" integer DEFAULT 0 NOT NULL,
	"annual_price" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"required_plan" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_apps_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "org_ai_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"lifetime_granted" integer DEFAULT 0 NOT NULL,
	"lifetime_consumed" integer DEFAULT 0 NOT NULL,
	"auto_top_up_enabled" boolean DEFAULT false NOT NULL,
	"auto_top_up_pack_id" integer,
	"auto_top_up_threshold" integer DEFAULT 100,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_ai_credits_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" serial PRIMARY KEY NOT NULL,
	"referrer_org_id" integer NOT NULL,
	"referrer_user_id" integer NOT NULL,
	"referred_email" varchar(255) NOT NULL,
	"referred_org_id" integer,
	"referral_code" varchar(20) NOT NULL,
	"status" "referral_status" DEFAULT 'PENDING' NOT NULL,
	"reward_granted" boolean DEFAULT false NOT NULL,
	"signed_up_at" timestamp,
	"activated_at" timestamp,
	"rewarded_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "revenue_event_type" NOT NULL,
	"org_id" integer NOT NULL,
	"plan" varchar(20),
	"previous_plan" varchar(20),
	"mrr" integer NOT NULL,
	"amount" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" "workflow_node_type" NOT NULL,
	"action_type" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb,
	"position" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"approver_id" text NOT NULL,
	"status" "workflow_approval_status" DEFAULT 'pending' NOT NULL,
	"comment" text,
	"approved_at" timestamp,
	"rejected_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"workflow_id" uuid,
	"execution_id" uuid,
	"actor_id" text,
	"event" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"node_type" "workflow_node_type" NOT NULL,
	"status" "workflow_execution_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"status" "workflow_execution_status" DEFAULT 'pending' NOT NULL,
	"trigger_type" "workflow_trigger_type",
	"trigger_data" jsonb,
	"context" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"triggered_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"trigger_type" "workflow_trigger_type" NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value_type" text NOT NULL,
	"default_value" jsonb,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition_json" jsonb NOT NULL,
	"published_by" text,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text,
	"key" text,
	"name" text NOT NULL,
	"description" text,
	"best_for" text,
	"complexity" text,
	"badge" text,
	"category" "payroll_template_category" DEFAULT 'CUSTOM' NOT NULL,
	"default_toggles" jsonb NOT NULL,
	"default_components" jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_recommended" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_inputs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"source" "payroll_input_source" NOT NULL,
	"scheduled_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"paid_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"lop_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"half_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"overtime_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"shift_allowance_units" numeric(8, 2) DEFAULT '0' NOT NULL,
	"holiday_work_days" numeric(6, 2) DEFAULT '0' NOT NULL,
	"billable_hours" numeric(8, 2) DEFAULT '0' NOT NULL,
	"is_override" boolean DEFAULT false NOT NULL,
	"override_reason" text,
	"overridden_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"type" "payroll_run_event_type" NOT NULL,
	"actor_id" text,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslip_publications" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" integer NOT NULL,
	"run_employee_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"payslip_template_id" integer,
	"pdf_url" text,
	"published_at" timestamp,
	"published_by" text,
	"channel" "payslip_publish_channel" DEFAULT 'PORTAL' NOT NULL,
	"status" "payslip_publication_status" DEFAULT 'PENDING' NOT NULL,
	"snapshot_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_tax_windows" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"financial_year" text NOT NULL,
	"opens_at" timestamp NOT NULL,
	"closes_at" timestamp NOT NULL,
	"proof_deadline" timestamp,
	"lock_date" date,
	"status" "payroll_tax_window_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_integration_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"composio_connected_account_id" text NOT NULL,
	"account_email" text,
	"account_label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"scope" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_integration_connections_composio_account" UNIQUE("composio_connected_account_id")
);
--> statement-breakpoint
CREATE TABLE "guided_tours" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text,
	"tour_key" text NOT NULL,
	"module_key" text,
	"role" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "module_setup_checklist_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"checklist_id" integer NOT NULL,
	"item_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"action_href" text,
	"status" "onboarding_flow_step_status" DEFAULT 'todo' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp,
	"skipped_at" timestamp,
	CONSTRAINT "uq_module_checklist_items_checklist_key" UNIQUE("checklist_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "module_setup_checklists" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"module_key" text NOT NULL,
	"status" "module_setup_checklist_status" DEFAULT 'not_started' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"dismissed_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_module_setup_checklists_org_module" UNIQUE("org_id","module_key")
);
--> statement-breakpoint
CREATE TABLE "onboarding_analytics_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"event_type" text NOT NULL,
	"source" text,
	"step_key" text,
	"module_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_flow_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "onboarding_flow_type" NOT NULL,
	"status" "onboarding_flow_session_status" DEFAULT 'not_started' NOT NULL,
	"current_step" text,
	"completed_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_tour_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tour_key" text NOT NULL,
	"status" "guided_tour_progress_status" DEFAULT 'not_started' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp,
	"dismissed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_user_tour_progress_org_user_tour" UNIQUE("org_id","user_id","tour_key")
);
--> statement-breakpoint
CREATE TABLE "payment_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_user_id" text,
	"provider_id" integer,
	"action" text NOT NULL,
	"environment" "payment_environment",
	"before_redacted" jsonb,
	"after_redacted" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_manual_methods" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"method_type" text NOT NULL,
	"display_name" text NOT NULL,
	"instructions" text,
	"bank_name" text,
	"account_holder" text,
	"masked_account_number" text,
	"ifsc_swift_iban" text,
	"upi_id" text,
	"payment_reference_instructions" text,
	"require_manual_approval" boolean DEFAULT true NOT NULL,
	"status" "payment_manual_method_status" DEFAULT 'missing_instructions' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payment_manual_methods_org_type" UNIQUE("org_id","method_type")
);
--> statement-breakpoint
CREATE TABLE "payment_provider_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"provider_account_id" text,
	"business_type" text,
	"country" text,
	"default_currency" text,
	"kyc_status" text,
	"requirements_due" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payout_status" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payment_provider_accounts_provider" UNIQUE("provider_id")
);
--> statement-breakpoint
CREATE TABLE "payment_provider_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"key_id" text,
	"secret_ref" text,
	"webhook_secret_ref" text,
	"masked_key_hint" text,
	"last_rotated_at" timestamp,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payment_provider_credentials_provider_env" UNIQUE("provider_id","environment")
);
--> statement-breakpoint
CREATE TABLE "payment_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_key" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "payment_provider_status" DEFAULT 'not_configured' NOT NULL,
	"environment" "payment_environment" DEFAULT 'test' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"supported_currencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supported_payment_methods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payment_providers_org_provider_key" UNIQUE("org_id","provider_key")
);
--> statement-breakpoint
CREATE TABLE "payment_test_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"status" "payment_test_transaction_status" DEFAULT 'created' NOT NULL,
	"provider_order_id" text,
	"provider_payment_id" text,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"webhook_received" boolean DEFAULT false NOT NULL,
	"result_summary" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_endpoints" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"url" text NOT NULL,
	"expected_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "payment_webhook_endpoint_status" DEFAULT 'not_verified' NOT NULL,
	"last_verified_at" timestamp,
	"last_failure_at" timestamp,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payment_webhook_endpoints_provider_env" UNIQUE("provider_id","environment")
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_id" integer NOT NULL,
	"environment" "payment_environment" NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processing_status" "payment_webhook_processing_status" DEFAULT 'received' NOT NULL,
	"idempotency_key" text NOT NULL,
	"related_invoice_id" integer,
	"related_subscription_id" text,
	"payload_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"error_message" text,
	CONSTRAINT "uq_payment_webhook_events_provider_env_event" UNIQUE("provider_id","environment","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "survey_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"mode" "survey_form_mode" DEFAULT 'survey' NOT NULL,
	"status" "survey_form_status" DEFAULT 'draft' NOT NULL,
	"owner_user_id" text,
	"default_language" text DEFAULT 'en' NOT NULL,
	"active_version_id" integer,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"branding" jsonb DEFAULT '{}'::jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "survey_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_number" integer NOT NULL,
	"schema_snapshot" jsonb,
	"published_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_versions_survey_number" UNIQUE("survey_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "survey_logic_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"source_question_id" integer NOT NULL,
	"condition" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"target" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_question_choices" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"question_id" integer NOT NULL,
	"choice_key" text NOT NULL,
	"label" text NOT NULL,
	"value" text,
	"score" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_question_choices_question_key" UNIQUE("question_id","choice_key")
);
--> statement-breakpoint
CREATE TABLE "survey_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"section_id" integer NOT NULL,
	"question_key" text NOT NULL,
	"variable_name" text,
	"type" "survey_question_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"required" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"validation" jsonb DEFAULT '{}'::jsonb,
	"scoring" jsonb DEFAULT '{}'::jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_questions_version_key" UNIQUE("version_id","question_key")
);
--> statement-breakpoint
CREATE TABLE "survey_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_collectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer,
	"collector_type" "survey_collector_type" NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"status" "survey_collector_status" DEFAULT 'active' NOT NULL,
	"source" text,
	"utm" jsonb DEFAULT '{}'::jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"opens" integer DEFAULT 0 NOT NULL,
	"starts" integer DEFAULT 0 NOT NULL,
	"completions" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_collectors_token" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "survey_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"collector_id" integer,
	"user_id" text,
	"contact_id" integer,
	"lead_id" integer,
	"client_id" integer,
	"name" text,
	"email" text,
	"phone" text,
	"status" "survey_participant_status" DEFAULT 'invited' NOT NULL,
	"access_token_hash" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"invited_at" timestamp,
	"opened_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_participants_access_token_hash" UNIQUE("access_token_hash")
);
--> statement-breakpoint
CREATE TABLE "survey_answers" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"session_id" integer NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"question_id" integer NOT NULL,
	"answer_value" jsonb,
	"answer_text" text,
	"choice_ids" jsonb,
	"score" integer,
	"answered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_response_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"collector_id" integer,
	"participant_id" integer,
	"status" "survey_response_session_status" DEFAULT 'in_progress' NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"submitted_at" timestamp,
	"duration_seconds" integer,
	"score" integer,
	"passed" boolean,
	"segment" text,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "survey_assessment_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"participant_id" integer,
	"session_id" integer,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" "survey_assessment_attempt_status" DEFAULT 'not_started' NOT NULL,
	"score" integer,
	"passed" boolean,
	"started_at" timestamp,
	"submitted_at" timestamp,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "survey_certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"participant_id" integer NOT NULL,
	"attempt_id" integer NOT NULL,
	"certificate_number" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"file_url" text,
	CONSTRAINT "uq_survey_certificates_number" UNIQUE("certificate_number")
);
--> statement-breakpoint
CREATE TABLE "survey_live_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"version_id" integer NOT NULL,
	"host_user_id" text,
	"session_code" text NOT NULL,
	"status" "survey_live_session_status" DEFAULT 'draft' NOT NULL,
	"current_question_id" integer,
	"started_at" timestamp,
	"ended_at" timestamp,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_survey_live_sessions_code" UNIQUE("session_code")
);
--> statement-breakpoint
CREATE TABLE "survey_automation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"survey_id" integer NOT NULL,
	"session_id" integer,
	"event_type" text NOT NULL,
	"status" "survey_automation_event_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "ai_chat_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_chat_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"conversation_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedbucket_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"submission_id" integer NOT NULL,
	"file_url" text NOT NULL,
	"file_key" text,
	"file_name" text,
	"file_size" integer,
	"mime_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedbucket_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"widget_id" integer NOT NULL,
	"type" "feedbucket_submission_type" NOT NULL,
	"status" "feedbucket_submission_status" DEFAULT 'open' NOT NULL,
	"priority" "feedbucket_submission_priority",
	"message" text NOT NULL,
	"page_url" text,
	"screenshot_url" text,
	"screenshot_key" text,
	"metadata" jsonb,
	"console_logs" jsonb,
	"network_logs" jsonb,
	"reporter_name" text,
	"reporter_email" text,
	"assignee_id" text,
	"linked_ticket_id" integer,
	"ai_type" text,
	"ai_confidence" integer,
	"ai_analysis" jsonb,
	"ai_model" text,
	"ai_processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "feedbucket_widgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" integer,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"allowed_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"auto_create_ticket" boolean DEFAULT false NOT NULL,
	"default_ticket_type" text DEFAULT 'BUG' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"ai_assist_enabled" boolean DEFAULT false NOT NULL,
	"theme" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"notification_id" integer,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_key" text,
	"channel" "notification_channel" NOT NULL,
	"provider" "notification_provider",
	"recipient_address" text,
	"status" "notification_delivery_status" DEFAULT 'PENDING' NOT NULL,
	"priority" "notification_priority" DEFAULT 'NORMAL' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp,
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"read_at" timestamp,
	"clicked_at" timestamp,
	"failed_at" timestamp,
	"failure_code" text,
	"failure_message" text,
	"suppression_reason" "notification_suppression_reason",
	"provider_message_id" text,
	"provider_response" jsonb,
	"cost_amount" integer DEFAULT 0 NOT NULL,
	"cost_currency" text DEFAULT 'USD' NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text,
	"event_key" text NOT NULL,
	"source_module" text NOT NULL,
	"category" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"default_priority" "notification_priority" DEFAULT 'NORMAL' NOT NULL,
	"default_type" "notification_type" DEFAULT 'INFO' NOT NULL,
	"default_channels" jsonb DEFAULT '["IN_APP"]'::jsonb NOT NULL,
	"allowed_channels" jsonb DEFAULT '["IN_APP"]'::jsonb NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"user_configurable" boolean DEFAULT true NOT NULL,
	"admin_configurable" boolean DEFAULT true NOT NULL,
	"quiet_hours_behavior" "notification_quiet_hours_behavior" DEFAULT 'respect' NOT NULL,
	"dedupe_window_seconds" integer DEFAULT 0 NOT NULL,
	"rate_limit_window_seconds" integer DEFAULT 0 NOT NULL,
	"rate_limit_max" integer DEFAULT 0 NOT NULL,
	"template_key" text,
	"audience_resolver" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_policy_defaults" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope_type" "notification_policy_scope" NOT NULL,
	"scope_id" text,
	"default_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"category_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"module_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"can_user_override" boolean DEFAULT true NOT NULL,
	"resolution_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_provider_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"provider" "notification_provider" NOT NULL,
	"display_name" text NOT NULL,
	"config_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sandbox_mode" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"daily_send_limit" integer,
	"monthly_cost_limit" integer,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_tested_at" timestamp,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" integer NOT NULL,
	"org_id" text NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"status" "notification_queue_status" DEFAULT 'PENDING' NOT NULL,
	"locked_by" text,
	"locked_at" timestamp,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_suppression_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"scope_type" text NOT NULL,
	"scope_key" text NOT NULL,
	"channel" "notification_channel",
	"reason" "notification_suppression_reason" NOT NULL,
	"expires_at" timestamp,
	"created_by" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"status" "sign_template_status" DEFAULT 'draft' NOT NULL,
	"owner_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"template_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"restricted_to_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"restricted_to_teams" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_watermark_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope_type" "sign_watermark_scope" DEFAULT 'tenant' NOT NULL,
	"scope_id" integer,
	"applies_states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text,
	"image_file_key" text,
	"opacity" integer DEFAULT 30 NOT NULL,
	"angle" integer DEFAULT 45 NOT NULL,
	"color" text DEFAULT '#94A3B8' NOT NULL,
	"font_size" integer DEFAULT 36 NOT NULL,
	"placement" text DEFAULT 'diagonal_tiled' NOT NULL,
	"pages" jsonb DEFAULT '{"mode":"all"}'::jsonb NOT NULL,
	"show_on_final_pdf" boolean DEFAULT true NOT NULL,
	"preview_only" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_envelopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"subject" text,
	"message" text,
	"status" "sign_envelope_status" DEFAULT 'draft' NOT NULL,
	"routing_mode" "sign_routing_mode" DEFAULT 'parallel' NOT NULL,
	"cc_timing" "sign_cc_timing" DEFAULT 'on_complete' NOT NULL,
	"allow_decline" boolean DEFAULT true NOT NULL,
	"source_module" text,
	"source_entity_type" text,
	"source_entity_id" text,
	"template_id" integer,
	"watermark_policy_id" integer,
	"sender_user_id" text NOT NULL,
	"reminder_enabled" boolean DEFAULT true NOT NULL,
	"reminder_first_after_days" integer DEFAULT 3 NOT NULL,
	"reminder_repeat_days" integer DEFAULT 3 NOT NULL,
	"reminder_max_count" integer DEFAULT 5 NOT NULL,
	"reminder_sent_count" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp,
	"expires_at" timestamp,
	"sent_at" timestamp,
	"completed_at" timestamp,
	"voided_at" timestamp,
	"voided_by" text,
	"void_reason" text,
	"declined_at" timestamp,
	"correction_required_at" timestamp,
	"correction_reason" text,
	"finalization_key" text,
	"finalized_at" timestamp,
	"final_pdf_file_key" text,
	"final_pdf_hash" text,
	"public_form_id" integer,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"envelope_id" integer NOT NULL,
	"original_file_key" text NOT NULL,
	"current_file_key" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"page_count" integer,
	"file_size" integer NOT NULL,
	"sha256_hash" text NOT NULL,
	"conversion_status" "sign_conversion_status" DEFAULT 'not_needed' NOT NULL,
	"conversion_error" text,
	"order_index" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_recipients" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"envelope_id" integer NOT NULL,
	"role_name" text NOT NULL,
	"recipient_type" "sign_recipient_type" DEFAULT 'signer' NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"user_id" text,
	"routing_order" integer DEFAULT 1 NOT NULL,
	"status" "sign_recipient_status" DEFAULT 'pending' NOT NULL,
	"auth_method" "sign_auth_method" DEFAULT 'email_link' NOT NULL,
	"access_code_hash" text,
	"otp_code_hash" text,
	"otp_expires_at" timestamp,
	"otp_attempts" integer DEFAULT 0 NOT NULL,
	"failed_auth_attempts" integer DEFAULT 0 NOT NULL,
	"auth_locked_until" timestamp,
	"signing_token_hash" text,
	"token_expires_at" timestamp,
	"token_revoked_at" timestamp,
	"consent_accepted_at" timestamp,
	"consent_ip" text,
	"consent_user_agent" text,
	"consent_disclosure_version" text,
	"delegated_to_recipient_id" integer,
	"viewed_at" timestamp,
	"authenticated_at" timestamp,
	"completed_at" timestamp,
	"declined_at" timestamp,
	"declined_reason" text,
	"bounced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"envelope_id" integer NOT NULL,
	"document_id" integer NOT NULL,
	"recipient_id" integer NOT NULL,
	"field_type" "sign_field_type" NOT NULL,
	"label" text,
	"page_number" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"readonly" boolean DEFAULT false NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"group_id" text,
	"default_value" text,
	"options_json" jsonb,
	"validation_type" text,
	"validation_rules_json" jsonb,
	"conditional_rules_json" jsonb,
	"value_json" jsonb,
	"attachment_file_key" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_signature_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"envelope_id" integer NOT NULL,
	"recipient_id" integer NOT NULL,
	"asset_type" "sign_signature_asset_type" NOT NULL,
	"method" "sign_signature_method" NOT NULL,
	"image_file_key" text,
	"typed_text" text,
	"typed_font_style" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"envelope_id" integer,
	"recipient_id" integer,
	"actor_type" "sign_actor_type" NOT NULL,
	"actor_user_id" text,
	"actor_name" text,
	"actor_email" text,
	"event_type" "sign_audit_event_type" NOT NULL,
	"event_message" text,
	"ip_address" text,
	"user_agent" text,
	"geolocation_json" jsonb,
	"document_hash" text,
	"request_id" text,
	"event_payload_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_certificates" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"envelope_id" integer NOT NULL,
	"certificate_number" text NOT NULL,
	"certificate_file_key" text NOT NULL,
	"final_pdf_file_key" text NOT NULL,
	"final_pdf_hash" text NOT NULL,
	"watermarked" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp DEFAULT now() NOT NULL,
	"certificate_json" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_bulk_send_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template_id" integer NOT NULL,
	"sender_user_id" text NOT NULL,
	"status" "sign_bulk_job_status" DEFAULT 'pending' NOT NULL,
	"column_mapping_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"csv_file_key" text,
	"error_report_file_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sign_bulk_send_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"row_number" integer NOT NULL,
	"raw_data_json" jsonb NOT NULL,
	"status" "sign_bulk_row_status" DEFAULT 'pending' NOT NULL,
	"envelope_id" integer,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_public_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"template_id" integer NOT NULL,
	"slug" text NOT NULL,
	"status" "sign_public_form_status" DEFAULT 'draft' NOT NULL,
	"access_code_hash" text,
	"max_submissions" integer,
	"submission_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp,
	"completion_redirect_url" text,
	"webhook_url" text,
	"embed_allowed" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_org_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"default_expiration_days" integer DEFAULT 30 NOT NULL,
	"expiration_warning_days" integer DEFAULT 3 NOT NULL,
	"default_reminder_first_after_days" integer DEFAULT 3 NOT NULL,
	"default_reminder_repeat_days" integer DEFAULT 3 NOT NULL,
	"default_reminder_max_count" integer DEFAULT 5 NOT NULL,
	"allowed_file_types" jsonb DEFAULT '["application/pdf"]'::jsonb NOT NULL,
	"max_file_size_mb" integer DEFAULT 25 NOT NULL,
	"allowed_auth_methods" jsonb DEFAULT '["email_link","access_code","otp_email"]'::jsonb NOT NULL,
	"certificate_format" text DEFAULT 'pdf' NOT NULL,
	"retention_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"public_forms_enabled" boolean DEFAULT true NOT NULL,
	"bulk_send_max_rows_per_job" integer DEFAULT 500 NOT NULL,
	"bulk_send_max_active_jobs" integer DEFAULT 5 NOT NULL,
	"bulk_send_max_recipients_per_envelope" integer DEFAULT 20 NOT NULL,
	"sender_rate_limit_per_hour" integer DEFAULT 200 NOT NULL,
	"branding_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "ai_job_status" DEFAULT 'QUEUED' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"idempotency_key" varchar(120),
	"run_at" timestamp DEFAULT now() NOT NULL,
	"locked_by" varchar(64),
	"locked_at" timestamp,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"feature" varchar(100) NOT NULL,
	"correlation_id" varchar(64),
	"entity_type" varchar(50),
	"entity_id" varchar(50),
	"rating" "ai_feedback_rating" NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_action_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"action" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"status" "ai_proposal_status" DEFAULT 'PROPOSED' NOT NULL,
	"idempotency_key" varchar(120),
	"expires_at" timestamp NOT NULL,
	"executed_at" timestamp,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_search_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"url_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"fts" "tsvector",
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_summary_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entity_type" varchar(50) NOT NULL,
	"entity_id" varchar(100) NOT NULL,
	"summary" text NOT NULL,
	"structured" jsonb,
	"citations" jsonb,
	"correlation_id" varchar(64),
	"generated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_otp_codes" ADD CONSTRAINT "email_otp_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_steps" ADD CONSTRAINT "onboarding_steps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_steps" ADD CONSTRAINT "onboarding_steps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_custom_domains" ADD CONSTRAINT "org_custom_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_custom_domains" ADD CONSTRAINT "org_custom_domains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_holidays" ADD CONSTRAINT "org_holidays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_holidays" ADD CONSTRAINT "org_holidays_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_api_tokens" ADD CONSTRAINT "user_api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_delegations" ADD CONSTRAINT "user_delegations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_delegations" ADD CONSTRAINT "user_delegations_delegator_id_users_id_fk" FOREIGN KEY ("delegator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_delegations" ADD CONSTRAINT "user_delegations_delegatee_id_users_id_fk" FOREIGN KEY ("delegatee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_delegations" ADD CONSTRAINT "user_delegations_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_last_active_org_id_organizations_id_fk" FOREIGN KEY ("last_active_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reporting_to_users_id_fk" FOREIGN KEY ("reporting_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_versions" ADD CONSTRAINT "access_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_roles" ADD CONSTRAINT "group_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission_grants" ADD CONSTRAINT "role_permission_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission_grants" ADD CONSTRAINT "role_permission_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission_grants" ADD CONSTRAINT "role_permission_grants_permission_key_permissions_name_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_states" ADD CONSTRAINT "custom_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_states" ADD CONSTRAINT "custom_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modules" ADD CONSTRAINT "modules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_template_tickets" ADD CONSTRAINT "project_template_tickets_template_id_project_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."project_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_users_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_automations" ADD CONSTRAINT "project_automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_custom_fields" ADD CONSTRAINT "project_custom_fields_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_custom_fields" ADD CONSTRAINT "project_custom_fields_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_releases" ADD CONSTRAINT "project_releases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tickets" ADD CONSTRAINT "release_tickets_release_id_project_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."project_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_tickets" ADD CONSTRAINT "release_tickets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_attachments" ADD CONSTRAINT "ticket_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_checklist_id_ticket_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."ticket_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklist_items" ADD CONSTRAINT "ticket_checklist_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklists" ADD CONSTRAINT "ticket_checklists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_checklists" ADD CONSTRAINT "ticket_checklists_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comment_reactions" ADD CONSTRAINT "ticket_comment_reactions_comment_id_ticket_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."ticket_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_parent_comment_id_ticket_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."ticket_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_custom_field_values" ADD CONSTRAINT "ticket_custom_field_values_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_custom_field_values" ADD CONSTRAINT "ticket_custom_field_values_field_id_project_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."project_custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_label_mappings" ADD CONSTRAINT "ticket_label_mappings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_label_mappings" ADD CONSTRAINT "ticket_label_mappings_label_id_ticket_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."ticket_labels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_labels" ADD CONSTRAINT "ticket_labels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_related_links" ADD CONSTRAINT "ticket_related_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_related_links" ADD CONSTRAINT "ticket_related_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "ticket_watchers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "ticket_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_state_id_custom_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."custom_states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_module_id_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."modules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_cycle_id_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_epic_id_tickets_id_fk" FOREIGN KEY ("epic_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_ticket_id_tickets_id_fk" FOREIGN KEY ("parent_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_payroll_export_id_timesheet_exports_id_fk" FOREIGN KEY ("payroll_export_id") REFERENCES "public"."timesheet_exports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_timesheet_period_id_timesheet_periods_id_fk" FOREIGN KEY ("timesheet_period_id") REFERENCES "public"."timesheet_periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_timer_session_id_timer_sessions_id_fk" FOREIGN KEY ("timer_session_id") REFERENCES "public"."timer_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_project_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."project_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_work_item_id_tickets_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_relations" ADD CONSTRAINT "work_item_relations_related_work_item_id_tickets_id_fk" FOREIGN KEY ("related_work_item_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_exports" ADD CONSTRAINT "timesheet_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_exports" ADD CONSTRAINT "timesheet_exports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_settings" ADD CONSTRAINT "timesheet_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer_sessions" ADD CONSTRAINT "timer_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer_sessions" ADD CONSTRAINT "timer_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timer_sessions" ADD CONSTRAINT "timer_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_audit_events" ADD CONSTRAINT "timesheet_audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_audit_events" ADD CONSTRAINT "timesheet_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ADD CONSTRAINT "timesheet_budgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_budgets" ADD CONSTRAINT "timesheet_budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_current_approver_id_users_id_fk" FOREIGN KEY ("current_approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_rate_cards" ADD CONSTRAINT "timesheet_rate_cards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_rates" ADD CONSTRAINT "timesheet_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_rates" ADD CONSTRAINT "timesheet_rates_rate_card_id_timesheet_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."timesheet_rate_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_rates" ADD CONSTRAINT "timesheet_rates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_rates" ADD CONSTRAINT "timesheet_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_items" ADD CONSTRAINT "intake_items_linked_work_item_id_tickets_id_fk" FOREIGN KEY ("linked_work_item_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_page_id_pages_id_fk" FOREIGN KEY ("parent_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_statuses" ADD CONSTRAINT "project_statuses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_statuses" ADD CONSTRAINT "project_statuses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_views" ADD CONSTRAINT "project_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_views" ADD CONSTRAINT "project_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_views" ADD CONSTRAINT "project_views_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_daily_snapshots" ADD CONSTRAINT "project_daily_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_daily_snapshots" ADD CONSTRAINT "project_daily_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "okr_goals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "okr_goals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "okr_goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "okr_goals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_goals" ADD CONSTRAINT "okr_goals_parent_goal_id_okr_goals_id_fk" FOREIGN KEY ("parent_goal_id") REFERENCES "public"."okr_goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_key_results" ADD CONSTRAINT "okr_key_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_key_results" ADD CONSTRAINT "okr_key_results_goal_id_okr_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."okr_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_links" ADD CONSTRAINT "okr_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_links" ADD CONSTRAINT "okr_links_goal_id_okr_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."okr_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_links" ADD CONSTRAINT "okr_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_links" ADD CONSTRAINT "okr_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_updates" ADD CONSTRAINT "okr_updates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_updates" ADD CONSTRAINT "okr_updates_goal_id_okr_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."okr_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_updates" ADD CONSTRAINT "okr_updates_key_result_id_okr_key_results_id_fk" FOREIGN KEY ("key_result_id") REFERENCES "public"."okr_key_results"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "okr_updates" ADD CONSTRAINT "okr_updates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_linked_roadmap_item_id_roadmap_items_id_fk" FOREIGN KEY ("linked_roadmap_item_id") REFERENCES "public"."roadmap_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_posts" ADD CONSTRAINT "feedback_posts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_posts" ADD CONSTRAINT "feedback_posts_linked_roadmap_item_id_roadmap_items_id_fk" FOREIGN KEY ("linked_roadmap_item_id") REFERENCES "public"."roadmap_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_feedback_post_id_feedback_posts_id_fk" FOREIGN KEY ("feedback_post_id") REFERENCES "public"."feedback_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_items" ADD CONSTRAINT "roadmap_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_items" ADD CONSTRAINT "roadmap_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_items" ADD CONSTRAINT "roadmap_items_epic_ticket_id_tickets_id_fk" FOREIGN KEY ("epic_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_votes" ADD CONSTRAINT "roadmap_votes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roadmap_votes" ADD CONSTRAINT "roadmap_votes_roadmap_item_id_roadmap_items_id_fk" FOREIGN KEY ("roadmap_item_id") REFERENCES "public"."roadmap_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "project_whiteboard_shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "project_whiteboard_shares_whiteboard_id_project_whiteboards_id_fk" FOREIGN KEY ("whiteboard_id") REFERENCES "public"."project_whiteboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_whiteboard_shares" ADD CONSTRAINT "project_whiteboard_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD CONSTRAINT "project_whiteboards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_whiteboards" ADD CONSTRAINT "project_whiteboards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_ticket_links" ADD CONSTRAINT "git_ticket_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_ticket_links" ADD CONSTRAINT "git_ticket_links_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_ticket_links" ADD CONSTRAINT "git_ticket_links_connection_id_git_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."git_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_activity_log" ADD CONSTRAINT "ticket_activity_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_activity_log" ADD CONSTRAINT "ticket_activity_log_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_activity_log" ADD CONSTRAINT "ticket_activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comment_mentions" ADD CONSTRAINT "ticket_comment_mentions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comment_mentions" ADD CONSTRAINT "ticket_comment_mentions_comment_id_ticket_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."ticket_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_comment_mentions" ADD CONSTRAINT "ticket_comment_mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_suite_id_test_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."test_suites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_test_case_id_test_cases_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_run_results" ADD CONSTRAINT "test_run_results_linked_bug_id_bugs_id_fk" FOREIGN KEY ("linked_bug_id") REFERENCES "public"."bugs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_release_id_project_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."project_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_tester_id_users_id_fk" FOREIGN KEY ("tester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_parent_id_test_suites_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."test_suites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_suites" ADD CONSTRAINT "test_suites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_affected_release_id_project_releases_id_fk" FOREIGN KEY ("affected_release_id") REFERENCES "public"."project_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_fixed_release_id_project_releases_id_fk" FOREIGN KEY ("fixed_release_id") REFERENCES "public"."project_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_qa_owner_id_users_id_fk" FOREIGN KEY ("qa_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_linked_test_case_id_test_cases_id_fk" FOREIGN KEY ("linked_test_case_id") REFERENCES "public"."test_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bugs" ADD CONSTRAINT "bugs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_approval_owner_id_users_id_fk" FOREIGN KEY ("approval_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_approvals" ADD CONSTRAINT "project_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_approvals" ADD CONSTRAINT "project_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_approvals" ADD CONSTRAINT "project_approvals_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_approvals" ADD CONSTRAINT "project_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_approvals" ADD CONSTRAINT "project_approvals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_risks" ADD CONSTRAINT "project_risks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_meeting_id_project_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."project_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_converted_ticket_id_tickets_id_fk" FOREIGN KEY ("converted_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_meeting_id_project_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."project_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendees" ADD CONSTRAINT "meeting_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_standup_entries" ADD CONSTRAINT "meeting_standup_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_standup_entries" ADD CONSTRAINT "meeting_standup_entries_meeting_id_project_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."project_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_standup_entries" ADD CONSTRAINT "meeting_standup_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_meetings" ADD CONSTRAINT "project_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_meetings" ADD CONSTRAINT "project_meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_meetings" ADD CONSTRAINT "project_meetings_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_meetings" ADD CONSTRAINT "project_meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_incident_id_project_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."project_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_incidents" ADD CONSTRAINT "project_incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_incidents" ADD CONSTRAINT "project_incidents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_incidents" ADD CONSTRAINT "project_incidents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_incidents" ADD CONSTRAINT "project_incidents_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_incidents" ADD CONSTRAINT "project_incidents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_project_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."project_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_by_id_users_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_converted_ticket_id_tickets_id_fk" FOREIGN KEY ("converted_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_forms" ADD CONSTRAINT "project_forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_forms" ADD CONSTRAINT "project_forms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_forms" ADD CONSTRAINT "project_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_projects" ADD CONSTRAINT "portfolio_projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_projects" ADD CONSTRAINT "portfolio_projects_portfolio_id_project_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."project_portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_projects" ADD CONSTRAINT "portfolio_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_projects" ADD CONSTRAINT "program_projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_projects" ADD CONSTRAINT "program_projects_program_id_project_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."project_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_projects" ADD CONSTRAINT "program_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_portfolios" ADD CONSTRAINT "project_portfolios_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_portfolios" ADD CONSTRAINT "project_portfolios_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_portfolios" ADD CONSTRAINT "project_portfolios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_programs" ADD CONSTRAINT "project_programs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_programs" ADD CONSTRAINT "project_programs_portfolio_id_project_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."project_portfolios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_programs" ADD CONSTRAINT "project_programs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_programs" ADD CONSTRAINT "project_programs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_from_status_id_project_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."project_statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_status_id_project_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."project_statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_effective_dated_changes" ADD CONSTRAINT "hr_effective_dated_changes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_effective_dated_changes" ADD CONSTRAINT "hr_effective_dated_changes_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_effective_dated_changes" ADD CONSTRAINT "hr_effective_dated_changes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_effective_dated_changes" ADD CONSTRAINT "hr_effective_dated_changes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_profiles" ADD CONSTRAINT "hr_employee_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_profiles" ADD CONSTRAINT "hr_employee_profiles_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_sensitive_fields" ADD CONSTRAINT "hr_employee_sensitive_fields_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employee_sensitive_fields" ADD CONSTRAINT "hr_employee_sensitive_fields_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_history" ADD CONSTRAINT "hr_employment_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_history" ADD CONSTRAINT "hr_employment_history_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employment_history" ADD CONSTRAINT "hr_employment_history_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_person_id_hr_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hr_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_employments" ADD CONSTRAINT "hr_employments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_people" ADD CONSTRAINT "hr_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_people" ADD CONSTRAINT "hr_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_lines" ADD CONSTRAINT "hr_reporting_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_lines" ADD CONSTRAINT "hr_reporting_lines_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_lines" ADD CONSTRAINT "hr_reporting_lines_manager_employment_id_hr_employments_id_fk" FOREIGN KEY ("manager_employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reporting_lines" ADD CONSTRAINT "hr_reporting_lines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_custom_field_definitions" ADD CONSTRAINT "hr_custom_field_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_custom_field_values" ADD CONSTRAINT "hr_custom_field_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_custom_field_values" ADD CONSTRAINT "hr_custom_field_values_field_definition_id_hr_custom_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."hr_custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_levels" ADD CONSTRAINT "hr_job_levels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_job_roles" ADD CONSTRAINT "hr_job_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_locations" ADD CONSTRAINT "hr_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_teams" ADD CONSTRAINT "hr_teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_teams" ADD CONSTRAINT "hr_teams_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_audit_logs" ADD CONSTRAINT "hr_audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_audit_logs" ADD CONSTRAINT "hr_audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_automation_rules" ADD CONSTRAINT "hr_automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_automation_rules" ADD CONSTRAINT "hr_automation_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_automation_runs" ADD CONSTRAINT "hr_automation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_automation_runs" ADD CONSTRAINT "hr_automation_runs_rule_id_hr_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."hr_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policies" ADD CONSTRAINT "hr_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policies" ADD CONSTRAINT "hr_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_assignments" ADD CONSTRAINT "hr_policy_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_assignments" ADD CONSTRAINT "hr_policy_assignments_policy_id_hr_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."hr_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_assignments" ADD CONSTRAINT "hr_policy_assignments_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_scopes" ADD CONSTRAINT "hr_policy_scopes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_policy_scopes" ADD CONSTRAINT "hr_policy_scopes_policy_id_hr_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."hr_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_definitions" ADD CONSTRAINT "hr_workflow_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" ADD CONSTRAINT "hr_workflow_delegations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" ADD CONSTRAINT "hr_workflow_delegations_delegator_user_id_users_id_fk" FOREIGN KEY ("delegator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_delegations" ADD CONSTRAINT "hr_workflow_delegations_delegate_user_id_users_id_fk" FOREIGN KEY ("delegate_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_instances" ADD CONSTRAINT "hr_workflow_instances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_instances" ADD CONSTRAINT "hr_workflow_instances_definition_id_hr_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."hr_workflow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_instances" ADD CONSTRAINT "hr_workflow_instances_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_instances" ADD CONSTRAINT "hr_workflow_instances_subject_employee_id_users_id_fk" FOREIGN KEY ("subject_employee_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" ADD CONSTRAINT "hr_workflow_step_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" ADD CONSTRAINT "hr_workflow_step_actions_instance_id_hr_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."hr_workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" ADD CONSTRAINT "hr_workflow_step_actions_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_step_actions" ADD CONSTRAINT "hr_workflow_step_actions_acted_by_user_id_users_id_fk" FOREIGN KEY ("acted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_workflow_steps" ADD CONSTRAINT "hr_workflow_steps_definition_id_hr_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."hr_workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_template_renders" ADD CONSTRAINT "hr_template_renders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_template_renders" ADD CONSTRAINT "hr_template_renders_template_id_hr_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."hr_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_template_renders" ADD CONSTRAINT "hr_template_renders_rendered_by_users_id_fk" FOREIGN KEY ("rendered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_templates" ADD CONSTRAINT "hr_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_templates" ADD CONSTRAINT "hr_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_templates" ADD CONSTRAINT "hr_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_period_id_hr_payroll_input_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."hr_payroll_input_periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_adjustments" ADD CONSTRAINT "hr_payroll_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_input_periods" ADD CONSTRAINT "hr_payroll_input_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_input_periods" ADD CONSTRAINT "hr_payroll_input_periods_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_input_periods" ADD CONSTRAINT "hr_payroll_input_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" ADD CONSTRAINT "hr_payroll_input_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" ADD CONSTRAINT "hr_payroll_input_snapshots_period_id_hr_payroll_input_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."hr_payroll_input_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_input_snapshots" ADD CONSTRAINT "hr_payroll_input_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_devices" ADD CONSTRAINT "employee_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_devices" ADD CONSTRAINT "employee_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" ADD CONSTRAINT "helpdesk_tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_helpdesk_comments" ADD CONSTRAINT "hr_helpdesk_comments_ticket_id_helpdesk_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."helpdesk_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_helpdesk_comments" ADD CONSTRAINT "hr_helpdesk_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_helpdesk_comments" ADD CONSTRAINT "hr_helpdesk_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ADD CONSTRAINT "hr_helpdesk_routing_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_helpdesk_routing" ADD CONSTRAINT "hr_helpdesk_routing_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD CONSTRAINT "wfh_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD CONSTRAINT "wfh_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wfh_requests" ADD CONSTRAINT "wfh_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" ADD CONSTRAINT "hr_attendance_regularizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" ADD CONSTRAINT "hr_attendance_regularizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" ADD CONSTRAINT "hr_attendance_regularizations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_attendance_regularizations" ADD CONSTRAINT "hr_attendance_regularizations_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_blackout_dates" ADD CONSTRAINT "leave_blackout_dates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_blackout_dates" ADD CONSTRAINT "leave_blackout_dates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_covering_employee_id_users_id_fk" FOREIGN KEY ("covering_employee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_ledger" ADD CONSTRAINT "hr_leave_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_ledger" ADD CONSTRAINT "hr_leave_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_ledger" ADD CONSTRAINT "hr_leave_ledger_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_leave_ledger" ADD CONSTRAINT "hr_leave_ledger_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_returns" ADD CONSTRAINT "asset_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_returns" ADD CONSTRAINT "asset_returns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_returns" ADD CONSTRAINT "asset_returns_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bonuses" ADD CONSTRAINT "bonuses_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_posted_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("posted_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD CONSTRAINT "fnf_settlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD CONSTRAINT "fnf_settlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD CONSTRAINT "fnf_settlements_resignation_id_resignations_id_fk" FOREIGN KEY ("resignation_id") REFERENCES "public"."resignations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fnf_settlements" ADD CONSTRAINT "fnf_settlements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursements" ADD CONSTRAINT "reimbursements_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_loans" ADD CONSTRAINT "salary_loans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_loans" ADD CONSTRAINT "salary_loans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_loans" ADD CONSTRAINT "salary_loans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_structures" ADD CONSTRAINT "salary_structures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_link_interviewers" ADD CONSTRAINT "booking_link_interviewers_booking_link_id_interview_booking_links_id_fk" FOREIGN KEY ("booking_link_id") REFERENCES "public"."interview_booking_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_link_interviewers" ADD CONSTRAINT "booking_link_interviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD CONSTRAINT "calibration_participants_session_id_calibration_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."calibration_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD CONSTRAINT "calibration_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_participants" ADD CONSTRAINT "calibration_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calibration_sessions" ADD CONSTRAINT "calibration_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD CONSTRAINT "candidate_applications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD CONSTRAINT "candidate_applications_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_applications" ADD CONSTRAINT "candidate_applications_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents_vault" ADD CONSTRAINT "candidate_documents_vault_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents_vault" ADD CONSTRAINT "candidate_documents_vault_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents_vault" ADD CONSTRAINT "candidate_documents_vault_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_messages" ADD CONSTRAINT "candidate_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_messages" ADD CONSTRAINT "candidate_messages_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_messages" ADD CONSTRAINT "candidate_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD CONSTRAINT "candidate_offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD CONSTRAINT "candidate_offers_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD CONSTRAINT "candidate_offers_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD CONSTRAINT "candidate_offers_offered_by_users_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_offers" ADD CONSTRAINT "candidate_offers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_reference_checks" ADD CONSTRAINT "candidate_reference_checks_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_reference_checks" ADD CONSTRAINT "candidate_reference_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_reference_checks" ADD CONSTRAINT "candidate_reference_checks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_referrals" ADD CONSTRAINT "candidate_referrals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_referrals" ADD CONSTRAINT "candidate_referrals_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_referrals" ADD CONSTRAINT "candidate_referrals_referred_by_users_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_referrals" ADD CONSTRAINT "candidate_referrals_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_sla_tracking" ADD CONSTRAINT "candidate_sla_tracking_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_sla_tracking" ADD CONSTRAINT "candidate_sla_tracking_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_sources" ADD CONSTRAINT "candidate_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_sources" ADD CONSTRAINT "candidate_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_referred_by_users_id_fk" FOREIGN KEY ("referred_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_duplicate_of_id_candidates_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequence_enrollments" ADD CONSTRAINT "email_sequence_enrollments_sequence_id_email_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."email_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequence_enrollments" ADD CONSTRAINT "email_sequence_enrollments_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequence_steps" ADD CONSTRAINT "email_sequence_steps_sequence_id_email_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."email_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequences" ADD CONSTRAINT "email_sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sequences" ADD CONSTRAINT "email_sequences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_requests" ADD CONSTRAINT "headcount_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_requests" ADD CONSTRAINT "headcount_requests_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_requests" ADD CONSTRAINT "headcount_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_requests" ADD CONSTRAINT "headcount_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "headcount_requests" ADD CONSTRAINT "headcount_requests_linked_job_posting_id_job_postings_id_fk" FOREIGN KEY ("linked_job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_flow_rounds" ADD CONSTRAINT "hiring_flow_rounds_flow_id_hiring_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."hiring_flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_flow_rounds" ADD CONSTRAINT "hiring_flow_rounds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_flow_rounds" ADD CONSTRAINT "hiring_flow_rounds_scorecard_template_id_scorecard_templates_id_fk" FOREIGN KEY ("scorecard_template_id") REFERENCES "public"."scorecard_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_flows" ADD CONSTRAINT "hiring_flows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hiring_flows" ADD CONSTRAINT "hiring_flows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_booking_links" ADD CONSTRAINT "interview_booking_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_booking_links" ADD CONSTRAINT "interview_booking_links_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_booking_links" ADD CONSTRAINT "interview_booking_links_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_booking_links" ADD CONSTRAINT "interview_booking_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD CONSTRAINT "interview_panel_members_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD CONSTRAINT "interview_panel_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_panel_members" ADD CONSTRAINT "interview_panel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_template_id_scorecard_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."scorecard_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slas" ADD CONSTRAINT "interview_slas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_hiring_flow_id_hiring_flows_id_fk" FOREIGN KEY ("hiring_flow_id") REFERENCES "public"."hiring_flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recruiters" ADD CONSTRAINT "job_recruiters_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recruiters" ADD CONSTRAINT "job_recruiters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recruiters" ADD CONSTRAINT "job_recruiters_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_letter_templates" ADD CONSTRAINT "offer_letter_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_letter_templates" ADD CONSTRAINT "offer_letter_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_negotiations" ADD CONSTRAINT "offer_negotiations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_negotiations" ADD CONSTRAINT "offer_negotiations_offer_id_candidate_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."candidate_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_negotiations" ADD CONSTRAINT "offer_negotiations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_offer_id_candidate_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."candidate_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_automations" ADD CONSTRAINT "pipeline_automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_activity_log" ADD CONSTRAINT "recruiter_activity_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_activity_log" ADD CONSTRAINT "recruiter_activity_log_recruiter_id_users_id_fk" FOREIGN KEY ("recruiter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_activity_log" ADD CONSTRAINT "recruiter_activity_log_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruiter_activity_log" ADD CONSTRAINT "recruiter_activity_log_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitment_vendors" ADD CONSTRAINT "recruitment_vendors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recruitment_vendors" ADD CONSTRAINT "recruitment_vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_templates" ADD CONSTRAINT "scorecard_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scorecard_templates" ADD CONSTRAINT "scorecard_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "vault_access_logs_vault_document_id_candidate_documents_vault_id_fk" FOREIGN KEY ("vault_document_id") REFERENCES "public"."candidate_documents_vault"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access_logs" ADD CONSTRAINT "vault_access_logs_accessed_by_users_id_fk" FOREIGN KEY ("accessed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_candidate_submissions" ADD CONSTRAINT "vendor_candidate_submissions_vendor_id_recruitment_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."recruitment_vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_candidate_submissions" ADD CONSTRAINT "vendor_candidate_submissions_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_candidate_submissions" ADD CONSTRAINT "vendor_candidate_submissions_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_profiles" ADD CONSTRAINT "alumni_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_profiles" ADD CONSTRAINT "alumni_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_verifications" ADD CONSTRAINT "background_verifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_verifications" ADD CONSTRAINT "background_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_documents" ADD CONSTRAINT "candidate_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audit_logs" ADD CONSTRAINT "document_audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audit_logs" ADD CONSTRAINT "document_audit_logs_onboarding_document_id_onboarding_documents_id_fk" FOREIGN KEY ("onboarding_document_id") REFERENCES "public"."onboarding_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_audit_logs" ADD CONSTRAINT "document_audit_logs_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_template_id_document_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."document_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_template_versions" ADD CONSTRAINT "document_template_versions_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD CONSTRAINT "exit_checklists_resignation_id_resignations_id_fk" FOREIGN KEY ("resignation_id") REFERENCES "public"."resignations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_checklists" ADD CONSTRAINT "exit_checklists_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_documents" ADD CONSTRAINT "onboarding_documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_template_step_id_onboarding_template_steps_id_fk" FOREIGN KEY ("template_step_id") REFERENCES "public"."onboarding_template_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_tasks" ADD CONSTRAINT "onboarding_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_template_steps" ADD CONSTRAINT "onboarding_template_steps_template_id_onboarding_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."onboarding_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_templates" ADD CONSTRAINT "onboarding_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_templates" ADD CONSTRAINT "onboarding_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_templates" ADD CONSTRAINT "onboarding_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_hr_reviewed_by_users_id_fk" FOREIGN KEY ("hr_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_ceo_reviewed_by_users_id_fk" FOREIGN KEY ("ceo_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_exit_interview_conducted_by_users_id_fk" FOREIGN KEY ("exit_interview_conducted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminations" ADD CONSTRAINT "terminations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminations" ADD CONSTRAINT "terminations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminations" ADD CONSTRAINT "terminations_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminations" ADD CONSTRAINT "terminations_ceo_reviewed_by_users_id_fk" FOREIGN KEY ("ceo_reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_postings" ADD CONSTRAINT "job_board_postings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_postings" ADD CONSTRAINT "job_board_postings_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_postings" ADD CONSTRAINT "job_board_postings_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_board_postings" ADD CONSTRAINT "job_board_postings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_pool_id_talent_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."talent_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_pool_members" ADD CONSTRAINT "talent_pool_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_pools" ADD CONSTRAINT "talent_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_pools" ADD CONSTRAINT "talent_pools_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_referrals" ADD CONSTRAINT "external_referrals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_referrals" ADD CONSTRAINT "external_referrals_referrer_id_external_referrers_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."external_referrers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_referrals" ADD CONSTRAINT "external_referrals_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_referrals" ADD CONSTRAINT "external_referrals_job_posting_id_job_postings_id_fk" FOREIGN KEY ("job_posting_id") REFERENCES "public"."job_postings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_referrers" ADD CONSTRAINT "external_referrers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_assessment_id_skill_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."skill_assessments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_attempts" ADD CONSTRAINT "assessment_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_skills" ADD CONSTRAINT "employee_skills_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enps_scores" ADD CONSTRAINT "enps_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enps_scores" ADD CONSTRAINT "enps_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_parent_goal_id_goals_id_fk" FOREIGN KEY ("parent_goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_calibration_entries" ADD CONSTRAINT "hr_calibration_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_calibration_entries" ADD CONSTRAINT "hr_calibration_entries_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_calibration_entries" ADD CONSTRAINT "hr_calibration_entries_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_calibration_entries" ADD CONSTRAINT "hr_calibration_entries_calibrated_by_users_id_fk" FOREIGN KEY ("calibrated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_results" ADD CONSTRAINT "key_results_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" ADD CONSTRAINT "one_on_one_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" ADD CONSTRAINT "one_on_one_meetings_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_on_one_meetings" ADD CONSTRAINT "one_on_one_meetings_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD CONSTRAINT "performance_improvement_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD CONSTRAINT "performance_improvement_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD CONSTRAINT "performance_improvement_plans_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_improvement_plans" ADD CONSTRAINT "performance_improvement_plans_hr_rep_id_users_id_fk" FOREIGN KEY ("hr_rep_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_reviews" ADD CONSTRAINT "performance_reviews_cycle_id_review_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."review_cycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pulse_surveys" ADD CONSTRAINT "pulse_surveys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pulse_surveys" ADD CONSTRAINT "pulse_surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recognitions" ADD CONSTRAINT "recognitions_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_template_id_hr_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."hr_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cycles" ADD CONSTRAINT "review_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_assessments" ADD CONSTRAINT "skill_assessments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_survey_id_pulse_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."pulse_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_ladders" ADD CONSTRAINT "career_ladders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_document_id_documents_id_fk" FOREIGN KEY ("parent_document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_email_templates" ADD CONSTRAINT "hr_email_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_email_templates" ADD CONSTRAINT "hr_email_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handbook_versions" ADD CONSTRAINT "handbook_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handbook_versions" ADD CONSTRAINT "handbook_versions_document_id_rich_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."rich_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handbook_versions" ADD CONSTRAINT "handbook_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_paths" ADD CONSTRAINT "learning_paths_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acknowledgments" ADD CONSTRAINT "policy_acknowledgments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rich_documents" ADD CONSTRAINT "rich_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rich_documents" ADD CONSTRAINT "rich_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rich_documents" ADD CONSTRAINT "rich_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_participants" ADD CONSTRAINT "team_event_participants_event_id_team_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."team_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_participants" ADD CONSTRAINT "team_event_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_events" ADD CONSTRAINT "team_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_events" ADD CONSTRAINT "team_events_organized_by_users_id_fk" FOREIGN KEY ("organized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_shift_assignments" ADD CONSTRAINT "employee_shift_assignments_shift_id_shift_templates_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_swap_requests" ADD CONSTRAINT "shift_swap_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_roster_id_rosters_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."rosters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_entries" ADD CONSTRAINT "roster_entries_shift_id_shift_templates_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shift_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_balances" ADD CONSTRAINT "comp_off_balances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_off_balances" ADD CONSTRAINT "comp_off_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_devices" ADD CONSTRAINT "biometric_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD CONSTRAINT "biometric_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD CONSTRAINT "biometric_logs_device_id_biometric_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."biometric_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_logs" ADD CONSTRAINT "biometric_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_categories" ADD CONSTRAINT "course_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_enrollments" ADD CONSTRAINT "course_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_category_id_course_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."course_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "courses" ADD CONSTRAINT "courses_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attendance" ADD CONSTRAINT "training_attendance_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_attendance" ADD CONSTRAINT "training_attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_instructor_id_users_id_fk" FOREIGN KEY ("instructor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_hiring_manager_id_users_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_requisitions" ADD CONSTRAINT "job_requisitions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competencies" ADD CONSTRAINT "competencies_framework_id_competency_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."competency_frameworks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competency_frameworks" ADD CONSTRAINT "competency_frameworks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kpi_definitions" ADD CONSTRAINT "kpi_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD CONSTRAINT "feedback_cycle_requests_cycle_id_feedback_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."feedback_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD CONSTRAINT "feedback_cycle_requests_subject_id_users_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_requests" ADD CONSTRAINT "feedback_cycle_requests_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycle_responses" ADD CONSTRAINT "feedback_cycle_responses_request_id_feedback_cycle_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."feedback_cycle_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycles" ADD CONSTRAINT "feedback_cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_cycles" ADD CONSTRAINT "feedback_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_manager_approver_id_users_id_fk" FOREIGN KEY ("manager_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_finance_approver_id_users_id_fk" FOREIGN KEY ("finance_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_paths" ADD CONSTRAINT "career_paths_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_path_id_career_paths_id_fk" FOREIGN KEY ("path_id") REFERENCES "public"."career_paths"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_career_plans" ADD CONSTRAINT "employee_career_plans_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_targets" ADD CONSTRAINT "announcement_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_structure_templates" ADD CONSTRAINT "salary_structure_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_types" ADD CONSTRAINT "allowance_types_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_proofs" ADD CONSTRAINT "investment_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_proofs" ADD CONSTRAINT "investment_proofs_declaration_id_tax_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "public"."tax_declarations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_declarations" ADD CONSTRAINT "tax_declarations_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_accounting_mappings" ADD CONSTRAINT "payroll_accounting_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_calendar_events" ADD CONSTRAINT "payroll_calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_calendar_events" ADD CONSTRAINT "payroll_calendar_events_policy_id_payroll_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."payroll_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_calendar_events" ADD CONSTRAINT "payroll_calendar_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policies" ADD CONSTRAINT "payroll_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_versions" ADD CONSTRAINT "payroll_policy_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_versions" ADD CONSTRAINT "payroll_policy_versions_policy_id_payroll_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."payroll_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy_versions" ADD CONSTRAINT "payroll_policy_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_template_activations" ADD CONSTRAINT "payroll_template_activations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_template_activations" ADD CONSTRAINT "payroll_template_activations_policy_version_id_payroll_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."payroll_policy_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_template_activations" ADD CONSTRAINT "payroll_template_activations_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_approvals" ADD CONSTRAINT "payroll_approvals_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_exceptions" ADD CONSTRAINT "payroll_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_line_items" ADD CONSTRAINT "payroll_line_items_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_policy_version_id_payroll_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."payroll_policy_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_batch_id_payroll_bank_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_bank_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batch_items" ADD CONSTRAINT "payroll_bank_batch_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batches" ADD CONSTRAINT "payroll_bank_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batches" ADD CONSTRAINT "payroll_bank_batches_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_bank_batches" ADD CONSTRAINT "payroll_bank_batches_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_templates" ADD CONSTRAINT "payslip_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_profile_components" ADD CONSTRAINT "employee_salary_profile_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_profile_components" ADD CONSTRAINT "employee_salary_profile_components_profile_id_employee_salary_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."employee_salary_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_profile_components" ADD CONSTRAINT "employee_salary_profile_components_component_id_salary_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."salary_components"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD CONSTRAINT "employee_salary_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD CONSTRAINT "employee_salary_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_salary_profiles" ADD CONSTRAINT "employee_salary_profiles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_loan_id_salary_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."salary_loans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_loan_adjustments" ADD CONSTRAINT "payroll_loan_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_components" ADD CONSTRAINT "salary_components_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_access_requests" ADD CONSTRAINT "hr_access_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_probation_reviews" ADD CONSTRAINT "hr_probation_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_probation_reviews" ADD CONSTRAINT "hr_probation_reviews_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_probation_reviews" ADD CONSTRAINT "hr_probation_reviews_person_id_hr_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."hr_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_probation_reviews" ADD CONSTRAINT "hr_probation_reviews_review_template_id_hr_templates_id_fk" FOREIGN KEY ("review_template_id") REFERENCES "public"."hr_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_mentorships" ADD CONSTRAINT "hr_mentorships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_mentorships" ADD CONSTRAINT "hr_mentorships_mentor_id_users_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_mentorships" ADD CONSTRAINT "hr_mentorships_mentee_id_users_id_fk" FOREIGN KEY ("mentee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_role_skill_requirements" ADD CONSTRAINT "hr_role_skill_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_role_skill_requirements" ADD CONSTRAINT "hr_role_skill_requirements_job_role_id_hr_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."hr_job_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_succession_plans" ADD CONSTRAINT "hr_succession_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_succession_plans" ADD CONSTRAINT "hr_succession_plans_job_role_id_hr_job_roles_id_fk" FOREIGN KEY ("job_role_id") REFERENCES "public"."hr_job_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_succession_plans" ADD CONSTRAINT "hr_succession_plans_incumbent_id_users_id_fk" FOREIGN KEY ("incumbent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_succession_plans" ADD CONSTRAINT "hr_succession_plans_successor_id_users_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_succession_plans" ADD CONSTRAINT "hr_succession_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_badge_awards" ADD CONSTRAINT "hr_badge_awards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_badge_awards" ADD CONSTRAINT "hr_badge_awards_badge_id_hr_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."hr_badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_badge_awards" ADD CONSTRAINT "hr_badge_awards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_badge_awards" ADD CONSTRAINT "hr_badge_awards_awarded_by_users_id_fk" FOREIGN KEY ("awarded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_badges" ADD CONSTRAINT "hr_badges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_campaigns" ADD CONSTRAINT "hr_campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_campaigns" ADD CONSTRAINT "hr_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_communities" ADD CONSTRAINT "hr_communities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_communities" ADD CONSTRAINT "hr_communities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_community_members" ADD CONSTRAINT "hr_community_members_community_id_hr_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."hr_communities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_community_members" ADD CONSTRAINT "hr_community_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" ADD CONSTRAINT "hr_mood_checkins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_mood_checkins" ADD CONSTRAINT "hr_mood_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_poll_votes" ADD CONSTRAINT "hr_poll_votes_poll_id_hr_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."hr_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_poll_votes" ADD CONSTRAINT "hr_poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_polls" ADD CONSTRAINT "hr_polls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_polls" ADD CONSTRAINT "hr_polls_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reward_points_ledger" ADD CONSTRAINT "hr_reward_points_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reward_points_ledger" ADD CONSTRAINT "hr_reward_points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_documents" ADD CONSTRAINT "hr_case_documents_case_id_hr_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."hr_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_documents" ADD CONSTRAINT "hr_case_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_documents" ADD CONSTRAINT "hr_case_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_notes" ADD CONSTRAINT "hr_case_notes_case_id_hr_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."hr_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_notes" ADD CONSTRAINT "hr_case_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_case_notes" ADD CONSTRAINT "hr_case_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_cases" ADD CONSTRAINT "hr_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_cases" ADD CONSTRAINT "hr_cases_subject_employee_id_users_id_fk" FOREIGN KEY ("subject_employee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_cases" ADD CONSTRAINT "hr_cases_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_cases" ADD CONSTRAINT "hr_cases_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" ADD CONSTRAINT "hr_disciplinary_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" ADD CONSTRAINT "hr_disciplinary_actions_case_id_hr_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."hr_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" ADD CONSTRAINT "hr_disciplinary_actions_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_disciplinary_actions" ADD CONSTRAINT "hr_disciplinary_actions_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_safety_incidents" ADD CONSTRAINT "hr_safety_incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_safety_incidents" ADD CONSTRAINT "hr_safety_incidents_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" ADD CONSTRAINT "hr_wellness_checkins_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_wellness_checkins" ADD CONSTRAINT "hr_wellness_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_benefit_enrollment_windows" ADD CONSTRAINT "hr_benefit_enrollment_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_benefit_enrollment_windows" ADD CONSTRAINT "hr_benefit_enrollment_windows_plan_id_hr_benefit_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."hr_benefit_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_benefit_enrollments" ADD CONSTRAINT "hr_benefit_enrollments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_benefit_enrollments" ADD CONSTRAINT "hr_benefit_enrollments_plan_id_hr_benefit_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."hr_benefit_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_benefit_enrollments" ADD CONSTRAINT "hr_benefit_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_benefit_plans" ADD CONSTRAINT "hr_benefit_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_dependents" ADD CONSTRAINT "hr_dependents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_dependents" ADD CONSTRAINT "hr_dependents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_insurance_claims" ADD CONSTRAINT "hr_insurance_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_insurance_claims" ADD CONSTRAINT "hr_insurance_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_insurance_claims" ADD CONSTRAINT "hr_insurance_claims_plan_id_hr_benefit_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."hr_benefit_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_insurance_claims" ADD CONSTRAINT "hr_insurance_claims_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_loan_repayments" ADD CONSTRAINT "hr_loan_repayments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_travel_visit_logs" ADD CONSTRAINT "hr_travel_visit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_travel_visit_logs" ADD CONSTRAINT "hr_travel_visit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_webhook_deliveries" ADD CONSTRAINT "hr_webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_webhook_deliveries" ADD CONSTRAINT "hr_webhook_deliveries_subscription_id_hr_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."hr_webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_webhook_subscriptions" ADD CONSTRAINT "hr_webhook_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_webhook_subscriptions" ADD CONSTRAINT "hr_webhook_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_import_jobs" ADD CONSTRAINT "hr_import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_import_jobs" ADD CONSTRAINT "hr_import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_import_rows" ADD CONSTRAINT "hr_import_rows_job_id_hr_import_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."hr_import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_compliance_events" ADD CONSTRAINT "hr_compliance_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_compliance_events" ADD CONSTRAINT "hr_compliance_events_requirement_id_hr_compliance_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."hr_compliance_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_compliance_events" ADD CONSTRAINT "hr_compliance_events_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_compliance_requirements" ADD CONSTRAINT "hr_compliance_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_compliance_requirements" ADD CONSTRAINT "hr_compliance_requirements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_contracts" ADD CONSTRAINT "hr_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_contracts" ADD CONSTRAINT "hr_contracts_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_contracts" ADD CONSTRAINT "hr_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_work_authorizations" ADD CONSTRAINT "hr_work_authorizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_work_authorizations" ADD CONSTRAINT "hr_work_authorizations_employment_id_hr_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."hr_employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_work_authorizations" ADD CONSTRAINT "hr_work_authorizations_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_work_authorizations" ADD CONSTRAINT "hr_work_authorizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_headcount_plans" ADD CONSTRAINT "hr_headcount_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_headcount_plans" ADD CONSTRAINT "hr_headcount_plans_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_hiring_plan_items" ADD CONSTRAINT "hr_hiring_plan_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_hiring_plan_items" ADD CONSTRAINT "hr_hiring_plan_items_plan_id_hr_headcount_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."hr_headcount_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_form_submissions" ADD CONSTRAINT "hr_form_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_form_submissions" ADD CONSTRAINT "hr_form_submissions_form_id_hr_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."hr_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_form_submissions" ADD CONSTRAINT "hr_form_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_forms" ADD CONSTRAINT "hr_forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_forms" ADD CONSTRAINT "hr_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_collective_agreements" ADD CONSTRAINT "hr_collective_agreements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_data_requests" ADD CONSTRAINT "hr_data_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_data_requests" ADD CONSTRAINT "hr_data_requests_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_data_requests" ADD CONSTRAINT "hr_data_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_data_requests" ADD CONSTRAINT "hr_data_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_labor_cases" ADD CONSTRAINT "hr_labor_cases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_labor_cases" ADD CONSTRAINT "hr_labor_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_legal_hold_items" ADD CONSTRAINT "hr_legal_hold_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_legal_hold_items" ADD CONSTRAINT "hr_legal_hold_items_hold_id_hr_legal_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."hr_legal_holds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_legal_holds" ADD CONSTRAINT "hr_legal_holds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_legal_holds" ADD CONSTRAINT "hr_legal_holds_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_legal_holds" ADD CONSTRAINT "hr_legal_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_legal_holds" ADD CONSTRAINT "hr_legal_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_positions" ADD CONSTRAINT "hr_positions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_positions" ADD CONSTRAINT "hr_positions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_positions" ADD CONSTRAINT "hr_positions_incumbent_user_id_users_id_fk" FOREIGN KEY ("incumbent_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_proxy_access" ADD CONSTRAINT "hr_proxy_access_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_proxy_access" ADD CONSTRAINT "hr_proxy_access_grantor_user_id_users_id_fk" FOREIGN KEY ("grantor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_proxy_access" ADD CONSTRAINT "hr_proxy_access_proxy_user_id_users_id_fk" FOREIGN KEY ("proxy_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_proxy_access" ADD CONSTRAINT "hr_proxy_access_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reorg_scenarios" ADD CONSTRAINT "hr_reorg_scenarios_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_reorg_scenarios" ADD CONSTRAINT "hr_reorg_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_retention_policies" ADD CONSTRAINT "hr_retention_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_union_memberships" ADD CONSTRAINT "hr_union_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_union_memberships" ADD CONSTRAINT "hr_union_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_arrears_adjustments" ADD CONSTRAINT "hr_arrears_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_arrears_adjustments" ADD CONSTRAINT "hr_arrears_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_arrears_adjustments" ADD CONSTRAINT "hr_arrears_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_budget_pools" ADD CONSTRAINT "hr_comp_budget_pools_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_budget_pools" ADD CONSTRAINT "hr_comp_budget_pools_cycle_id_hr_comp_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."hr_comp_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_budget_pools" ADD CONSTRAINT "hr_comp_budget_pools_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_cycles" ADD CONSTRAINT "hr_comp_cycles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_cycles" ADD CONSTRAINT "hr_comp_cycles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD CONSTRAINT "hr_comp_recommendations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD CONSTRAINT "hr_comp_recommendations_cycle_id_hr_comp_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."hr_comp_cycles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD CONSTRAINT "hr_comp_recommendations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD CONSTRAINT "hr_comp_recommendations_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD CONSTRAINT "hr_comp_recommendations_calibrated_by_users_id_fk" FOREIGN KEY ("calibrated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_comp_recommendations" ADD CONSTRAINT "hr_comp_recommendations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_device_employee_mappings" ADD CONSTRAINT "hr_device_employee_mappings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_device_employee_mappings" ADD CONSTRAINT "hr_device_employee_mappings_device_id_hr_time_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."hr_time_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_device_employee_mappings" ADD CONSTRAINT "hr_device_employee_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_device_sync_logs" ADD CONSTRAINT "hr_device_sync_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_device_sync_logs" ADD CONSTRAINT "hr_device_sync_logs_device_id_hr_time_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."hr_time_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_exercises" ADD CONSTRAINT "hr_equity_exercises_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_exercises" ADD CONSTRAINT "hr_equity_exercises_grant_id_hr_equity_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."hr_equity_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_exercises" ADD CONSTRAINT "hr_equity_exercises_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_grants" ADD CONSTRAINT "hr_equity_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_grants" ADD CONSTRAINT "hr_equity_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_grants" ADD CONSTRAINT "hr_equity_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_vesting_events" ADD CONSTRAINT "hr_equity_vesting_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_equity_vesting_events" ADD CONSTRAINT "hr_equity_vesting_events_grant_id_hr_equity_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."hr_equity_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_compliance_tasks" ADD CONSTRAINT "hr_payroll_compliance_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_compliance_tasks" ADD CONSTRAINT "hr_payroll_compliance_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_variance_approvals" ADD CONSTRAINT "hr_payroll_variance_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_payroll_variance_approvals" ADD CONSTRAINT "hr_payroll_variance_approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_time_devices" ADD CONSTRAINT "hr_time_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_access_provisioning" ADD CONSTRAINT "hr_access_provisioning_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_access_provisioning" ADD CONSTRAINT "hr_access_provisioning_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_access_provisioning" ADD CONSTRAINT "hr_access_provisioning_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_access_provisioning_templates" ADD CONSTRAINT "hr_access_provisioning_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_accommodation_requests" ADD CONSTRAINT "hr_accommodation_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_accommodation_requests" ADD CONSTRAINT "hr_accommodation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_accommodation_requests" ADD CONSTRAINT "hr_accommodation_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_accommodation_tasks" ADD CONSTRAINT "hr_accommodation_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_accommodation_tasks" ADD CONSTRAINT "hr_accommodation_tasks_request_id_hr_accommodation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."hr_accommodation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_accommodation_tasks" ADD CONSTRAINT "hr_accommodation_tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_emergency_events" ADD CONSTRAINT "hr_emergency_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_emergency_events" ADD CONSTRAINT "hr_emergency_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_emergency_responses" ADD CONSTRAINT "hr_emergency_responses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_emergency_responses" ADD CONSTRAINT "hr_emergency_responses_event_id_hr_emergency_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."hr_emergency_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_emergency_responses" ADD CONSTRAINT "hr_emergency_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_event_stream" ADD CONSTRAINT "hr_event_stream_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_event_stream" ADD CONSTRAINT "hr_event_stream_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_simulations" ADD CONSTRAINT "hr_simulations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hr_simulations" ADD CONSTRAINT "hr_simulations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_campaigns" ADD CONSTRAINT "crm_campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_campaigns" ADD CONSTRAINT "crm_campaigns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_campaign_id_crm_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."crm_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_rule_state" ADD CONSTRAINT "assignment_rule_state_rule_id_lead_assignment_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."lead_assignment_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_rules" ADD CONSTRAINT "lead_assignment_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_rules" ADD CONSTRAINT "lead_assignment_rules_assign_to_user_id_users_id_fk" FOREIGN KEY ("assign_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_emails" ADD CONSTRAINT "lead_emails_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_emails" ADD CONSTRAINT "lead_emails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_import_batches" ADD CONSTRAINT "lead_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_notes" ADD CONSTRAINT "lead_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_scoring_rules" ADD CONSTRAINT "lead_scoring_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_tasks" ADD CONSTRAINT "lead_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_campaign_id_crm_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."crm_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_merged_into_id_leads_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_lead_forms" ADD CONSTRAINT "web_lead_forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_lead_forms" ADD CONSTRAINT "web_lead_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_branch_manager_id_users_id_fk" FOREIGN KEY ("branch_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_branch_hr_id_users_id_fk" FOREIGN KEY ("branch_hr_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_account_activities" ADD CONSTRAINT "client_account_activities_client_account_id_client_accounts_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."client_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_account_activities" ADD CONSTRAINT "client_account_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "client_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "client_accounts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "client_accounts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "client_accounts_sales_rep_id_users_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_accounts" ADD CONSTRAINT "client_accounts_assigned_crm_id_users_id_fk" FOREIGN KEY ("assigned_crm_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "client_onboarding_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "client_onboarding_items_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "client_onboarding_items_template_id_client_onboarding_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."client_onboarding_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "client_onboarding_items_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_items" ADD CONSTRAINT "client_onboarding_items_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_templates" ADD CONSTRAINT "client_onboarding_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_onboarding_templates" ADD CONSTRAINT "client_onboarding_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_opportunities" ADD CONSTRAINT "client_opportunities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_opportunities" ADD CONSTRAINT "client_opportunities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_opportunities" ADD CONSTRAINT "client_opportunities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_account_manager_id_users_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_crm_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."crm_organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_organizations" ADD CONSTRAINT "crm_organizations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_organizations" ADD CONSTRAINT "crm_organizations_parent_id_crm_organizations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."crm_organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_survey_id_csat_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."csat_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_responses" ADD CONSTRAINT "csat_responses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csat_surveys" ADD CONSTRAINT "csat_surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_roles" ADD CONSTRAINT "crm_contact_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact_roles" ADD CONSTRAINT "crm_contact_roles_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_rule_id_commission_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."commission_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_competitors" ADD CONSTRAINT "crm_deal_competitors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_competitors" ADD CONSTRAINT "crm_deal_competitors_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" ADD CONSTRAINT "crm_deal_stakeholders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" ADD CONSTRAINT "crm_deal_stakeholders_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_stakeholders" ADD CONSTRAINT "crm_deal_stakeholders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_forecast_snapshots" ADD CONSTRAINT "crm_forecast_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_forecast_snapshots" ADD CONSTRAINT "crm_forecast_snapshots_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_forecast_snapshots" ADD CONSTRAINT "crm_forecast_snapshots_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_activities" ADD CONSTRAINT "deal_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_approval_rules" ADD CONSTRAINT "deal_approval_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_approval_rules" ADD CONSTRAINT "deal_approval_rules_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_approvals" ADD CONSTRAINT "deal_approvals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_meeting_attendees" ADD CONSTRAINT "deal_meeting_attendees_meeting_id_deal_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."deal_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_meeting_attendees" ADD CONSTRAINT "deal_meeting_attendees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_meetings" ADD CONSTRAINT "deal_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_meetings" ADD CONSTRAINT "deal_meetings_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_meetings" ADD CONSTRAINT "deal_meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_crm_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentive_config" ADD CONSTRAINT "incentive_config_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentive_config" ADD CONSTRAINT "incentive_config_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentive_config" ADD CONSTRAINT "incentive_config_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_client_account_id_client_accounts_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."client_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_sales_rep_id_users_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incentives" ADD CONSTRAINT "incentives_payroll_id_payrolls_id_fk" FOREIGN KEY ("payroll_id") REFERENCES "public"."payrolls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotas" ADD CONSTRAINT "sales_quotas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotas" ADD CONSTRAINT "sales_quotas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_quotas" ADD CONSTRAINT "sales_quotas_set_by_id_users_id_fk" FOREIGN KEY ("set_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_history" ADD CONSTRAINT "target_history_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_history" ADD CONSTRAINT "target_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_history" ADD CONSTRAINT "target_history_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_set_by_id_users_id_fk" FOREIGN KEY ("set_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_parent_target_id_targets_id_fk" FOREIGN KEY ("parent_target_id") REFERENCES "public"."targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sequence_steps" ADD CONSTRAINT "task_sequence_steps_sequence_id_task_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."task_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sequences" ADD CONSTRAINT "task_sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sequences" ADD CONSTRAINT "task_sequences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_collection_owner_id_users_id_fk" FOREIGN KEY ("collection_owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_items" ADD CONSTRAINT "purchase_bill_items_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_vendor_id_clients_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_client_accounts_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_converted_invoice_id_invoices_id_fk" FOREIGN KEY ("converted_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_snoozed_by_users_id_fk" FOREIGN KEY ("snoozed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_person_id_crm_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_csm_id_crm_people_id_fk" FOREIGN KEY ("csm_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_sales_rep_id_crm_people_id_fk" FOREIGN KEY ("sales_rep_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_email_templates" ADD CONSTRAINT "crm_email_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_email_templates" ADD CONSTRAINT "crm_email_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_monthly_metrics" ADD CONSTRAINT "crm_monthly_metrics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_people" ADD CONSTRAINT "crm_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sla_policies" ADD CONSTRAINT "crm_sla_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_support_tickets" ADD CONSTRAINT "crm_support_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_support_tickets" ADD CONSTRAINT "crm_support_tickets_assignee_id_crm_people_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."crm_people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_team_performance" ADD CONSTRAINT "crm_team_performance_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_team_performance" ADD CONSTRAINT "crm_team_performance_person_id_crm_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."crm_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_views" ADD CONSTRAINT "crm_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_views" ADD CONSTRAINT "crm_views_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_health_scores" ADD CONSTRAINT "client_health_scores_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_health_scores" ADD CONSTRAINT "client_health_scores_client_account_id_client_accounts_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."client_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_score_config" ADD CONSTRAINT "health_score_config_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_survey_id_nps_surveys_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."nps_surveys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_responses" ADD CONSTRAINT "nps_responses_client_account_id_client_accounts_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."client_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_surveys" ADD CONSTRAINT "nps_surveys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nps_surveys" ADD CONSTRAINT "nps_surveys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_entries" ADD CONSTRAINT "playbook_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbook_entries" ADD CONSTRAINT "playbook_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_automation_rules" ADD CONSTRAINT "crm_automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_products" ADD CONSTRAINT "crm_products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pricebook_entries" ADD CONSTRAINT "crm_pricebook_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pricebook_entries" ADD CONSTRAINT "crm_pricebook_entries_pricebook_id_crm_pricebooks_id_fk" FOREIGN KEY ("pricebook_id") REFERENCES "public"."crm_pricebooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pricebook_entries" ADD CONSTRAINT "crm_pricebook_entries_product_id_crm_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."crm_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pricebooks" ADD CONSTRAINT "crm_pricebooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_quote_settings" ADD CONSTRAINT "crm_quote_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_quote_templates" ADD CONSTRAINT "crm_quote_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_automation_actions" ADD CONSTRAINT "crm_automation_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_automation_events" ADD CONSTRAINT "crm_automation_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_blueprint_transitions" ADD CONSTRAINT "crm_blueprint_transitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_blueprint_transitions" ADD CONSTRAINT "crm_blueprint_transitions_blueprint_id_crm_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."crm_blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_blueprints" ADD CONSTRAINT "crm_blueprints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_blueprints" ADD CONSTRAINT "crm_blueprints_pipeline_id_crm_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_options" ADD CONSTRAINT "crm_options_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_pipeline_id_crm_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."crm_pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_pipelines" ADD CONSTRAINT "crm_pipelines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_ui_metadata" ADD CONSTRAINT "crm_ui_metadata_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_validation_rules" ADD CONSTRAINT "crm_validation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_automation_runs" ADD CONSTRAINT "crm_automation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_automation_runs" ADD CONSTRAINT "crm_automation_runs_rule_id_crm_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."crm_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sequence_enrollments" ADD CONSTRAINT "crm_sequence_enrollments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sequence_enrollments" ADD CONSTRAINT "crm_sequence_enrollments_sequence_id_crm_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."crm_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sequence_steps" ADD CONSTRAINT "crm_sequence_steps_sequence_id_crm_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."crm_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sequences" ADD CONSTRAINT "crm_sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" ADD CONSTRAINT "crm_lead_touchpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" ADD CONSTRAINT "crm_lead_touchpoints_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_lead_touchpoints" ADD CONSTRAINT "crm_lead_touchpoints_campaign_id_crm_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."crm_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links" ADD CONSTRAINT "chat_channel_invite_links_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_invite_links" ADD CONSTRAINT "chat_channel_invite_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_linked_deal_id_deals_id_fk" FOREIGN KEY ("linked_deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_huddle_participants" ADD CONSTRAINT "chat_huddle_participants_huddle_id_chat_huddles_id_fk" FOREIGN KEY ("huddle_id") REFERENCES "public"."chat_huddles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_huddle_participants" ADD CONSTRAINT "chat_huddle_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_huddles" ADD CONSTRAINT "chat_huddles_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_huddles" ADD CONSTRAINT "chat_huddles_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_reply_to_id_chat_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_org_settings" ADD CONSTRAINT "chat_org_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_org_settings" ADD CONSTRAINT "chat_org_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "chat_pinned_messages_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "chat_pinned_messages_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_pinned_messages" ADD CONSTRAINT "chat_pinned_messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reply_reminders" ADD CONSTRAINT "chat_reply_reminders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reply_reminders" ADD CONSTRAINT "chat_reply_reminders_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reply_reminders" ADD CONSTRAINT "chat_reply_reminders_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reply_reminders" ADD CONSTRAINT "chat_reply_reminders_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reply_reminders" ADD CONSTRAINT "chat_reply_reminders_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_saved_messages" ADD CONSTRAINT "chat_saved_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_saved_messages" ADD CONSTRAINT "chat_saved_messages_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_user_presence" ADD CONSTRAINT "chat_user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_user_presence" ADD CONSTRAINT "chat_user_presence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_audit_logs" ADD CONSTRAINT "notification_audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_audit_logs" ADD CONSTRAINT "notification_audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_logs" ADD CONSTRAINT "webhook_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_id_blog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."blog_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_author_id_blog_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."blog_authors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_messages" ADD CONSTRAINT "platform_messages_replied_by_id_users_id_fk" FOREIGN KEY ("replied_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_subscriptions" ADD CONSTRAINT "platform_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversed_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_parent_account_id_ledger_accounts_id_fk" FOREIGN KEY ("parent_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_number_sequences" ADD CONSTRAINT "acc_number_sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_system_account_map" ADD CONSTRAINT "acc_system_account_map_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_system_account_map" ADD CONSTRAINT "acc_system_account_map_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_dimension_values" ADD CONSTRAINT "accounting_dimension_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_dimension_values" ADD CONSTRAINT "accounting_dimension_values_dimension_id_accounting_dimensions_id_fk" FOREIGN KEY ("dimension_id") REFERENCES "public"."accounting_dimensions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_dimensions" ADD CONSTRAINT "accounting_dimensions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD CONSTRAINT "accounting_settings_retained_earnings_account_id_ledger_accounts_id_fk" FOREIGN KEY ("retained_earnings_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_approval_policies" ADD CONSTRAINT "fin_approval_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_approval_policies" ADD CONSTRAINT "fin_approval_policies_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_approval_requests" ADD CONSTRAINT "fin_approval_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_approval_requests" ADD CONSTRAINT "fin_approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_approval_requests" ADD CONSTRAINT "fin_approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_exchange_rates" ADD CONSTRAINT "fin_exchange_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_journal_templates" ADD CONSTRAINT "fin_recurring_journal_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_journal_templates" ADD CONSTRAINT "fin_recurring_journal_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_collection_activities" ADD CONSTRAINT "fin_collection_activities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_collection_activities" ADD CONSTRAINT "fin_collection_activities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_collection_activities" ADD CONSTRAINT "fin_collection_activities_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_collection_activities" ADD CONSTRAINT "fin_collection_activities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_allocations" ADD CONSTRAINT "fin_payment_allocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_allocations" ADD CONSTRAINT "fin_payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_allocations" ADD CONSTRAINT "fin_payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_run_id_fin_payment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fin_payment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_vendor_id_clients_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_run_items" ADD CONSTRAINT "fin_payment_run_items_vendor_payment_id_vendor_payments_id_fk" FOREIGN KEY ("vendor_payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_runs" ADD CONSTRAINT "fin_payment_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_runs" ADD CONSTRAINT "fin_payment_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_payment_runs" ADD CONSTRAINT "fin_payment_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_bill_templates" ADD CONSTRAINT "fin_recurring_bill_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_bill_templates" ADD CONSTRAINT "fin_recurring_bill_templates_vendor_id_clients_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_bill_templates" ADD CONSTRAINT "fin_recurring_bill_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_invoice_templates" ADD CONSTRAINT "fin_recurring_invoice_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_invoice_templates" ADD CONSTRAINT "fin_recurring_invoice_templates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_recurring_invoice_templates" ADD CONSTRAINT "fin_recurring_invoice_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reminder_log" ADD CONSTRAINT "fin_reminder_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reminder_log" ADD CONSTRAINT "fin_reminder_log_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reminder_policies" ADD CONSTRAINT "fin_reminder_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_vendor_payment_allocations" ADD CONSTRAINT "fin_vendor_payment_allocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_vendor_payment_allocations" ADD CONSTRAINT "fin_vendor_payment_allocations_vendor_payment_id_vendor_payments_id_fk" FOREIGN KEY ("vendor_payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_vendor_payment_allocations" ADD CONSTRAINT "fin_vendor_payment_allocations_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credit_items" ADD CONSTRAINT "vendor_credit_items_vendor_credit_id_vendor_credits_id_fk" FOREIGN KEY ("vendor_credit_id") REFERENCES "public"."vendor_credits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_vendor_id_clients_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_credits" ADD CONSTRAINT "vendor_credits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_accounts" ADD CONSTRAINT "fin_bank_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_accounts" ADD CONSTRAINT "fin_bank_accounts_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_imports" ADD CONSTRAINT "fin_bank_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_imports" ADD CONSTRAINT "fin_bank_imports_bank_account_id_fin_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."fin_bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_imports" ADD CONSTRAINT "fin_bank_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transactions" ADD CONSTRAINT "fin_bank_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transactions" ADD CONSTRAINT "fin_bank_transactions_bank_account_id_fin_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."fin_bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transactions" ADD CONSTRAINT "fin_bank_transactions_import_id_fin_bank_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."fin_bank_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transactions" ADD CONSTRAINT "fin_bank_transactions_matched_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("matched_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" ADD CONSTRAINT "fin_bank_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" ADD CONSTRAINT "fin_bank_transfers_from_bank_account_id_fin_bank_accounts_id_fk" FOREIGN KEY ("from_bank_account_id") REFERENCES "public"."fin_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" ADD CONSTRAINT "fin_bank_transfers_to_bank_account_id_fin_bank_accounts_id_fk" FOREIGN KEY ("to_bank_account_id") REFERENCES "public"."fin_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" ADD CONSTRAINT "fin_bank_transfers_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_bank_transfers" ADD CONSTRAINT "fin_bank_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reconciliation_matches" ADD CONSTRAINT "fin_reconciliation_matches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reconciliation_matches" ADD CONSTRAINT "fin_reconciliation_matches_bank_transaction_id_fin_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."fin_bank_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reconciliation_matches" ADD CONSTRAINT "fin_reconciliation_matches_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reconciliation_matches" ADD CONSTRAINT "fin_reconciliation_matches_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reconciliation_rules" ADD CONSTRAINT "fin_reconciliation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_tax_codes" ADD CONSTRAINT "acc_tax_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_tax_codes" ADD CONSTRAINT "acc_tax_codes_collected_account_id_ledger_accounts_id_fk" FOREIGN KEY ("collected_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_tax_codes" ADD CONSTRAINT "acc_tax_codes_paid_account_id_ledger_accounts_id_fk" FOREIGN KEY ("paid_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_tax_payments" ADD CONSTRAINT "acc_tax_payments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_tax_payments" ADD CONSTRAINT "acc_tax_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_tax_payments" ADD CONSTRAINT "acc_tax_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_budget_id_fin_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."fin_budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_lines" ADD CONSTRAINT "fin_budget_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_revisions" ADD CONSTRAINT "fin_budget_revisions_budget_id_fin_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."fin_budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_revisions" ADD CONSTRAINT "fin_budget_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budget_revisions" ADD CONSTRAINT "fin_budget_revisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budgets" ADD CONSTRAINT "fin_budgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budgets" ADD CONSTRAINT "fin_budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_budgets" ADD CONSTRAINT "fin_budgets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_cash_flow_scenarios" ADD CONSTRAINT "fin_cash_flow_scenarios_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_cash_flow_scenarios" ADD CONSTRAINT "fin_cash_flow_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_asset_categories" ADD CONSTRAINT "acc_asset_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_asset_categories" ADD CONSTRAINT "acc_asset_categories_asset_account_id_ledger_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_asset_categories" ADD CONSTRAINT "acc_asset_categories_depreciation_expense_account_id_ledger_accounts_id_fk" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_asset_categories" ADD CONSTRAINT "acc_asset_categories_accumulated_depreciation_account_id_ledger_accounts_id_fk" FOREIGN KEY ("accumulated_depreciation_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_runs" ADD CONSTRAINT "acc_depreciation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_runs" ADD CONSTRAINT "acc_depreciation_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_runs" ADD CONSTRAINT "acc_depreciation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_schedules" ADD CONSTRAINT "acc_depreciation_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_schedules" ADD CONSTRAINT "acc_depreciation_schedules_asset_id_acc_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."acc_fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_schedules" ADD CONSTRAINT "acc_depreciation_schedules_run_id_acc_depreciation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."acc_depreciation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_depreciation_schedules" ADD CONSTRAINT "acc_depreciation_schedules_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_fixed_assets" ADD CONSTRAINT "acc_fixed_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_fixed_assets" ADD CONSTRAINT "acc_fixed_assets_category_id_acc_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."acc_asset_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_fixed_assets" ADD CONSTRAINT "acc_fixed_assets_vendor_id_clients_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_fixed_assets" ADD CONSTRAINT "acc_fixed_assets_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acc_fixed_assets" ADD CONSTRAINT "acc_fixed_assets_disposal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_expense_policies" ADD CONSTRAINT "fin_expense_policies_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_bank_account_id_fin_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."fin_bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_reimbursement_batches" ADD CONSTRAINT "fin_reimbursement_batches_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_feedback" ADD CONSTRAINT "kb_article_feedback_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_category_id_kb_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."kb_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_articles" ADD CONSTRAINT "kb_articles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_categories" ADD CONSTRAINT "kb_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_categories" ADD CONSTRAINT "kb_categories_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_categories" ADD CONSTRAINT "fk_kb_categories_parent" FOREIGN KEY ("parent_id") REFERENCES "public"."kb_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_attachments" ADD CONSTRAINT "kb_article_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_attachments" ADD CONSTRAINT "kb_article_attachments_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_attachment_id_kb_article_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."kb_article_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD CONSTRAINT "kb_article_chunks_source_id_kb_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."kb_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_macros" ADD CONSTRAINT "support_macros_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_routing_rules" ADD CONSTRAINT "support_routing_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_comments" ADD CONSTRAINT "kb_article_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_comments" ADD CONSTRAINT "kb_article_comments_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_comments" ADD CONSTRAINT "kb_article_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_activity" ADD CONSTRAINT "support_ticket_activity_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_activity" ADD CONSTRAINT "support_ticket_activity_support_ticket_id_support_tickets_id_fk" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_saved_views" ADD CONSTRAINT "support_saved_views_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_saved_views" ADD CONSTRAINT "support_saved_views_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tags" ADD CONSTRAINT "support_tags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_links" ADD CONSTRAINT "support_ticket_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_links" ADD CONSTRAINT "support_ticket_links_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_links" ADD CONSTRAINT "support_ticket_links_linked_ticket_id_support_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_tags" ADD CONSTRAINT "support_ticket_tags_tag_id_support_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."support_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_watchers" ADD CONSTRAINT "support_ticket_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_business_hours" ADD CONSTRAINT "support_business_hours_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_sla_policies" ADD CONSTRAINT "support_sla_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_channels" ADD CONSTRAINT "support_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_csat_requests" ADD CONSTRAINT "support_csat_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_csat_requests" ADD CONSTRAINT "support_csat_requests_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_settings" ADD CONSTRAINT "support_ai_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_suggestions" ADD CONSTRAINT "support_ai_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_suggestions" ADD CONSTRAINT "support_ai_suggestions_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ai_suggestions" ADD CONSTRAINT "support_ai_suggestions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_embeddings" ADD CONSTRAINT "support_ticket_embeddings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_embeddings" ADD CONSTRAINT "support_ticket_embeddings_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_custom_fields" ADD CONSTRAINT "support_custom_fields_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_custom_field_values" ADD CONSTRAINT "support_ticket_custom_field_values_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_custom_field_values" ADD CONSTRAINT "support_ticket_custom_field_values_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_custom_field_values" ADD CONSTRAINT "support_ticket_custom_field_values_field_id_support_custom_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."support_custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_settings_audit_log" ADD CONSTRAINT "support_settings_audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_settings_audit_log" ADD CONSTRAINT "support_settings_audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_availability" ADD CONSTRAINT "support_agent_availability_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_availability" ADD CONSTRAINT "support_agent_availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_skills" ADD CONSTRAINT "support_agent_skills_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_agent_skills" ADD CONSTRAINT "support_agent_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_vip_clients" ADD CONSTRAINT "support_vip_clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_vip_clients" ADD CONSTRAINT "support_vip_clients_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message_mentions" ADD CONSTRAINT "support_message_mentions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message_mentions" ADD CONSTRAINT "support_message_mentions_message_id_support_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_message_mentions" ADD CONSTRAINT "support_message_mentions_mentioned_user_id_users_id_fk" FOREIGN KEY ("mentioned_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" ADD CONSTRAINT "support_ticket_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" ADD CONSTRAINT "support_ticket_drafts_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_drafts" ADD CONSTRAINT "support_ticket_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_external_links" ADD CONSTRAINT "support_ticket_external_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_ticket_external_links" ADD CONSTRAINT "support_ticket_external_links_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" ADD CONSTRAINT "support_knowledge_gaps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" ADD CONSTRAINT "support_knowledge_gaps_proposed_article_id_kb_articles_id_fk" FOREIGN KEY ("proposed_article_id") REFERENCES "public"."kb_articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" ADD CONSTRAINT "support_knowledge_gaps_drafted_by_users_id_fk" FOREIGN KEY ("drafted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_knowledge_gaps" ADD CONSTRAINT "support_knowledge_gaps_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_space_members" ADD CONSTRAINT "kb_space_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_space_members" ADD CONSTRAINT "kb_space_members_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_space_members" ADD CONSTRAINT "kb_space_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD CONSTRAINT "kb_spaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_spaces" ADD CONSTRAINT "kb_spaces_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_restrictions" ADD CONSTRAINT "kb_article_restrictions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_restrictions" ADD CONSTRAINT "kb_article_restrictions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_restrictions" ADD CONSTRAINT "kb_article_restrictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_versions" ADD CONSTRAINT "kb_article_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_translations" ADD CONSTRAINT "kb_article_translations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_translations" ADD CONSTRAINT "kb_article_translations_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_tags" ADD CONSTRAINT "kb_article_tags_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_article_tags" ADD CONSTRAINT "kb_article_tags_tag_id_kb_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."kb_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_tags" ADD CONSTRAINT "kb_tags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_events" ADD CONSTRAINT "kb_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_events" ADD CONSTRAINT "kb_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_events" ADD CONSTRAINT "kb_events_article_id_kb_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."kb_articles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_ai_credit_transactions" ADD CONSTRAINT "tenant_ai_credit_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_ai_credit_transactions" ADD CONSTRAINT "tenant_ai_credit_transactions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_ai_credits" ADD CONSTRAINT "tenant_ai_credits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_favorites" ADD CONSTRAINT "kb_page_favorites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_favorites" ADD CONSTRAINT "kb_page_favorites_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_favorites" ADD CONSTRAINT "kb_page_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD CONSTRAINT "kb_page_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD CONSTRAINT "kb_page_links_source_page_id_kb_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_links" ADD CONSTRAINT "kb_page_links_target_page_id_kb_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_visits" ADD CONSTRAINT "kb_page_visits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_visits" ADD CONSTRAINT "kb_page_visits_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_visits" ADD CONSTRAINT "kb_page_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_last_edited_by_id_users_id_fk" FOREIGN KEY ("last_edited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD CONSTRAINT "kb_pages_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_comments" ADD CONSTRAINT "kb_page_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_comments" ADD CONSTRAINT "kb_page_comments_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_comments" ADD CONSTRAINT "kb_page_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_templates" ADD CONSTRAINT "kb_page_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_templates" ADD CONSTRAINT "kb_page_templates_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD CONSTRAINT "kb_page_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD CONSTRAINT "kb_page_versions_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_versions" ADD CONSTRAINT "kb_page_versions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_export_jobs" ADD CONSTRAINT "kb_export_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_export_jobs" ADD CONSTRAINT "kb_export_jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_import_jobs" ADD CONSTRAINT "kb_import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_import_jobs" ADD CONSTRAINT "kb_import_jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_page_id_kb_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."kb_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_page_reviews" ADD CONSTRAINT "kb_page_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_space_id_kb_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."kb_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" ADD CONSTRAINT "kb_chat_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chat_conversations" ADD CONSTRAINT "kb_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chat_messages" ADD CONSTRAINT "kb_chat_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chat_messages" ADD CONSTRAINT "kb_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chat_messages" ADD CONSTRAINT "kb_chat_messages_conversation_id_kb_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."kb_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_settings" ADD CONSTRAINT "kb_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD CONSTRAINT "kb_research_briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_research_briefs" ADD CONSTRAINT "kb_research_briefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_categories" ADD CONSTRAINT "inv_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_product_variants" ADD CONSTRAINT "inv_product_variants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_product_variants" ADD CONSTRAINT "inv_product_variants_product_id_inv_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."inv_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_category_id_inv_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."inv_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_uom_id_inv_uom_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."inv_uom"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_purchase_uom_id_inv_uom_id_fk" FOREIGN KEY ("purchase_uom_id") REFERENCES "public"."inv_uom"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_sales_uom_id_inv_uom_id_fk" FOREIGN KEY ("sales_uom_id") REFERENCES "public"."inv_uom"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_products" ADD CONSTRAINT "inv_products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_uom" ADD CONSTRAINT "inv_uom_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_locations" ADD CONSTRAINT "inv_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_locations" ADD CONSTRAINT "inv_locations_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "inv_warehouses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "inv_warehouses_branch_id_org_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."org_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "inv_warehouses_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_warehouses" ADD CONSTRAINT "inv_warehouses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "inv_stock_adjustment_lines_adjustment_id_inv_stock_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."inv_stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "inv_stock_adjustment_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustment_lines" ADD CONSTRAINT "inv_stock_adjustment_lines_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ADD CONSTRAINT "inv_stock_adjustments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ADD CONSTRAINT "inv_stock_adjustments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ADD CONSTRAINT "inv_stock_adjustments_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_adjustments" ADD CONSTRAINT "inv_stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_levels" ADD CONSTRAINT "inv_stock_levels_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transactions" ADD CONSTRAINT "inv_stock_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" ADD CONSTRAINT "inv_stock_transfer_lines_transfer_id_inv_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."inv_stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfer_lines" ADD CONSTRAINT "inv_stock_transfer_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_from_location_id_inv_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."inv_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_to_location_id_inv_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."inv_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_from_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_to_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_transfers" ADD CONSTRAINT "inv_stock_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "inv_grn_lines_grn_id_inv_grns_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."inv_grns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_grn_lines" ADD CONSTRAINT "inv_grn_lines_po_line_id_inv_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."inv_po_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_po_id_inv_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."inv_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_grns" ADD CONSTRAINT "inv_grns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_po_lines" ADD CONSTRAINT "inv_po_lines_po_id_inv_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."inv_purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_po_lines" ADD CONSTRAINT "inv_po_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_vendor_id_inv_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."inv_vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_purchase_orders" ADD CONSTRAINT "inv_purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendors" ADD CONSTRAINT "inv_vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_sales_orders" ADD CONSTRAINT "inv_sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD CONSTRAINT "inv_so_lines_so_id_inv_sales_orders_id_fk" FOREIGN KEY ("so_id") REFERENCES "public"."inv_sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_so_lines" ADD CONSTRAINT "inv_so_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "inv_stock_reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "inv_stock_reservations_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "inv_stock_reservations_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_stock_reservations" ADD CONSTRAINT "inv_stock_reservations_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_lots" ADD CONSTRAINT "inv_lots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_lots" ADD CONSTRAINT "inv_lots_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_serial_numbers" ADD CONSTRAINT "inv_serial_numbers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_serial_numbers" ADD CONSTRAINT "inv_serial_numbers_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_serial_numbers" ADD CONSTRAINT "inv_serial_numbers_current_location_id_inv_locations_id_fk" FOREIGN KEY ("current_location_id") REFERENCES "public"."inv_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines" ADD CONSTRAINT "inv_customer_return_lines_return_id_inv_customer_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."inv_customer_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_customer_return_lines" ADD CONSTRAINT "inv_customer_return_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ADD CONSTRAINT "inv_customer_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ADD CONSTRAINT "inv_customer_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_customer_returns" ADD CONSTRAINT "inv_customer_returns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_count_lines" ADD CONSTRAINT "inv_cycle_count_lines_cycle_count_id_inv_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."inv_cycle_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_count_lines" ADD CONSTRAINT "inv_cycle_count_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_count_lines" ADD CONSTRAINT "inv_cycle_count_lines_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "inv_cycle_counts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "inv_cycle_counts_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "inv_cycle_counts_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "inv_cycle_counts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_cycle_counts" ADD CONSTRAINT "inv_cycle_counts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audit_lines" ADD CONSTRAINT "inv_physical_audit_lines_audit_id_inv_physical_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."inv_physical_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audit_lines" ADD CONSTRAINT "inv_physical_audit_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audit_lines" ADD CONSTRAINT "inv_physical_audit_lines_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audits" ADD CONSTRAINT "inv_physical_audits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audits" ADD CONSTRAINT "inv_physical_audits_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audits" ADD CONSTRAINT "inv_physical_audits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_physical_audits" ADD CONSTRAINT "inv_physical_audits_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "inv_pick_list_lines_pick_list_id_inv_pick_lists_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."inv_pick_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "inv_pick_list_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_pick_list_lines" ADD CONSTRAINT "inv_pick_list_lines_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_pick_lists" ADD CONSTRAINT "inv_pick_lists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_pick_lists" ADD CONSTRAINT "inv_pick_lists_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_pick_lists" ADD CONSTRAINT "inv_pick_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendor_return_lines" ADD CONSTRAINT "inv_vendor_return_lines_return_id_inv_vendor_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."inv_vendor_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendor_return_lines" ADD CONSTRAINT "inv_vendor_return_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" ADD CONSTRAINT "inv_vendor_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" ADD CONSTRAINT "inv_vendor_returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_vendor_returns" ADD CONSTRAINT "inv_vendor_returns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_valuation_layers" ADD CONSTRAINT "inv_valuation_layers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_valuation_layers" ADD CONSTRAINT "inv_valuation_layers_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "inv_quality_holds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "inv_quality_holds_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "inv_quality_holds_location_id_inv_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inv_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "inv_quality_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_holds" ADD CONSTRAINT "inv_quality_holds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_inspection_lines" ADD CONSTRAINT "inv_quality_inspection_lines_inspection_id_inv_quality_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inv_quality_inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_inspection_lines" ADD CONSTRAINT "inv_quality_inspection_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" ADD CONSTRAINT "inv_quality_inspections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" ADD CONSTRAINT "inv_quality_inspections_inspector_user_id_users_id_fk" FOREIGN KEY ("inspector_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_quality_inspections" ADD CONSTRAINT "inv_quality_inspections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_recall_events" ADD CONSTRAINT "inv_recall_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_recall_events" ADD CONSTRAINT "inv_recall_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_recall_lines" ADD CONSTRAINT "inv_recall_lines_recall_id_inv_recall_events_id_fk" FOREIGN KEY ("recall_id") REFERENCES "public"."inv_recall_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_recall_lines" ADD CONSTRAINT "inv_recall_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_carriers" ADD CONSTRAINT "inv_carriers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_load_lines" ADD CONSTRAINT "inv_load_lines_load_id_inv_loads_id_fk" FOREIGN KEY ("load_id") REFERENCES "public"."inv_loads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_load_lines" ADD CONSTRAINT "inv_load_lines_shipment_id_inv_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."inv_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_loads" ADD CONSTRAINT "inv_loads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_loads" ADD CONSTRAINT "inv_loads_source_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_loads" ADD CONSTRAINT "inv_loads_carrier_id_inv_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."inv_carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_loads" ADD CONSTRAINT "inv_loads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_package_lines" ADD CONSTRAINT "inv_package_lines_package_id_inv_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."inv_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_package_lines" ADD CONSTRAINT "inv_package_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_packages" ADD CONSTRAINT "inv_packages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_packages" ADD CONSTRAINT "inv_packages_shipment_id_inv_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."inv_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_packages" ADD CONSTRAINT "inv_packages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipment_lines" ADD CONSTRAINT "inv_shipment_lines_shipment_id_inv_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."inv_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipment_lines" ADD CONSTRAINT "inv_shipment_lines_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipments" ADD CONSTRAINT "inv_shipments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipments" ADD CONSTRAINT "inv_shipments_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipments" ADD CONSTRAINT "inv_shipments_carrier_id_inv_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."inv_carriers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipments" ADD CONSTRAINT "inv_shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_shipments" ADD CONSTRAINT "inv_shipments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_3pl_connections" ADD CONSTRAINT "inv_3pl_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_channel_stock_publications" ADD CONSTRAINT "inv_channel_stock_publications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_channel_stock_publications" ADD CONSTRAINT "inv_channel_stock_publications_channel_id_inv_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."inv_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_channel_stock_publications" ADD CONSTRAINT "inv_channel_stock_publications_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_channels" ADD CONSTRAINT "inv_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_ai_insights" ADD CONSTRAINT "inv_ai_insights_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_reorder_rules" ADD CONSTRAINT "inv_reorder_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_reorder_rules" ADD CONSTRAINT "inv_reorder_rules_product_variant_id_inv_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."inv_product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_reorder_rules" ADD CONSTRAINT "inv_reorder_rules_warehouse_id_inv_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."inv_warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_audit_events" ADD CONSTRAINT "inv_audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_audit_events" ADD CONSTRAINT "inv_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_export_jobs" ADD CONSTRAINT "inv_export_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_export_jobs" ADD CONSTRAINT "inv_export_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_idempotency_keys" ADD CONSTRAINT "inv_idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD CONSTRAINT "inv_import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_import_jobs" ADD CONSTRAINT "inv_import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_number_sequences" ADD CONSTRAINT "inv_number_sequences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_settings" ADD CONSTRAINT "inv_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_webhook_events" ADD CONSTRAINT "inv_webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_webhook_events" ADD CONSTRAINT "inv_webhook_events_webhook_id_inv_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."inv_webhooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_webhooks" ADD CONSTRAINT "inv_webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_business_unit_id_org_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."org_business_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_branches" ADD CONSTRAINT "org_branches_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_business_units" ADD CONSTRAINT "org_business_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_cost_centers" ADD CONSTRAINT "org_cost_centers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_branch_id_org_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."org_branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_head_user_id_users_id_fk" FOREIGN KEY ("head_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_locations" ADD CONSTRAINT "org_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_department_id_org_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."org_departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_teams" ADD CONSTRAINT "org_teams_lead_user_id_users_id_fk" FOREIGN KEY ("lead_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memberships" ADD CONSTRAINT "user_memberships_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_reservations" ADD CONSTRAINT "ai_credit_reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_reservations" ADD CONSTRAINT "ai_credit_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD CONSTRAINT "ai_credit_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_credit_transactions" ADD CONSTRAINT "ai_credit_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_client_id_client_accounts_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enterprise_quotes" ADD CONSTRAINT "enterprise_quotes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_ai_credits" ADD CONSTRAINT "org_ai_credits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_actions" ADD CONSTRAINT "workflow_actions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approvals" ADD CONSTRAINT "workflow_approvals_step_id_workflow_execution_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."workflow_execution_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_audit_logs" ADD CONSTRAINT "workflow_audit_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_audit_logs" ADD CONSTRAINT "workflow_audit_logs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_audit_logs" ADD CONSTRAINT "workflow_audit_logs_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" ADD CONSTRAINT "workflow_execution_steps_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_secrets" ADD CONSTRAINT "workflow_secrets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_variables" ADD CONSTRAINT "workflow_variables_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_templates" ADD CONSTRAINT "payroll_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_inputs" ADD CONSTRAINT "payroll_inputs_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_events" ADD CONSTRAINT "payroll_run_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_events" ADD CONSTRAINT "payroll_run_events_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_events" ADD CONSTRAINT "payroll_run_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_run_employee_id_payroll_run_employees_id_fk" FOREIGN KEY ("run_employee_id") REFERENCES "public"."payroll_run_employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_payslip_template_id_payslip_templates_id_fk" FOREIGN KEY ("payslip_template_id") REFERENCES "public"."payslip_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_publications" ADD CONSTRAINT "payslip_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_tax_windows" ADD CONSTRAINT "payroll_tax_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_connections" ADD CONSTRAINT "user_integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_integration_connections" ADD CONSTRAINT "user_integration_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guided_tours" ADD CONSTRAINT "guided_tours_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_setup_checklist_items" ADD CONSTRAINT "module_setup_checklist_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_setup_checklist_items" ADD CONSTRAINT "module_setup_checklist_items_checklist_id_module_setup_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."module_setup_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "module_setup_checklists" ADD CONSTRAINT "module_setup_checklists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_analytics_events" ADD CONSTRAINT "onboarding_analytics_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_analytics_events" ADD CONSTRAINT "onboarding_analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" ADD CONSTRAINT "onboarding_flow_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_flow_sessions" ADD CONSTRAINT "onboarding_flow_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tour_progress" ADD CONSTRAINT "user_tour_progress_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tour_progress" ADD CONSTRAINT "user_tour_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_audit_events" ADD CONSTRAINT "payment_audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_audit_events" ADD CONSTRAINT "payment_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_audit_events" ADD CONSTRAINT "payment_audit_events_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_manual_methods" ADD CONSTRAINT "payment_manual_methods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_accounts" ADD CONSTRAINT "payment_provider_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_accounts" ADD CONSTRAINT "payment_provider_accounts_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_credentials" ADD CONSTRAINT "payment_provider_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_credentials" ADD CONSTRAINT "payment_provider_credentials_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_credentials" ADD CONSTRAINT "payment_provider_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_credentials" ADD CONSTRAINT "payment_provider_credentials_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_providers" ADD CONSTRAINT "payment_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_test_transactions" ADD CONSTRAINT "payment_test_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_test_transactions" ADD CONSTRAINT "payment_test_transactions_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_test_transactions" ADD CONSTRAINT "payment_test_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_endpoints" ADD CONSTRAINT "payment_webhook_endpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_endpoints" ADD CONSTRAINT "payment_webhook_endpoints_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_provider_id_payment_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."payment_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_forms" ADD CONSTRAINT "survey_forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_forms" ADD CONSTRAINT "survey_forms_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_forms" ADD CONSTRAINT "survey_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_versions" ADD CONSTRAINT "survey_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_logic_rules" ADD CONSTRAINT "survey_logic_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_logic_rules" ADD CONSTRAINT "survey_logic_rules_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_logic_rules" ADD CONSTRAINT "survey_logic_rules_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_logic_rules" ADD CONSTRAINT "survey_logic_rules_source_question_id_survey_questions_id_fk" FOREIGN KEY ("source_question_id") REFERENCES "public"."survey_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_question_choices" ADD CONSTRAINT "survey_question_choices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_question_choices" ADD CONSTRAINT "survey_question_choices_question_id_survey_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."survey_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_questions" ADD CONSTRAINT "survey_questions_section_id_survey_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."survey_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_sections" ADD CONSTRAINT "survey_sections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_sections" ADD CONSTRAINT "survey_sections_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_sections" ADD CONSTRAINT "survey_sections_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_collectors" ADD CONSTRAINT "survey_collectors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_collectors" ADD CONSTRAINT "survey_collectors_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_collectors" ADD CONSTRAINT "survey_collectors_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_collector_id_survey_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."survey_collectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_participants" ADD CONSTRAINT "survey_participants_client_id_client_accounts_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."client_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_session_id_survey_response_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."survey_response_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_answers" ADD CONSTRAINT "survey_answers_question_id_survey_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."survey_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_response_sessions" ADD CONSTRAINT "survey_response_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_response_sessions" ADD CONSTRAINT "survey_response_sessions_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_response_sessions" ADD CONSTRAINT "survey_response_sessions_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_response_sessions" ADD CONSTRAINT "survey_response_sessions_collector_id_survey_collectors_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."survey_collectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_response_sessions" ADD CONSTRAINT "survey_response_sessions_participant_id_survey_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."survey_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_assessment_attempts" ADD CONSTRAINT "survey_assessment_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_assessment_attempts" ADD CONSTRAINT "survey_assessment_attempts_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_assessment_attempts" ADD CONSTRAINT "survey_assessment_attempts_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_assessment_attempts" ADD CONSTRAINT "survey_assessment_attempts_participant_id_survey_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."survey_participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_assessment_attempts" ADD CONSTRAINT "survey_assessment_attempts_session_id_survey_response_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."survey_response_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_certificates" ADD CONSTRAINT "survey_certificates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_certificates" ADD CONSTRAINT "survey_certificates_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_certificates" ADD CONSTRAINT "survey_certificates_participant_id_survey_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."survey_participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_certificates" ADD CONSTRAINT "survey_certificates_attempt_id_survey_assessment_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."survey_assessment_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_live_sessions" ADD CONSTRAINT "survey_live_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_live_sessions" ADD CONSTRAINT "survey_live_sessions_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_live_sessions" ADD CONSTRAINT "survey_live_sessions_version_id_survey_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."survey_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_live_sessions" ADD CONSTRAINT "survey_live_sessions_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_live_sessions" ADD CONSTRAINT "survey_live_sessions_current_question_id_survey_questions_id_fk" FOREIGN KEY ("current_question_id") REFERENCES "public"."survey_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_automation_events" ADD CONSTRAINT "survey_automation_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_automation_events" ADD CONSTRAINT "survey_automation_events_survey_id_survey_forms_id_fk" FOREIGN KEY ("survey_id") REFERENCES "public"."survey_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_automation_events" ADD CONSTRAINT "survey_automation_events_session_id_survey_response_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."survey_response_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_conversations" ADD CONSTRAINT "ai_chat_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_conversations" ADD CONSTRAINT "ai_chat_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_conversation_id_ai_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_attachments" ADD CONSTRAINT "feedbucket_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_attachments" ADD CONSTRAINT "feedbucket_attachments_submission_id_feedbucket_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."feedbucket_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_submissions" ADD CONSTRAINT "feedbucket_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_submissions" ADD CONSTRAINT "feedbucket_submissions_widget_id_feedbucket_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."feedbucket_widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_submissions" ADD CONSTRAINT "feedbucket_submissions_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_submissions" ADD CONSTRAINT "feedbucket_submissions_linked_ticket_id_tickets_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_widgets" ADD CONSTRAINT "feedbucket_widgets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_widgets" ADD CONSTRAINT "feedbucket_widgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedbucket_widgets" ADD CONSTRAINT "feedbucket_widgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_policy_defaults" ADD CONSTRAINT "notification_policy_defaults_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_policy_defaults" ADD CONSTRAINT "notification_policy_defaults_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_provider_accounts" ADD CONSTRAINT "notification_provider_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_provider_accounts" ADD CONSTRAINT "notification_provider_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_queue" ADD CONSTRAINT "notification_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_suppression_rules" ADD CONSTRAINT "notification_suppression_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_suppression_rules" ADD CONSTRAINT "notification_suppression_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_suppression_rules" ADD CONSTRAINT "notification_suppression_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_templates" ADD CONSTRAINT "sign_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_templates" ADD CONSTRAINT "sign_templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_watermark_policies" ADD CONSTRAINT "sign_watermark_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD CONSTRAINT "sign_envelopes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD CONSTRAINT "sign_envelopes_template_id_sign_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sign_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD CONSTRAINT "sign_envelopes_watermark_policy_id_sign_watermark_policies_id_fk" FOREIGN KEY ("watermark_policy_id") REFERENCES "public"."sign_watermark_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD CONSTRAINT "sign_envelopes_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD CONSTRAINT "sign_envelopes_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_envelopes" ADD CONSTRAINT "sign_envelopes_public_form_id_sign_public_forms_id_fk" FOREIGN KEY ("public_form_id") REFERENCES "public"."sign_public_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_documents" ADD CONSTRAINT "sign_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_documents" ADD CONSTRAINT "sign_documents_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_documents" ADD CONSTRAINT "sign_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_recipients" ADD CONSTRAINT "sign_recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_recipients" ADD CONSTRAINT "sign_recipients_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_recipients" ADD CONSTRAINT "sign_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_fields" ADD CONSTRAINT "sign_fields_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_fields" ADD CONSTRAINT "sign_fields_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_fields" ADD CONSTRAINT "sign_fields_document_id_sign_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."sign_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_fields" ADD CONSTRAINT "sign_fields_recipient_id_sign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."sign_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_signature_assets" ADD CONSTRAINT "sign_signature_assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_signature_assets" ADD CONSTRAINT "sign_signature_assets_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_signature_assets" ADD CONSTRAINT "sign_signature_assets_recipient_id_sign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."sign_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_audit_events" ADD CONSTRAINT "sign_audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_audit_events" ADD CONSTRAINT "sign_audit_events_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_audit_events" ADD CONSTRAINT "sign_audit_events_recipient_id_sign_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."sign_recipients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_certificates" ADD CONSTRAINT "sign_certificates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_certificates" ADD CONSTRAINT "sign_certificates_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_bulk_send_jobs" ADD CONSTRAINT "sign_bulk_send_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_bulk_send_jobs" ADD CONSTRAINT "sign_bulk_send_jobs_template_id_sign_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sign_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_bulk_send_jobs" ADD CONSTRAINT "sign_bulk_send_jobs_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_bulk_send_rows" ADD CONSTRAINT "sign_bulk_send_rows_job_id_sign_bulk_send_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sign_bulk_send_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_bulk_send_rows" ADD CONSTRAINT "sign_bulk_send_rows_envelope_id_sign_envelopes_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "public"."sign_envelopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_public_forms" ADD CONSTRAINT "sign_public_forms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_public_forms" ADD CONSTRAINT "sign_public_forms_template_id_sign_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."sign_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_public_forms" ADD CONSTRAINT "sign_public_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sign_org_settings" ADD CONSTRAINT "sign_org_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_feedback" ADD CONSTRAINT "ai_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_search_chunks" ADD CONSTRAINT "workspace_search_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_summary_snapshots" ADD CONSTRAINT "ai_summary_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_summary_snapshots" ADD CONSTRAINT "ai_summary_snapshots_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_org_active" ON "api_keys" USING btree ("org_id","is_revoked");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_api_keys_key_prefix" ON "api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_devices_user_fingerprint" ON "devices" USING btree ("user_id","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_devices_user" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_email_otp_codes_user_expires" ON "email_otp_codes" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_invitations_org_email" ON "invitations" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "idx_invitations_expires" ON "invitations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_invitations_org_email_pending" ON "invitations" USING btree ("org_id","email") WHERE accepted_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_login_history_user_created" ON "login_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_history_org_created" ON "login_history" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_history_user_success" ON "login_history" USING btree ("user_id","success");--> statement-breakpoint
CREATE INDEX "idx_magic_link_tokens_user" ON "magic_link_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_magic_link_tokens_hash" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_mfa_backup_codes_user" ON "mfa_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_steps_user" ON "onboarding_steps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_steps_org_status" ON "onboarding_steps" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_custom_domains_domain" ON "org_custom_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_org_custom_domains_org" ON "org_custom_domains" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_holidays_org_date" ON "org_holidays" USING btree ("org_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_members_user_org" ON "organization_members" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_org_members_org_role" ON "organization_members" USING btree ("org_id","role");--> statement-breakpoint
CREATE INDEX "idx_org_members_owner" ON "organization_members" USING btree ("org_id","is_owner");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_role_permissions_role_perm_org" ON "role_permissions" USING btree ("role","permission_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_role_permissions_org" ON "role_permissions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_role_permissions_role" ON "role_permissions" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_role_permissions_org_role" ON "role_permissions" USING btree ("org_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_role_slug_org" ON "roles" USING btree ("slug","org_id");--> statement-breakpoint
CREATE INDEX "idx_service_accounts_org" ON "service_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_api_tokens_hash" ON "user_api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_user_api_tokens_user" ON "user_api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_delegations_delegatee_status" ON "user_delegations" USING btree ("delegatee_id","status");--> statement-breakpoint
CREATE INDEX "idx_user_delegations_org_ends" ON "user_delegations" USING btree ("org_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_permissions_user_perm_org" ON "user_permissions" USING btree ("user_id","permission_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_user_permissions_org" ON "user_permissions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_user_permissions_user_org" ON "user_permissions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_active" ON "user_sessions" USING btree ("user_id","is_revoked","created_at");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_revoked_last" ON "user_sessions" USING btree ("user_id","is_revoked","last_active");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_users_last_active_org" ON "users" USING btree ("last_active_org_id");--> statement-breakpoint
CREATE INDEX "idx_verification_tokens_expires" ON "verification_tokens" USING btree ("expires");--> statement-breakpoint
CREATE INDEX "email_outbox_status_next_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "email_outbox_email_created_idx" ON "email_outbox" USING btree ("to_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_group_roles_org_group_role" ON "group_roles" USING btree ("org_id","group_type","group_id","role_id");--> statement-breakpoint
CREATE INDEX "idx_group_roles_org_group" ON "group_roles" USING btree ("org_id","group_type","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_modules_unique_idx" ON "org_modules" USING btree ("org_id","module_key");--> statement-breakpoint
CREATE INDEX "org_modules_org_idx" ON "org_modules" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_grants_unique_idx" ON "resource_grants" USING btree ("org_id","resource_type","resource_id","principal_type","principal_id","permission_key");--> statement-breakpoint
CREATE INDEX "resource_grants_org_resource_idx" ON "resource_grants" USING btree ("org_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_grants_principal_idx" ON "resource_grants" USING btree ("org_id","principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_role_permission_grants_role_key" ON "role_permission_grants" USING btree ("org_id","role_id","permission_key");--> statement-breakpoint
CREATE INDEX "idx_role_permission_grants_org_role" ON "role_permission_grants" USING btree ("org_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_roles_org_user_role" ON "user_roles" USING btree ("org_id","user_id","role_id");--> statement-breakpoint
CREATE INDEX "idx_user_roles_org_user" ON "user_roles" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_custom_states_project" ON "custom_states" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_custom_states_org" ON "custom_states" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_cycles_project" ON "cycles" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_cycles_org_status" ON "cycles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_modules_project" ON "modules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_modules_org" ON "modules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_project_template_tickets_template" ON "project_template_tickets" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_project_templates_org" ON "project_templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_projects_org_key" ON "projects" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "idx_projects_org_status" ON "projects" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_projects_manager" ON "projects" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "idx_projects_deal" ON "projects" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_reports_org_type" ON "reports" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_sprints_project_status" ON "sprints" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_automations_project_id" ON "project_automations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_automations_org_id" ON "project_automations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_project_custom_fields_project" ON "project_custom_fields" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_custom_fields_name" ON "project_custom_fields" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_project_releases_project" ON "project_releases" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_releases_org_status" ON "project_releases" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_webhooks_project_id" ON "project_webhooks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_webhooks_org_id" ON "project_webhooks" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_release_tickets" ON "release_tickets" USING btree ("release_id","ticket_id");--> statement-breakpoint
CREATE INDEX "idx_release_tickets_release" ON "release_tickets" USING btree ("release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_assignees_ticket_user" ON "ticket_assignees" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_assignees_user_id" ON "ticket_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_attachments_ticket" ON "ticket_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_checklist_items_checklist" ON "ticket_checklist_items" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_checklists_ticket" ON "ticket_checklists" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_comment_reaction_user_emoji" ON "ticket_comment_reactions" USING btree ("comment_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX "idx_comment_reactions_comment_id" ON "ticket_comment_reactions" USING btree ("comment_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_comments_ticket" ON "ticket_comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_custom_field_values" ON "ticket_custom_field_values" USING btree ("ticket_id","field_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_custom_field_values_ticket" ON "ticket_custom_field_values" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_label_mappings_ticket_label" ON "ticket_label_mappings" USING btree ("ticket_id","label_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_labels_org_name" ON "ticket_labels" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_ticket_related_links_ticket" ON "ticket_related_links" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_watcher" ON "ticket_watchers" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_watchers_user" ON "ticket_watchers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_tickets_project_number" ON "tickets" USING btree ("project_id","ticket_number");--> statement-breakpoint
CREATE INDEX "idx_tickets_project_status" ON "tickets" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_tickets_assignee" ON "tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_sprint" ON "tickets" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_org_status_priority" ON "tickets" USING btree ("org_id","status","priority");--> statement-breakpoint
CREATE INDEX "idx_tickets_org_project" ON "tickets" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_org_project_status" ON "tickets" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_tickets_cycle" ON "tickets" USING btree ("cycle_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_parent" ON "tickets" USING btree ("parent_ticket_id");--> statement-breakpoint
CREATE INDEX "idx_tickets_recurrence_next" ON "tickets" USING btree ("recurrence_next_run_at") WHERE is_recurring = true;--> statement-breakpoint
CREATE INDEX "idx_timesheets_user_date" ON "timesheets" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_timesheets_org_status" ON "timesheets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_timesheets_org_payroll" ON "timesheets" USING btree ("org_id","payroll_status","date");--> statement-breakpoint
CREATE INDEX "idx_timesheets_org_project_date" ON "timesheets" USING btree ("org_id","project_id","date");--> statement-breakpoint
CREATE INDEX "idx_timesheets_org_invoicing" ON "timesheets" USING btree ("org_id","invoicing_status");--> statement-breakpoint
CREATE INDEX "idx_timesheets_period" ON "timesheets" USING btree ("timesheet_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_timesheets_work_log" ON "timesheets" USING btree ("org_id","user_id","date") WHERE ticket_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_webhook_id" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_delivered_at" ON "webhook_deliveries" USING btree ("delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_work_item_relation" ON "work_item_relations" USING btree ("work_item_id","related_work_item_id");--> statement-breakpoint
CREATE INDEX "idx_work_item_relations_item" ON "work_item_relations" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "idx_work_item_relations_related" ON "work_item_relations" USING btree ("related_work_item_id");--> statement-breakpoint
CREATE INDEX "idx_timesheet_exports_org_type_created" ON "timesheet_exports" USING btree ("org_id","export_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_timer_sessions_user_status" ON "timer_sessions" USING btree ("org_id","user_id","status");--> statement-breakpoint
CREATE INDEX "idx_timesheet_audit_entity" ON "timesheet_audit_events" USING btree ("org_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_timesheet_budgets_org_status" ON "timesheet_budgets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_timesheet_budgets_org_project" ON "timesheet_budgets" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_timesheet_periods_user_range" ON "timesheet_periods" USING btree ("org_id","user_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_timesheet_periods_user_start" ON "timesheet_periods" USING btree ("org_id","user_id","period_start");--> statement-breakpoint
CREATE INDEX "idx_timesheet_periods_org_status" ON "timesheet_periods" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_timesheet_rate_cards_org" ON "timesheet_rate_cards" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_timesheet_rates_org_priority" ON "timesheet_rates" USING btree ("org_id","priority");--> statement-breakpoint
CREATE INDEX "idx_timesheet_rates_org_project" ON "timesheet_rates" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_intake_items_project" ON "intake_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_intake_items_org_status" ON "intake_items" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_pages_project" ON "pages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_pages_org" ON "pages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_pages_parent" ON "pages" USING btree ("parent_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_members_project_user" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_milestones_project" ON "project_milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_milestones_org" ON "project_milestones" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_project_statuses_project" ON "project_statuses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_views_project" ON "project_views" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_views_org" ON "project_views" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_project_views_org_scope" ON "project_views" USING btree ("org_id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_daily_snapshots_project_date_group" ON "project_daily_snapshots" USING btree ("project_id","snapshot_date","state_group");--> statement-breakpoint
CREATE INDEX "idx_project_daily_snapshots_org_project" ON "project_daily_snapshots" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_okr_goals_org" ON "okr_goals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_okr_goals_org_status" ON "okr_goals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_okr_goals_parent" ON "okr_goals" USING btree ("parent_goal_id");--> statement-breakpoint
CREATE INDEX "idx_okr_key_results_goal" ON "okr_key_results" USING btree ("goal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_okr_links_goal_ticket" ON "okr_links" USING btree ("goal_id","ticket_id");--> statement-breakpoint
CREATE INDEX "idx_okr_links_goal" ON "okr_links" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_okr_updates_goal" ON "okr_updates" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_changelog_entries_org_published" ON "changelog_entries" USING btree ("org_id","is_published");--> statement-breakpoint
CREATE INDEX "idx_feedback_posts_org_status" ON "feedback_posts" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_feedback_votes_post_voter" ON "feedback_votes" USING btree ("feedback_post_id","voter_key");--> statement-breakpoint
CREATE INDEX "idx_roadmap_items_org_status" ON "roadmap_items" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_roadmap_votes_item_voter" ON "roadmap_votes" USING btree ("roadmap_item_id","voter_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_whiteboard_shares_board_user" ON "project_whiteboard_shares" USING btree ("whiteboard_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_whiteboard_shares_org_board" ON "project_whiteboard_shares" USING btree ("org_id","whiteboard_id");--> statement-breakpoint
CREATE INDEX "idx_project_whiteboards_org_project" ON "project_whiteboards" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_whiteboards_share_token" ON "project_whiteboards" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "idx_git_connections_org" ON "git_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_git_connections_project" ON "git_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_git_ticket_links_ticket" ON "git_ticket_links" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_git_ticket_links_ref" ON "git_ticket_links" USING btree ("ticket_id","ref_type","external_id");--> statement-breakpoint
CREATE INDEX "idx_ticket_activity_log_ticket_recent" ON "ticket_activity_log" USING btree ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "idx_ticket_activity_log_org_ticket" ON "ticket_activity_log" USING btree ("org_id","ticket_id","id");--> statement-breakpoint
CREATE INDEX "idx_ticket_comment_mentions_comment" ON "ticket_comment_mentions" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ticket_comment_mentions_comment_user" ON "ticket_comment_mentions" USING btree ("comment_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX "idx_test_cases_org_project_suite" ON "test_cases" USING btree ("org_id","project_id","suite_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_test_cases_project_number" ON "test_cases" USING btree ("project_id","case_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_test_run_results_run_case" ON "test_run_results" USING btree ("run_id","test_case_id");--> statement-breakpoint
CREATE INDEX "idx_test_run_results_org_project" ON "test_run_results" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_test_runs_org_project_status" ON "test_runs" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_test_runs_sprint" ON "test_runs" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "idx_test_runs_release" ON "test_runs" USING btree ("release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_test_runs_project_number" ON "test_runs" USING btree ("project_id","run_number");--> statement-breakpoint
CREATE INDEX "idx_test_suites_org_project" ON "test_suites" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_test_suites_parent" ON "test_suites" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_bugs_org_project_status" ON "bugs" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_bugs_org_project_severity" ON "bugs" USING btree ("org_id","project_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bugs_project_number" ON "bugs" USING btree ("project_id","bug_number");--> statement-breakpoint
CREATE INDEX "idx_bugs_assignee" ON "bugs" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_change_requests_org_project_status" ON "change_requests" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_change_requests_project_number" ON "change_requests" USING btree ("project_id","cr_number");--> statement-breakpoint
CREATE INDEX "idx_change_requests_requested_by" ON "change_requests" USING btree ("requested_by_id");--> statement-breakpoint
CREATE INDEX "idx_project_approvals_org_project_status" ON "project_approvals" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_approvals_approver_status" ON "project_approvals" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_approvals_entity" ON "project_approvals" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_project_decisions_org_project_status" ON "project_decisions" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_decisions_project_number" ON "project_decisions" USING btree ("project_id","decision_number");--> statement-breakpoint
CREATE INDEX "idx_project_risks_org_project_status" ON "project_risks" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_risks_project_number" ON "project_risks" USING btree ("project_id","risk_number");--> statement-breakpoint
CREATE INDEX "idx_project_risks_owner" ON "project_risks" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_action_items_meeting" ON "meeting_action_items" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_action_items_org_project_status" ON "meeting_action_items" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_meeting_action_items_assignee" ON "meeting_action_items" USING btree ("assignee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_meeting_attendees_meeting_user" ON "meeting_attendees" USING btree ("meeting_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_meeting_attendees_user" ON "meeting_attendees" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_meeting_standup_meeting_user" ON "meeting_standup_entries" USING btree ("meeting_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_meetings_org_project_status" ON "project_meetings" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_meetings_project_number" ON "project_meetings" USING btree ("project_id","meeting_number");--> statement-breakpoint
CREATE INDEX "idx_project_meetings_scheduled" ON "project_meetings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_incident_updates_incident" ON "incident_updates" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "idx_project_incidents_org_project_status" ON "project_incidents" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_incidents_project_number" ON "project_incidents" USING btree ("project_id","incident_number");--> statement-breakpoint
CREATE INDEX "idx_project_incidents_severity" ON "project_incidents" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_form_submissions_form" ON "form_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "idx_form_submissions_org_project_status" ON "form_submissions" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_forms_org_project" ON "project_forms" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_forms_project_number" ON "project_forms" USING btree ("project_id","form_number");--> statement-breakpoint
CREATE INDEX "idx_project_forms_public_token" ON "project_forms" USING btree ("public_token");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_portfolio_projects" ON "portfolio_projects" USING btree ("portfolio_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_portfolio_projects_project" ON "portfolio_projects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_program_projects" ON "program_projects" USING btree ("program_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_program_projects_project" ON "program_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_portfolios_org_status" ON "project_portfolios" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_programs_org_status" ON "project_programs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_programs_portfolio" ON "project_programs" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_transitions_org_project" ON "workflow_transitions" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_transitions_from" ON "workflow_transitions" USING btree ("from_status_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_transitions_to" ON "workflow_transitions" USING btree ("to_status_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_dept_members_dept_user" ON "department_members" USING btree ("department_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_dept_members_user_id" ON "department_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_departments_org_name" ON "departments" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_eff_changes_org_employment" ON "hr_effective_dated_changes" USING btree ("org_id","employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_eff_changes_org_status" ON "hr_effective_dated_changes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_eff_changes_effective_from" ON "hr_effective_dated_changes" USING btree ("effective_from");--> statement-breakpoint
CREATE INDEX "idx_hr_eff_changes_type" ON "hr_effective_dated_changes" USING btree ("change_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_emp_profiles_employment" ON "hr_employee_profiles" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_emp_profiles_org" ON "hr_employee_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_sensitive_employment" ON "hr_employee_sensitive_fields" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_sensitive_org" ON "hr_employee_sensitive_fields" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_emp_history_org_employment" ON "hr_employment_history" USING btree ("org_id","employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_emp_history_created_at" ON "hr_employment_history" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_employments_org_emp_num" ON "hr_employments" USING btree ("org_id","employee_number");--> statement-breakpoint
CREATE INDEX "idx_hr_employments_org" ON "hr_employments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_employments_person" ON "hr_employments" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "idx_hr_employments_org_status" ON "hr_employments" USING btree ("org_id","lifecycle_status");--> statement-breakpoint
CREATE INDEX "idx_hr_employments_dept" ON "hr_employments" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_people_org_work_email" ON "hr_people" USING btree ("org_id","work_email");--> statement-breakpoint
CREATE INDEX "idx_hr_people_org" ON "hr_people" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_people_user" ON "hr_people" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_reporting_lines_org_emp" ON "hr_reporting_lines" USING btree ("org_id","employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_reporting_lines_manager" ON "hr_reporting_lines" USING btree ("manager_employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_reporting_lines_org_type" ON "hr_reporting_lines" USING btree ("org_id","line_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_cfd_org_entity_key" ON "hr_custom_field_definitions" USING btree ("org_id","entity_type","key");--> statement-breakpoint
CREATE INDEX "idx_hr_cfd_org_entity" ON "hr_custom_field_definitions" USING btree ("org_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_cfv_field_entity" ON "hr_custom_field_values" USING btree ("field_definition_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_hr_cfv_org_entity" ON "hr_custom_field_values" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_job_levels_org_name" ON "hr_job_levels" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_job_levels_org" ON "hr_job_levels" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_job_roles_org_name" ON "hr_job_roles" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_job_roles_org" ON "hr_job_roles" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_locations_org_name" ON "hr_locations" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_locations_org" ON "hr_locations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_teams_org_name" ON "hr_teams" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_teams_org" ON "hr_teams" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_audit_logs_org" ON "hr_audit_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_audit_logs_org_entity" ON "hr_audit_logs" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_hr_audit_logs_actor" ON "hr_audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_hr_audit_logs_created_at" ON "hr_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_audit_logs_org_action" ON "hr_audit_logs" USING btree ("org_id","action");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_automation_rules_org_name" ON "hr_automation_rules" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_automation_rules_org_event" ON "hr_automation_rules" USING btree ("org_id","trigger_event");--> statement-breakpoint
CREATE INDEX "idx_hr_automation_rules_org_enabled" ON "hr_automation_rules" USING btree ("org_id","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_hr_automation_runs_org_rule_created" ON "hr_automation_runs" USING btree ("org_id","rule_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_automation_runs_org_status" ON "hr_automation_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_policies_org_type_name_version" ON "hr_policies" USING btree ("org_id","policy_type","name","version");--> statement-breakpoint
CREATE INDEX "idx_hr_policies_org_type_status" ON "hr_policies" USING btree ("org_id","policy_type","status");--> statement-breakpoint
CREATE INDEX "idx_hr_policies_org_status" ON "hr_policies" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_policy_assignments_org_policy" ON "hr_policy_assignments" USING btree ("org_id","policy_id");--> statement-breakpoint
CREATE INDEX "idx_hr_policy_assignments_org_employee" ON "hr_policy_assignments" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_hr_policy_scopes_org_policy" ON "hr_policy_scopes" USING btree ("org_id","policy_id");--> statement-breakpoint
CREATE INDEX "idx_hr_policy_scopes_org_type_value" ON "hr_policy_scopes" USING btree ("org_id","scope_type","scope_value");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_wf_def_org_type_name_version" ON "hr_workflow_definitions" USING btree ("org_id","object_type","name","version");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_def_org_type_status" ON "hr_workflow_definitions" USING btree ("org_id","object_type","status");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_delegations_org_delegator_active" ON "hr_workflow_delegations" USING btree ("org_id","delegator_user_id","active");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_inst_org_obj" ON "hr_workflow_instances" USING btree ("org_id","object_type","object_id");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_inst_org_status" ON "hr_workflow_instances" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_inst_org_requester" ON "hr_workflow_instances" USING btree ("org_id","requested_by");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_actions_org_instance" ON "hr_workflow_step_actions" USING btree ("org_id","instance_id");--> statement-breakpoint
CREATE INDEX "idx_hr_wf_steps_def_order" ON "hr_workflow_steps" USING btree ("definition_id","step_order");--> statement-breakpoint
CREATE INDEX "idx_hr_template_renders_org_template" ON "hr_template_renders" USING btree ("org_id","template_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_templates_org_kind_name_ver" ON "hr_templates" USING btree ("org_id","kind","name","version");--> statement-breakpoint
CREATE INDEX "idx_hr_templates_org_kind" ON "hr_templates" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "idx_hr_templates_org_status" ON "hr_templates" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_adjustments_org_status" ON "hr_payroll_adjustments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_adjustments_org_period" ON "hr_payroll_adjustments" USING btree ("org_id","period_id");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_adjustments_org_user" ON "hr_payroll_adjustments" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_payroll_input_periods_org_key" ON "hr_payroll_input_periods" USING btree ("org_id","period_key");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_input_periods_org_status" ON "hr_payroll_input_periods" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_payroll_input_snapshots_period_user_section" ON "hr_payroll_input_snapshots" USING btree ("period_id","user_id","section");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_input_snapshots_org_period_user" ON "hr_payroll_input_snapshots" USING btree ("org_id","period_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_attendance_user_date" ON "attendance" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_attendance_org_date_status" ON "attendance" USING btree ("org_id","date","status");--> statement-breakpoint
CREATE INDEX "idx_attendance_org_user_date" ON "attendance" USING btree ("org_id","user_id","date");--> statement-breakpoint
CREATE INDEX "idx_helpdesk_tickets_org_status" ON "helpdesk_tickets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_helpdesk_tickets_org_user" ON "helpdesk_tickets" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_helpdesk_tickets_org_assignee" ON "helpdesk_tickets" USING btree ("org_id","assignee_id");--> statement-breakpoint
CREATE INDEX "idx_hr_helpdesk_comments_ticket" ON "hr_helpdesk_comments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_hr_helpdesk_routing_org" ON "hr_helpdesk_routing" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_helpdesk_routing_org_category" ON "hr_helpdesk_routing" USING btree ("org_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_wfh_requests_user_date" ON "wfh_requests" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_wfh_requests_org_status" ON "wfh_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_wfh_requests_org_user_status" ON "wfh_requests" USING btree ("org_id","user_id","status");--> statement-breakpoint
CREATE INDEX "idx_att_reg_org_user" ON "hr_attendance_regularizations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_att_reg_org_date" ON "hr_attendance_regularizations" USING btree ("org_id","attendance_date");--> statement-breakpoint
CREATE INDEX "idx_att_reg_status" ON "hr_attendance_regularizations" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leave_balances_user_type_year" ON "leave_balances" USING btree ("user_id","leave_type_id","year");--> statement-breakpoint
CREATE INDEX "idx_leave_balances_org_year" ON "leave_balances" USING btree ("org_id","year");--> statement-breakpoint
CREATE INDEX "idx_leave_blackout_org" ON "leave_blackout_dates" USING btree ("org_id","start_date");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_user_id" ON "leave_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_org_status" ON "leave_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_dates" ON "leave_requests" USING btree ("start_date","end_date");--> statement-breakpoint
CREATE INDEX "idx_leave_requests_org_user_status" ON "leave_requests" USING btree ("org_id","user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_leave_types_org_name" ON "leave_types" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_leave_ledger_user_type_date" ON "hr_leave_ledger" USING btree ("org_id","user_id","leave_type_id","effective_date");--> statement-breakpoint
CREATE INDEX "idx_hr_leave_ledger_payroll_status" ON "hr_leave_ledger" USING btree ("org_id","payroll_status");--> statement-breakpoint
CREATE INDEX "idx_hr_leave_ledger_org_user" ON "hr_leave_ledger" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_assets_org_status" ON "assets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_assets_assigned" ON "assets" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_asset_returns_user" ON "asset_returns" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bonuses_user" ON "bonuses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_expense_categories_org_name" ON "expense_categories" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_expenses_user_id" ON "expenses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_expenses_org_status_date" ON "expenses" USING btree ("org_id","status","expense_date");--> statement-breakpoint
CREATE INDEX "idx_expenses_category" ON "expenses" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_expenses_org_receipt_hash" ON "expenses" USING btree ("org_id","receipt_hash");--> statement-breakpoint
CREATE INDEX "idx_fnf_user" ON "fnf_settlements" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payrolls_user_month" ON "payrolls" USING btree ("user_id","month");--> statement-breakpoint
CREATE INDEX "idx_payrolls_org_month_status" ON "payrolls" USING btree ("org_id","month","status");--> statement-breakpoint
CREATE INDEX "idx_reimbursements_org" ON "reimbursements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_reimbursements_user" ON "reimbursements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_loans_org" ON "salary_loans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_loans_user" ON "salary_loans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_salary_structures_user_active" ON "salary_structures" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_booking_link_interviewers_link_user" ON "booking_link_interviewers" USING btree ("booking_link_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_calibration_participants_session_user" ON "calibration_participants" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_calibration_participants_org_user" ON "calibration_participants" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_calibration_sessions_candidate" ON "calibration_sessions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_calibration_sessions_org" ON "calibration_sessions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_applications_candidate" ON "candidate_applications" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_applications_job" ON "candidate_applications" USING btree ("job_posting_id");--> statement-breakpoint
CREATE INDEX "idx_vault_candidate" ON "candidate_documents_vault" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_vault_org" ON "candidate_documents_vault" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_messages_org" ON "candidate_messages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_messages_candidate" ON "candidate_messages" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_messages_sent" ON "candidate_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "idx_candidate_offers_candidate" ON "candidate_offers" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_offers_org" ON "candidate_offers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_reference_checks_candidate" ON "candidate_reference_checks" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_reference_checks_org" ON "candidate_reference_checks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_referrals_candidate" ON "candidate_referrals" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_referrals_referred_by" ON "candidate_referrals" USING btree ("referred_by");--> statement-breakpoint
CREATE INDEX "idx_referrals_org" ON "candidate_referrals" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sla_tracking_candidate_stage" ON "candidate_sla_tracking" USING btree ("candidate_id","stage");--> statement-breakpoint
CREATE INDEX "idx_sla_tracking_org_status" ON "candidate_sla_tracking" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_sla_tracking_candidate" ON "candidate_sla_tracking" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_sources_org" ON "candidate_sources" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_candidate_sources_org_platform" ON "candidate_sources" USING btree ("org_id","platform");--> statement-breakpoint
CREATE INDEX "idx_candidates_org" ON "candidates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_candidates_status" ON "candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_candidates_email" ON "candidates" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_email_sequence_enrollments_sequence" ON "email_sequence_enrollments" USING btree ("sequence_id");--> statement-breakpoint
CREATE INDEX "idx_email_sequence_enrollments_candidate" ON "email_sequence_enrollments" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_email_sequence_enrollments_next_send" ON "email_sequence_enrollments" USING btree ("next_send_at");--> statement-breakpoint
CREATE INDEX "idx_email_sequence_steps_sequence" ON "email_sequence_steps" USING btree ("sequence_id");--> statement-breakpoint
CREATE INDEX "idx_email_sequences_org" ON "email_sequences" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_headcount_requests_org" ON "headcount_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_headcount_requests_status" ON "headcount_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_headcount_requests_dept" ON "headcount_requests" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "idx_hiring_flow_rounds_flow" ON "hiring_flow_rounds" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX "idx_hiring_flows_org" ON "hiring_flows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_booking_links_token" ON "interview_booking_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_booking_links_candidate" ON "interview_booking_links" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_interview_panel_members_interview_user" ON "interview_panel_members" USING btree ("interview_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_interview_panel_members_org_user" ON "interview_panel_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_interview_questions_org" ON "interview_questions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_interview_questions_category" ON "interview_questions" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_scorecards_interview" ON "interview_scorecards" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "idx_scorecards_interviewer" ON "interview_scorecards" USING btree ("interviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_scorecard_interview_interviewer" ON "interview_scorecards" USING btree ("interview_id","interviewer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_interview_sla_org_stage" ON "interview_slas" USING btree ("org_id","stage");--> statement-breakpoint
CREATE INDEX "idx_interviews_candidate" ON "interviews" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_interviews_interviewer" ON "interviews" USING btree ("interviewer_id");--> statement-breakpoint
CREATE INDEX "idx_interviews_scheduled" ON "interviews" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_job_postings_org" ON "job_postings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_job_postings_status" ON "job_postings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_job_recruiters_job_user" ON "job_recruiters" USING btree ("job_posting_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_job_recruiters_job" ON "job_recruiters" USING btree ("job_posting_id");--> statement-breakpoint
CREATE INDEX "idx_job_recruiters_user" ON "job_recruiters" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_offer_letter_templates_org" ON "offer_letter_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_offer_negotiations_offer" ON "offer_negotiations" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "idx_offer_versions_offer" ON "offer_versions" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_automations_org" ON "pipeline_automations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_pipeline_automations_trigger" ON "pipeline_automations" USING btree ("trigger");--> statement-breakpoint
CREATE INDEX "idx_recruiter_activity_org" ON "recruiter_activity_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_recruiter_activity_recruiter" ON "recruiter_activity_log" USING btree ("recruiter_id");--> statement-breakpoint
CREATE INDEX "idx_recruiter_activity_created" ON "recruiter_activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_recruitment_vendors_org" ON "recruitment_vendors" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_recruitment_vendors_portal_token" ON "recruitment_vendors" USING btree ("portal_token");--> statement-breakpoint
CREATE INDEX "idx_scheduled_reports_org" ON "scheduled_reports" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_scorecard_templates_org" ON "scorecard_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_submissions_vendor" ON "vendor_candidate_submissions" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_submissions_candidate" ON "vendor_candidate_submissions" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_alumni_org" ON "alumni_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_bgv_user" ON "background_verifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_docs_candidate" ON "candidate_documents" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_candidate_docs_external" ON "candidate_documents" USING btree ("external_doc_id");--> statement-breakpoint
CREATE INDEX "idx_certifications_user" ON "certifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_certifications_expiry" ON "certifications" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "idx_dtv_template_id" ON "document_template_versions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_doc_templates_org" ON "document_templates" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_doc_types_org" ON "document_types" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_docs_user" ON "onboarding_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_docs_org" ON "onboarding_documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_tasks_user" ON "onboarding_tasks" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_tasks_status" ON "onboarding_tasks" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_onboarding_templates_org" ON "onboarding_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_resignations_org" ON "resignations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_resignations_user" ON "resignations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_terminations_org" ON "terminations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_terminations_user" ON "terminations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_terminations_status" ON "terminations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_job_board_postings_job" ON "job_board_postings" USING btree ("job_posting_id");--> statement-breakpoint
CREATE INDEX "idx_job_board_postings_org" ON "job_board_postings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_talent_pool_members_pool_candidate" ON "talent_pool_members" USING btree ("pool_id","candidate_id");--> statement-breakpoint
CREATE INDEX "idx_talent_pool_members_pool" ON "talent_pool_members" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "idx_talent_pool_members_candidate" ON "talent_pool_members" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "idx_talent_pools_org" ON "talent_pools" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_referrals_referrer_candidate" ON "external_referrals" USING btree ("referrer_id","candidate_id");--> statement-breakpoint
CREATE INDEX "idx_external_referrals_org" ON "external_referrals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_external_referrals_candidate" ON "external_referrals" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_referrers_org_email" ON "external_referrers" USING btree ("org_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_external_referrers_token" ON "external_referrers" USING btree ("referral_token");--> statement-breakpoint
CREATE INDEX "idx_assessment_attempts_user" ON "assessment_attempts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_employee_skills_user" ON "employee_skills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_employee_skills_name" ON "employee_skills" USING btree ("skill_name");--> statement-breakpoint
CREATE INDEX "idx_enps_org_period" ON "enps_scores" USING btree ("org_id","period");--> statement-breakpoint
CREATE INDEX "idx_feedback_subject" ON "feedback_requests" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_reviewer" ON "feedback_requests" USING btree ("reviewer_user_id");--> statement-breakpoint
CREATE INDEX "idx_goals_user_status" ON "goals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_goals_org_status" ON "goals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_calibration_entries_org" ON "hr_calibration_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_calibration_entries_cycle" ON "hr_calibration_entries" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_calibration_cycle_employee" ON "hr_calibration_entries" USING btree ("cycle_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_key_results_goal" ON "key_results" USING btree ("goal_id");--> statement-breakpoint
CREATE INDEX "idx_one_on_ones_org" ON "one_on_one_meetings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_one_on_ones_manager" ON "one_on_one_meetings" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX "idx_one_on_ones_scheduled" ON "one_on_one_meetings" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_pip_user" ON "performance_improvement_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_perf_reviews_org_cycle" ON "performance_reviews" USING btree ("org_id","cycle_id");--> statement-breakpoint
CREATE INDEX "idx_perf_reviews_user" ON "performance_reviews" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_surveys_org" ON "pulse_surveys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_recognitions_org" ON "recognitions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_recognitions_to_user" ON "recognitions" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "idx_review_cycles_org" ON "review_cycles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_skill_assessments_org" ON "skill_assessments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_survey_responses_survey" ON "survey_responses" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_career_ladders_org" ON "career_ladders" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_documents_org_type" ON "documents" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_documents_user" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_documents_expiry" ON "documents" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "idx_email_templates_org" ON "hr_email_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_handbook_org" ON "handbook_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_learning_paths_org" ON "learning_paths" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_policy_ack_doc" ON "policy_acknowledgments" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_policy_ack_user" ON "policy_acknowledgments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_rich_documents_org" ON "rich_documents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_team_events_org" ON "team_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_shift_assignments_user" ON "employee_shift_assignments" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_shift_assignments_org" ON "employee_shift_assignments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_shift_swaps_org_status" ON "shift_swap_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_shift_swaps_requester" ON "shift_swap_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_shift_templates_org_name" ON "shift_templates" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_shift_templates_org_active" ON "shift_templates" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_roster_entries_roster" ON "roster_entries" USING btree ("roster_id");--> statement-breakpoint
CREATE INDEX "idx_roster_entries_user_date" ON "roster_entries" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "idx_rosters_org_week" ON "rosters" USING btree ("org_id","week_start");--> statement-breakpoint
CREATE INDEX "idx_comp_off_user" ON "comp_off_balances" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_overtime_org_status" ON "overtime_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_overtime_user" ON "overtime_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_geofences_org_active" ON "geofences" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_biometric_devices_org" ON "biometric_devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_biometric_logs_org_device" ON "biometric_logs" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_biometric_logs_user_time" ON "biometric_logs" USING btree ("user_id","punch_time");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_course_categories_org_name" ON "course_categories" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_course_enrollments_course_user" ON "course_enrollments" USING btree ("course_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_course_enrollments_user" ON "course_enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_courses_org_status" ON "courses" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_training_attendance_program" ON "training_attendance" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_training_attendance_user" ON "training_attendance" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_training_programs_org_status" ON "training_programs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_requisitions_org_status" ON "job_requisitions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_requisitions_hiring_manager" ON "job_requisitions" USING btree ("hiring_manager_id");--> statement-breakpoint
CREATE INDEX "idx_competencies_framework" ON "competencies" USING btree ("framework_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_competency_frameworks_org_name" ON "competency_frameworks" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_kpi_definitions_org" ON "kpi_definitions" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fb_cycle_req_cycle_sub_rev" ON "feedback_cycle_requests" USING btree ("cycle_id","subject_id","reviewer_id");--> statement-breakpoint
CREATE INDEX "idx_fb_cycle_requests_reviewer" ON "feedback_cycle_requests" USING btree ("reviewer_id","status");--> statement-breakpoint
CREATE INDEX "idx_fb_cycle_responses_request" ON "feedback_cycle_responses" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_cycles_org_status" ON "feedback_cycles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_travel_requests_org_status" ON "travel_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_travel_requests_user" ON "travel_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_career_paths_org" ON "career_paths" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_career_plans_user" ON "employee_career_plans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_leave_policies_org_type" ON "leave_policies" USING btree ("org_id","leave_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_announcement_reads_unique" ON "announcement_reads" USING btree ("announcement_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_announcement_reads_announcement" ON "announcement_reads" USING btree ("announcement_id");--> statement-breakpoint
CREATE INDEX "idx_announcement_reads_user" ON "announcement_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_announcement_targets_announcement" ON "announcement_targets" USING btree ("announcement_id");--> statement-breakpoint
CREATE INDEX "idx_announcement_targets_org_type_target" ON "announcement_targets" USING btree ("org_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "idx_announcements_org_status" ON "announcements" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_announcements_org_pinned" ON "announcements" USING btree ("org_id","is_pinned");--> statement-breakpoint
CREATE INDEX "idx_salary_structure_templates_org" ON "salary_structure_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_salary_structure_templates_org_active" ON "salary_structure_templates" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_allowance_types_org_name" ON "allowance_types" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_allowance_types_org_category" ON "allowance_types" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_investment_proofs_declaration" ON "investment_proofs" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "idx_tax_declarations_org_year" ON "tax_declarations" USING btree ("org_id","financial_year");--> statement-breakpoint
CREATE INDEX "idx_tax_declarations_user" ON "tax_declarations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bank_transfers_org_month" ON "bank_transfers" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "idx_bank_transfers_org_status" ON "bank_transfers" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_payroll_accounting_mappings_org" ON "payroll_accounting_mappings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payroll_accounting_mappings_org_component" ON "payroll_accounting_mappings" USING btree ("org_id","component_id") WHERE "payroll_accounting_mappings"."component_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_payroll_accounting_mappings_org_category" ON "payroll_accounting_mappings" USING btree ("org_id","category") WHERE "payroll_accounting_mappings"."component_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_payroll_calendar_events_org_date" ON "payroll_calendar_events" USING btree ("org_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_policies_org" ON "payroll_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_policies_org_status" ON "payroll_policies" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_policy_versions_policy_version" ON "payroll_policy_versions" USING btree ("policy_id","version");--> statement-breakpoint
CREATE INDEX "idx_payroll_policy_versions_org_policy" ON "payroll_policy_versions" USING btree ("org_id","policy_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_template_activations_org" ON "payroll_template_activations" USING btree ("org_id","policy_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_approvals_run_stage" ON "payroll_approvals" USING btree ("run_id","stage");--> statement-breakpoint
CREATE INDEX "idx_payroll_approvals_org_run" ON "payroll_approvals" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_exceptions_org_run_status" ON "payroll_exceptions" USING btree ("org_id","run_id","status");--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_run_employee" ON "payroll_line_items" USING btree ("run_employee_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_line_items_org_run" ON "payroll_line_items" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_run_employees_run_user" ON "payroll_run_employees" USING btree ("run_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_run_employees_org_run" ON "payroll_run_employees" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_runs_org_month" ON "payroll_runs" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "idx_payroll_runs_org_status" ON "payroll_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_payroll_bank_batch_items_batch_status" ON "payroll_bank_batch_items" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "idx_payroll_bank_batch_items_org" ON "payroll_bank_batch_items" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_bank_batches_org_number" ON "payroll_bank_batches" USING btree ("org_id","batch_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_bank_batches_idempotency_key" ON "payroll_bank_batches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_payroll_bank_batches_org_run" ON "payroll_bank_batches" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_payslip_templates_org" ON "payslip_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profile_components_profile" ON "employee_salary_profile_components" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profile_components_org" ON "employee_salary_profile_components" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profiles_org_user_effective" ON "employee_salary_profiles" USING btree ("org_id","user_id","effective_from");--> statement-breakpoint
CREATE INDEX "idx_employee_salary_profiles_org_status" ON "employee_salary_profiles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_payroll_loan_adjustments_org_loan" ON "payroll_loan_adjustments" USING btree ("org_id","loan_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_loan_adjustments_run" ON "payroll_loan_adjustments" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_salary_components_org_code" ON "salary_components" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_salary_components_org_active" ON "salary_components" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_hr_access_requests_org" ON "hr_access_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_access_requests_employee" ON "hr_access_requests" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "idx_hr_probation_reviews_org" ON "hr_probation_reviews" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_probation_reviews_employment" ON "hr_probation_reviews" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_probation_reviews_status" ON "hr_probation_reviews" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_mentorships_org" ON "hr_mentorships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_mentorships_mentor" ON "hr_mentorships" USING btree ("mentor_id");--> statement-breakpoint
CREATE INDEX "idx_mentorships_mentee" ON "hr_mentorships" USING btree ("mentee_id");--> statement-breakpoint
CREATE INDEX "idx_role_skill_req_org" ON "hr_role_skill_requirements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_role_skill_req_job_role" ON "hr_role_skill_requirements" USING btree ("job_role_id");--> statement-breakpoint
CREATE INDEX "idx_succession_org" ON "hr_succession_plans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_succession_role" ON "hr_succession_plans" USING btree ("org_id","job_role_id");--> statement-breakpoint
CREATE INDEX "idx_badge_awards_org_user" ON "hr_badge_awards" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_badge_awards_badge" ON "hr_badge_awards" USING btree ("badge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_badge_org_name" ON "hr_badges" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_badges_org" ON "hr_badges" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_campaigns_org_status" ON "hr_campaigns" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_community_org_name" ON "hr_communities" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_communities_org" ON "hr_communities" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_community_member" ON "hr_community_members" USING btree ("community_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_community_members_community" ON "hr_community_members" USING btree ("community_id");--> statement-breakpoint
CREATE INDEX "idx_community_members_user" ON "hr_community_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_mood_org_user_date" ON "hr_mood_checkins" USING btree ("org_id","user_id","date");--> statement-breakpoint
CREATE INDEX "idx_mood_checkins_org_date" ON "hr_mood_checkins" USING btree ("org_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_poll_vote_poll_user" ON "hr_poll_votes" USING btree ("poll_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_poll_votes_poll" ON "hr_poll_votes" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "idx_hr_polls_org_status" ON "hr_polls" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_reward_ledger_org_user" ON "hr_reward_points_ledger" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_reward_ledger_org_created" ON "hr_reward_points_ledger" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_case_documents_case" ON "hr_case_documents" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_hr_case_notes_case" ON "hr_case_notes" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "idx_hr_case_notes_org" ON "hr_case_notes" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_cases_org_number" ON "hr_cases" USING btree ("org_id","case_number");--> statement-breakpoint
CREATE INDEX "idx_hr_cases_org_status" ON "hr_cases" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_cases_org_category" ON "hr_cases" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_hr_cases_org_assigned" ON "hr_cases" USING btree ("org_id","assigned_to");--> statement-breakpoint
CREATE INDEX "idx_hr_disciplinary_org_employee" ON "hr_disciplinary_actions" USING btree ("org_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_hr_disciplinary_org_case" ON "hr_disciplinary_actions" USING btree ("org_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_safety_incidents_org_number" ON "hr_safety_incidents" USING btree ("org_id","incident_number");--> statement-breakpoint
CREATE INDEX "idx_hr_safety_incidents_org_status" ON "hr_safety_incidents" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_safety_incidents_org_type" ON "hr_safety_incidents" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_hr_safety_incidents_org_occurred" ON "hr_safety_incidents" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_wellness_org_user_date" ON "hr_wellness_checkins" USING btree ("org_id","user_id","date");--> statement-breakpoint
CREATE INDEX "idx_hr_wellness_org_date" ON "hr_wellness_checkins" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "idx_hr_wellness_org_user" ON "hr_wellness_checkins" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_enroll_windows_org_status" ON "hr_benefit_enrollment_windows" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_enroll_windows_org_plan" ON "hr_benefit_enrollment_windows" USING btree ("org_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_benefit_enrollments_org_plan_user" ON "hr_benefit_enrollments" USING btree ("org_id","plan_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_benefit_enrollments_org_user" ON "hr_benefit_enrollments" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_benefit_enrollments_org_plan" ON "hr_benefit_enrollments" USING btree ("org_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_benefit_plans_org_name" ON "hr_benefit_plans" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_benefit_plans_org_status" ON "hr_benefit_plans" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_benefit_plans_org_category" ON "hr_benefit_plans" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_hr_dependents_org_user" ON "hr_dependents" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_insurance_claims_org_number" ON "hr_insurance_claims" USING btree ("org_id","claim_number");--> statement-breakpoint
CREATE INDEX "idx_hr_insurance_claims_org_user" ON "hr_insurance_claims" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_insurance_claims_org_status" ON "hr_insurance_claims" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_insurance_claims_org_plan" ON "hr_insurance_claims" USING btree ("org_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_loan_repayments_loan_installment" ON "hr_loan_repayments" USING btree ("loan_id","installment_no");--> statement-breakpoint
CREATE INDEX "idx_hr_loan_repayments_org_status" ON "hr_loan_repayments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_loan_repayments_org_due_date" ON "hr_loan_repayments" USING btree ("org_id","due_date");--> statement-breakpoint
CREATE INDEX "idx_hr_travel_visit_logs_org_travel" ON "hr_travel_visit_logs" USING btree ("org_id","travel_request_id");--> statement-breakpoint
CREATE INDEX "idx_hr_travel_visit_logs_org_user" ON "hr_travel_visit_logs" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_webhook_deliveries_org_sub_created" ON "hr_webhook_deliveries" USING btree ("org_id","subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_webhook_deliveries_org_status" ON "hr_webhook_deliveries" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_webhook_subscriptions_org_name" ON "hr_webhook_subscriptions" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_webhook_subscriptions_org_active" ON "hr_webhook_subscriptions" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_hr_import_jobs_org" ON "hr_import_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_import_rows_job_status" ON "hr_import_rows" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_events_org_due" ON "hr_compliance_events" USING btree ("org_id","due_date");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_events_org_status" ON "hr_compliance_events" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_events_req" ON "hr_compliance_events" USING btree ("requirement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_compliance_req_org_name" ON "hr_compliance_requirements" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_req_org_country" ON "hr_compliance_requirements" USING btree ("org_id","country_code");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_req_org_active" ON "hr_compliance_requirements" USING btree ("org_id","active");--> statement-breakpoint
CREATE INDEX "idx_hr_contracts_org_end_date" ON "hr_contracts" USING btree ("org_id","end_date");--> statement-breakpoint
CREATE INDEX "idx_hr_contracts_org_status" ON "hr_contracts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_contracts_org_emp" ON "hr_contracts" USING btree ("org_id","employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_work_auths_org_emp" ON "hr_work_authorizations" USING btree ("org_id","employment_id");--> statement-breakpoint
CREATE INDEX "idx_hr_work_auths_org_valid_until" ON "hr_work_authorizations" USING btree ("org_id","valid_until");--> statement-breakpoint
CREATE INDEX "idx_hr_work_auths_org_status" ON "hr_work_authorizations" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_headcount_plans_org_year_dept" ON "hr_headcount_plans" USING btree ("org_id","fiscal_year","department_id");--> statement-breakpoint
CREATE INDEX "idx_hr_headcount_plans_org" ON "hr_headcount_plans" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_hiring_plan_items_plan" ON "hr_hiring_plan_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "idx_hr_hiring_plan_items_org" ON "hr_hiring_plan_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_form_subs_org_form_created" ON "hr_form_submissions" USING btree ("org_id","form_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_hr_form_subs_org_status" ON "hr_form_submissions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_forms_org_name" ON "hr_forms" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_forms_org_slug" ON "hr_forms" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "idx_hr_forms_org_status" ON "hr_forms" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_collective_agreements_org_status" ON "hr_collective_agreements" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_collective_agreements_org_union" ON "hr_collective_agreements" USING btree ("org_id","union_name");--> statement-breakpoint
CREATE INDEX "idx_hr_data_requests_org_status" ON "hr_data_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_data_requests_org_subject" ON "hr_data_requests" USING btree ("org_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_labor_cases_org_status" ON "hr_labor_cases" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_labor_cases_org_union" ON "hr_labor_cases" USING btree ("org_id","union_name");--> statement-breakpoint
CREATE INDEX "idx_hr_legal_hold_items_hold" ON "hr_legal_hold_items" USING btree ("hold_id");--> statement-breakpoint
CREATE INDEX "idx_hr_legal_hold_items_org_subject" ON "hr_legal_hold_items" USING btree ("org_id","item_type","item_ref");--> statement-breakpoint
CREATE INDEX "idx_hr_legal_holds_org_status" ON "hr_legal_holds" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_legal_holds_org_subject" ON "hr_legal_holds" USING btree ("org_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_positions_org_status" ON "hr_positions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_positions_org_dept" ON "hr_positions" USING btree ("org_id","department_id");--> statement-breakpoint
CREATE INDEX "idx_hr_positions_org" ON "hr_positions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_proxy_access_org_grantor" ON "hr_proxy_access" USING btree ("org_id","grantor_user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_proxy_access_org_proxy" ON "hr_proxy_access" USING btree ("org_id","proxy_user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_reorg_scenarios_org_status" ON "hr_reorg_scenarios" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_retention_policies_org" ON "hr_retention_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_retention_policy_org_type_country" ON "hr_retention_policies" USING btree ("org_id","record_type","country_code");--> statement-breakpoint
CREATE INDEX "idx_hr_union_memberships_org" ON "hr_union_memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_union_memberships_org_user" ON "hr_union_memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_arrears_org_user" ON "hr_arrears_adjustments" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_arrears_org_status" ON "hr_arrears_adjustments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_comp_budget_pools_org_cycle" ON "hr_comp_budget_pools" USING btree ("org_id","cycle_id");--> statement-breakpoint
CREATE INDEX "idx_hr_comp_cycles_org_status" ON "hr_comp_cycles" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_comp_cycles_org_year_name" ON "hr_comp_cycles" USING btree ("org_id","fiscal_year","name");--> statement-breakpoint
CREATE INDEX "idx_hr_comp_recs_org_cycle" ON "hr_comp_recommendations" USING btree ("org_id","cycle_id");--> statement-breakpoint
CREATE INDEX "idx_hr_comp_recs_org_user" ON "hr_comp_recommendations" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_comp_recs_cycle_user" ON "hr_comp_recommendations" USING btree ("cycle_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_device_emp_mappings_org_device" ON "hr_device_employee_mappings" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_hr_device_emp_mappings_org_user" ON "hr_device_employee_mappings" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_device_sync_logs_org_device" ON "hr_device_sync_logs" USING btree ("org_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_hr_device_sync_logs_status" ON "hr_device_sync_logs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_equity_exercises_org_grant" ON "hr_equity_exercises" USING btree ("org_id","grant_id");--> statement-breakpoint
CREATE INDEX "idx_hr_equity_grants_org_user" ON "hr_equity_grants" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_equity_grants_org_status" ON "hr_equity_grants" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_equity_vesting_events_grant" ON "hr_equity_vesting_events" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_hr_equity_vesting_events_org_grant" ON "hr_equity_vesting_events" USING btree ("org_id","grant_id");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_tasks_org_country" ON "hr_payroll_compliance_tasks" USING btree ("org_id","country_code");--> statement-breakpoint
CREATE INDEX "idx_hr_compliance_tasks_org_status" ON "hr_payroll_compliance_tasks" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_variance_org_period" ON "hr_payroll_variance_approvals" USING btree ("org_id","payroll_period_key");--> statement-breakpoint
CREATE INDEX "idx_hr_payroll_variance_status" ON "hr_payroll_variance_approvals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_time_devices_org_status" ON "hr_time_devices" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_hr_time_devices_org_serial" ON "hr_time_devices" USING btree ("org_id","serial_number");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_prov_org" ON "hr_access_provisioning" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_prov_user" ON "hr_access_provisioning" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_prov_status" ON "hr_access_provisioning" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_prov_tmpl_org" ON "hr_access_provisioning_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_req_org" ON "hr_accommodation_requests" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_req_user" ON "hr_accommodation_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_task_org" ON "hr_accommodation_tasks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_acc_task_request" ON "hr_accommodation_tasks" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_hr_emerg_ev_org" ON "hr_emergency_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_emerg_ev_status" ON "hr_emergency_events" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_hr_emerg_resp_event" ON "hr_emergency_responses" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_hr_emerg_resp_user" ON "hr_emergency_responses" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_hr_evstream_org" ON "hr_event_stream" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_evstream_type" ON "hr_event_stream" USING btree ("org_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_hr_evstream_entity" ON "hr_event_stream" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_hr_evstream_occurred" ON "hr_event_stream" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_hr_sim_org" ON "hr_simulations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_hr_sim_type" ON "hr_simulations" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_lead_activities_lead" ON "lead_activities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lead_activities_user" ON "lead_activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_lead_activities_org_date" ON "lead_activities" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "idx_lead_assignment_rules_org" ON "lead_assignment_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_lead_emails_lead" ON "lead_emails" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lead_emails_org_sent" ON "lead_emails" USING btree ("org_id","sent_at");--> statement-breakpoint
CREATE INDEX "idx_lead_batches_org" ON "lead_import_batches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_lead_notes_lead" ON "lead_notes" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lead_notes_org_created" ON "lead_notes" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_lead_scoring_rules_org" ON "lead_scoring_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_lead_tasks_lead" ON "lead_tasks" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_lead_tasks_org_status" ON "lead_tasks" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_leads_org_status_created" ON "leads" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_leads_assigned_to" ON "leads" USING btree ("assigned_to_id");--> statement-breakpoint
CREATE INDEX "idx_leads_org_assigned_status" ON "leads" USING btree ("org_id","assigned_to_id","status");--> statement-breakpoint
CREATE INDEX "idx_leads_source" ON "leads" USING btree ("source");--> statement-breakpoint
CREATE INDEX "idx_leads_score" ON "leads" USING btree ("score");--> statement-breakpoint
CREATE INDEX "idx_leads_deleted" ON "leads" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "web_lead_forms_org_id_idx" ON "web_lead_forms" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_lead_forms_token_idx" ON "web_lead_forms" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "idx_branches_org" ON "branches" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_branch_code_org" ON "branches" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_client_account_activities_account" ON "client_account_activities" USING btree ("client_account_id");--> statement-breakpoint
CREATE INDEX "idx_client_account_activities_user" ON "client_account_activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_client_accounts_org" ON "client_accounts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_client_accounts_sales_rep" ON "client_accounts" USING btree ("sales_rep_id");--> statement-breakpoint
CREATE INDEX "idx_client_accounts_status" ON "client_accounts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_onboarding_items_client" ON "client_onboarding_items" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_onboarding_items_org" ON "client_onboarding_items" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_client_onboarding_templates_org" ON "client_onboarding_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_client_opps_org" ON "client_opportunities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_client_opps_client" ON "client_opportunities" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_clients_org_status" ON "clients" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_clients_account_manager" ON "clients" USING btree ("account_manager_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_org" ON "contacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_organization" ON "contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_contacts_name_email" ON "contacts" USING btree ("org_id","name","email");--> statement-breakpoint
CREATE INDEX "idx_crm_organizations_org" ON "crm_organizations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_crm_organizations_parent" ON "crm_organizations" USING btree ("org_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_csat_responses_survey" ON "csat_responses" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_csat_surveys_org" ON "csat_surveys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_csat_surveys_token" ON "csat_surveys" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "idx_crm_contact_roles_org" ON "crm_contact_roles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_crm_contact_roles_contact" ON "crm_contact_roles" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "idx_crm_contact_roles_entity" ON "crm_contact_roles" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_contact_roles_combo" ON "crm_contact_roles" USING btree ("org_id","contact_id","entity_type","entity_id","role_key");--> statement-breakpoint
CREATE INDEX "idx_commissions_org_user" ON "commissions" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_commissions_deal" ON "commissions" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crm_deal_competitors_deal_key" ON "crm_deal_competitors" USING btree ("org_id","deal_id","competitor_key");--> statement-breakpoint
CREATE INDEX "idx_crm_deal_competitors_deal" ON "crm_deal_competitors" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_crm_deal_competitors_org" ON "crm_deal_competitors" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crm_deal_stakeholders_deal_contact" ON "crm_deal_stakeholders" USING btree ("org_id","deal_id","contact_id");--> statement-breakpoint
CREATE INDEX "idx_crm_deal_stakeholders_deal" ON "crm_deal_stakeholders" USING btree ("org_id","deal_id");--> statement-breakpoint
CREATE INDEX "idx_crm_deal_stakeholders_contact" ON "crm_deal_stakeholders" USING btree ("org_id","contact_id");--> statement-breakpoint
CREATE INDEX "idx_crm_forecast_snapshots_org_period" ON "crm_forecast_snapshots" USING btree ("org_id","period","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sla_breach_log_lead_policy_unique" ON "crm_sla_breach_log" USING btree ("lead_id","policy_id");--> statement-breakpoint
CREATE INDEX "idx_sla_breach_org_idx" ON "crm_sla_breach_log" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_sla_breach_lead_idx" ON "crm_sla_breach_log" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "cfd_org_entity_name_idx" ON "custom_field_definitions" USING btree ("org_id","entity_type","name");--> statement-breakpoint
CREATE INDEX "idx_cfd_org_entity" ON "custom_field_definitions" USING btree ("org_id","entity_type");--> statement-breakpoint
CREATE INDEX "idx_deal_activities_deal" ON "deal_activities" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_deal_activities_org" ON "deal_activities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_deal_approvals_org" ON "deal_approvals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_deal_approvals_deal" ON "deal_approvals" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deal_meeting_attendees_unique" ON "deal_meeting_attendees" USING btree ("meeting_id","attendee_id");--> statement-breakpoint
CREATE INDEX "idx_deal_meetings_deal" ON "deal_meetings" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_deal_meetings_org" ON "deal_meetings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_deals_org_stage_assignee" ON "deals" USING btree ("org_id","stage","assigned_to_id");--> statement-breakpoint
CREATE INDEX "idx_deals_client" ON "deals" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_deals_lead" ON "deals" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "idx_deals_close_date" ON "deals" USING btree ("expected_close_date");--> statement-breakpoint
CREATE INDEX "idx_deals_org_pipeline_stage" ON "deals" USING btree ("org_id","pipeline_id","stage");--> statement-breakpoint
CREATE INDEX "idx_incentives_org" ON "incentives" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_incentives_sales_rep" ON "incentives" USING btree ("sales_rep_id");--> statement-breakpoint
CREATE INDEX "idx_incentives_status" ON "incentives" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sales_quotas_org_user" ON "sales_quotas" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_target_history_target" ON "target_history" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_target_history_org_created" ON "target_history" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_targets_user_period" ON "targets" USING btree ("user_id","period");--> statement-breakpoint
CREATE INDEX "idx_targets_branch" ON "targets" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_targets_parent" ON "targets" USING btree ("parent_target_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_org" ON "tasks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_assignee" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_due_date" ON "tasks" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_tasks_entity" ON "tasks" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "territories_org_id_idx" ON "territories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_items_invoice" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_org_status" ON "invoices" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_invoices_client" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_project" ON "invoices" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_due_date" ON "invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_invoices_collection_owner" ON "invoices" USING btree ("collection_owner_id");--> statement-breakpoint
CREATE INDEX "idx_payments_invoice" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_payments_org_date" ON "payments" USING btree ("org_id","payment_date");--> statement-breakpoint
CREATE INDEX "idx_purchase_bill_items_bill" ON "purchase_bill_items" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "idx_purchase_bills_org_status" ON "purchase_bills" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_purchase_bills_vendor" ON "purchase_bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "idx_purchase_bills_due_date" ON "purchase_bills" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_quotes_org_status" ON "quotes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_quotes_deal" ON "quotes" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_quotes_client" ON "quotes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_quotes_created_by" ON "quotes" USING btree ("created_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_quotes_number" ON "quotes" USING btree ("org_id","quote_number");--> statement-breakpoint
CREATE INDEX "idx_quotes_pricebook" ON "quotes" USING btree ("pricebook_id");--> statement-breakpoint
CREATE INDEX "idx_quotes_converted_invoice" ON "quotes" USING btree ("converted_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_messages_ticket" ON "support_ticket_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_messages_author" ON "support_ticket_messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_messages_source_message" ON "support_ticket_messages" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_org_status" ON "support_tickets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_assignee" ON "support_tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_client" ON "support_tickets" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_priority" ON "support_tickets" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_sla" ON "support_tickets" USING btree ("sla_deadline");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_queue" ON "support_tickets" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_source_message" ON "support_tickets" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "idx_support_tickets_snoozed_until" ON "support_tickets" USING btree ("snoozed_until");--> statement-breakpoint
CREATE INDEX "idx_vendor_payments_bill" ON "vendor_payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_payments_org_date" ON "vendor_payments" USING btree ("org_id","payment_date");--> statement-breakpoint
CREATE INDEX "idx_crm_email_templates_org" ON "crm_email_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_crm_sla_org" ON "crm_sla_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_crm_views_org" ON "crm_views" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_client_health_scores_account" ON "client_health_scores" USING btree ("org_id","client_account_id");--> statement-breakpoint
CREATE INDEX "idx_client_health_scores_computed" ON "client_health_scores" USING btree ("org_id","computed_at");--> statement-breakpoint
CREATE INDEX "idx_health_score_config_org" ON "health_score_config" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_nps_responses_survey" ON "nps_responses" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_nps_surveys_org_status" ON "nps_surveys" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_playbook_entries_org" ON "playbook_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_crm_automation_rules_org" ON "crm_automation_rules" USING btree ("org_id","is_active","created_at");--> statement-breakpoint
CREATE INDEX "idx_crm_automation_rules_deleted" ON "crm_automation_rules" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_crm_products_org" ON "crm_products" USING btree ("org_id","is_active","created_at");--> statement-breakpoint
CREATE INDEX "idx_crm_products_deleted" ON "crm_products" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_pb_entry" ON "crm_pricebook_entries" USING btree ("org_id","pricebook_id","product_id","min_quantity");--> statement-breakpoint
CREATE INDEX "idx_crm_pb_entries_pricebook" ON "crm_pricebook_entries" USING btree ("pricebook_id");--> statement-breakpoint
CREATE INDEX "idx_crm_pb_entries_product" ON "crm_pricebook_entries" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_pricebooks_org_name" ON "crm_pricebooks" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_crm_pricebooks_org" ON "crm_pricebooks" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_quote_settings_org" ON "crm_quote_settings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_quote_templates_org_name" ON "crm_quote_templates" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_crm_quote_templates_org" ON "crm_quote_templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_automation_actions_org_key" ON "crm_automation_actions" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_automation_events_org_key" ON "crm_automation_events" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "idx_crm_blueprint_transitions_org_blueprint" ON "crm_blueprint_transitions" USING btree ("org_id","blueprint_id");--> statement-breakpoint
CREATE INDEX "idx_crm_blueprints_org_pipeline" ON "crm_blueprints" USING btree ("org_id","pipeline_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_options_org_type_key" ON "crm_options" USING btree ("org_id","type","key");--> statement-breakpoint
CREATE INDEX "idx_crm_options_org_type_active" ON "crm_options" USING btree ("org_id","type","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_pipeline_stages_org_pipeline_key" ON "crm_pipeline_stages" USING btree ("org_id","pipeline_id","key");--> statement-breakpoint
CREATE INDEX "idx_crm_pipeline_stages_org_pipeline_sort" ON "crm_pipeline_stages" USING btree ("org_id","pipeline_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_pipelines_org_key" ON "crm_pipelines" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_ui_metadata_org_scope" ON "crm_ui_metadata" USING btree ("org_id","scope");--> statement-breakpoint
CREATE INDEX "idx_crm_validation_rules_org_entity_active" ON "crm_validation_rules" USING btree ("org_id","entity_type","is_active");--> statement-breakpoint
CREATE INDEX "idx_crm_automation_runs_org_rule" ON "crm_automation_runs" USING btree ("org_id","rule_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_seq_enrollment" ON "crm_sequence_enrollments" USING btree ("org_id","sequence_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_crm_seq_enrollment_due" ON "crm_sequence_enrollments" USING btree ("org_id","status","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_crm_sequence_steps_seq_sort" ON "crm_sequence_steps" USING btree ("sequence_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_crm_sequences_org_name" ON "crm_sequences" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_crm_lead_touchpoints_org_lead_occurred" ON "crm_lead_touchpoints" USING btree ("org_id","lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_crm_lead_touchpoints_org_occurred" ON "crm_lead_touchpoints" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_chat_attachments_msg" ON "chat_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chat_invite_link_token" ON "chat_channel_invite_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_chat_invite_links_channel" ON "chat_channel_invite_links" USING btree ("channel_id","revoked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_channel_member" ON "chat_channel_members" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_members_user" ON "chat_channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_members_channel" ON "chat_channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_chat_channels_org" ON "chat_channels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_chat_channels_last_msg" ON "chat_channels" USING btree ("org_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_huddle_participant" ON "chat_huddle_participants" USING btree ("huddle_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_huddle_participants_huddle" ON "chat_huddle_participants" USING btree ("huddle_id");--> statement-breakpoint
CREATE INDEX "idx_chat_huddles_channel" ON "chat_huddles" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_channel" ON "chat_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_sender" ON "chat_messages" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_unread" ON "chat_messages" USING btree ("channel_id","is_deleted","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chat_org_settings_org" ON "chat_org_settings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chat_pinned_msg" ON "chat_pinned_messages" USING btree ("channel_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_chat_pinned_channel" ON "chat_pinned_messages" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chat_reply_reminder" ON "chat_reply_reminders" USING btree ("message_id","recipient_user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_reply_reminders_due" ON "chat_reply_reminders" USING btree ("remind_at");--> statement-breakpoint
CREATE INDEX "idx_chat_reply_reminders_recipient" ON "chat_reply_reminders" USING btree ("recipient_user_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_saved_message" ON "chat_saved_messages" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_saved_messages_user" ON "chat_saved_messages" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_chat_presence_user" ON "chat_user_presence" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_presence_org" ON "chat_user_presence" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_chat_presence_lastseen" ON "chat_user_presence" USING btree ("org_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_org_feature" ON "ai_usage_logs" USING btree ("org_id","feature");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_org_created" ON "ai_usage_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_usage_user" ON "ai_usage_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_org_id" ON "audit_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_org_created" ON "audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_org_action" ON "audit_logs" USING btree ("org_id","action");--> statement-breakpoint
CREATE INDEX "idx_audit_logs_resource" ON "audit_logs" USING btree ("org_id","resource_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_org_status" ON "broadcasts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_scheduled" ON "broadcasts" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "idx_broadcasts_created_by" ON "broadcasts" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_org_date" ON "calendar_events" USING btree ("org_id","start_date");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_category" ON "calendar_events" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_created_by" ON "calendar_events" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_external" ON "calendar_events" USING btree ("integration_connection_id","external_event_id");--> statement-breakpoint
CREATE INDEX "idx_coupon_redemptions_coupon" ON "coupon_redemptions" USING btree ("coupon_id");--> statement-breakpoint
CREATE INDEX "idx_coupon_redemptions_org" ON "coupon_redemptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_coupons_code" ON "coupons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_coupons_is_active" ON "coupons" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_coupons_org" ON "coupons" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendees_event_id" ON "event_attendees" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendees_user_id" ON "event_attendees" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_notif_audit_org_action" ON "notification_audit_logs" USING btree ("org_id","action");--> statement-breakpoint
CREATE INDEX "idx_notif_audit_org_created" ON "notification_audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notif_audit_notification" ON "notification_audit_logs" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "idx_notification_templates_org" ON "notification_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_notification_templates_channel" ON "notification_templates" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_notification_templates_active" ON "notification_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread_created" ON "notifications" USING btree ("user_id","is_read","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_org_created" ON "notifications" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_archived" ON "notifications" USING btree ("user_id","archived_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_org_category" ON "notifications" USING btree ("org_id","category");--> statement-breakpoint
CREATE INDEX "idx_notifications_priority" ON "notifications" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_notifications_dedupe" ON "notifications" USING btree ("org_id","event_key","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_push_subs_user" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sub_payments_org" ON "subscription_payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_sub_payments_sub" ON "subscription_payments" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_org" ON "subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_status" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_razorpay" ON "subscriptions" USING btree ("razorpay_subscription_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_endpoints_org" ON "webhook_endpoints" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_logs_endpoint" ON "webhook_logs" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_logs_org_event" ON "webhook_logs" USING btree ("org_id","event");--> statement-breakpoint
CREATE INDEX "idx_blog_authors_name" ON "blog_authors" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_blog_categories_slug" ON "blog_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_blog_posts_status" ON "blog_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_blog_posts_category" ON "blog_posts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_blog_posts_author" ON "blog_posts" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_blog_posts_status_published" ON "blog_posts" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_platform_messages_status" ON "platform_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_platform_messages_topic" ON "platform_messages" USING btree ("topic");--> statement-breakpoint
CREATE INDEX "idx_platform_messages_created" ON "platform_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_platform_messages_email" ON "platform_messages" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_platform_payments_razorpay_payment" ON "platform_payments" USING btree ("razorpay_payment_id");--> statement-breakpoint
CREATE INDEX "idx_platform_payments_status" ON "platform_payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_platform_payments_org" ON "platform_payments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_platform_payments_created" ON "platform_payments" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_platform_subscriptions_org" ON "platform_subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_platform_subscriptions_status" ON "platform_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_platform_visits_session" ON "platform_visits" USING btree ("session_token");--> statement-breakpoint
CREATE INDEX "idx_platform_visits_path" ON "platform_visits" USING btree ("path");--> statement-breakpoint
CREATE INDEX "idx_platform_visits_created" ON "platform_visits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_je_org_date" ON "journal_entries" USING btree ("org_id","entry_date");--> statement-breakpoint
CREATE INDEX "idx_je_org_source" ON "journal_entries" USING btree ("org_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "idx_je_org_status" ON "journal_entries" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_jl_entry" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "idx_jl_account" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_jl_org_account" ON "journal_lines" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_accounts_org_type_active" ON "ledger_accounts" USING btree ("org_id","account_type","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_number_sequences_org_entity" ON "acc_number_sequences" USING btree ("org_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_system_account_map_org_purpose" ON "acc_system_account_map" USING btree ("org_id","purpose");--> statement-breakpoint
CREATE INDEX "idx_acc_system_account_map_org" ON "acc_system_account_map" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_dim_values_org_dim_code" ON "accounting_dimension_values" USING btree ("org_id","dimension_id","code");--> statement-breakpoint
CREATE INDEX "idx_accounting_dim_values_org_dim" ON "accounting_dimension_values" USING btree ("org_id","dimension_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_dimensions_org_key" ON "accounting_dimensions" USING btree ("org_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_periods_org_start" ON "accounting_periods" USING btree ("org_id","start_date");--> statement-breakpoint
CREATE INDEX "idx_accounting_periods_org_status" ON "accounting_periods" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_accounting_settings_org" ON "accounting_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_fin_approval_policies_org_type" ON "fin_approval_policies" USING btree ("org_id","record_type");--> statement-breakpoint
CREATE INDEX "idx_fin_approval_requests_org_status" ON "fin_approval_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_fin_approval_requests_org_type_record" ON "fin_approval_requests" USING btree ("org_id","record_type","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_exchange_rates_org_pair_date" ON "fin_exchange_rates" USING btree ("org_id","from_currency","to_currency","as_of_date");--> statement-breakpoint
CREATE INDEX "idx_fin_exchange_rates_org_date" ON "fin_exchange_rates" USING btree ("org_id","as_of_date");--> statement-breakpoint
CREATE INDEX "idx_fin_recurring_journal_templates_org" ON "fin_recurring_journal_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_credit_note_items_cn" ON "credit_note_items" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_credit_notes_org_number" ON "credit_notes" USING btree ("org_id","credit_note_number");--> statement-breakpoint
CREATE INDEX "idx_credit_notes_org_status" ON "credit_notes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_credit_notes_client" ON "credit_notes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_credit_notes_invoice" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_fin_collection_activities_org_client" ON "fin_collection_activities" USING btree ("org_id","client_id");--> statement-breakpoint
CREATE INDEX "idx_fin_collection_activities_invoice" ON "fin_collection_activities" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_payment_allocations_pay_inv" ON "fin_payment_allocations" USING btree ("payment_id","invoice_id");--> statement-breakpoint
CREATE INDEX "idx_fin_payment_allocations_org" ON "fin_payment_allocations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_fin_payment_allocations_invoice" ON "fin_payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_fin_payment_run_items_run" ON "fin_payment_run_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_fin_payment_run_items_bill" ON "fin_payment_run_items" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "idx_fin_payment_runs_org_status" ON "fin_payment_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_fin_recurring_bill_templates_org" ON "fin_recurring_bill_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_fin_recurring_invoice_templates_org" ON "fin_recurring_invoice_templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_reminder_log_org_inv_offset" ON "fin_reminder_log" USING btree ("org_id","invoice_id","offset_days");--> statement-breakpoint
CREATE INDEX "idx_fin_reminder_log_org_invoice" ON "fin_reminder_log" USING btree ("org_id","invoice_id");--> statement-breakpoint
CREATE INDEX "idx_fin_reminder_policies_org" ON "fin_reminder_policies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_vendor_pay_alloc_pay_bill" ON "fin_vendor_payment_allocations" USING btree ("vendor_payment_id","bill_id");--> statement-breakpoint
CREATE INDEX "idx_fin_vendor_payment_allocations_org" ON "fin_vendor_payment_allocations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_fin_vendor_payment_allocations_bill" ON "fin_vendor_payment_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "idx_vendor_credit_items_vc" ON "vendor_credit_items" USING btree ("vendor_credit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_vendor_credits_org_number" ON "vendor_credits" USING btree ("org_id","vendor_credit_number");--> statement-breakpoint
CREATE INDEX "idx_vendor_credits_org_status" ON "vendor_credits" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_vendor_credits_vendor" ON "vendor_credits" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_bank_accounts_org_name" ON "fin_bank_accounts" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_accounts_org_active" ON "fin_bank_accounts" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_imports_org_account" ON "fin_bank_imports" USING btree ("org_id","bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_bank_txn_org_account_fp" ON "fin_bank_transactions" USING btree ("org_id","bank_account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_txn_org_account_status" ON "fin_bank_transactions" USING btree ("org_id","bank_account_id","status");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_txn_org_date" ON "fin_bank_transactions" USING btree ("org_id","txn_date");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_transfers_org_date" ON "fin_bank_transfers" USING btree ("org_id","transfer_date");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_transfers_from" ON "fin_bank_transfers" USING btree ("from_bank_account_id");--> statement-breakpoint
CREATE INDEX "idx_fin_bank_transfers_to" ON "fin_bank_transfers" USING btree ("to_bank_account_id");--> statement-breakpoint
CREATE INDEX "idx_fin_recon_matches_org_txn" ON "fin_reconciliation_matches" USING btree ("org_id","bank_transaction_id");--> statement-breakpoint
CREATE INDEX "idx_fin_recon_matches_org_je" ON "fin_reconciliation_matches" USING btree ("org_id","journal_entry_id");--> statement-breakpoint
CREATE INDEX "idx_fin_reconciliation_rules_org_priority" ON "fin_reconciliation_rules" USING btree ("org_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_tax_codes_org_code" ON "acc_tax_codes" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_acc_tax_codes_org_type" ON "acc_tax_codes" USING btree ("org_id","tax_type");--> statement-breakpoint
CREATE INDEX "idx_acc_tax_payments_org_type" ON "acc_tax_payments" USING btree ("org_id","tax_type");--> statement-breakpoint
CREATE INDEX "idx_acc_tax_payments_org_period" ON "acc_tax_payments" USING btree ("org_id","period_start","period_end");--> statement-breakpoint
CREATE INDEX "uniq_acc_tax_payments_org_type_ref" ON "acc_tax_payments" USING btree ("org_id","tax_type","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_budget_lines_budget_acct_period" ON "fin_budget_lines" USING btree ("budget_id","account_id","period_key","department_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_fin_budget_lines_org_budget" ON "fin_budget_lines" USING btree ("org_id","budget_id");--> statement-breakpoint
CREATE INDEX "idx_fin_budget_revisions_budget" ON "fin_budget_revisions" USING btree ("budget_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_fin_budgets_org_name_year" ON "fin_budgets" USING btree ("org_id","name","fiscal_year");--> statement-breakpoint
CREATE INDEX "idx_fin_budgets_org_status" ON "fin_budgets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_fin_cash_flow_scenarios_org" ON "fin_cash_flow_scenarios" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_asset_categories_org_name" ON "acc_asset_categories" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_acc_asset_categories_org" ON "acc_asset_categories" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_depreciation_runs_org_period" ON "acc_depreciation_runs" USING btree ("org_id","period_key");--> statement-breakpoint
CREATE INDEX "idx_acc_depreciation_runs_org_status" ON "acc_depreciation_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_depreciation_schedules_asset_period" ON "acc_depreciation_schedules" USING btree ("asset_id","period_key");--> statement-breakpoint
CREATE INDEX "idx_acc_depreciation_schedules_org_asset" ON "acc_depreciation_schedules" USING btree ("org_id","asset_id");--> statement-breakpoint
CREATE INDEX "idx_acc_depreciation_schedules_run" ON "acc_depreciation_schedules" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_acc_fixed_assets_org_number" ON "acc_fixed_assets" USING btree ("org_id","asset_number");--> statement-breakpoint
CREATE INDEX "idx_acc_fixed_assets_org_status" ON "acc_fixed_assets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_acc_fixed_assets_org_category" ON "acc_fixed_assets" USING btree ("org_id","category_id");--> statement-breakpoint
CREATE INDEX "idx_fin_expense_policies_org" ON "fin_expense_policies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_fin_reimbursement_batches_org_status" ON "fin_reimbursement_batches" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_kb_article_feedback_article" ON "kb_article_feedback" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_article_feedback_org_article_visitor" ON "kb_article_feedback" USING btree ("org_id","article_id","visitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_articles_org_slug" ON "kb_articles" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_org_status" ON "kb_articles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_org_category" ON "kb_articles" USING btree ("org_id","category_id");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_space" ON "kb_articles" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_org_updated" ON "kb_articles" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kb_articles_org_status_views" ON "kb_articles" USING btree ("org_id","status","views");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_categories_org_space_slug" ON "kb_categories" USING btree ("org_id","space_id","slug");--> statement-breakpoint
CREATE INDEX "idx_kb_categories_space" ON "kb_categories" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "idx_kb_categories_parent" ON "kb_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_kb_article_attachments_article" ON "kb_article_attachments" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_article" ON "kb_article_chunks" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_org_article" ON "kb_article_chunks" USING btree ("org_id","article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_org_page" ON "kb_article_chunks" USING btree ("org_id","page_id");--> statement-breakpoint
CREATE INDEX "idx_kb_chunks_org_source" ON "kb_article_chunks" USING btree ("org_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_support_macros_org" ON "support_macros" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_support_routing_rules_org_enabled" ON "support_routing_rules" USING btree ("org_id","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_kb_article_comments_article" ON "kb_article_comments" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_comments_org_article" ON "kb_article_comments" USING btree ("org_id","article_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_activity_ticket" ON "support_ticket_activity" USING btree ("support_ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_queues_org_sort" ON "support_queues" USING btree ("org_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_support_saved_views_org_owner" ON "support_saved_views" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_tags_org_name" ON "support_tags" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ticket_links_ticket_linked" ON "support_ticket_links" USING btree ("ticket_id","linked_ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_links_org_ticket" ON "support_ticket_links" USING btree ("org_id","ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_tags_tag" ON "support_ticket_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ticket_watchers_ticket_user" ON "support_ticket_watchers" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_watchers_org_ticket" ON "support_ticket_watchers" USING btree ("org_id","ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_business_hours_org" ON "support_business_hours" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_support_sla_policies_org_enabled" ON "support_sla_policies" USING btree ("org_id","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_support_channels_org_type" ON "support_channels" USING btree ("org_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_channels_org_type_name" ON "support_channels" USING btree ("org_id","type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_csat_requests_token" ON "support_csat_requests" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_csat_requests_ticket" ON "support_csat_requests" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_csat_requests_org" ON "support_csat_requests" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ai_settings_org" ON "support_ai_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_support_ai_suggestions_ticket" ON "support_ai_suggestions" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_ai_suggestions_org_type" ON "support_ai_suggestions" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_support_ai_suggestions_status" ON "support_ai_suggestions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_support_ticket_embeddings_ticket" ON "support_ticket_embeddings" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_embeddings_org" ON "support_ticket_embeddings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_custom_fields_org_key" ON "support_custom_fields" USING btree ("org_id","key");--> statement-breakpoint
CREATE INDEX "idx_support_custom_fields_org_active" ON "support_custom_fields" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ticket_custom_field_values_ticket_field" ON "support_ticket_custom_field_values" USING btree ("ticket_id","field_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_custom_field_values_org_ticket" ON "support_ticket_custom_field_values" USING btree ("org_id","ticket_id");--> statement-breakpoint
CREATE INDEX "idx_support_settings_audit_log_org_created" ON "support_settings_audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_support_settings_audit_log_org_entity" ON "support_settings_audit_log" USING btree ("org_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_agent_availability_user" ON "support_agent_availability" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_agent_skills_user_skill" ON "support_agent_skills" USING btree ("user_id","skill");--> statement-breakpoint
CREATE INDEX "idx_support_agent_skills_org" ON "support_agent_skills" USING btree ("org_id","skill");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_vip_clients_org_client" ON "support_vip_clients" USING btree ("org_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_message_mentions_message_user" ON "support_message_mentions" USING btree ("message_id","mentioned_user_id");--> statement-breakpoint
CREATE INDEX "idx_support_message_mentions_message" ON "support_message_mentions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ticket_drafts_ticket_user" ON "support_ticket_drafts" USING btree ("ticket_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_ticket_external_links_ticket_entity" ON "support_ticket_external_links" USING btree ("ticket_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_support_ticket_external_links_org_ticket" ON "support_ticket_external_links" USING btree ("org_id","ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_support_knowledge_gaps_org_cluster" ON "support_knowledge_gaps" USING btree ("org_id","cluster_key");--> statement-breakpoint
CREATE INDEX "idx_support_knowledge_gaps_org_status_created" ON "support_knowledge_gaps" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_support_knowledge_gaps_org" ON "support_knowledge_gaps" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_kb_space_members_space" ON "kb_space_members" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "idx_kb_space_members_user" ON "kb_space_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_kb_space_members_org_role" ON "kb_space_members" USING btree ("org_id","role");--> statement-breakpoint
CREATE INDEX "idx_kb_spaces_org" ON "kb_spaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_spaces_org_slug" ON "kb_spaces" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "idx_kb_article_restrictions_article" ON "kb_article_restrictions" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_kb_article_restrictions_user" ON "kb_article_restrictions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_article_versions" ON "kb_article_versions" USING btree ("article_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_article_translations" ON "kb_article_translations" USING btree ("article_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_tags_org_slug" ON "kb_tags" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "idx_kb_events_org_time" ON "kb_events" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_kb_events_org_type" ON "kb_events" USING btree ("org_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_kb_events_org_type_time" ON "kb_events" USING btree ("org_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_tenant_ai_credit_txns_org_time" ON "tenant_ai_credit_transactions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_favorites_page_user" ON "kb_page_favorites" USING btree ("page_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_kb_page_favorites_org_user" ON "kb_page_favorites" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_links_source_target" ON "kb_page_links" USING btree ("source_page_id","target_page_id");--> statement-breakpoint
CREATE INDEX "idx_kb_page_links_org_target" ON "kb_page_links" USING btree ("org_id","target_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_visits_page_user" ON "kb_page_visits" USING btree ("page_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_kb_page_visits_org_user_visited" ON "kb_page_visits" USING btree ("org_id","user_id","visited_at");--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_parent_sort" ON "kb_pages" USING btree ("org_id","parent_page_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_deleted" ON "kb_pages" USING btree ("org_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_updated" ON "kb_pages" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kb_pages_parent" ON "kb_pages" USING btree ("parent_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_pages_public_token" ON "kb_pages" USING btree ("public_token");--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_status" ON "kb_pages" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_kb_pages_org_next_review" ON "kb_pages" USING btree ("org_id","next_review_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_pages_org_public_slug" ON "kb_pages" USING btree ("org_id","public_slug") WHERE "kb_pages"."public_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_pages_org_source_article" ON "kb_pages" USING btree ("org_id","source_article_id") WHERE "kb_pages"."source_article_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_kb_page_comments_org_page" ON "kb_page_comments" USING btree ("org_id","page_id");--> statement-breakpoint
CREATE INDEX "idx_kb_page_templates_org" ON "kb_page_templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_page_versions_page_version" ON "kb_page_versions" USING btree ("page_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_kb_export_jobs_org_created" ON "kb_export_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_kb_import_jobs_org_created" ON "kb_import_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_kb_page_reviews_org_status_due" ON "kb_page_reviews" USING btree ("org_id","status","due_at");--> statement-breakpoint
CREATE INDEX "idx_kb_page_reviews_org_page" ON "kb_page_reviews" USING btree ("org_id","page_id");--> statement-breakpoint
CREATE INDEX "idx_kb_sources_org" ON "kb_sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_kb_sources_org_space" ON "kb_sources" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX "idx_kb_chat_conversations_org_user_updated" ON "kb_chat_conversations" USING btree ("org_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_kb_chat_messages_org_user_id" ON "kb_chat_messages" USING btree ("org_id","user_id","id");--> statement-breakpoint
CREATE INDEX "idx_kb_chat_messages_conversation_id" ON "kb_chat_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kb_settings_org" ON "kb_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_kb_research_briefs_org" ON "kb_research_briefs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_kb_research_briefs_org_user" ON "kb_research_briefs" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_kb_research_briefs_job" ON "kb_research_briefs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_automation_rules_org_trigger_enabled" ON "automation_rules" USING btree ("org_id","trigger_event","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_rule" ON "automation_runs" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "idx_inv_categories_org" ON "inv_categories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_categories_parent" ON "inv_categories" USING btree ("parent_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_variants_org_sku" ON "inv_product_variants" USING btree ("org_id","sku");--> statement-breakpoint
CREATE INDEX "idx_inv_variants_product" ON "inv_product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "idx_inv_variants_barcode" ON "inv_product_variants" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "idx_inv_variants_sku_trgm" ON "inv_product_variants" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_products_org_sku" ON "inv_products" USING btree ("org_id","sku");--> statement-breakpoint
CREATE INDEX "idx_inv_products_org_status" ON "inv_products" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_products_category" ON "inv_products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_inv_products_barcode" ON "inv_products" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "idx_inv_products_name_trgm" ON "inv_products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_inv_products_sku_trgm" ON "inv_products" USING btree ("sku");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_uom_org_name" ON "inv_uom" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "idx_inv_uom_org" ON "inv_uom" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_locations_warehouse_code" ON "inv_locations" USING btree ("warehouse_id","code");--> statement-breakpoint
CREATE INDEX "idx_inv_locations_org" ON "inv_locations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_locations_warehouse" ON "inv_locations" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "idx_inv_locations_parent" ON "inv_locations" USING btree ("parent_location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_warehouses_org_code" ON "inv_warehouses" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_inv_warehouses_org" ON "inv_warehouses" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_warehouses_branch" ON "inv_warehouses" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_inv_adj_lines_adj" ON "inv_stock_adjustment_lines" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "idx_inv_adj_org_ref" ON "inv_stock_adjustments" USING btree ("org_id","reference_number");--> statement-breakpoint
CREATE INDEX "idx_inv_adj_org" ON "inv_stock_adjustments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_stock_org" ON "inv_stock_levels" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_stock_variant" ON "inv_stock_levels" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_stock_location" ON "inv_stock_levels" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "idx_inv_stock_lot" ON "inv_stock_levels" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "idx_inv_stock_serial" ON "inv_stock_levels" USING btree ("serial_id");--> statement-breakpoint
CREATE INDEX "idx_inv_stock_levels_org_variant_loc" ON "inv_stock_levels" USING btree ("org_id","product_variant_id","location_id");--> statement-breakpoint
CREATE INDEX "idx_inv_txn_org_variant" ON "inv_stock_transactions" USING btree ("org_id","product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_txn_org_type" ON "inv_stock_transactions" USING btree ("org_id","transaction_type");--> statement-breakpoint
CREATE INDEX "idx_inv_txn_reference" ON "inv_stock_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "idx_inv_txn_idempotency" ON "inv_stock_transactions" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_inv_txn_created" ON "inv_stock_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_inv_txn_org_created" ON "inv_stock_transactions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_lines_transfer" ON "inv_stock_transfer_lines" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "idx_inv_transfer_org_ref" ON "inv_stock_transfers" USING btree ("org_id","reference_number");--> statement-breakpoint
CREATE INDEX "idx_inv_transfers_org_status" ON "inv_stock_transfers" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_grn_lines_grn" ON "inv_grn_lines" USING btree ("grn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_grn_org_number" ON "inv_grns" USING btree ("org_id","grn_number");--> statement-breakpoint
CREATE INDEX "idx_inv_grn_po" ON "inv_grns" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "idx_inv_po_lines_po" ON "inv_po_lines" USING btree ("po_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_po_org_number" ON "inv_purchase_orders" USING btree ("org_id","po_number");--> statement-breakpoint
CREATE INDEX "idx_inv_po_org_status" ON "inv_purchase_orders" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_po_vendor" ON "inv_purchase_orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "idx_inv_po_expected_delivery" ON "inv_purchase_orders" USING btree ("expected_delivery_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_vendors_org_code" ON "inv_vendors" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_inv_vendors_org" ON "inv_vendors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_vendors_name_trgm" ON "inv_vendors" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_so_org_number" ON "inv_sales_orders" USING btree ("org_id","so_number");--> statement-breakpoint
CREATE INDEX "idx_inv_so_org_status" ON "inv_sales_orders" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_so_client" ON "inv_sales_orders" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_inv_so_warehouse" ON "inv_sales_orders" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "idx_inv_so_lines_so" ON "inv_so_lines" USING btree ("so_id");--> statement-breakpoint
CREATE INDEX "idx_inv_res_org_source" ON "inv_stock_reservations" USING btree ("org_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "idx_inv_res_org_variant_status" ON "inv_stock_reservations" USING btree ("org_id","product_variant_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_res_org_status" ON "inv_stock_reservations" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_lots_org_variant_number" ON "inv_lots" USING btree ("org_id","product_variant_id","lot_number");--> statement-breakpoint
CREATE INDEX "idx_inv_lots_org" ON "inv_lots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_lots_variant" ON "inv_lots" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_lots_expiry" ON "inv_lots" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "idx_inv_lots_status" ON "inv_lots" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_lots_lot_number_trgm" ON "inv_lots" USING btree ("lot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_serials_org_variant_number" ON "inv_serial_numbers" USING btree ("org_id","product_variant_id","serial_number");--> statement-breakpoint
CREATE INDEX "idx_inv_serials_org" ON "inv_serial_numbers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_serials_variant" ON "inv_serial_numbers" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_serials_status" ON "inv_serial_numbers" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_serials_location" ON "inv_serial_numbers" USING btree ("current_location_id");--> statement-breakpoint
CREATE INDEX "idx_inv_serials_serial_number_trgm" ON "inv_serial_numbers" USING btree ("serial_number");--> statement-breakpoint
CREATE INDEX "idx_inv_cret_lines_return" ON "inv_customer_return_lines" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_cret_org_number" ON "inv_customer_returns" USING btree ("org_id","return_number");--> statement-breakpoint
CREATE INDEX "idx_inv_cret_org_status" ON "inv_customer_returns" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_cc_lines_count" ON "inv_cycle_count_lines" USING btree ("cycle_count_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_cc_org_number" ON "inv_cycle_counts" USING btree ("org_id","count_number");--> statement-breakpoint
CREATE INDEX "idx_inv_cc_org_status" ON "inv_cycle_counts" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_pa_lines_audit" ON "inv_physical_audit_lines" USING btree ("audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_pa_org_number" ON "inv_physical_audits" USING btree ("org_id","audit_number");--> statement-breakpoint
CREATE INDEX "idx_inv_pa_org_status" ON "inv_physical_audits" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_pick_lines_pick" ON "inv_pick_list_lines" USING btree ("pick_list_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_pick_org_number" ON "inv_pick_lists" USING btree ("org_id","pick_number");--> statement-breakpoint
CREATE INDEX "idx_inv_pick_org_status" ON "inv_pick_lists" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_vret_lines_return" ON "inv_vendor_return_lines" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_vret_org_number" ON "inv_vendor_returns" USING btree ("org_id","return_number");--> statement-breakpoint
CREATE INDEX "idx_inv_vret_org_status" ON "inv_vendor_returns" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_val_layers_org_variant" ON "inv_valuation_layers" USING btree ("org_id","product_variant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inv_val_layers_remaining" ON "inv_valuation_layers" USING btree ("org_id","product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_qh_org_status" ON "inv_quality_holds" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_qh_variant" ON "inv_quality_holds" USING btree ("org_id","product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_qi_lines_insp" ON "inv_quality_inspection_lines" USING btree ("inspection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_qi_org_number" ON "inv_quality_inspections" USING btree ("org_id","inspection_number");--> statement-breakpoint
CREATE INDEX "idx_inv_qi_org_status" ON "inv_quality_inspections" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_qi_source" ON "inv_quality_inspections" USING btree ("org_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_recall_org_number" ON "inv_recall_events" USING btree ("org_id","recall_number");--> statement-breakpoint
CREATE INDEX "idx_inv_recall_org_status" ON "inv_recall_events" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_recall_lines_recall" ON "inv_recall_lines" USING btree ("recall_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_carriers_org_code" ON "inv_carriers" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_inv_carriers_org" ON "inv_carriers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_load_lines_load" ON "inv_load_lines" USING btree ("load_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_loads_org_number" ON "inv_loads" USING btree ("org_id","load_number");--> statement-breakpoint
CREATE INDEX "idx_inv_loads_org_status" ON "inv_loads" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_pkg_lines_pkg" ON "inv_package_lines" USING btree ("package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_packages_org_number" ON "inv_packages" USING btree ("org_id","package_number");--> statement-breakpoint
CREATE INDEX "idx_inv_packages_org_status" ON "inv_packages" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_ship_lines_ship" ON "inv_shipment_lines" USING btree ("shipment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_shipments_org_number" ON "inv_shipments" USING btree ("org_id","shipment_number");--> statement-breakpoint
CREATE INDEX "idx_inv_shipments_org_status" ON "inv_shipments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_3pl_org_status" ON "inv_3pl_connections" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_pub_org_channel_variant" ON "inv_channel_stock_publications" USING btree ("org_id","channel_id","product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_pub_org_channel" ON "inv_channel_stock_publications" USING btree ("org_id","channel_id");--> statement-breakpoint
CREATE INDEX "idx_inv_pub_status" ON "inv_channel_stock_publications" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_channels_org_status" ON "inv_channels" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_ai_insights_org_status" ON "inv_ai_insights" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_reorder_org_variant_wh" ON "inv_reorder_rules" USING btree ("org_id","product_variant_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "idx_inv_reorder_org" ON "inv_reorder_rules" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_reorder_variant" ON "inv_reorder_rules" USING btree ("product_variant_id");--> statement-breakpoint
CREATE INDEX "idx_inv_audit_org_type_created" ON "inv_audit_events" USING btree ("org_id","resource_type","created_at");--> statement-breakpoint
CREATE INDEX "idx_inv_audit_org_created" ON "inv_audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_inv_export_org_status" ON "inv_export_jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_idempotency_org_key" ON "inv_idempotency_keys" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_inv_idempotency_expires" ON "inv_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_inv_import_org_status" ON "inv_import_jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_inv_numseq_org_doctype" ON "inv_number_sequences" USING btree ("org_id","doc_type");--> statement-breakpoint
CREATE INDEX "idx_inv_settings_org" ON "inv_settings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_inv_whe_org_status" ON "inv_webhook_events" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_inv_webhooks_org" ON "inv_webhooks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_branches_org" ON "org_branches" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_branches_bu" ON "org_branches" USING btree ("business_unit_id");--> statement-breakpoint
CREATE INDEX "idx_org_bus_org" ON "org_business_units" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_cc_org" ON "org_cost_centers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_depts_org" ON "org_departments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_depts_branch" ON "org_departments" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_org_locations_org" ON "org_locations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_teams_org" ON "org_teams" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_teams_dept" ON "org_teams" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_user_memberships_user_org" ON "user_memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_user_memberships_org" ON "user_memberships" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_user_memberships_manager" ON "user_memberships" USING btree ("manager_user_id");--> statement-breakpoint
CREATE INDEX "idx_user_memberships_dept" ON "user_memberships" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "idx_user_memberships_branch" ON "user_memberships" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_user_memberships_team" ON "user_memberships" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_user_memberships_bu" ON "user_memberships" USING btree ("business_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_feature_flags_key" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_feature_flags_is_archived" ON "feature_flags" USING btree ("is_archived");--> statement-breakpoint
CREATE INDEX "idx_feature_flags_created_at" ON "feature_flags" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_affiliate_idx" ON "affiliate_commissions" USING btree ("affiliate_id");--> statement-breakpoint
CREATE INDEX "affiliate_commissions_status_idx" ON "affiliate_commissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "affiliates_code_idx" ON "affiliates" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "affiliates_user_idx" ON "affiliates" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_ai_credit_packs_name" ON "ai_credit_packs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ai_credit_res_org_created_idx" ON "ai_credit_reservations" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_credit_res_status_expires_idx" ON "ai_credit_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_credit_res_org_idem_key" ON "ai_credit_reservations" USING btree ("org_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_credit_txns_org_idx" ON "ai_credit_transactions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ai_credit_txns_org_created_idx" ON "ai_credit_transactions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_credit_txns_plan_grant_ref" ON "ai_credit_transactions" USING btree ("org_id","reference_id") WHERE type = 'PLAN_GRANT' AND reference_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "app_installations_org_app_idx" ON "app_installations" USING btree ("org_id","app_id");--> statement-breakpoint
CREATE INDEX "app_installations_org_idx" ON "app_installations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "billing_profiles_org_idx" ON "billing_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_ent_quotes_org_status" ON "enterprise_quotes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_ent_quotes_deal" ON "enterprise_quotes" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idx_ent_quotes_client" ON "enterprise_quotes" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ent_quotes_ref" ON "enterprise_quotes" USING btree ("org_id","quote_ref");--> statement-breakpoint
CREATE INDEX "marketplace_apps_category_idx" ON "marketplace_apps" USING btree ("category");--> statement-breakpoint
CREATE INDEX "marketplace_apps_active_idx" ON "marketplace_apps" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "org_ai_credits_org_idx" ON "org_ai_credits" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" USING btree ("referrer_org_id");--> statement-breakpoint
CREATE INDEX "referrals_code_idx" ON "referrals" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "referrals_email_idx" ON "referrals" USING btree ("referred_email");--> statement-breakpoint
CREATE INDEX "revenue_events_type_idx" ON "revenue_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "revenue_events_created_idx" ON "revenue_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "revenue_events_org_idx" ON "revenue_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_actions_version" ON "workflow_actions" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_approvals_execution" ON "workflow_approvals" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_approvals_approver_status" ON "workflow_approvals" USING btree ("approver_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_audit_logs_org" ON "workflow_audit_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_audit_logs_workflow" ON "workflow_audit_logs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_audit_logs_org_created" ON "workflow_audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_steps_execution" ON "workflow_execution_steps" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_execution_steps_execution_node" ON "workflow_execution_steps" USING btree ("execution_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_org" ON "workflow_executions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_org_status" ON "workflow_executions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_workflow" ON "workflow_executions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_executions_org_created" ON "workflow_executions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_workflow" ON "workflow_schedules" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_org_enabled" ON "workflow_schedules" USING btree ("org_id","is_enabled");--> statement-breakpoint
CREATE INDEX "idx_workflow_schedules_next_run" ON "workflow_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_secrets_org" ON "workflow_secrets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_triggers_version" ON "workflow_triggers" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_variables_version" ON "workflow_variables" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_versions_workflow" ON "workflow_versions" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_versions_workflow_version" ON "workflow_versions" USING btree ("workflow_id","version");--> statement-breakpoint
CREATE INDEX "idx_workflows_org" ON "workflows" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_workflows_org_status" ON "workflows" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_payroll_templates_org" ON "payroll_templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_templates_system" ON "payroll_templates" USING btree ("is_system");--> statement-breakpoint
CREATE INDEX "idx_payroll_templates_category" ON "payroll_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_payroll_inputs_run" ON "payroll_inputs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_inputs_org_user" ON "payroll_inputs" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_inputs_run_user" ON "payroll_inputs" USING btree ("run_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_run_events_run" ON "payroll_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_run_events_org_type" ON "payroll_run_events" USING btree ("org_id","type");--> statement-breakpoint
CREATE INDEX "idx_payroll_run_events_org_created" ON "payroll_run_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payslip_publications_run" ON "payslip_publications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_payslip_publications_user" ON "payslip_publications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_payslip_publications_org_status" ON "payslip_publications" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payslip_publications_run_employee" ON "payslip_publications" USING btree ("run_employee_id");--> statement-breakpoint
CREATE INDEX "idx_payroll_tax_windows_org" ON "payroll_tax_windows" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_payroll_tax_windows_org_year" ON "payroll_tax_windows" USING btree ("org_id","financial_year");--> statement-breakpoint
CREATE INDEX "idx_integration_connections_org_user" ON "user_integration_connections" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_guided_tours_org_key" ON "guided_tours" USING btree ("org_id","tour_key");--> statement-breakpoint
CREATE INDEX "idx_module_checklist_items_checklist" ON "module_setup_checklist_items" USING btree ("checklist_id");--> statement-breakpoint
CREATE INDEX "idx_onb_analytics_org_event" ON "onboarding_analytics_events" USING btree ("org_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_onb_analytics_org_created" ON "onboarding_analytics_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_onb_flow_sessions_org_user_type" ON "onboarding_flow_sessions" USING btree ("org_id","user_id","type");--> statement-breakpoint
CREATE INDEX "idx_onb_flow_sessions_status" ON "onboarding_flow_sessions" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_payment_audit_events_org" ON "payment_audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_payment_providers_org" ON "payment_providers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_payment_test_transactions_org" ON "payment_test_transactions" USING btree ("org_id","provider_id");--> statement-breakpoint
CREATE INDEX "idx_payment_webhook_events_org" ON "payment_webhook_events" USING btree ("org_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_survey_forms_org_status_mode" ON "survey_forms" USING btree ("org_id","status","mode");--> statement-breakpoint
CREATE INDEX "idx_survey_versions_survey" ON "survey_versions" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_survey_logic_rules_source" ON "survey_logic_rules" USING btree ("survey_id","version_id","source_question_id");--> statement-breakpoint
CREATE INDEX "idx_survey_question_choices_question" ON "survey_question_choices" USING btree ("question_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_survey_questions_section" ON "survey_questions" USING btree ("survey_id","version_id","section_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_survey_sections_version" ON "survey_sections" USING btree ("survey_id","version_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_survey_collectors_survey_status" ON "survey_collectors" USING btree ("survey_id","status");--> statement-breakpoint
CREATE INDEX "idx_survey_participants_org_survey_status" ON "survey_participants" USING btree ("org_id","survey_id","status");--> statement-breakpoint
CREATE INDEX "idx_survey_answers_org_question" ON "survey_answers" USING btree ("org_id","question_id");--> statement-breakpoint
CREATE INDEX "idx_survey_answers_session" ON "survey_answers" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_survey_response_sessions_survey_submitted" ON "survey_response_sessions" USING btree ("org_id","survey_id","submitted_at");--> statement-breakpoint
CREATE INDEX "idx_survey_response_sessions_collector" ON "survey_response_sessions" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "idx_survey_assessment_attempts_survey_participant" ON "survey_assessment_attempts" USING btree ("survey_id","participant_id");--> statement-breakpoint
CREATE INDEX "idx_survey_certificates_survey_participant" ON "survey_certificates" USING btree ("survey_id","participant_id");--> statement-breakpoint
CREATE INDEX "idx_survey_live_sessions_survey" ON "survey_live_sessions" USING btree ("survey_id");--> statement-breakpoint
CREATE INDEX "idx_survey_automation_events_org_survey_type" ON "survey_automation_events" USING btree ("org_id","survey_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_ai_chat_conversations_org_user_updated" ON "ai_chat_conversations" USING btree ("org_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_ai_chat_messages_org_user_id" ON "ai_chat_messages" USING btree ("org_id","user_id","id");--> statement-breakpoint
CREATE INDEX "idx_ai_chat_messages_conversation_id" ON "ai_chat_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "idx_feedbucket_attachments_submission" ON "feedbucket_attachments" USING btree ("org_id","submission_id");--> statement-breakpoint
CREATE INDEX "idx_feedbucket_submissions_widget" ON "feedbucket_submissions" USING btree ("org_id","widget_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_feedbucket_submissions_org_status" ON "feedbucket_submissions" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_feedbucket_submissions_assignee" ON "feedbucket_submissions" USING btree ("org_id","assignee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_feedbucket_widgets_public_key" ON "feedbucket_widgets" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "idx_feedbucket_widgets_org" ON "feedbucket_widgets" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_deliveries_idempotency" ON "notification_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_due" ON "notification_deliveries" USING btree ("org_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_notification" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_user_channel" ON "notification_deliveries" USING btree ("org_id","user_id","channel","created_at");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_event" ON "notification_deliveries" USING btree ("org_id","event_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_events_org_key" ON "notification_events" USING btree ("org_id","event_key");--> statement-breakpoint
CREATE INDEX "idx_notification_events_module" ON "notification_events" USING btree ("source_module");--> statement-breakpoint
CREATE INDEX "idx_notification_events_category" ON "notification_events" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_policy_scope" ON "notification_policy_defaults" USING btree ("org_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "idx_notification_policy_org_scope" ON "notification_policy_defaults" USING btree ("org_id","scope_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_provider_name" ON "notification_provider_accounts" USING btree ("org_id","provider","display_name");--> statement-breakpoint
CREATE INDEX "idx_notification_provider_channel" ON "notification_provider_accounts" USING btree ("org_id","channel","enabled");--> statement-breakpoint
CREATE INDEX "idx_notification_queue_due" ON "notification_queue" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "idx_notification_queue_delivery" ON "notification_queue" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "idx_notification_queue_org" ON "notification_queue" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_notification_suppression_lookup" ON "notification_suppression_rules" USING btree ("org_id","user_id","scope_type","scope_key");--> statement-breakpoint
CREATE INDEX "idx_notification_suppression_expiry" ON "notification_suppression_rules" USING btree ("org_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_sign_templates_org_status" ON "sign_templates" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sign_templates_org_name_version" ON "sign_templates" USING btree ("org_id","name","version");--> statement-breakpoint
CREATE INDEX "idx_sign_watermark_policies_org_scope" ON "sign_watermark_policies" USING btree ("org_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "idx_sign_envelopes_org_status" ON "sign_envelopes" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_sign_envelopes_org_sender" ON "sign_envelopes" USING btree ("org_id","sender_user_id");--> statement-breakpoint
CREATE INDEX "idx_sign_envelopes_source" ON "sign_envelopes" USING btree ("source_module","source_entity_type","source_entity_id");--> statement-breakpoint
CREATE INDEX "idx_sign_envelopes_expires" ON "sign_envelopes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sign_envelopes_finalization_key" ON "sign_envelopes" USING btree ("finalization_key");--> statement-breakpoint
CREATE INDEX "idx_sign_documents_org_envelope" ON "sign_documents" USING btree ("org_id","envelope_id");--> statement-breakpoint
CREATE INDEX "idx_sign_recipients_org_envelope" ON "sign_recipients" USING btree ("org_id","envelope_id");--> statement-breakpoint
CREATE INDEX "idx_sign_recipients_envelope_order" ON "sign_recipients" USING btree ("envelope_id","routing_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sign_recipients_token_hash" ON "sign_recipients" USING btree ("signing_token_hash");--> statement-breakpoint
CREATE INDEX "idx_sign_fields_org_envelope" ON "sign_fields" USING btree ("org_id","envelope_id");--> statement-breakpoint
CREATE INDEX "idx_sign_fields_document" ON "sign_fields" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_sign_fields_recipient" ON "sign_fields" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "idx_sign_signature_assets_recipient" ON "sign_signature_assets" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "idx_sign_signature_assets_org_envelope" ON "sign_signature_assets" USING btree ("org_id","envelope_id");--> statement-breakpoint
CREATE INDEX "idx_sign_audit_events_org_envelope_created" ON "sign_audit_events" USING btree ("org_id","envelope_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_sign_audit_events_recipient" ON "sign_audit_events" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "idx_sign_audit_events_type" ON "sign_audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sign_certificates_number" ON "sign_certificates" USING btree ("certificate_number");--> statement-breakpoint
CREATE INDEX "idx_sign_certificates_org_envelope" ON "sign_certificates" USING btree ("org_id","envelope_id");--> statement-breakpoint
CREATE INDEX "idx_sign_bulk_send_jobs_org_status" ON "sign_bulk_send_jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_sign_bulk_send_rows_job" ON "sign_bulk_send_rows" USING btree ("job_id","row_number");--> statement-breakpoint
CREATE INDEX "idx_sign_bulk_send_rows_status" ON "sign_bulk_send_rows" USING btree ("job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sign_public_forms_slug" ON "sign_public_forms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_sign_public_forms_org_status" ON "sign_public_forms" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_sign_org_settings_org" ON "sign_org_settings" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_agent_tokens_hash" ON "agent_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_agent_tokens_org_user" ON "agent_tokens" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_jobs_org_idem_key" ON "ai_jobs" USING btree ("org_id","idempotency_key") WHERE "ai_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_status_run_at_priority" ON "ai_jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_org_created_at" ON "ai_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_org_type_status" ON "ai_jobs" USING btree ("org_id","type","status");--> statement-breakpoint
CREATE INDEX "idx_ai_feedback_org_feature_created" ON "ai_feedback" USING btree ("org_id","feature","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_feedback_org_correlation" ON "ai_feedback" USING btree ("org_id","correlation_id");--> statement-breakpoint
CREATE INDEX "idx_ai_proposals_org_user_created" ON "ai_action_proposals" USING btree ("org_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_proposals_status_expires" ON "ai_action_proposals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_proposals_org_idem_key" ON "ai_action_proposals" USING btree ("org_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_wsc_org_entity" ON "workspace_search_chunks" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_wsc_org_type" ON "workspace_search_chunks" USING btree ("org_id","entity_type");--> statement-breakpoint
CREATE INDEX "idx_ai_summary_snapshots_org_type_entity_created" ON "ai_summary_snapshots" USING btree ("org_id","entity_type","entity_id","created_at");