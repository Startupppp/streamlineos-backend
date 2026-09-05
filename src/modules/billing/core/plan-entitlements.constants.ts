/**
 * Single source of truth for StreamlineOS plan entitlements.
 *
 * Limits, prices, trial length, feature flags, and locked modules all live here.
 * Charging (Razorpay), plan catalog API, auth trial creation, and frontend
 * marketing/billing UIs must derive from these values — never re-hardcode them.
 *
 * Product defaults (documented):
 * - Free plan: 5 seats; locked payroll + inventory; limited channel/project quotas
 * - Paid plans: STARTER / PROFESSIONAL / ENTERPRISE monthly prices in INR
 * - New orgs start on STARTER trial for TRIAL_DAYS days
 * - Annual billing is 20% off monthly × 12
 */

export type PlanTier = "FREE" | "PAID" | "ENTERPRISE";
export type EffectivePlan = "FREE" | "STARTER" | "PROFESSIONAL" | "ENTERPRISE";
export type PaidPlan = "STARTER" | "PROFESSIONAL" | "ENTERPRISE";

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
  | "acctInvoices"
  | "hrCandidates"
  | "hrJobPostings";

export interface PlanLimitEntry {
  FREE: number | null;
  STARTER: number | null;
  PROFESSIONAL: number | null;
  ENTERPRISE: number | null;
}

/** Resource quotas per effective plan. `null` = unlimited. */
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
  hrCandidates:   { FREE: 50,  STARTER: 2000, PROFESSIONAL: 50000, ENTERPRISE: null },
  hrJobPostings:  { FREE: 3,   STARTER: 25,   PROFESSIONAL: 200,   ENTERPRISE: null },
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

/** Module keys that cannot be enabled on this plan tier (enforced server-side). */
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

// Trial / pricing catalog (charged amounts + public plan list)

/** Days of STARTER trial granted on org creation / registration. Overridable via TRIAL_DAYS env. */
export const DEFAULT_TRIAL_DAYS = 14;

/** Plan granted during trial. */
export const TRIAL_PLAN: PaidPlan = "STARTER";

/** Annual billing discount as a fraction of monthly × 12 (0.2 = 20% off). */
export const ANNUAL_DISCOUNT_PCT = 0.2;

/**
 * The currency `PLAN_PRICES_PAISE` and `ai_credit_packs.price_in_paise` are denominated in.
 *
 * Named rather than implied, because an amount without its currency is not a price. The
 * tenant's own `accounting_settings.base_currency` is a different fact — what the tenant
 * keeps ITS books in — and must never be substituted for this one: pairing it with these
 * paise charged a USD-books tenant $999 for a ₹999 plan.
 */
export const PLATFORM_PRICE_CURRENCY = "INR";

/**
 * Monthly price in MINOR UNITS of `PLATFORM_PRICE_CURRENCY` — paise, INR × 100.
 * FREE is not chargeable. These values are what Razorpay charges.
 */
export const PLAN_PRICES_PAISE: Record<PaidPlan, number> = {
  STARTER: 99_900,       // ₹999
  PROFESSIONAL: 249_900, // ₹2,499
  ENTERPRISE: 499_900,   // ₹4,999
};

/** Free-plan group huddle cap (1:1 only). Paid plans use org settings up to mesh max. */
export const FREE_HUDDLE_MAX_PARTICIPANTS = 2;

/** Mesh topology hard cap for huddles (WebRTC mesh limit, not a plan entitlement). */
export const HUDDLE_MESH_MAX_PARTICIPANTS = 10;

export const FREE_HUDDLE_UPGRADE_MESSAGE =
  "Huddles are one-to-one on the Free plan. Upgrade to start group huddles.";

/** Marketing / billing UI feature bullets keyed by paid plan. */
export const PLAN_FEATURE_BULLETS: Record<PaidPlan, string[]> = {
  STARTER: [
    `Up to ${PLAN_LIMITS.members.STARTER} employees`,
    "Core HR & Attendance",
    "Payroll management",
    "Leave management",
    "Email support",
  ],
  PROFESSIONAL: [
    `Up to ${PLAN_LIMITS.members.PROFESSIONAL} employees`,
    "Everything in Starter",
    "Recruitment module",
    "Performance & OKRs",
    "CRM & Sales tools",
    "Priority support",
  ],
  ENTERPRISE: [
    "Unlimited / negotiated seats",
    "Everything in Professional",
    "Advanced analytics",
    "Custom integrations",
    "Dedicated account manager",
    "SLA-backed support",
  ],
};

export interface PlanCatalogEntry {
  id: PaidPlan;
  name: string;
  monthlyPrice: number;
  annualPrice: number;
  monthlyPricePaise: number;
  features: string[];
  maxEmployees: number | null;
}

export function getTrialDays(): number {
  const raw = process.env.TRIAL_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_TRIAL_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 365) return DEFAULT_TRIAL_DAYS;
  return parsed;
}

export function monthlyPriceInr(plan: PaidPlan): number {
  return Math.round(PLAN_PRICES_PAISE[plan] / 100);
}

export function annualMonthlyPriceInr(plan: PaidPlan): number {
  return Math.round(monthlyPriceInr(plan) * (1 - ANNUAL_DISCOUNT_PCT));
}

export function annualTotalPaise(plan: PaidPlan): number {
  return Math.round(PLAN_PRICES_PAISE[plan] * 12 * (1 - ANNUAL_DISCOUNT_PCT));
}

/** Build the public plan catalog returned by GET /billing/plans. */
export function buildPlanCatalog(): PlanCatalogEntry[] {
  const paid: PaidPlan[] = ["STARTER", "PROFESSIONAL", "ENTERPRISE"];
  return paid.map((id) => ({
    id,
    name: PLAN_LABELS[id],
    monthlyPrice: monthlyPriceInr(id),
    annualPrice: annualMonthlyPriceInr(id),
    monthlyPricePaise: PLAN_PRICES_PAISE[id],
    features: PLAN_FEATURE_BULLETS[id],
    maxEmployees: PLAN_LIMITS.members[id],
  }));
}

/** Free-tier marketing facts for landing pages (not a chargeable plan). */
export const FREE_PLAN_MARKETING = {
  id: "FREE" as const,
  name: PLAN_LABELS.FREE,
  monthlyPrice: 0,
  annualPrice: 0,
  seatLimit: PLAN_LIMITS.members.FREE,
  storageGb: 5,
  features: [
    `Up to ${PLAN_LIMITS.members.FREE} seats`,
    "All core modules — HR, Projects, CRM, Chat",
    "5 GB workspace storage",
    "Single organization",
    "Community support",
  ],
} as const;
