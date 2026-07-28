export interface CrmDraftCase {
  name: string;
  leadContext: Record<string, unknown>;
  draftKind: "email" | "nba";
  mustGroundOnFields: string[];
  mustNotFabricate: string[];
}

export const CRM_DRAFTS_DATASET: readonly CrmDraftCase[] = [
  {
    name: "email-warm-lead",
    leadContext: {
      name: "Sarah Chen",
      company: "Acme Corp",
      title: "VP of Engineering",
      lastContact: "2026-07-01",
      dealStage: "Proposal",
      dealValue: 25000,
    },
    draftKind: "email",
    mustGroundOnFields: ["name", "company", "dealStage"],
    mustNotFabricate: ["product pricing", "competitor claims", "unverified statistics"],
  },
  {
    name: "nba-cold-lead",
    leadContext: {
      name: "Bob Martinez",
      company: "StartupXYZ",
      title: "CTO",
      source: "LinkedIn",
      status: "New",
    },
    draftKind: "nba",
    mustGroundOnFields: ["name", "source", "status"],
    mustNotFabricate: ["existing relationship", "past meetings", "specific product interest"],
  },
  {
    name: "email-renewal-deal",
    leadContext: {
      name: "Priya Sharma",
      company: "GlobalTech",
      contractEndDate: "2026-09-30",
      currentPlan: "Professional",
      mrr: 2500,
    },
    draftKind: "email",
    mustGroundOnFields: ["name", "company", "contractEndDate", "currentPlan"],
    mustNotFabricate: ["renewal discount amount", "new features not mentioned", "competitor pricing"],
  },
  {
    name: "nba-stale-deal",
    leadContext: {
      name: "David Kim",
      company: "RetailPro",
      dealStage: "Negotiation",
      daysSinceLastActivity: 45,
      dealValue: 50000,
    },
    draftKind: "nba",
    mustGroundOnFields: ["daysSinceLastActivity", "dealStage", "dealValue"],
    mustNotFabricate: ["reasons for silence", "competitor activity", "new decision makers"],
  },
  {
    name: "email-discovery-call-followup",
    leadContext: {
      name: "Emma Wilson",
      company: "HealthFirst",
      lastMeetingDate: "2026-07-10",
      painPoints: ["manual reporting", "no real-time visibility"],
      nextStep: "demo scheduled",
    },
    draftKind: "email",
    mustGroundOnFields: ["name", "lastMeetingDate", "painPoints", "nextStep"],
    mustNotFabricate: ["pricing not discussed", "features not in context", "ROI figures"],
  },
  {
    name: "nba-high-value-churn-risk",
    leadContext: {
      name: "Carlos Rivera",
      company: "EnterpriseOne",
      churnRiskScore: 78,
      lastLoginDaysAgo: 30,
      mrr: 8000,
    },
    draftKind: "nba",
    mustGroundOnFields: ["churnRiskScore", "lastLoginDaysAgo", "mrr"],
    mustNotFabricate: ["specific complaint", "named competitor", "internal escalation details"],
  },
  {
    name: "email-inbound-trial",
    leadContext: {
      name: "Aisha Okonkwo",
      company: "LocalBiz",
      trialStartDate: "2026-07-08",
      trialEndDate: "2026-07-22",
      featuresUsed: ["CRM", "HR"],
    },
    draftKind: "email",
    mustGroundOnFields: ["name", "trialEndDate", "featuresUsed"],
    mustNotFabricate: ["usage metrics not provided", "industry-specific claims", "hypothetical outcomes"],
  },
] as const;
