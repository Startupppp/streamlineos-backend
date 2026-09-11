/**
 * Documented product defaults for payroll policy activation.
 * Only applied when creating/activating a policy and the org did not supply overrides.
 * Runtime payroll always reads the persisted policy config from the database.
 */
import type { PayrollPolicyConfig } from "../payroll.types";

export const DEFAULT_PAYROLL_CALENDAR = {
  attendanceCutoffDay: 20,
  reimbursementCutoffDay: 20,
  declarationCutoffDay: 15,
  previewDay: 22,
  approvalDeadlineDay: 25,
  publishOffsetDays: 1,
} as const;

/** India statutory baseline percentages/ceilings used when org does not override. */
export const DEFAULT_PAYROLL_STATUTORY: {
  pfEmployeePercent: string;
  pfEmployerPercent: string;
  pfWageCeiling: string | null;
  esiEmployeePercent: string;
  esiEmployerPercent: string;
  esiWageCeiling: string | null;
  professionalTaxMonthly: string;
  tdsMode: "DECLARATION" | "FLAT" | "NONE";
  tdsFlatPercent: string | null;
} = {
  pfEmployeePercent: "12",
  pfEmployerPercent: "12",
  pfWageCeiling: "15000.00",
  esiEmployeePercent: "0.75",
  esiEmployerPercent: "3.25",
  esiWageCeiling: "21000.00",
  professionalTaxMonthly: "200.00",
  tdsMode: "DECLARATION",
  tdsFlatPercent: null,
};

/**
 * A fully populated fallback config for when a policy version's stored JSONB
 * config is absent or not an object. Every field a consumer reads must exist
 * on this default — an empty object forced into this type left downstream
 * reads of e.g. `config.rounding.mode` crashing on the missing property.
 */
export const DEFAULT_PAYROLL_POLICY_CONFIG: PayrollPolicyConfig = {
  components: [],
  rounding: { mode: "NEAREST", precision: 2 },
  approvalChain: [],
  payslipLayout: "CLASSIC",
  calendar: { ...DEFAULT_PAYROLL_CALENDAR },
  statutory: { ...DEFAULT_PAYROLL_STATUTORY },
  overtime: { multiplier: "1.50", basis: "BASIC" },
  varianceThresholdPercent: 20,
};
