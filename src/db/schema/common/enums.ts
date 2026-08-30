
import { pgEnum } from "drizzle-orm/pg-core";

export const ticketTypeEnum = pgEnum("ticket_type", ["EPIC", "STORY", "TASK", "BUG"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
export const ticketPriorityEnum = pgEnum("ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);
export const projectStatusEnum = pgEnum("project_status", ["ACTIVE", "COMPLETED", "ARCHIVED"]);
export const managedProductStatusEnum = pgEnum("managed_product_status", ["active", "archived"]);
export const workerEngagementStatusEnum = pgEnum("worker_engagement_status", ["PLANNED", "ACTIVE", "COMPLETED", "TERMINATED", "CANCELLED"]);
export const stateGroupEnum = pgEnum("state_group", ["backlog", "unstarted", "started", "completed", "cancelled"]);
export const cycleStatusEnum = pgEnum("cycle_status", ["draft", "active", "completed"]);
export const moduleStatusEnum = pgEnum("module_status", ["backlog", "planned", "in-progress", "completed", "paused", "cancelled"]);
export const intakeStatusEnum = pgEnum("intake_status", ["pending", "accepted", "declined", "duplicate"]);
export const intakeSourceEnum = pgEnum("intake_source", ["manual", "web_form", "email"]);
export const workItemRelationTypeEnum = pgEnum("work_item_relation_type", ["blocks", "blocked_by", "duplicate_of", "relates_to"]);
export const viewLayoutEnum = pgEnum("view_layout", ["board", "list", "table", "calendar", "gantt"]);

export const leaveStatusEnum = pgEnum("leave_status", ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);
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
export const resignationStatusEnum = pgEnum("resignation_status", ["SUBMITTED", "PENDING_HR", "HR_APPROVED", "FINAL_APPROVED", "IN_PROGRESS", "APPROVED", "WITHDRAWN", "COMPLETED", "REJECTED"]);
export const exitChecklistStatusEnum = pgEnum("exit_checklist_status", ["PENDING", "DONE"]);
export const ackStatusEnum = pgEnum("ack_status", ["PENDING", "ACKNOWLEDGED", "DECLINED"]);
export const reimbursementStatusEnum = pgEnum("reimbursement_status", ["PENDING", "APPROVED", "REJECTED", "PAID"]);
export const loanStatusEnum = pgEnum("loan_status", ["PENDING", "APPROVED", "ACTIVE", "REPAID", "REJECTED"]);
export const pipStatusEnum = pgEnum("pip_status", ["ACTIVE", "EXTENDED", "COMPLETED", "TERMINATED"]);
export const surveyStatusEnum = pgEnum("survey_status", ["DRAFT", "ACTIVE", "CLOSED"]);
export const feedbackTypeEnum = pgEnum("feedback_type", ["SELF", "PEER", "MANAGER", "SKIP_LEVEL"]);
export const bonusTypeEnum = pgEnum("bonus_type", ["PERFORMANCE", "FESTIVAL", "REFERRAL", "SPOT", "ANNUAL", "JOINING", "RETENTION", "COMMISSION", "ADJUSTMENT"]);
export const fnfStatusEnum = pgEnum("fnf_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PAID", "HR_REVIEW", "FINANCE_REVIEW"]);
export const terminationStatusEnum = pgEnum("termination_status", ["DRAFT", "PENDING_FINAL", "APPROVED", "REJECTED", "SENT", "COMPLETED"]);
export const onboardingDocStatusEnum = pgEnum("onboarding_doc_status", ["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]);
export const onboardingDocumentStatusEnum = pgEnum("onboarding_document_status", ["PENDING", "SUBMITTED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]);
export const docAuditActionEnum = pgEnum("doc_audit_action", ["UPLOADED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED", "RE_UPLOADED"]);

export const leadEmailDirectionEnum = pgEnum("lead_email_direction", ["sent", "received"]);
export const leadTaskStatusEnum = pgEnum("lead_task_status", ["open", "done"]);
export const clientAccountStatusEnum = pgEnum("client_account_status", ["ACCOUNT_OPENING", "QUERIES", "PLAN_SELECTED", "INVESTED"]);
export const incentiveStatusEnum = pgEnum("incentive_status", ["PENDING", "APPROVED", "REJECTED", "ADDED_TO_PAYROLL"]);
export const scoringOperatorEnum = pgEnum("scoring_operator", ["eq", "gt", "lt", "contains", "in"]);
export const assignmentRuleTypeEnum = pgEnum("assignment_rule_type", ["assign_user", "round_robin", "weighted_round_robin", "least_loaded", "territory"]);
export const slaAppliesToEnum = pgEnum("sla_applies_to", ["lead", "deal", "both"]);
export const slaPriorityEnum = pgEnum("sla_priority", ["low", "medium", "high", "urgent"]);
export const orgSizeEnum = pgEnum("org_size", ["1-10", "11-50", "51-200", "201-1000", "1000+"]);

export const membershipStatusEnum = pgEnum("membership_status", ["INVITED", "ACTIVE", "SUSPENDED", "LEFT"]);

export const crmPersonRoleEnum = pgEnum("crm_person_role", ["sales_rep", "csm"]);
export const crmHealthEnum = pgEnum("crm_health", ["healthy", "at_risk", "critical"]);
export const crmDealStageEnum = pgEnum("crm_deal_stage", ["Discovery", "Qualified", "Proposal", "Negotiation", "Closed Won"]);
export const crmCampaignStatusEnum = pgEnum("crm_campaign_status", ["active", "paused", "completed"]);
export const crmLeadStatusEnum = pgEnum("crm_lead_status", ["visitor", "lead", "mql", "sql", "opportunity"]);
export const crmSupportTicketStatusEnum = pgEnum("crm_support_ticket_status", ["new", "in_progress", "resolved", "closed"]);
export const crmSupportTicketPriorityEnum = pgEnum("crm_support_ticket_priority", ["critical", "high", "medium", "low"]);
export const crmActivityTypeEnum = pgEnum("crm_activity_type", ["deal_won", "meeting", "proposal", "call", "email", "ticket", "escalation", "task_completed"]);

export const crmConsentChannelEnum = pgEnum("crm_consent_channel", ["EMAIL", "SMS", "WHATSAPP", "PHONE", "POST"]);
export const crmConsentStatusEnum = pgEnum("crm_consent_status", ["OPTED_IN", "OPTED_OUT", "UNKNOWN"]);
export const crmConsentSourceEnum = pgEnum("crm_consent_source", ["USER_ENTRY", "IMPORT", "WEB_FORM", "UNSUBSCRIBE_LINK", "API", "ENRICHMENT"]);
export const crmLegalBasisEnum = pgEnum("crm_legal_basis", ["CONSENT", "CONTRACT", "LEGITIMATE_INTEREST", "LEGAL_OBLIGATION"]);

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
  "ACCOUNTING",
]);
export const broadcastStatusEnum = pgEnum("broadcast_status", [
  "DRAFT", "SCHEDULED", "QUEUED", "SENDING", "SENT", "CANCELLED", "FAILED",
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
  "NO_PROVIDER", "CONSENT_MISSING", "CHANNEL_DISABLED", "COST_LIMIT", "NO_ACCESS",
]);

export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "ISSUED", "SENT", "PARTIALLY_PAID", "OVERDUE", "PAID", "FAILED", "VOIDED"]);

export const supportTicketStatusEnum = pgEnum("support_ticket_status", ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]);
export const supportTicketPriorityEnum = pgEnum("support_ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const kbAudienceEnum = pgEnum("kb_audience", ["internal", "public", "mixed"]);
export const kbSpaceRoleEnum = pgEnum("kb_space_role", ["viewer", "commenter", "editor", "publisher", "admin"]);
export const kbTranslationStatusEnum = pgEnum("kb_translation_status", ["draft", "in_progress", "translated", "published", "outdated"]);

export const quoteStatusEnum = pgEnum("quote_status", ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["TRIAL", "ACTIVE", "PAST_DUE", "CANCELLED", "SUSPENDED", "EXPIRED"]);
export const subscriptionPlanEnum = pgEnum("subscription_plan", ["STARTER", "PROFESSIONAL", "ENTERPRISE"]);

export const taskEntityTypeEnum = pgEnum("task_entity_type", ["LEAD", "DEAL", "CONTACT", "PROJECT"]);
export const taskStatusEnum = pgEnum("task_status", ["pending", "completed", "cancelled"]);

export const blogPostStatusEnum = pgEnum("blog_post_status", ["draft", "published", "archived"]);

export const accountTypeEnum = pgEnum("account_type", ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);
export const journalEntryStatusEnum = pgEnum("journal_entry_status", ["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"]);

export const invProductStatusEnum = pgEnum("inv_product_status", ["ACTIVE", "INACTIVE", "DISCONTINUED"]);
/**
 * D8. `SCRAP` names the condemning of goods that are on the shelf, which the
 * other seven reasons could only approximate: DAMAGE says why they are worthless
 * and RECOUNT says the count was wrong, but neither says the units were
 * destroyed. The ledger has had `SCRAP` as a transaction type since the first
 * migration and `inv_reason_category` has had it as a category; only the
 * document's own reason was missing it.
 */
export const invAdjReasonEnum = pgEnum("inv_adj_reason", ["PURCHASE", "SALE", "RETURN", "DAMAGE", "EXPIRY", "THEFT", "RECOUNT", "OTHER", "SCRAP"]);
/**
 * Which quantity a movement moved.
 *
 * Without it the ledger cannot say whether a row changed on-hand or moved
 * goods into a block or a quality hold, and quantity_before/quantity_after
 * describe a bucket the reader has to infer from transaction_type.
 */
export const invQuantityBucketEnum = pgEnum("inv_quantity_bucket", ["ON_HAND", "BLOCKED", "QUALITY_HOLD"]);

export const invTxnTypeEnum = pgEnum("inv_txn_type", ["PURCHASE", "SALE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN_IN", "RETURN_OUT", "GRN", "OPENING_BALANCE", "VENDOR_RETURN", "CUSTOMER_RETURN", "CYCLE_COUNT_GAIN", "CYCLE_COUNT_LOSS", "SCRAP", "QUARANTINE_IN", "QUARANTINE_OUT", "RESERVATION_CREATE", "RESERVATION_RELEASE", "RESERVATION_CONSUME"]);
export const invPoStatusEnum = pgEnum("inv_po_status", ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]);
export const invSoStatusEnum = pgEnum("inv_so_status", ["DRAFT", "CONFIRMED", "PARTIALLY_RESERVED", "RESERVED", "PICKED", "PACKED", "SHIPPED", "PARTIALLY_SHIPPED", "INVOICED", "CANCELLED", "CLOSED"]);
export const invTransferStatusEnum = pgEnum("inv_transfer_status", ["PENDING", "RESERVED", "IN_TRANSIT", "COMPLETED", "CANCELLED"]);
export const invLocationTypeEnum = pgEnum("inv_location_type", ["ZONE", "AISLE", "RACK", "BIN", "RECEIVING", "SHIPPING", "QUARANTINE", "SCRAP", "TRANSIT", "RETURNS"]);
export const invGrnQualityEnum = pgEnum("inv_grn_quality", ["ACCEPTED", "REJECTED"]);
/**
 * B1. A delivery has a life before it becomes stock.
 *
 * `inv_grns` had no status at all, so recording a receipt and posting it were
 * the same act and there was nowhere to put a delivery that had arrived but not
 * yet been counted. DRAFT and COUNTING write no stock; QUALITY_REVIEW is the
 * step where an inspector looks at what the counter found; POSTED is the only
 * state in which `inv_stock_transactions` has rows for this document. CANCELLED
 * is how an unposted receipt is abandoned — the row stays, because a delivery
 * somebody walked away from is a fact worth keeping.
 */
export const invGrnStatusEnum = pgEnum("inv_grn_status", [
  "DRAFT",
  "COUNTING",
  "QUALITY_REVIEW",
  "POSTED",
  "CANCELLED",
]);
/** INV-201. Why a received line did not match what the purchase order owed. */
export const invGrnDiscrepancyEnum = pgEnum("inv_grn_discrepancy", [
  "SHORT",
  "OVER",
  "DAMAGED",
  "WRONG_ITEM",
]);
export const invAdjustmentStatusEnum = pgEnum("inv_adjustment_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PENDING_POST", "POSTED", "CANCELLED"]);
/**
 * B9. `APPROVED` sits between the draft and the ledger.
 *
 * A return used to go from DRAFT straight to POSTED, so the act of moving stock
 * and the act of agreeing to move it were the same click. The inspection
 * recorded by INV-209 had nobody signing it off, and a cancellation had exactly
 * one moment it could happen in.
 */
