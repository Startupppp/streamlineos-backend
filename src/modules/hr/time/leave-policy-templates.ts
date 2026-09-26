/**
 * Ticket 08. A newly created organisation opens Leave Policies with nothing in
 * it and no way to tell what a policy is supposed to look like. These are the
 * three an Indian workplace starts from; an administrator previews and edits
 * them before anything is written, and may refuse them permanently.
 *
 * They are a starting point, not a standard — every field is editable at import
 * and afterwards.
 */
export const LEAVE_POLICY_TEMPLATE_KEYS = ["casual", "sick", "comp_off"] as const;

export type LeavePolicyTemplateKey = (typeof LEAVE_POLICY_TEMPLATE_KEYS)[number];

export interface LeavePolicyTemplate {
  key: LeavePolicyTemplateKey;
  leaveTypeName: string;
  policyName: string;
  description: string;
  daysPerYear: number;
  carryForward: boolean;
  accrualType: "ANNUAL" | "MONTHLY";
  accrualRate: string;
  maxBalance: string | null;
  carryForwardDays: string;
  encashable: boolean;
  probationRestricted: boolean;
}

export const LEAVE_POLICY_TEMPLATES: readonly LeavePolicyTemplate[] = [
  {
    key: "casual",
    leaveTypeName: "Casual Leave",
    policyName: "Casual Leave",
    description: "Short, planned absences. Accrues monthly and does not carry over.",
    daysPerYear: 12,
    carryForward: false,
    accrualType: "MONTHLY",
    accrualRate: "1",
    maxBalance: "12",
    carryForwardDays: "0",
    encashable: false,
    probationRestricted: true,
  },
  {
    key: "sick",
    leaveTypeName: "Sick Leave",
    policyName: "Sick Leave",
    description: "Illness and medical absence. Available from day one.",
    daysPerYear: 12,
    carryForward: false,
    accrualType: "ANNUAL",
    accrualRate: "12",
    maxBalance: "12",
    carryForwardDays: "0",
    encashable: false,
    probationRestricted: false,
  },
  {
    key: "comp_off",
    leaveTypeName: "Comp Off",
    policyName: "Comp Off",
    description:
      "Time off earned by working a holiday or a weekend. Granted, never accrued.",
    daysPerYear: 0,
    carryForward: true,
    accrualType: "ANNUAL",
    accrualRate: "0",
    maxBalance: null,
    carryForwardDays: "5",
    encashable: false,
    probationRestricted: false,
  },
];

export function templateByKey(
  key: LeavePolicyTemplateKey,
): LeavePolicyTemplate {
  const template = LEAVE_POLICY_TEMPLATES.find(
    (candidate) => candidate.key === key,
  );
  if (!template) throw new Error(`Unknown leave policy template: ${key}`);
  return template;
}

/**
 * Two leave types are the same thing when their names match once case and
 * whitespace stop counting — "comp off", "Comp  Off" and "COMP OFF" are one
 * leave type, and importing a template over an existing one must not create a
 * second.
 */
export function normalizeLeaveTypeName(name: string): string {
  return name.replace(/\s+/gu, " ").trim().toLowerCase();
}
