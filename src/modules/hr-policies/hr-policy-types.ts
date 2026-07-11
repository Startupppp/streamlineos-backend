import { z } from "zod";

const leaveRulesSchema = z.object({
  accrualFrequency: z.enum(["monthly", "quarterly", "yearly"]).default("monthly"),
  accrualAmount: z.number().min(0).default(1),
  maxBalance: z.number().min(0).optional(),
  carryForwardLimit: z.number().min(0).default(0),
  encashmentEligible: z.boolean().default(false),
  probationRestricted: z.boolean().default(false),
  sandwichRule: z.boolean().default(false),
  halfDayAllowed: z.boolean().default(true),
  hourlyAllowed: z.boolean().default(false),
});

const attendanceRulesSchema = z.object({
  graceMinutes: z.number().int().min(0).max(120).default(15),
  halfDayThresholdMinutes: z.number().int().min(0).default(240),
  absentThresholdMinutes: z.number().int().min(0).default(0),
  autoCheckoutTime: z.string().optional(),
  lateArrivalPenalty: z.enum(["none", "half_day", "full_day"]).default("none"),
});

const shiftRosterRulesSchema = z.object({
  defaultShiftStartTime: z.string().default("09:00"),
  defaultShiftEndTime: z.string().default("18:00"),
  breakMinutes: z.number().int().min(0).default(60),
  weeklyOffDays: z
    .array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]))
    .default(["sun"]),
  flexibleTiming: z.boolean().default(false),
});

const overtimeRulesSchema = z.object({
  dailyThresholdMinutes: z.number().int().min(0).default(480),
  weeklyThresholdMinutes: z.number().int().min(0).default(2400),
  minDurationMinutes: z.number().int().min(0).default(30),
  compOffConversion: z.boolean().default(false),
  overtimeMultiplier: z.number().min(1).default(1.5),
});

const compOffRulesSchema = z.object({
  expiryDays: z.number().int().min(1).default(90),
  autoApprove: z.boolean().default(false),
  maxAccrual: z.number().min(0).optional(),
});

const probationRulesSchema = z.object({
  durationDays: z.number().int().min(1).default(90),
  extensionAllowed: z.boolean().default(true),
  maxExtensions: z.number().int().min(0).default(1),
  maxExtensionDays: z.number().int().min(1).default(30),
});

const noticePeriodRulesSchema = z.object({
  permanentDays: z.number().int().min(0).default(30),
  contractDays: z.number().int().min(0).default(14),
  probationDays: z.number().int().min(0).default(7),
  buyoutAllowed: z.boolean().default(true),
});

const documentRequirementRulesSchema = z.object({
  requiredDocTypes: z
    .array(
      z.enum([
        "CONTRACT",
        "CERTIFICATE",
        "ID_PROOF",
        "PAYSLIP",
        "POLICY",
        "OFFER_LETTER",
        "RESUME",
        "OTHER",
      ]),
    )
    .min(1),
  mandatoryAtOnboarding: z.boolean().default(true),
  reminderDays: z.number().int().min(0).default(7),
});

const approvalRulesSchema = z.object({
  steps: z
    .array(
      z.object({
        order: z.number().int().min(1),
        approverType: z.enum(["manager", "hr", "department_head", "specific_user"]),
        approverId: z.string().optional(),
        timeoutHours: z.number().int().min(1).default(48),
        escalateOnTimeout: z.boolean().default(true),
      }),
    )
    .min(1),
  requireAllApprovers: z.boolean().default(false),
  allowSelfApproval: z.boolean().default(false),
});

const expenseRulesSchema = z.object({
  dailyLimit: z.number().min(0).optional(),
  monthlyLimit: z.number().min(0).optional(),
  requireReceipt: z.boolean().default(true),
  receiptThreshold: z.number().min(0).default(500),
  autoApproveBelow: z.number().min(0).optional(),
  allowedCategories: z.array(z.string()).optional(),
});

const travelRulesSchema = z.object({
  requirePreApproval: z.boolean().default(true),
  advanceBookingDays: z.number().int().min(0).default(3),
  perDiemDomestic: z.number().min(0).optional(),
  perDiemInternational: z.number().min(0).optional(),
  hotelLimitPerNight: z.number().min(0).optional(),
  allowedTravelClasses: z.array(z.enum(["economy", "business", "first"])).default(["economy"]),
});

const assetRulesSchema = z.object({
  requireApproval: z.boolean().default(true),
  maxAssetsPerEmployee: z.number().int().min(1).default(5),
  allowedAssetTypes: z.array(z.string()).optional(),
  returnOnExit: z.boolean().default(true),
});

const wfhRulesSchema = z.object({
  monthlyQuota: z.number().int().min(0).default(4),
  weeklyMax: z.number().int().min(0).default(2),
  requireApproval: z.boolean().default(true),
  probationRestricted: z.boolean().default(true),
  allowConsecutive: z.boolean().default(false),
});

const remoteWorkRulesSchema = z.object({
  allowedCountries: z.array(z.string()).optional(),
  maxDurationDays: z.number().int().min(1).optional(),
  requireApproval: z.boolean().default(true),
  noticeDays: z.number().int().min(0).default(7),
});

const payrollEligibilityRulesSchema = z.object({
  minDaysWorkedPercent: z.number().min(0).max(100).default(50),
  probationEligible: z.boolean().default(true),
  salaryCycleDay: z.number().int().min(1).max(31).default(1),
  overtimeInPayroll: z.boolean().default(true),
  lossOfPayEnabled: z.boolean().default(true),
});

const RULES_BY_TYPE = {
  leave: leaveRulesSchema,
  attendance: attendanceRulesSchema,
  shift_roster: shiftRosterRulesSchema,
  overtime: overtimeRulesSchema,
  comp_off: compOffRulesSchema,
  probation: probationRulesSchema,
  notice_period: noticePeriodRulesSchema,
  document_requirement: documentRequirementRulesSchema,
  approval: approvalRulesSchema,
  expense: expenseRulesSchema,
  travel: travelRulesSchema,
  asset: assetRulesSchema,
  wfh: wfhRulesSchema,
  remote_work: remoteWorkRulesSchema,
  payroll_eligibility: payrollEligibilityRulesSchema,
} as const;

export type PolicyType = keyof typeof RULES_BY_TYPE;

export function validatePolicyRules(
  policyType: PolicyType,
  rules: Record<string, unknown>,
): Record<string, unknown> {
  const schema = RULES_BY_TYPE[policyType];
  return schema.parse(rules);
}

export function buildDefaultRules(policyType: PolicyType): Record<string, unknown> {
  const schema = RULES_BY_TYPE[policyType];
  return schema.parse({});
}