export const invReturnStatusEnum = pgEnum("inv_return_status", ["DRAFT", "APPROVED", "POSTED", "CANCELLED"]);

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

/**
 * E2 — how a supply is treated for GST, which is not the same question as what
 * rate it carries.
 *
 * `TAXABLE` at 0% and `NIL_RATED` look identical on an invoice line and are
 * different rows in a GSTR-1 summary; `EXEMPT` and `NON_GST` differ again in
 * whether input credit has to be reversed. Collapsing them into "rate = 0"
 * loses the distinction the return actually asks for, so the treatment is
 * stored beside the rate rather than derived from it.
 */
export const invTaxTreatmentEnum = pgEnum("inv_tax_treatment", [
  "TAXABLE", "EXEMPT", "NIL_RATED", "ZERO_RATED", "NON_GST",
]);

/**
 * E2 — the organisation's GST registration mode.
 *
 * A composition dealer pays tax out of turnover and may not collect it from a
 * customer, so an outward document that shows a tax split is not merely
 * cosmetic — it is an invoice the dealer is not allowed to raise. The mode is
 * snapshotted onto every document line so a later switch cannot rewrite what an
 * already-posted document claimed.
 */
export const invGstModeEnum = pgEnum("inv_gst_mode", ["REGULAR", "COMPOSITION"]);

