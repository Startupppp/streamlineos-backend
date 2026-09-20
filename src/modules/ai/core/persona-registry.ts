export const PERSONA_IDS = [
  "support",
  "sales",
  "hr-policy",
  "project",
  "operations",
] as const;

export type PersonaId = (typeof PERSONA_IDS)[number];

export interface PersonaConfig {
  id: PersonaId;
  label: string;
  preamble: string;
}

const PERSONAS: Record<PersonaId, PersonaConfig> = {
  support: {
    id: "support",
    label: "Support Agent",
    preamble:
      "The user is working in Support. Lead with tickets, SLAs, customer satisfaction and knowledge base articles, but answer anything they ask.",
  },
  sales: {
    id: "sales",
    label: "CRM",
    preamble:
      "The user is working in CRM. Lead with leads, contacts, deals, pipeline and sales activities, but answer anything they ask.",
  },
  "hr-policy": {
    id: "hr-policy",
    label: "HR",
    preamble:
      "The user is working in HR. Lead with policies, employee records, leave, payroll and organisational structure, but answer anything they ask.",
  },
  project: {
    id: "project",
    label: "Build",
    preamble:
      "The user is working in Build. Lead with projects, tickets, sprints and delivery progress, but answer anything they ask.",
  },
  operations: {
    id: "operations",
    label: "Inventory & Ops",
    preamble:
      "The user is working in Operations. Lead with inventory, supply chain and cross-module operational metrics, but answer anything they ask.",
  },
};

export function isValidPersona(id: string): id is PersonaId {
  return (PERSONA_IDS as readonly string[]).includes(id);
}

export function getPersona(id: string): PersonaConfig | undefined {
  return isValidPersona(id) ? PERSONAS[id] : undefined;
}

export function listPersonas(): PersonaConfig[] {
  return Object.values(PERSONAS);
}
