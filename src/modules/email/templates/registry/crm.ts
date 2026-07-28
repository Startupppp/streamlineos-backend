import {
  getClientInvestmentEmailTemplate,
  getLeadStatusChangeEmailTemplate,
  getLeadDistributionEmailTemplate,
} from "../index";
import { BASE_URL } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const crmTemplates: Record<string, TemplateEntry> = {
  "crm.client_investment": {
    category: "CRM",
    name: "Client Investment Recorded",
    subject: "Investment recorded for Acme Corp",
    generateHtml: () =>
      getClientInvestmentEmailTemplate({
        recipientName: "Rahul Verma",
        clientName: "Acme Corp",
        amount: "5,00,000",
        date: "Mon, 7 Jul 2026",
        recordedBy: "Priya Sharma",
        clientUrl: `${BASE_URL}/crm/clients/1`,
      }).html,
  },
  "crm.lead_status_change": {
    category: "CRM",
    name: "Lead Status Change",
    subject: "Lead status updated: Raj Industries",
    generateHtml: () =>
      getLeadStatusChangeEmailTemplate({
        recipientName: "Rahul Verma",
        leadName: "Raj Industries",
        fromStatus: "New",
        toStatus: "Qualified",
        leadUrl: `${BASE_URL}/crm/leads/5`,
      }).html,
  },
  "crm.lead_distribution": {
    category: "CRM",
    name: "Lead Distribution",
    subject: "3 leads assigned to you",
    generateHtml: () =>
      getLeadDistributionEmailTemplate({
        recipientName: "Priya Sharma",
        assignerName: "Rahul Verma",
        leadCount: 3,
        leadsUrl: `${BASE_URL}/crm/leads`,
      }).html,
  },
};
