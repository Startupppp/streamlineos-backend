import { z } from "zod";
import {
  payrollInputSourceEnum,
  payslipLayoutEnum,
  salaryComponentCalcMethodEnum,
  salaryComponentTypeEnum,
} from "../../../db/schema";
import {
  DEFAULT_PAYROLL_TOGGLES,
  PAYROLL_TOGGLE_KEYS,
  type CalculationSnapshot,
  type InputsSnapshot,
  type PayrollPolicyConfig,
  type PayrollToggles,
  type TemplateComponentDef,
} from "../payroll.types";

/**
 * The payroll JSONB columns (`payroll_policy_versions.toggles`/`.config`,
 * `payroll_templates.default_toggles`/`.default_components`,
 * `payroll_run_employees.calculation_snapshot`/`.inputs_snapshot`) arrive from the
 * driver as `unknown`. Each reader below validates the stored value against the
 * schema for its domain shape and falls back exactly where the previous readers
 * did — never returning the raw value under a type it was not checked against.
 */
function matches<S extends z.ZodType>(schema: S, value: unknown): value is z.infer<S> {
  return schema.safeParse(value).success;
}

const togglesRecordSchema = z.record(z.string(), z.unknown());

export function normalizePayrollToggles(raw: unknown): PayrollToggles {
  const toggles: PayrollToggles = { ...DEFAULT_PAYROLL_TOGGLES };
  const parsed = togglesRecordSchema.safeParse(raw);
  if (!parsed.success) return toggles;
  for (const key of PAYROLL_TOGGLE_KEYS) {
    const value = parsed.data[key];
    if (typeof value === "boolean") toggles[key] = value;
  }
  return toggles;
}

/** The in-memory `TemplateComponentDef`: every flag decided, nothing left to default. */
export const templateComponentDefSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: z.enum(salaryComponentTypeEnum.enumValues),
  calcMethod: z.enum(salaryComponentCalcMethodEnum.enumValues),
  amount: z.string().optional(),
  percent: z.string().optional(),
  formula: z.string().optional(),
  taxable: z.boolean(),
  showOnPayslip: z.boolean(),
  includeInCtc: z.boolean(),
  isStatutory: z.boolean(),
  statutoryKey: z.string().optional(),
  sortOrder: z.number(),
});

const templateComponentDefsSchema = z.array(templateComponentDefSchema);

/**
 * The STORED shape of `payroll_templates.default_components`, which is not the
 * in-memory shape. Identity and calculation basis are required — nothing can stand
 * in for a missing `code` or `calcMethod` — but the four flags and the sort order
 * are defaultable, and a template row whose jsonb predates them must still preview
 * and still activate. Requiring them rejected the whole array, so one absent
 * `taxable` previewed as zero components and activated a policy with none.
 */
const storedTemplateComponentsSchema = z.array(
  templateComponentDefSchema.partial({
    taxable: true,
    showOnPayslip: true,
    includeInCtc: true,
    isStatutory: true,
    sortOrder: true,
  }),
);

export function toTemplateComponentDefs(raw: unknown): TemplateComponentDef[] {
  if (!matches(storedTemplateComponentsSchema, raw)) return [];
  return raw.map((component) => ({
    ...component,
    taxable: component.taxable === true,
    showOnPayslip: component.showOnPayslip === true,
    includeInCtc: component.includeInCtc === true,
    isStatutory: component.isStatutory === true,
    sortOrder: component.sortOrder ?? 0,
  }));
}

const payrollApprovalStageDefSchema = z.object({
  stage: z.number(),
  stageName: z.string(),
  requiredPermission: z.string(),
});

const statutoryPackConfigSchema = z.object({
  country: z.string(),
  items: z.array(
    z.object({
      key: z.string(),
      enabled: z.boolean(),
      percentOverride: z.string().optional(),
      label: z.string().optional(),
      kind: z.string().nullable().optional(),
    }),
  ),
});

