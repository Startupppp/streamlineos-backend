
import { pgEnum } from "drizzle-orm/pg-core";

export const ticketTypeEnum = pgEnum("ticket_type", ["EPIC", "STORY", "TASK", "BUG"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
export const ticketPriorityEnum = pgEnum("ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);
export const projectStatusEnum = pgEnum("project_status", ["ACTIVE", "COMPLETED", "ARCHIVED"]);
export const stateGroupEnum = pgEnum("state_group", ["backlog", "unstarted", "started", "completed", "cancelled"]);
export const cycleStatusEnum = pgEnum("cycle_status", ["draft", "active", "completed"]);
export const moduleStatusEnum = pgEnum("module_status", ["backlog", "planned", "in-progress", "completed", "paused", "cancelled"]);
export const intakeStatusEnum = pgEnum("intake_status", ["pending", "accepted", "declined", "duplicate"]);
export const intakeSourceEnum = pgEnum("intake_source", ["manual", "web_form", "email"]);
export const workItemRelationTypeEnum = pgEnum("work_item_relation_type", ["blocks", "blocked_by", "duplicate_of", "relates_to"]);
export const viewLayoutEnum = pgEnum("view_layout", ["board", "list", "table", "calendar", "gantt"]);

export const leaveStatusEnum = pgEnum("leave_status", ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
export const payrollStatusEnum = pgEnum("payroll_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PAID"]);
export const expenseStatusEnum = pgEnum("expense_status", ["DRAFT", "SUBMITTED", "PENDING", "APPROVED", "REJECTED", "REIMBURSEMENT_PENDING", "REIMBURSED", "PAID"]);
export const assetStatusEnum = pgEnum("asset_status", ["AVAILABLE", "ASSIGNED", "MAINTENANCE", "RETIRED"]);
export const documentTypeEnum = pgEnum("document_type", ["CONTRACT", "CERTIFICATE", "ID_PROOF", "PAYSLIP", "POLICY", "OFFER_LETTER", "RESUME", "OTHER"]);
export const reviewStatusEnum = pgEnum("review_status", ["DRAFT", "IN_PROGRESS", "COMPLETED", "ARCHIVED"]);
export const onboardingStatusEnum = pgEnum("onboarding_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "REJECTED"]);
export const genderEnum = pgEnum("gender", ["MALE", "FEMALE", "OTHER"]);
export const wfhRequestStatusEnum = pgEnum("wfh_request_status", ["PENDING", "APPROVED", "REJECTED"]);
export const deviceStatusEnum = pgEnum("device_status", ["ACTIVE", "INACTIVE", "LOST", "RETURNED"]);
export const reviewCycleStatusEnum = pgEnum("review_cycle_status", ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]);
export const meetingStatusEnum = pgEnum("meeting_status", ["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
export const resignationStatusEnum = pgEnum("resignation_status", ["SUBMITTED", "PENDING_HR", "HR_APPROVED", "CEO_APPROVED", "IN_PROGRESS", "APPROVED", "WITHDRAWN", "COMPLETED", "REJECTED"]);
export const exitChecklistStatusEnum = pgEnum("exit_checklist_status", ["PENDING", "DONE"]);
export const ackStatusEnum = pgEnum("ack_status", ["PENDING", "ACKNOWLEDGED", "DECLINED"]);
export const reimbursementStatusEnum = pgEnum("reimbursement_status", ["PENDING", "APPROVED", "REJECTED", "PAID"]);
export const loanStatusEnum = pgEnum("loan_status", ["PENDING", "APPROVED", "ACTIVE", "REPAID", "REJECTED"]);
export const pipStatusEnum = pgEnum("pip_status", ["ACTIVE", "EXTENDED", "COMPLETED", "TERMINATED"]);
export const surveyStatusEnum = pgEnum("survey_status", ["DRAFT", "ACTIVE", "CLOSED"]);
export const feedbackTypeEnum = pgEnum("feedback_type", ["SELF", "PEER", "MANAGER", "SKIP_LEVEL"]);
export const bonusTypeEnum = pgEnum("bonus_type", ["PERFORMANCE", "FESTIVAL", "REFERRAL", "SPOT", "ANNUAL", "JOINING", "RETENTION", "COMMISSION", "ADJUSTMENT"]);
export const fnfStatusEnum = pgEnum("fnf_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PAID", "HR_REVIEW", "FINANCE_REVIEW"]);
export const terminationStatusEnum = pgEnum("termination_status", ["DRAFT", "PENDING_CEO", "APPROVED", "REJECTED", "SENT", "COMPLETED"]);
export const onboardingDocStatusEnum = pgEnum("onboarding_doc_status", ["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]);
export const onboardingDocumentStatusEnum = pgEnum("onboarding_document_status", ["PENDING", "SUBMITTED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]);
export const docAuditActionEnum = pgEnum("doc_audit_action", ["UPLOADED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED", "RE_UPLOADED"]);

export const leadEmailDirectionEnum = pgEnum("lead_email_direction", ["sent", "received"]);
export const leadTaskStatusEnum = pgEnum("lead_task_status", ["open", "done"]);
export const dealActivityTypeEnum = pgEnum("deal_activity_type", ["stage_change", "note", "call", "email", "meeting", "document"]);
export const clientAccountStatusEnum = pgEnum("client_account_status", ["ACCOUNT_OPENING", "QUERIES", "PLAN_SELECTED", "INVESTED"]);
export const incentiveStatusEnum = pgEnum("incentive_status", ["PENDING", "APPROVED", "REJECTED", "ADDED_TO_PAYROLL"]);
export const scoringOperatorEnum = pgEnum("scoring_operator", ["eq", "gt", "lt", "contains", "in"]);
export const assignmentRuleTypeEnum = pgEnum("assignment_rule_type", ["assign_user", "round_robin", "weighted_round_robin", "least_loaded", "territory"]);
export const slaAppliesToEnum = pgEnum("sla_applies_to", ["lead", "deal", "both"]);
export const slaPriorityEnum = pgEnum("sla_priority", ["low", "medium", "high", "urgent"]);
export const orgSizeEnum = pgEnum("org_size", ["1-10", "11-50", "51-200", "201-1000", "1000+"]);
export const branchStatusEnum = pgEnum("branch_status", ["ACTIVE", "INACTIVE"]);

export const crmPersonRoleEnum = pgEnum("crm_person_role", ["sales_rep", "csm"]);
export const crmHealthEnum = pgEnum("crm_health", ["healthy", "at_risk", "critical"]);
export const crmDealStageEnum = pgEnum("crm_deal_stage", ["Discovery", "Qualified", "Proposal", "Negotiation", "Closed Won"]);
export const crmCampaignStatusEnum = pgEnum("crm_campaign_status", ["active", "paused", "completed"]);
export const crmLeadStatusEnum = pgEnum("crm_lead_status", ["visitor", "lead", "mql", "sql", "opportunity"]);
export const crmSupportTicketStatusEnum = pgEnum("crm_support_ticket_status", ["new", "in_progress", "resolved", "closed"]);
export const crmSupportTicketPriorityEnum = pgEnum("crm_support_ticket_priority", ["critical", "high", "medium", "low"]);
export const crmActivityTypeEnum = pgEnum("crm_activity_type", ["deal_won", "meeting", "proposal", "call", "email", "ticket", "escalation"]);
export const crmEventStatusEnum = pgEnum("crm_event_status", ["planning", "confirmed", "completed"]);

export const jobPostingStatusEnum = pgEnum("job_posting_status", ["DRAFT", "OPEN", "PAUSED", "CLOSED", "FILLED"]);
export const candidateStatusEnum = pgEnum("candidate_status", ["NEW", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED"]);
export const interviewTypeEnum = pgEnum("interview_type", ["PHONE", "VIDEO", "ONSITE", "TECHNICAL", "HR", "FINAL"]);
export const interviewResultEnum = pgEnum("interview_result", ["PENDING", "PASSED", "FAILED", "NO_SHOW"]);
export const applicationStatusEnum = pgEnum("application_status", ["APPLIED", "SHORTLISTED", "INTERVIEWING", "OFFERED", "ACCEPTED", "REJECTED", "WITHDRAWN"]);

export const chatMessageTypeEnum = pgEnum("chat_message_type", ["text", "lead_submission", "system"]);

export const notificationTypeEnum = pgEnum("notification_type", ["INFO", "SUCCESS", "WARNING", "ERROR"]);
export const notificationPriorityEnum = pgEnum("notification_priority", ["LOW", "NORMAL", "HIGH", "CRITICAL"]);
export const notificationCategoryEnum = pgEnum("notification_category", [
  "SECURITY", "CRM", "HRMS", "BILLING", "AI", "PROJECTS", "WORKFLOW", "MARKETING", "SYSTEM",
  "CHAT", "PAYROLL", "RECRUITMENT", "KNOWLEDGE", "SIGN", "INVENTORY", "SURVEYS", "CALENDAR", "SUPPORT",
]);
export const broadcastStatusEnum = pgEnum("broadcast_status", [
  "DRAFT", "SCHEDULED", "QUEUED", "SENDING", "SENT", "CANCELLED", "FAILED",
]);
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "QUEUED", "PROCESSING", "DELIVERED", "FAILED", "EXPIRED",
]);
export const notificationChannelEnum = pgEnum("notification_channel", [
  "IN_APP", "EMAIL", "PUSH", "SMS", "WHATSAPP", "WEBHOOK",
]);

// Delivery engine (notifications) â€” one row per channel per recipient tracks its full lifecycle.
export const notificationDeliveryStatusEnum = pgEnum("notification_delivery_status", [
  "PENDING", "QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "CLICKED",
  "FAILED", "BOUNCED", "SUPPRESSED", "CANCELLED", "DEAD",
]);
export const notificationQueueStatusEnum = pgEnum("notification_queue_status", [
  "PENDING", "LOCKED", "DONE", "FAILED", "DEAD",
]);
export const notificationPolicyScopeEnum = pgEnum("notification_policy_scope", [
  "ORG", "ROLE", "DEPARTMENT", "TEAM", "PROJECT",
]);
export const notificationProviderEnum = pgEnum("notification_provider", [
  "SMTP", "TWILIO", "META_WHATSAPP", "WEBHOOK", "WEB_PUSH", "INTERNAL", "SANDBOX",
]);
export const notificationQuietHoursBehaviorEnum = pgEnum("notification_quiet_hours_behavior", [
  "respect", "bypass_if_high", "always_bypass",
]);
export const notificationSuppressionReasonEnum = pgEnum("notification_suppression_reason", [
  "DEDUPE", "MUTE", "UNSUBSCRIBE", "INVALID_RECIPIENT", "RATE_LIMIT", "QUIET_HOURS",
  "NO_PROVIDER", "CONSENT_MISSING", "CHANNEL_DISABLED", "COST_LIMIT",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "ISSUED", "SENT", "PARTIALLY_PAID", "OVERDUE", "PAID", "FAILED", "VOIDED"]);

export const supportTicketStatusEnum = pgEnum("support_ticket_status", ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]);
export const supportTicketPriorityEnum = pgEnum("support_ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const kbAudienceEnum = pgEnum("kb_audience", ["internal", "public", "mixed"]);
export const kbSpaceRoleEnum = pgEnum("kb_space_role", ["viewer", "commenter", "editor", "publisher", "admin"]);
export const kbTranslationStatusEnum = pgEnum("kb_translation_status", ["draft", "in_progress", "translated", "published", "outdated"]);

export const quoteStatusEnum = pgEnum("quote_status", ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["TRIAL", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"]);
export const subscriptionPlanEnum = pgEnum("subscription_plan", ["STARTER", "PROFESSIONAL", "ENTERPRISE"]);

export const taskEntityTypeEnum = pgEnum("task_entity_type", ["LEAD", "DEAL", "CONTACT", "PROJECT"]);
export const taskTypeEnum = pgEnum("task_type", ["CALL", "EMAIL", "MEETING", "CUSTOM"]);
export const taskStatusEnum = pgEnum("task_status", ["pending", "completed", "cancelled"]);

export const blogPostStatusEnum = pgEnum("blog_post_status", ["draft", "published", "archived"]);

export const accountTypeEnum = pgEnum("account_type", ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);
export const journalEntryStatusEnum = pgEnum("journal_entry_status", ["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"]);

export const invProductStatusEnum = pgEnum("inv_product_status", ["ACTIVE", "INACTIVE", "DISCONTINUED"]);
export const invAdjReasonEnum = pgEnum("inv_adj_reason", ["PURCHASE", "SALE", "RETURN", "DAMAGE", "EXPIRY", "THEFT", "RECOUNT", "OTHER"]);
export const invTxnTypeEnum = pgEnum("inv_txn_type", ["PURCHASE", "SALE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN_IN", "RETURN_OUT", "GRN", "OPENING_BALANCE", "VENDOR_RETURN", "CUSTOMER_RETURN", "CYCLE_COUNT_GAIN", "CYCLE_COUNT_LOSS", "SCRAP", "QUARANTINE_IN", "QUARANTINE_OUT", "RESERVATION_CREATE", "RESERVATION_RELEASE", "RESERVATION_CONSUME"]);
export const invPoStatusEnum = pgEnum("inv_po_status", ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]);
export const invSoStatusEnum = pgEnum("inv_so_status", ["DRAFT", "CONFIRMED", "PARTIALLY_RESERVED", "RESERVED", "PICKED", "PACKED", "SHIPPED", "PARTIALLY_SHIPPED", "INVOICED", "CANCELLED", "CLOSED"]);
export const invTransferStatusEnum = pgEnum("inv_transfer_status", ["PENDING", "RESERVED", "IN_TRANSIT", "COMPLETED", "CANCELLED"]);
export const invLocationTypeEnum = pgEnum("inv_location_type", ["ZONE", "AISLE", "RACK", "BIN", "RECEIVING", "SHIPPING", "QUARANTINE", "SCRAP", "TRANSIT", "RETURNS"]);
export const invGrnQualityEnum = pgEnum("inv_grn_quality", ["ACCEPTED", "REJECTED"]);

export const appInstallStatusEnum = pgEnum("app_install_status", [
  "TRIALING",
  "ACTIVE",
  "CANCELLED",
]);

export const aiCreditTxnTypeEnum = pgEnum("ai_credit_txn_type", [
  "PURCHASE",
  "USAGE",
  "REFUND",
  "PLAN_GRANT",
  "EXPIRY",
]);

export const aiCreditReservationStatusEnum = pgEnum("ai_credit_reservation_status", [
  "RESERVED",
  "SETTLED",
  "RELEASED",
]);

export const affiliateStatusEnum = pgEnum("affiliate_status", [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
]);

export const commissionStatusEnum = pgEnum("commission_status", [
  "PENDING",
  "APPROVED",
  "PAID",
  "CANCELLED",
]);

export const referralStatusEnum = pgEnum("referral_status", [
  "PENDING",
  "SIGNED_UP",
  "ACTIVATED",
  "REWARDED",
  "EXPIRED",
]);

export const revenueEventTypeEnum = pgEnum("revenue_event_type", [
  "new_subscription",
  "upgrade",
  "downgrade",
  "churn",
  "reactivation",
  "addon_purchase",
  "refund",
]);

export const enterpriseQuoteStatusEnum = pgEnum("enterprise_quote_status", [
  "DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"
]);

export const payrollRunStatusEnum = pgEnum("payroll_run_status", [
  "PREPARING", "DRAFT", "PREVIEW_READY", "EXCEPTIONS_FOUND", "PENDING_APPROVAL",
  "APPROVED", "LOCKED", "PAID", "PAYSLIPS_PUBLISHED", "CLOSED", "REOPENED",
]);

export const payrollWorkerTypeEnum = pgEnum("payroll_worker_type", [
  "EMPLOYEE", "CONTRACTOR", "CONSULTANT", "INTERN", "EOR",
]);

export const salaryComponentTypeEnum = pgEnum("salary_component_type", [
  "EARNING", "DEDUCTION", "EMPLOYER_CONTRIBUTION", "REIMBURSEMENT", "TAX", "ADJUSTMENT",
]);

export const salaryComponentCalcMethodEnum = pgEnum("salary_component_calc_method", [
  "FIXED", "PERCENT_OF_BASIC", "PERCENT_OF_GROSS", "FORMULA",
  "ATTENDANCE_BASED", "TIMESHEET_BASED", "MANUAL",
]);

export const payrollExceptionSeverityEnum = pgEnum("payroll_exception_severity", [
  "BLOCKER", "WARNING", "INFO",
]);

export const payrollExceptionStatusEnum = pgEnum("payroll_exception_status", [
  "OPEN", "RESOLVED", "OVERRIDDEN",
]);

export const payrollApprovalStatusEnum = pgEnum("payroll_approval_status", [
  "PENDING", "APPROVED", "REJECTED",
]);

export const payrollBankBatchStatusEnum = pgEnum("payroll_bank_batch_status", [
  "DRAFT", "GENERATED", "SENT", "PARTIALLY_PAID", "PAID", "FAILED",
]);

export const payrollBankItemStatusEnum = pgEnum("payroll_bank_item_status", [
  "PENDING", "SENT", "PAID", "FAILED", "HELD",
]);

export const payrollPolicyStatusEnum = pgEnum("payroll_policy_status", [
  "DRAFT", "ACTIVE", "SUPERSEDED", "ARCHIVED",
]);

export const salaryProfileStatusEnum = pgEnum("salary_profile_status", [
  "UPCOMING", "ACTIVE", "SUPERSEDED",
]);

export const payFrequencyEnum = pgEnum("pay_frequency", [
  "MONTHLY", "SEMI_MONTHLY", "BI_WEEKLY", "WEEKLY",
]);

export const taxRegimeTypeEnum = pgEnum("tax_regime_type", [
  "OLD", "NEW",
]);

export const payslipLayoutEnum = pgEnum("payslip_layout", [
  "CLASSIC", "MODERN", "COMPLIANCE",
]);

export const payslipPublishChannelEnum = pgEnum("payslip_publish_channel", [
  "PORTAL", "EMAIL",
]);

export const payrollCalendarEventTypeEnum = pgEnum("payroll_calendar_event_type", [
  "ATTENDANCE_CUTOFF", "REIMBURSEMENT_CUTOFF", "DECLARATION_CUTOFF",
  "PREVIEW_DUE", "APPROVAL_DEADLINE", "PAY_DATE", "PUBLISH_DATE",
]);

export const payrollLoanAdjustmentTypeEnum = pgEnum("payroll_loan_adjustment_type", [
  "SKIP_EMI", "EXTRA_RECOVERY", "FORECLOSURE", "MANUAL_ADJUST",
]);

// Onboarding Flow (org setup / module checklists / guided tours) â€” see onboarding.ts.
// Named "onboarding_flow_*" to avoid colliding with the pre-existing HR employee
// onboarding tables (onboarding_templates, onboarding_template_steps, onboarding_tasks,
// onboarding_steps) which remain in hr/offboarding.ts and auth.ts unchanged.
export const onboardingFlowTypeEnum = pgEnum("onboarding_flow_type", [
  "org_setup",
  "member_setup",
  "employee_onboarding",
  "module_setup",
  "guided_tour",
  "payment_setup",
]);

export const onboardingFlowSessionStatusEnum = pgEnum("onboarding_flow_session_status", [
  "not_started", "in_progress", "completed", "skipped", "abandoned",
]);

export const onboardingFlowStepStatusEnum = pgEnum("onboarding_flow_step_status", [
  "todo", "in_progress", "done", "skipped", "blocked",
]);

export const onboardingFlowTaskStatusEnum = pgEnum("onboarding_flow_task_status", [
  "todo", "in_progress", "done", "skipped",
]);

export const onboardingFlowTaskCategoryEnum = pgEnum("onboarding_flow_task_category", [
  "profile", "document", "training", "system_access", "equipment",
  "policy", "module_setup", "guided_action", "payment_setup",
]);

export const moduleSetupChecklistStatusEnum = pgEnum("module_setup_checklist_status", [
  "not_started", "in_progress", "completed",
]);

export const guidedTourProgressStatusEnum = pgEnum("guided_tour_progress_status", [
  "not_started", "in_progress", "completed", "dismissed",
]);

// Payment provider setup (12_Payment_Integration_Setup_Page.md). Deliberately separate from
// the existing subscriptions/subscription_payments (and platform_subscriptions/platform_payments)
// tables in shared.ts/platform.ts â€” those are StreamlineOS billing tenants for their own SaaS
// plan; this system is for tenants connecting their own Razorpay/Stripe account to charge their
// own customers. See payment-providers.ts.
export const paymentEnvironmentEnum = pgEnum("payment_environment", ["test", "live"]);

export const paymentProviderStatusEnum = pgEnum("payment_provider_status", [
  "not_configured",
  "test_mode_ready",
  "needs_credentials",
  "needs_business_details",
  "needs_kyc",
  "kyc_pending",
  "kyc_rejected",
  "needs_webhook",
  "webhook_failing",
  "test_payment_required",
  "ready_for_live",
  "live",
  "degraded",
  "disabled",
]);

export const paymentWebhookEndpointStatusEnum = pgEnum("payment_webhook_endpoint_status", [
  "not_verified", "verified", "failing",
]);

export const paymentWebhookProcessingStatusEnum = pgEnum("payment_webhook_processing_status", [
  "received", "processed", "failed", "ignored_duplicate",
]);

export const paymentTestTransactionStatusEnum = pgEnum("payment_test_transaction_status", [
  "created", "pending", "succeeded", "failed",
]);

export const paymentManualMethodStatusEnum = pgEnum("payment_manual_method_status", [
  "enabled", "missing_instructions", "disabled",
]);

export const invProductTypeEnum = pgEnum("inv_product_type", ["STOCKABLE", "CONSUMABLE", "SERVICE"]);
export const invTrackingMethodEnum = pgEnum("inv_tracking_method", ["NONE", "LOT", "SERIAL"]);
export const invCostingMethodEnum = pgEnum("inv_costing_method", ["STANDARD", "WEIGHTED_AVERAGE", "FIFO"]);
export const invReservationStatusEnum = pgEnum("inv_reservation_status", ["ACTIVE", "CONSUMED", "RELEASED", "EXPIRED"]);
export const invLotStatusEnum = pgEnum("inv_lot_status", ["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]);
export const invSerialStatusEnum = pgEnum("inv_serial_status", ["IN_STOCK", "RESERVED", "SHIPPED", "RETURNED", "SCRAPPED", "QUARANTINE"]);
export const invVendorReturnReasonEnum = pgEnum("inv_vendor_return_reason", ["DAMAGED", "WRONG_ITEM", "EXCESS", "EXPIRED", "QUALITY_REJECTED"]);
export const invCustomerReturnDispositionEnum = pgEnum("inv_customer_return_disposition", ["RESTOCK", "QUARANTINE", "SCRAP"]);
export const invPickListStatusEnum = pgEnum("inv_pick_list_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
export const invCycleCountStatusEnum = pgEnum("inv_cycle_count_status", ["PLANNED", "COUNTING", "REVIEW", "POSTED", "CANCELLED"]);
export const invQualityInspectionStatusEnum = pgEnum("inv_quality_inspection_status", ["PENDING", "IN_PROGRESS", "PASSED", "FAILED", "DISPOSITION_REQUIRED", "COMPLETED", "CANCELLED"]);
export const invQualityHoldStatusEnum = pgEnum("inv_quality_hold_status", ["ACTIVE", "RELEASED"]);
export const invQualityDispositionEnum = pgEnum("inv_quality_disposition", ["RELEASE_TO_AVAILABLE", "QUARANTINE", "RETURN_TO_VENDOR", "SCRAP"]);
export const invRecallStatusEnum = pgEnum("inv_recall_status", ["OPEN", "IN_PROGRESS", "CLOSED"]);
export const invShipmentStatusEnum = pgEnum("inv_shipment_status", ["DRAFT", "PACKED", "LABEL_CREATED", "SHIPPED", "DELIVERED", "CANCELLED"]);
export const invPackageStatusEnum = pgEnum("inv_package_status", ["OPEN", "CLOSED", "SHIPPED"]);
export const invLoadStatusEnum = pgEnum("inv_load_status", ["DRAFT", "DISPATCHED", "ARRIVED", "CLOSED", "CANCELLED"]);
export const invChannelTypeEnum = pgEnum("inv_channel_type", ["INTERNAL", "SHOPIFY", "WOOCOMMERCE", "MARKETPLACE", "B2B", "THREE_PL"]);
export const invChannelStatusEnum = pgEnum("inv_channel_status", ["ACTIVE", "PAUSED"]);
export const invChannelPubStatusEnum = pgEnum("inv_channel_pub_status", ["PENDING", "PUBLISHED", "FAILED"]);
export const inv3plStatusEnum = pgEnum("inv_3pl_status", ["DISCONNECTED", "CONNECTED", "ERROR"]);
export const invIdempotencyStatusEnum = pgEnum("inv_idempotency_status", ["IN_FLIGHT", "COMPLETED", "FAILED"]);
export const invJobStatusEnum = pgEnum("inv_job_status", ["PENDING", "VALIDATING", "RUNNING", "COMPLETED", "FAILED"]);
export const invWebhookEventStatusEnum = pgEnum("inv_webhook_event_status", ["PENDING", "DELIVERED", "FAILED"]);
export const invReservationStrategyEnum = pgEnum("inv_reservation_strategy", ["MANUAL", "AUTO_ON_CONFIRM", "FEFO", "FIFO"]);
export const invExpiryPolicyEnum = pgEnum("inv_expiry_policy", ["BLOCK", "WARN", "ALLOW"]);
export const invAiInsightStatusEnum = pgEnum("inv_ai_insight_status", ["NEW", "ACKNOWLEDGED", "DISMISSED"]);

