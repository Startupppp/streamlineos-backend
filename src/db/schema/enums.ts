
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
export const expenseStatusEnum = pgEnum("expense_status", ["PENDING", "APPROVED", "REJECTED", "PAID"]);
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
export const bonusTypeEnum = pgEnum("bonus_type", ["PERFORMANCE", "FESTIVAL", "REFERRAL", "SPOT", "ANNUAL"]);
export const fnfStatusEnum = pgEnum("fnf_status", ["DRAFT", "PENDING_APPROVAL", "APPROVED", "PAID"]);
export const terminationStatusEnum = pgEnum("termination_status", ["DRAFT", "PENDING_CEO", "APPROVED", "REJECTED", "SENT", "COMPLETED"]);
export const onboardingDocStatusEnum = pgEnum("onboarding_doc_status", ["PENDING", "IN_PROGRESS", "SUBMITTED", "APPROVED"]);
export const onboardingDocumentStatusEnum = pgEnum("onboarding_document_status", ["PENDING", "SUBMITTED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED"]);
export const docAuditActionEnum = pgEnum("doc_audit_action", ["UPLOADED", "APPROVED", "REJECTED", "RE_UPLOAD_REQUESTED", "RE_UPLOADED"]);

export const leadPipelineStatusEnum = pgEnum("lead_pipeline_status", ["NEW", "CONTACTED", "INTERESTED", "QUALIFIED", "CONVERTED", "LOST"]);
export const leadActivityTypeEnum = pgEnum("lead_activity_type", ["call", "email", "whatsapp", "meeting", "site_visit"]);
export const leadSourceEnum = pgEnum("lead_source", ["referral", "campaign", "cold_call", "website", "social_media", "walk_in", "other"]);
export const leadPriorityEnum = pgEnum("lead_priority", ["HOT", "WARM", "COLD"]);
export const leadEmailDirectionEnum = pgEnum("lead_email_direction", ["sent", "received"]);
export const leadTaskStatusEnum = pgEnum("lead_task_status", ["open", "done"]);
export const dealStageEnum = pgEnum("deal_stage", ["LEAD", "CONTACTED", "PROPOSAL", "NEGOTIATION", "WON", "LOST"]);
export const dealActivityTypeEnum = pgEnum("deal_activity_type", ["stage_change", "note", "call", "email", "meeting", "document"]);
export const clientAccountStatusEnum = pgEnum("client_account_status", ["ACCOUNT_OPENING", "QUERIES", "PLAN_SELECTED", "INVESTED"]);
export const incentiveStatusEnum = pgEnum("incentive_status", ["PENDING", "APPROVED", "REJECTED", "ADDED_TO_PAYROLL"]);
export const scoringOperatorEnum = pgEnum("scoring_operator", ["eq", "gt", "lt", "contains", "in"]);
export const assignmentRuleTypeEnum = pgEnum("assignment_rule_type", ["assign_user", "round_robin"]);
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

export const invoiceStatusEnum = pgEnum("invoice_status", ["DRAFT", "SENT", "PAID", "OVERDUE", "CANCELLED"]);

export const supportTicketStatusEnum = pgEnum("support_ticket_status", ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"]);
export const supportTicketPriorityEnum = pgEnum("support_ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const quoteStatusEnum = pgEnum("quote_status", ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["TRIAL", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"]);
export const subscriptionPlanEnum = pgEnum("subscription_plan", ["STARTER", "PROFESSIONAL", "ENTERPRISE"]);

export const taskEntityTypeEnum = pgEnum("task_entity_type", ["LEAD", "DEAL", "CONTACT", "PROJECT"]);
export const taskTypeEnum = pgEnum("task_type", ["CALL", "EMAIL", "MEETING", "CUSTOM"]);
export const taskStatusEnum = pgEnum("task_status", ["pending", "completed", "cancelled"]);

export const blogPostStatusEnum = pgEnum("blog_post_status", ["draft", "published", "archived"]);

export const accountTypeEnum = pgEnum("account_type", ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);
export const journalEntryStatusEnum = pgEnum("journal_entry_status", ["DRAFT", "POSTED", "VOID"]);

export const invProductStatusEnum = pgEnum("inv_product_status", ["ACTIVE", "INACTIVE", "DISCONTINUED"]);
export const invAdjReasonEnum = pgEnum("inv_adj_reason", ["PURCHASE", "SALE", "RETURN", "DAMAGE", "EXPIRY", "THEFT", "RECOUNT", "OTHER"]);
export const invTxnTypeEnum = pgEnum("inv_txn_type", ["PURCHASE", "SALE", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT", "RETURN_IN", "RETURN_OUT", "GRN"]);
export const invPoStatusEnum = pgEnum("inv_po_status", ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED", "CANCELLED"]);
export const invSoStatusEnum = pgEnum("inv_so_status", ["DRAFT", "CONFIRMED", "SHIPPED", "INVOICED", "CANCELLED"]);
export const invTransferStatusEnum = pgEnum("inv_transfer_status", ["PENDING", "IN_TRANSIT", "COMPLETED", "CANCELLED"]);
export const invLocationTypeEnum = pgEnum("inv_location_type", ["ZONE", "AISLE", "RACK", "BIN"]);
export const invGrnQualityEnum = pgEnum("inv_grn_quality", ["ACCEPTED", "REJECTED"]);