/**
 * E3 — the schedule a medicine is sold under, behind the `pharmacy` pack.
 *
 * Recorded because it decides what a counter is allowed to do, not because
 * inventory files anything: Schedule H and H1 need a prescription, H1 and X
 * additionally need an entry in a bound register, and narcotics are counted and
 * reconciled separately. `OTC` is stated rather than left as NULL where the
 * organisation has actually classified the SKU — "over the counter" and "nobody
 * has looked at this yet" are different facts, and only the second is a reason
 * to stop a dispense and ask.
 *
 * Deliberately not a jurisdiction-neutral abstraction. These are the Indian
 * Drugs and Cosmetics Rules schedules, and a set that pretended otherwise would
 * be a set nobody could map their labels onto.
 */
export const invDrugScheduleEnum = pgEnum("inv_drug_schedule", [
  "OTC", "H", "H1", "X", "NARCOTIC",
]);

/**
 * E4 — whether a SKU leaves the shop as a sealed pack or is measured out of one.
 *
 * A packed SKU is handed over in the unit it was received in. A loose SKU is
 * broken out of bulk: rice received in 25 kg sacks and sold in 500 g scoops is
 * one product, one stock balance, and two units of measure with a conversion
 * between them. The distinction is what decides whether a sale may name a
 * different unit from the stock the ledger holds — not a cosmetic label.
 */
