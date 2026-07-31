import { Injectable } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { crmPipelines, crmPipelineStages, crmOptions, crmAutomationEvents, crmAutomationActions } from "../../../db/schema";

@Injectable()
export class CrmMetadataSeedService {
  async seedCrmDefaults(db: Db, orgId: string): Promise<void> {
    const leadPipelineId = crypto.randomUUID();
    const dealPipelineId = crypto.randomUUID();

    await db.insert(crmPipelines).values([
      { id: leadPipelineId, orgId, type: "lead", key: "default_lead", name: "Lead Pipeline", isDefault: true, isActive: true, sortOrder: 0 },
      { id: dealPipelineId, orgId, type: "deal", key: "default_deal", name: "Deal Pipeline", isDefault: true, isActive: true, sortOrder: 1 },
    ]).onConflictDoNothing();

    await db.insert(crmPipelineStages).values([
      { id: crypto.randomUUID(), orgId, pipelineId: leadPipelineId, key: "NEW", label: "New", stageType: "open", probability: 0, sortOrder: 0, color: "blue", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: leadPipelineId, key: "CONTACTED", label: "Contacted", stageType: "open", probability: 20, sortOrder: 1, color: "blue", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: leadPipelineId, key: "INTERESTED", label: "Interested", stageType: "open", probability: 40, sortOrder: 2, color: "amber", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: leadPipelineId, key: "QUALIFIED", label: "Qualified", stageType: "open", probability: 60, sortOrder: 3, color: "emerald", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: leadPipelineId, key: "CONVERTED", label: "Converted", stageType: "won", probability: 100, sortOrder: 4, color: "emerald", isSystemDefault: true, isActive: true, isTerminal: true, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: leadPipelineId, key: "LOST", label: "Lost", stageType: "lost", probability: 0, sortOrder: 5, color: "red", isSystemDefault: true, isActive: true, isTerminal: true, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: dealPipelineId, key: "LEAD", label: "Lead", stageType: "open", probability: 10, sortOrder: 0, color: "slate", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: dealPipelineId, key: "CONTACTED", label: "Contacted", stageType: "open", probability: 20, sortOrder: 1, color: "blue", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: dealPipelineId, key: "PROPOSAL", label: "Proposal", stageType: "open", probability: 50, sortOrder: 2, color: "amber", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: dealPipelineId, key: "NEGOTIATION", label: "Negotiation", stageType: "open", probability: 75, sortOrder: 3, color: "amber", isSystemDefault: true, isActive: true, isTerminal: false, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: dealPipelineId, key: "WON", label: "Won", stageType: "won", probability: 100, sortOrder: 4, color: "emerald", isSystemDefault: true, isActive: true, isTerminal: true, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
      { id: crypto.randomUUID(), orgId, pipelineId: dealPipelineId, key: "LOST", label: "Lost", stageType: "lost", probability: 0, sortOrder: 5, color: "red", isSystemDefault: true, isActive: true, isTerminal: true, requiresApproval: false, slaHours: null, requiredFields: [], allowedNextStageKeys: null },
    ]).onConflictDoNothing();

    await db.insert(crmOptions).values([
      { id: crypto.randomUUID(), orgId, type: "lead_status", key: "NEW", label: "New", color: "blue", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lead_status", key: "CONTACTED", label: "Contacted", color: "blue", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lead_status", key: "INTERESTED", label: "Interested", color: "amber", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lead_status", key: "QUALIFIED", label: "Qualified", color: "emerald", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lead_status", key: "CONVERTED", label: "Converted", color: "emerald", sortOrder: 4, isSystemDefault: true, isActive: true, isTerminal: true },
      { id: crypto.randomUUID(), orgId, type: "lead_status", key: "LOST", label: "Lost", color: "red", sortOrder: 5, isSystemDefault: true, isActive: true, isTerminal: true },
      { id: crypto.randomUUID(), orgId, type: "priority", key: "HOT", label: "Hot", color: "red", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "priority", key: "WARM", label: "Warm", color: "amber", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "priority", key: "COLD", label: "Cold", color: "slate", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "referral", label: "Referral", color: "emerald", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "campaign", label: "Campaign", color: "blue", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "cold_call", label: "Cold Call", color: "slate", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "website", label: "Website", color: "blue", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "social_media", label: "Social Media", color: "blue", sortOrder: 4, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "walk_in", label: "Walk In", color: "slate", sortOrder: 5, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "source", key: "other", label: "Other", color: "slate", sortOrder: 6, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "activity_type", key: "call", label: "Call", color: "blue", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "activity_type", key: "email", label: "Email", color: "blue", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "activity_type", key: "whatsapp", label: "WhatsApp", color: "emerald", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "activity_type", key: "meeting", label: "Meeting", color: "amber", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "activity_type", key: "site_visit", label: "Site Visit", color: "slate", sortOrder: 4, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lost_reason", key: "price", label: "Price", color: "red", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lost_reason", key: "competitor", label: "Competitor", color: "red", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lost_reason", key: "timing", label: "Timing", color: "slate", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lost_reason", key: "no_budget", label: "No Budget", color: "slate", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "lost_reason", key: "no_need", label: "No Need", color: "slate", sortOrder: 4, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "task_type", key: "CALL", label: "Call", color: "blue", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "task_type", key: "EMAIL", label: "Email", color: "blue", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "task_type", key: "MEETING", label: "Meeting", color: "amber", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "task_type", key: "CUSTOM", label: "Custom", color: "slate", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "contact_role", key: "decision_maker", label: "Decision Maker", color: "blue", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "contact_role", key: "influencer", label: "Influencer", color: "violet", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "contact_role", key: "champion", label: "Champion", color: "emerald", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "contact_role", key: "blocker", label: "Blocker", color: "red", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "contact_role", key: "economic_buyer", label: "Economic Buyer", color: "amber", sortOrder: 4, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "contact_role", key: "user", label: "User", color: "slate", sortOrder: 5, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "forecast_category", key: "pipeline", label: "Pipeline", color: "blue", sortOrder: 0, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "forecast_category", key: "best_case", label: "Best Case", color: "cyan", sortOrder: 1, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "forecast_category", key: "commit", label: "Commit", color: "emerald", sortOrder: 2, isSystemDefault: true, isActive: true, isTerminal: false },
      { id: crypto.randomUUID(), orgId, type: "forecast_category", key: "omitted", label: "Omitted", color: "slate", sortOrder: 3, isSystemDefault: true, isActive: true, isTerminal: false },
    ]).onConflictDoNothing();

    await db.insert(crmAutomationEvents).values([
      { id: crypto.randomUUID(), orgId, key: "lead.created", label: "Lead Created", entityType: "lead", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "lead.updated", label: "Lead Updated", entityType: "lead", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "lead.stage_changed", label: "Lead Stage Changed", entityType: "lead", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "lead.score_changed", label: "Lead Score Changed", entityType: "lead", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "lead.assigned", label: "Lead Assigned", entityType: "lead", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "deal.created", label: "Deal Created", entityType: "deal", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "deal.stage_changed", label: "Deal Stage Changed", entityType: "deal", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "deal.won", label: "Deal Won", entityType: "deal", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "deal.lost", label: "Deal Lost", entityType: "deal", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "task.overdue", label: "Task Overdue", entityType: "task", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "email.replied", label: "Email Replied", entityType: "email", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "form.submitted", label: "Form Submitted", entityType: "form", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "quote.sent", label: "Quote Sent", entityType: "quote", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "quote.signed", label: "Quote Signed", entityType: "quote", isSystemDefault: true, isActive: true },
      { id: crypto.randomUUID(), orgId, key: "invoice.paid", label: "Invoice Paid", entityType: "invoice", isSystemDefault: true, isActive: true },
    ]).onConflictDoNothing();

    await db.insert(crmAutomationActions).values([
      { id: crypto.randomUUID(), orgId, key: "assign_owner", label: "Assign Owner", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "update_field", label: "Update Field", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "create_task", label: "Create Task", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "send_notification", label: "Send Notification", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "send_email", label: "Send Email", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "send_whatsapp", label: "Send WhatsApp", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "add_tag", label: "Add Tag", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "remove_tag", label: "Remove Tag", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "create_deal", label: "Create Deal", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "create_quote", label: "Create Quote", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "call_webhook", label: "Call Webhook", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "start_sequence", label: "Start Sequence", isSystemDefault: true, isActive: true, configSchema: null },
      { id: crypto.randomUUID(), orgId, key: "stop_sequence", label: "Stop Sequence", isSystemDefault: true, isActive: true, configSchema: null },
    ]).onConflictDoNothing();
  }
}

export async function seedCrmDefaults(db: Db, orgId: string): Promise<void> {
  const svc = new CrmMetadataSeedService();
  return svc.seedCrmDefaults(db, orgId);
}
