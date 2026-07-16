export type PlanTier = "FREE" | "PAID" | "ENTERPRISE";
export type EffectivePlan = "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";
export type LimitKey =
  | "members"
  | "projects"
  | "kbPages"
  | "chatChannels"
  | "crmLeads"
  | "crmContacts"
  | "crmDeals"
  | "supportTickets"
  | "automations"
  | "signEnvelopes"
  | "surveys"
  | "acctInvoices";

export interface PlanLimitEntry {
  FREE: number | null;
  STARTER: number | null;
  PROFESSIONAL: number | null;
  ENTERPRISE: number | null;
}

export const PLAN_LIMITS: Record<LimitKey, PlanLimitEntry> = {
  members:        { FREE: 5,   STARTER: 10,   PROFESSIONAL: 50,    ENTERPRISE: 500 },
  projects:       { FREE: 2,   STARTER: 25,   PROFESSIONAL: null,  ENTERPRISE: null },
  kbPages:        { FREE: 10,  STARTER: 500,  PROFESSIONAL: null,  ENTERPRISE: null },
  chatChannels:   { FREE: 1,   STARTER: 50,   PROFESSIONAL: 200,   ENTERPRISE: null },
  crmLeads:       { FREE: 100, STARTER: 5000, PROFESSIONAL: 50000, ENTERPRISE: null },
  crmContacts:    { FREE: 100, STARTER: 5000, PROFESSIONAL: 50000, ENTERPRISE: null },
  crmDeals:       { FREE: 50,  STARTER: 2500, PROFESSIONAL: 25000, ENTERPRISE: null },
  supportTickets: { FREE: 50,  STARTER: 2000, PROFESSIONAL: null,  ENTERPRISE: null },
  automations:    { FREE: 1,   STARTER: 20,   PROFESSIONAL: 100,   ENTERPRISE: null },
  signEnvelopes:  { FREE: 3,   STARTER: 50,   PROFESSIONAL: 250,   ENTERPRISE: null },
  surveys:        { FREE: 3,   STARTER: 25,   PROFESSIONAL: null,  ENTERPRISE: null },
  acctInvoices:   { FREE: 10,  STARTER: null, PROFESSIONAL: null,  ENTERPRISE: null },
};

export interface PlanFeatureFlags {
  chatGroupHuddles: boolean;
  chatVoiceVideo: boolean;
  kbPublicSharing: boolean;
  hrFull: boolean;
}

export const PLAN_FEATURE_FLAGS: Record<PlanTier, PlanFeatureFlags> = {
  FREE:       { chatGroupHuddles: false, chatVoiceVideo: false, kbPublicSharing: false, hrFull: false },
  PAID:       { chatGroupHuddles: true,  chatVoiceVideo: true,  kbPublicSharing: true,  hrFull: true },
  ENTERPRISE: { chatGroupHuddles: true,  chatVoiceVideo: true,  kbPublicSharing: true,  hrFull: true },
};

export const PLAN_LOCKED_MODULES: Record<PlanTier, string[]> = {
  FREE:       ["payroll", "inventory"],
  PAID:       [],
  ENTERPRISE: [],
};

export const PLAN_LABELS: Record<EffectivePlan, string> = {
  FREE:         "Free",
  STARTER:      "Starter",
  PROFESSIONAL: "Professional",
  ENTERPRISE:   "Enterprise",
};

export const LIMIT_HUMAN_LABELS: Record<LimitKey, string> = {
  members:        "members",
  projects:       "projects",
  kbPages:        "knowledge base pages",
  chatChannels:   "chat channels",
  crmLeads:       "CRM leads",
  crmContacts:    "CRM contacts",
  crmDeals:       "CRM deals",
  supportTickets: "support tickets",
  automations:    "automations",
  signEnvelopes:  "sign envelopes",
  surveys:        "surveys",
  acctInvoices:   "invoices",
};
