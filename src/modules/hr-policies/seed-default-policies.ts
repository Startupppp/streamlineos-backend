import type { PolicyType } from "./hr-policy-types";
import {
  DEFAULT_OVERTIME_RULES,
  DEFAULT_WFH_RULES,
} from "./hr-policy-defaults.constants";

interface DefaultPolicySpec {
  policyType: PolicyType;
  name: string;
  description: string;
  priority: number;
  rules: Record<string, unknown>;
}

export function buildDefaultPolicies(
  _orgId: string,
): DefaultPolicySpec[] {
  return [
    {
      policyType: "leave",
      name: "Standard Leave Policy",
      description: "Default leave accrual and encashment rules",
      priority: 0,
      rules: {
        accrualFrequency: "monthly",
        accrualAmount: 1,
        maxBalance: 30,
        carryForwardLimit: 10,
        encashmentEligible: false,
        probationRestricted: true,
        sandwichRule: true,
        halfDayAllowed: true,
        hourlyAllowed: false,
      },
    },
    {
      policyType: "attendance",
      name: "Standard Attendance Policy",
      description: "Grace period and half-day thresholds",
      priority: 0,
      rules: {
        graceMinutes: 15,
        halfDayThresholdMinutes: 240,
        absentThresholdMinutes: 0,
        autoCheckoutTime: "21:00",
        lateArrivalPenalty: "none",
      },
    },
    {
      policyType: "probation",
      name: "Standard Probation Policy",
      description: "Default 90-day probation with one 30-day extension",
      priority: 0,
      rules: {
        durationDays: 90,
        extensionAllowed: true,
        maxExtensions: 1,
        maxExtensionDays: 30,
      },
    },
    {
      policyType: "notice_period",
      name: "Standard Notice Period Policy",
      description: "30-day notice for permanent employees",
      priority: 0,
      rules: {
        permanentDays: 30,
        contractDays: 14,
        probationDays: 7,
        buyoutAllowed: true,
      },
    },
    {
      policyType: "overtime",
      name: "Standard Overtime Policy",
      description: "Overtime threshold and comp-off conversion rules",
      priority: 0,
      rules: { ...DEFAULT_OVERTIME_RULES },
    },
    {
      policyType: "wfh",
      name: "Standard WFH Policy",
      description: `Default ${DEFAULT_WFH_RULES.monthlyQuota}-day monthly WFH quota`,
      priority: 0,
      rules: { ...DEFAULT_WFH_RULES },
    },
  ];
}