export const payrollPolicyConfigSchema = z.object({
  components: templateComponentDefsSchema,
  rounding: z.object({
    mode: z.enum(["NEAREST", "UP", "DOWN"]),
    precision: z.union([z.literal(0), z.literal(2)]),
  }),
  approvalChain: z.array(payrollApprovalStageDefSchema),
  payslipLayout: z.enum(payslipLayoutEnum.enumValues),
  calendar: z.object({
    attendanceCutoffDay: z.number(),
    reimbursementCutoffDay: z.number(),
    declarationCutoffDay: z.number(),
    previewDay: z.number(),
    approvalDeadlineDay: z.number(),
    publishOffsetDays: z.number(),
  }),
  statutory: z.object({
    pfEmployeePercent: z.string(),
    pfEmployerPercent: z.string(),
    pfWageCeiling: z.string().nullable(),
    esiEmployeePercent: z.string(),
    esiEmployerPercent: z.string(),
    esiWageCeiling: z.string().nullable(),
    professionalTaxMonthly: z.string(),
    tdsMode: z.enum(["DECLARATION", "FLAT", "NONE"]),
    tdsFlatPercent: z.string().nullable(),
  }),
  statutoryPack: statutoryPackConfigSchema.optional(),
  overtime: z.object({
    multiplier: z.string(),
    basis: z.enum(["BASIC", "GROSS"]),
  }),
  varianceThresholdPercent: z.number(),
  fxRates: z.record(z.string(), z.string()).optional(),
});

export function toPayrollPolicyConfig(raw: unknown): PayrollPolicyConfig | null {
  return matches(payrollPolicyConfigSchema, raw) ? raw : null;
}

const calculationSnapshotLineSchema = z.object({
  code: z.string(),
  name: z.string(),
  category: z.enum(salaryComponentTypeEnum.enumValues),
  amount: z.string(),
  calcMethod: z.enum(salaryComponentCalcMethodEnum.enumValues),
  taxable: z.boolean(),
  sortOrder: z.number(),
  explain: z.object({
    method: z.enum(salaryComponentCalcMethodEnum.enumValues),
    formula: z.string().optional(),
    inputs: z.record(z.string(), z.number()),
    steps: z.array(z.string()),
    note: z.string().optional(),
  }),
});

const runEmployeeVarianceSchema = z.object({
  previousRunId: z.number().nullable(),
  previousNet: z.string().nullable(),
  netDelta: z.string().nullable(),
  netDeltaPercent: z.number().nullable(),
  changedComponents: z.array(
    z.object({
      code: z.string(),
      previous: z.string().nullable(),
      current: z.string().nullable(),
    }),
  ),
  baselineSource: z
    .enum(["PREVIOUS_RUN", "LOCKED_INPUT_SNAPSHOT", "PREVIOUS_RUN_AND_LOCKED_INPUTS"])
    .nullable()
    .optional(),
  inputBaseline: z
    .object({
      lockedPaidDays: z.string().nullable(),
      lockedLopDays: z.string().nullable(),
      paidDaysDelta: z.number().nullable(),
      lopDaysDelta: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

export const calculationSnapshotSchema = z.object({
  policyVersionId: z.number().nullable(),
  computedAt: z.string(),
  currency: z.string(),
  fxRate: z.string().nullable().optional(),
  netPayoutCurrency: z.string().nullable().optional(),
  scheduledDays: z.string(),
  paidDays: z.string(),
  lopDays: z.string(),
  overtimeHours: z.string(),
  lines: z.array(calculationSnapshotLineSchema),
  totals: z.object({
    gross: z.string(),
    deductions: z.string(),
    employerContributions: z.string(),
    net: z.string(),
  }),
  variance: runEmployeeVarianceSchema.nullable(),
  wageDefinitionWarning: z.string().nullable().optional(),
});

export function toCalculationSnapshot(raw: unknown): CalculationSnapshot | null {
  return matches(calculationSnapshotSchema, raw) ? raw : null;
}

export const inputsSnapshotSchema = z.object({
  source: z.enum(payrollInputSourceEnum.enumValues),
  scheduledDays: z.string(),
  paidDays: z.string(),
  lopDays: z.string(),
  halfDays: z.string(),
  overtimeHours: z.string(),
  shiftAllowanceUnits: z.string(),
  holidayWorkDays: z.string(),
  billableHours: z.string(),
  isOverride: z.boolean(),
  overrideReason: z.string().nullable(),
  consumedReimbursementIds: z.array(z.number()).optional(),
});

export function toInputsSnapshot(raw: unknown): InputsSnapshot | null {
  return matches(inputsSnapshotSchema, raw) ? raw : null;
}
