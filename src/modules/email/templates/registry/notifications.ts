import {
  getTaskAssignedEmailTemplate,
  getDealStageChangeEmailTemplate,
  getLeadAssignedEmailTemplate,
  getReviewAssignedEmailTemplate,
  getAssetAssignedEmailTemplate,
  getOnboardingWelcomeEmailTemplate,
  getOnboardingTaskEmailTemplate,
  getOnboardingCompleteEmployeeEmailTemplate,
  getOnboardingCompleteHrEmailTemplate,
  getTicketCreatedEmailTemplate,
  getTicketReplyEmailTemplate,
  getTicketStatusEmailTemplate,
  getHelpdeskTicketEmailTemplate,
  getWorkLogApprovedEmailTemplate,
  getWorkLogRejectedEmailTemplate,
  getOnboardingReminderEmailTemplate,
} from "../index";
import { BRAND } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const notificationsTemplates: Record<string, TemplateEntry> = {
  "notif.task_assigned": {
    category: "Notifications",
    name: "Task Assigned",
    subject: "Task assigned: Follow up with Raj Industries",
    generateHtml: () =>
      getTaskAssignedEmailTemplate(
        "Priya Sharma",
        "Follow up with Raj Industries",
        "Call",
        "Mon, 7 Jul 2026",
        "Rahul Verma",
        "Lead: Raj Industries",
      ),
  },
  "notif.deal_stage_change": {
    category: "Notifications",
    name: "Deal Stage Change",
    subject: "Deal stage updated: Phoenix Project",
    generateHtml: () =>
      getDealStageChangeEmailTemplate(
        "Priya Sharma",
        "Phoenix Project",
        "Proposal",
        "Negotiation",
        "12,00,000",
        "Rahul Verma",
        7,
      ),
  },
  "notif.lead_assigned": {
    category: "Notifications",
    name: "Lead Assigned",
    subject: "Lead assigned: Raj Industries",
    generateHtml: () =>
      getLeadAssignedEmailTemplate("Priya Sharma", "Raj Industries", "Inbound", "HOT", "Rahul Verma"),
  },
  "notif.review_assigned": {
    category: "Notifications",
    name: "Performance Review Assigned",
    subject: "Performance review assigned",
    generateHtml: () =>
      getReviewAssignedEmailTemplate("Priya Sharma", "Rahul Verma", "1 Apr 2026", "30 Jun 2026"),
  },
  "notif.asset_assigned": {
    category: "Notifications",
    name: "Asset Assigned",
    subject: "Asset assigned: MacBook Pro 14",
    generateHtml: () =>
      getAssetAssignedEmailTemplate("Priya Sharma", "MacBook Pro 14", "Laptop", "SN-MBP-2026-001"),
  },
  "notif.onboarding_welcome": {
    category: "Notifications",
    name: "Onboarding Welcome",
    subject: `Welcome to ${BRAND}`,
    generateHtml: () =>
      getOnboardingWelcomeEmailTemplate("Arjun Kapoor", "Junior Developer", "Mon, 7 Jul 2026", 6),
  },
  "notif.onboarding_task": {
    category: "Notifications",
    name: "Onboarding Tasks Assigned",
    subject: "Onboarding tasks assigned to you",
    generateHtml: () => getOnboardingTaskEmailTemplate("Priya Sharma", "Arjun Kapoor", "IT", 3),
  },
  "notif.onboarding_complete_employee": {
    category: "Notifications",
    name: "Onboarding Complete (Employee)",
    subject: "Onboarding complete",
    generateHtml: () => getOnboardingCompleteEmployeeEmailTemplate("Arjun Kapoor"),
  },
  "notif.onboarding_complete_hr": {
    category: "Notifications",
    name: "Onboarding Complete (HR)",
    subject: "Arjun Kapoor completed onboarding",
    generateHtml: () => getOnboardingCompleteHrEmailTemplate("Priya Sharma", "Arjun Kapoor"),
  },
  "notif.onboarding_reminder": {
    category: "Notifications",
    name: "Onboarding Reminder",
    subject: "Onboarding reminder",
    generateHtml: () => getOnboardingReminderEmailTemplate("Arjun Kapoor", 3, 6),
  },
  "notif.ticket_created": {
    category: "Notifications",
    name: "Support Ticket Created",
    subject: "New support ticket: Unable to export reports",
    generateHtml: () =>
      getTicketCreatedEmailTemplate("Priya Sharma", "Unable to export reports", "HIGH", "Rahul Verma", 101),
  },
  "notif.ticket_reply": {
    category: "Notifications",
    name: "Ticket Reply",
    subject: "New reply on ticket #101",
    generateHtml: () =>
      getTicketReplyEmailTemplate(
        "Rahul Verma",
        "Unable to export reports",
        101,
        "Priya Sharma",
        "We identified the root cause and a fix is being deployed shortly.",
      ),
  },
  "notif.ticket_status": {
    category: "Notifications",
    name: "Ticket Status Update",
    subject: "Ticket #101 status: RESOLVED",
    generateHtml: () =>
      getTicketStatusEmailTemplate("Rahul Verma", "Unable to export reports", 101, "RESOLVED", "Priya Sharma"),
  },
  "notif.helpdesk_ticket": {
    category: "Notifications",
    name: "Helpdesk Ticket",
    subject: "New helpdesk ticket: Laptop overheating",
    generateHtml: () =>
      getHelpdeskTicketEmailTemplate("Priya Sharma", "Laptop overheating", "Hardware", "MEDIUM", "Arjun Kapoor"),
  },
  "notif.work_log_approved": {
    category: "Notifications",
    name: "Work Log Approved",
    subject: "Your work log was approved",
    generateHtml: () => getWorkLogApprovedEmailTemplate("Priya Sharma", "30 Jun 2026", "Rahul Verma"),
  },
  "notif.work_log_rejected": {
    category: "Notifications",
    name: "Work Log Needs Changes",
    subject: "Your work log needs changes",
    generateHtml: () =>
      getWorkLogRejectedEmailTemplate(
        "Priya Sharma",
        "30 Jun 2026",
        "Rahul Verma",
        "Please add more detail on the task descriptions.",
      ),
  },
};
