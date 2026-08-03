export type PersonaId = "support" | "sales" | "hr-policy" | "project" | "operations";

export interface PersonaConfig {
  id: PersonaId;
  label: string;
  preamble: string;
  allowedTools: ReadonlyArray<string>;
}

const PERSONAS: Record<PersonaId, PersonaConfig> = {
  support: {
    id: "support",
    label: "Support Agent",
    preamble:
      "You are the StreamlineOS Support Copilot. Focus exclusively on customer support: ticket management, SLA tracking, customer satisfaction, and knowledge base articles. Do not discuss sales, HR, finance, or project topics.",
    allowedTools: ["searchKnowledgeBase", "findPerson", "getPersonTicketStats", "searchChatMessages"],
  },
  sales: {
    id: "sales",
    label: "Sales Assistant",
    preamble:
      "You are the StreamlineOS Sales Copilot. Focus on CRM: leads, contacts, deals, pipeline, and sales activities. Do not discuss HR, support operations, or internal project management.",
    allowedTools: [
      "searchLeads",
      "updateLeadStatus",
      "createTask",
      "sendEmail",
      "scheduleEvent",
      "sendDirectMessage",
      "findPerson",
    ],
  },
  "hr-policy": {
    id: "hr-policy",
    label: "HR Policy",
    preamble:
      "You are the StreamlineOS HR Policy Copilot. Answer questions about HR policies, employee records, leave balances, payroll, and organizational structure. Do not discuss customer data, sales deals, or project details.",
    allowedTools: [
      "askHrPolicy",
      "getHeadcountSummary",
      "getAttritionSummary",
      "getMoodTrend",
      "getLeaveUtilization",
      "getMyLeaveBalances",
      "getPayrollSummary",
      "draftPerformanceReviewNote",
      "draftPromotionLetter",
      "findPerson",
      "grantRecognition",
    ],
  },
  project: {
    id: "project",
    label: "Project Manager",
    preamble:
      "You are the StreamlineOS Project Copilot. Focus on project and ticket management: creating tasks, tracking progress, updating statuses, assigning work. Do not discuss CRM, HR policies, or finance.",
    allowedTools: [
      "searchProjects",
      "getProjectSummary",
      "askProjectAI",
      "searchTickets",
      "readTicket",
      "createTicket",
      "updateTicketStatus",
      "addTicketComment",
      "createCalendarReminder",
      "findPerson",
      "getPersonTicketStats",
    ],
  },
  operations: {
    id: "operations",
    label: "Operations",
    preamble:
      "You are the StreamlineOS Operations Copilot. Focus on inventory, supply chain, financial reporting, and cross-module operational metrics. Do not discuss individual HR matters or customer support tickets.",
    allowedTools: [
      "getInventoryStock",
      "getPayrollSummary",
      "scheduleEvent",
      "getMyCalendarEvents",
      "findPerson",
    ],
  },
};

export function getPersona(id: string): PersonaConfig | undefined {
  return PERSONAS[id as PersonaId];
}

export function isValidPersona(id: string): id is PersonaId {
  return id in PERSONAS;
}

export function listPersonas(): PersonaConfig[] {
  return Object.values(PERSONAS);
}

export function filterToolsByPersona<T extends Record<string, unknown>>(
  allTools: T,
  personaId: string,
): Partial<T> {
  const persona = getPersona(personaId);
  if (!persona) return allTools;
  const allowed = new Set(persona.allowedTools);
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => allowed.has(name)),
  ) as Partial<T>;
}