export const invSaleModeEnum = pgEnum("inv_sale_mode", ["PACKED", "LOOSE"]);

/**
 * E4 — how a quantity may be entered for this SKU.
 *
 * `WHOLE` is countable goods: three tins, not 3.25 tins. `DECIMAL` is a measure
 * somebody types. `SCALE` is a measure a weighing scale sends, which differs
 * from `DECIMAL` in exactly one way that matters — the operator did not choose
 * the digits, so the number arrives at the scale's own precision and must not be
 * silently re-rounded to something tidier on the way in.
 *
 * All three describe *entry*. The ledger stores base units at scale 4 whichever
 * one is set; this decides what is allowed to reach it, not what it holds.
 */
export const invQtyInputModeEnum = pgEnum("inv_qty_input_mode", ["WHOLE", "DECIMAL", "SCALE"]);

export const invProductTypeEnum = pgEnum("inv_product_type", ["STOCKABLE", "CONSUMABLE", "SERVICE"]);
export const invTrackingMethodEnum = pgEnum("inv_tracking_method", ["NONE", "LOT", "SERIAL"]);
export const invCostingMethodEnum = pgEnum("inv_costing_method", ["STANDARD", "WEIGHTED_AVERAGE", "FIFO"]);
export const invReservationStatusEnum = pgEnum("inv_reservation_status", ["ACTIVE", "CONSUMED", "RELEASED", "EXPIRED"]);
export const invLotStatusEnum = pgEnum("inv_lot_status", ["ACTIVE", "EXPIRED", "BLOCKED", "CONSUMED", "RECALLED"]);
export const invSerialStatusEnum = pgEnum("inv_serial_status", ["IN_STOCK", "RESERVED", "SHIPPED", "RETURNED", "SCRAPPED", "QUARANTINE"]);
export const invBarcodeTypeEnum = pgEnum("inv_barcode_type", ["GTIN", "EAN13", "UPC", "CODE128", "QR", "OTHER"]);
export const invReasonCategoryEnum = pgEnum("inv_reason_category", ["ADJUSTMENT", "COUNT", "SCRAP", "RETURN", "TRANSFER", "OTHER"]);
export const invVendorReturnReasonEnum = pgEnum("inv_vendor_return_reason", ["DAMAGED", "WRONG_ITEM", "EXCESS", "EXPIRED", "QUALITY_REJECTED"]);
/**
 * B9. `RETURN_TO_VENDOR` is the fourth answer an inspector can give.
 *
 * The goods are faulty but they are the supplier's fault, so they arrive, they
 * are not sellable, and they are not written off either — they wait for a vendor
 * RMA to take them away. Modelled as `BLOCKED` stock rather than a status flag:
 * they are physically on the shelf, and availability already subtracts
 * `blocked_qty`.
 */
