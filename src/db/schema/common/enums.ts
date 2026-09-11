
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * `enums.ts` is the contract, not the file layout: every pgEnum in the schema is
 * importable from here, and 100+ call sites say `from "../common/enums"`. The four
 * domain files below hold the declarations verbatim; what stays in this file is the
 * platform and cross-module set — work items, CRM, notifications, billing, support,
 * knowledge, accounting, onboarding, payments, party and portal — which has no
 * vertical of its own to move to.
 */
export * from "./enums-people";
export * from "./enums-inventory";
export * from "./enums-inventory-fulfilment";
export * from "./enums-inventory-verticals";

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
