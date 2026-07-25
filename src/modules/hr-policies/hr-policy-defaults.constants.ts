/**
 * Documented product defaults for HR policy seed + schema defaults.
 * Org-level policies in the DB always win; these values are only used when
 * seeding a new org or when a policy field is omitted on create.
 */

/** Standard WFH policy: 4 days/month, max 2/week, approval required. */
export const DEFAULT_WFH_RULES = {
  monthlyQuota: 4,
  weeklyMax: 2,
  requireApproval: true,
  probationRestricted: true,
  allowConsecutive: false,
} as const;

/** Standard overtime: 8h/day, 40h/week, 1.5× multiplier, no auto comp-off. */
export const DEFAULT_OVERTIME_RULES = {
  dailyThresholdMinutes: 480,
  weeklyThresholdMinutes: 2400,
  minDurationMinutes: 30,
  compOffConversion: false,
  overtimeMultiplier: 1.5,
} as const;

/** Comp-off accrual ceiling when no policy is configured. */
export const DEFAULT_COMP_OFF_MAX_ACCRUAL = 30;

/** Remote-work notice period default (days). */
export const DEFAULT_REMOTE_WORK_NOTICE_DAYS = 7;