export const invCustomerReturnDispositionEnum = pgEnum("inv_customer_return_disposition", ["RESTOCK", "QUARANTINE", "SCRAP", "RETURN_TO_VENDOR"]);
/**
 * INV-205. Why a pick line did not close the way it was asked to.
 *
 * B5 adds `WRONG_LOCATION`, and it is the one member that does not close the
 * line. The other four say the units are not coming: the shelf was short, the
 * bin was empty, the goods were broken, or something else went in the tote.
 * `WRONG_LOCATION` says the goods exist and the wave sent the picker to the
 * wrong place — the work is still outstanding, so the line is retargeted and
 * stays open rather than being written off.
 */
export const invPickExceptionEnum = pgEnum("inv_pick_exception", [
  "SHORT",
  "NOT_FOUND",
  "DAMAGED",
  "SUBSTITUTED",
  "WRONG_LOCATION",
]);
/**
 * B5. Where an exception is in its own life, separately from the line's.
 *
 * An exception nobody has looked at and one a supervisor has signed off are
 * different facts, and the enum on its own could not tell them apart — so a
 * substitution the picker invented at the shelf read exactly like one the
 * warehouse had agreed to.
 */
export const invPickExceptionStatusEnum = pgEnum("inv_pick_exception_status", [
  "OPEN",
  "RESOLVED",
]);
/** B5. What the reviewer decided. Set only when the exception is RESOLVED. */
export const invPickExceptionResolutionEnum = pgEnum("inv_pick_exception_resolution", [
  "ACCEPTED",
  "REJECTED",
]);

export const invPickListStatusEnum = pgEnum("inv_pick_list_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
/** B3. Where a putaway task is between the receiving dock and the shelf. */
export const invPutawayStatusEnum = pgEnum("inv_putaway_status", ["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
/**
 * B3. Where a putaway line is allowed to end up.
 *
 * `STORAGE` is the ordinary case and the destination is the operator's, chosen
 * from the suggestions. `QUARANTINE` is not a preference: it is set from the
 * quality state of the goods, and the destination is the warehouse's quarantine
 * location whatever the operator scans.
 */
export const invPutawayDispositionEnum = pgEnum("inv_putaway_disposition", ["STORAGE", "QUARANTINE"]);
export const invCycleCountStatusEnum = pgEnum("inv_cycle_count_status", ["PLANNED", "COUNTING", "REVIEW", "POSTED", "CANCELLED"]);
export const invQualityInspectionStatusEnum = pgEnum("inv_quality_inspection_status", ["PENDING", "IN_PROGRESS", "PASSED", "FAILED", "DISPOSITION_REQUIRED", "COMPLETED", "CANCELLED"]);
export const invQualityHoldStatusEnum = pgEnum("inv_quality_hold_status", ["ACTIVE", "RELEASED"]);
export const invQualityDispositionEnum = pgEnum("inv_quality_disposition", ["RELEASE_TO_AVAILABLE", "QUARANTINE", "RETURN_TO_VENDOR", "SCRAP"]);
/**
 * D3. How much of an arriving quantity an inspector has to physically check.
 *
 * It is the *sample*, never the hold: the whole delivered quantity is
 * quarantined pending the verdict whatever the sample size says, because a
 * sample that fails condemns the batch it was drawn from and not just the units
 * that were opened.
 */
export const invInspectionSamplingMethodEnum = pgEnum("inv_inspection_sampling_method", ["ALL", "PERCENTAGE", "FIXED_QUANTITY"]);
/**
 * A plan version is immutable once it leaves DRAFT — an inspection records the
 * version that governed it, so editing that version rewrites the rule a
 * completed result was judged against. Changing a rule publishes a new version
 * and supersedes the old one.
 */
export const invInspectionPlanVersionStatusEnum = pgEnum("inv_inspection_plan_version_status", ["DRAFT", "ACTIVE", "SUPERSEDED"]);
export const invRecallStatusEnum = pgEnum("inv_recall_status", ["OPEN", "IN_PROGRESS", "CLOSED"]);
export const invShipmentStatusEnum = pgEnum("inv_shipment_status", ["DRAFT", "PACKED", "LABEL_CREATED", "SHIPPED", "DELIVERED", "CANCELLED"]);
export const invPackageStatusEnum = pgEnum("inv_package_status", ["OPEN", "CLOSED", "SHIPPED"]);
export const invLoadStatusEnum = pgEnum("inv_load_status", ["DRAFT", "DISPATCHED", "ARRIVED", "CLOSED", "CANCELLED"]);
export const invChannelTypeEnum = pgEnum("inv_channel_type", ["INTERNAL", "SHOPIFY", "WOOCOMMERCE", "MARKETPLACE", "B2B", "THREE_PL"]);
export const invChannelStatusEnum = pgEnum("inv_channel_status", ["ACTIVE", "PAUSED"]);
export const invChannelPubStatusEnum = pgEnum("inv_channel_pub_status", ["PENDING", "PUBLISHED", "FAILED"]);
export const inv3plStatusEnum = pgEnum("inv_3pl_status", ["DISCONNECTED", "CONNECTED", "ERROR"]);

/**
 * E6 — the lifecycle of one inbound delivery from a sales channel.
 *
 * `PENDING` is "received and acknowledged, not yet refetched": the delivery row
 * *is* the queue, so a delivery that arrives while the drain is down is not
 * lost. `DEAD` is one whose refetch failed its whole ladder — kept rather than
 * deleted, because "the marketplace told us something and we never looked" is
 * exactly the fact an operator needs to see.
 */
export const invChannelDeliveryStatusEnum = pgEnum("inv_channel_delivery_status", ["PENDING", "PROCESSED", "FAILED", "DEAD"]);
export const invChannelSnapshotDiffStatusEnum = pgEnum("inv_channel_snapshot_diff_status", ["OPEN", "ACCEPTED", "DISMISSED"]);

/**
 * E6 — what an organisation has decided may happen when a channel disagrees
 * with the ledger.
 *
 * `RECORD_DIFFERENCE` is the default and does exactly what it says. It is not a
 * degraded mode: a marketplace's stock figure is that marketplace's opinion
 * about our warehouse, and an opinion that could post a movement would make the
 * ledger a mirror of whichever system last spoke.
 *
 * `ALLOW_ADJUSTMENT` does **not** mean the snapshot writes the ledger. It means
 * a named operator is permitted to accept a recorded difference, which then
 * posts one ordinary stock-engine command under their own idempotency key and
 * warehouse scope — the same path a manual adjustment takes.
 */
export const invChannelSnapshotPolicyEnum = pgEnum("inv_channel_snapshot_policy", ["RECORD_DIFFERENCE", "ALLOW_ADJUSTMENT"]);
export const invIdempotencyStatusEnum = pgEnum("inv_idempotency_status", ["IN_FLIGHT", "COMPLETED", "FAILED"]);
export const invJobStatusEnum = pgEnum("inv_job_status", ["PENDING", "VALIDATING", "RUNNING", "COMPLETED", "FAILED"]);

/** Per-row outcome, so a resumed import skips what already applied. */
export const invImportRowStatusEnum = pgEnum("inv_import_row_status", ["PENDING", "APPLIED", "FAILED", "SKIPPED"]);
export const invWebhookEventStatusEnum = pgEnum("inv_webhook_event_status", ["PENDING", "DELIVERED", "FAILED"]);
export const invReservationStrategyEnum = pgEnum("inv_reservation_strategy", ["MANUAL", "AUTO_ON_CONFIRM", "FEFO", "FIFO"]);
export const invExpiryPolicyEnum = pgEnum("inv_expiry_policy", ["BLOCK", "WARN", "ALLOW"]);
/**
 * D2 — what the allocator does with stock that is close to expiry but not expired.
 *
 * Distinct from `invExpiryPolicyEnum`, which decides whether *already expired*
 * stock may be promised at all. This one is about short-dated stock: physically
 * fine, saleable, and often refused on arrival by the customer. `DEPRIORITIZE`
 * keeps it allocatable but takes it last; `BLOCK` refuses it automatically and
 * leaves it for a person holding `inventory:allocation:override` to choose
 * deliberately.
 */
export const invNearExpiryPolicyEnum = pgEnum("inv_near_expiry_policy", ["ALLOW", "DEPRIORITIZE", "BLOCK"]);
/**
 * G5 — a landed-cost voucher has two states and no third.
 *
 * DRAFT is editable and has moved no money; APPLIED has revalued cost layers and
 * posted a journal entry, and is terminal. There is deliberately no VOID: undoing
 * an applied voucher means un-revaluing layers that a later issue may already
 * have drawn from at the landed rate, and that reversal is a document of its own
 * rather than a status flip.
 */
export const invLandedCostStatusEnum = pgEnum("inv_landed_cost_status", ["DRAFT", "APPLIED"]);
/** How a charge is spread across the receipt's cost layers. */
export const invLandedCostBasisEnum = pgEnum("inv_landed_cost_basis", ["VALUE", "QUANTITY"]);
export const invLandedCostChargeTypeEnum = pgEnum("inv_landed_cost_charge_type", [
  "FREIGHT",
  "DUTY",
  "INSURANCE",
  "HANDLING",
  "OTHER",
]);
export const invAiInsightStatusEnum = pgEnum("inv_ai_insight_status", ["NEW", "ACKNOWLEDGED", "DISMISSED"]);

/**
 * F6 — what a person says about an AI answer they were shown.
 *
 * Four verdicts rather than a thumb, because the four are acted on differently
 * and collapsing them destroys the only signal worth having. `WRONG` is a claim
 * about the arithmetic and points at the deterministic layer. `STALE` says the
 * numbers were right when computed and are not any more, which is a caching and
 * evidence-hash question, not a model question. `UNSAFE` is the one that must
 * never be averaged into a satisfaction ratio: it means the answer proposed
 * something an operator should not do, and one of those matters more than a
 * hundred `USEFUL`s.
 *
 * A pg enum rather than free text so an unknown verdict cannot be stored at all
 * — a text column with an application-side union drifts the first time a client
 * sends something else.
 */
export const invAiFeedbackVerdictEnum = pgEnum("inv_ai_feedback_verdict", [
  "USEFUL",
  "WRONG",
  "STALE",
  "UNSAFE",
]);

export const partyTypeEnum = pgEnum("party_type", ["CUSTOMER", "VENDOR", "PARTNER", "BOTH"]);

/**
 * Whether a party is a person or a company.
 *
 * A second axis, not a fifth `party_type`. `party_type` says what a party is
 * *to us* — and `party_roles` says it better, which is why `clients.is_vendor`
 * became a row there rather than a column. Being a company is not a
 * relationship: it is not multi-valued, it does not change when a prospect
 * becomes a customer, and a company is obviously both an organisation and a
 * customer. Putting ORGANISATION into `party_type` would force a choice between
 * those two and repeat the mistake the phase has now refused twice.
 */
export const partyKindEnum = pgEnum("party_kind", ["PERSON", "ORGANISATION"]);

export const portalAudienceEnum = pgEnum("portal_audience", ["CLIENT_PORTAL"]);
export const portalMembershipStatusEnum = pgEnum("portal_membership_status", ["PENDING", "ACTIVE", "SUSPENDED", "REVOKED"]);
export const portalInvitationStatusEnum = pgEnum("portal_invitation_status", ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"]);
export const portalGrantStatusEnum = pgEnum("portal_grant_status", ["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"]);
export const commandFenceStatusEnum = pgEnum("command_fence_status", ["IN_FLIGHT", "COMPLETED", "FAILED"]);
export const organizationStatusEnum = pgEnum("organization_status", ["ACTIVE", "ARCHIVED", "PURGE_SCHEDULED", "PURGED"]);
export const invitationStatusEnum = pgEnum("invitation_status", ["PENDING", "ACCEPTED", "DECLINED", "EXPIRED", "REVOKED"]);
export const broadcastAudienceTypeEnum = pgEnum("broadcast_audience_type", ["all", "roles", "departments", "users"]);
export const templateApprovalStatusEnum = pgEnum("template_approval_status", ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"]);
export const emailOutboxScopeEnum = pgEnum("email_outbox_scope", ["PLATFORM", "TENANT"]);

/**
 * NEO-2 — the quick-commerce networks a seller receives purchase orders from.
 *
 * These are *inbound* platforms: Streamline is the brand's system, and Blinkit,
 * Instamart and Zepto each run their own dark-store WMS. What crosses the
 * boundary is a purchase order and an advance shipping notice, never stock.
 */
export const invQcProviderEnum = pgEnum("inv_qc_provider", ["BLINKIT", "INSTAMART", "ZEPTO"]);

/** NEO-2. Where an ingested platform purchase order stands. */
export const invPlatformPoStatusEnum = pgEnum("inv_platform_po_status", [
  "RECEIVED",
  "REJECTED",
  "ACCEPTED",
  "CANCELLED",
]);

/** NEO-2. An advance shipping notice's life, from raised to received. */
export const invAsnStatusEnum = pgEnum("inv_asn_status", [
  "DRAFT",
  "CONFIRMED",
  "IN_TRANSIT",
  "ARRIVED",
  "CLOSED",
  "CANCELLED",
]);

/**
 * NEO-4 - what kind of thing the label is stuck to. Descriptive only: the engine
 * treats every kind identically, and the distinction is for the floor and for
 * carrier paperwork.
 */
export const invHandlingUnitKindEnum = pgEnum("inv_handling_unit_kind", [
  "PALLET",
  "CARTON",
  "CAGE",
  "TOTE",
]);

/**
 * NEO-4 - a handling unit's life.
 *
 * `OPEN` accepts more stock; `CLOSED` is built and may still be moved or picked
 * from; `SHIPPED` has left; `EMPTY` held stock and no longer does, kept rather
 * than deleted so a label that is scanned again resolves to its history instead
 * of to nothing.
 */
export const invHandlingUnitStatusEnum = pgEnum("inv_handling_unit_status", [
  "OPEN",
  "CLOSED",
  "SHIPPED",
  "EMPTY",
]);
