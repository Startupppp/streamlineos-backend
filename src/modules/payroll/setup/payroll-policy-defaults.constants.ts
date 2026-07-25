/**
 * Documented product defaults for payroll policy activation.
 * Only applied when creating/activating a policy and the org did not supply overrides.
 * Runtime payroll always reads the persisted policy config from the database.
 */

export const DEFAULT_PAYROLL_CALENDAR = {
  attendanceCutoffDay: 20,
  reimbursementCutoffDay: 20,
  declarationCutoffDay: 15,
  previewDay: 22,
  approvalDeadlineDay: 25,
  publishOffsetDays: 1,
} as const;

/** India statutory baseline percentages/ceilings used when org does not override. */
export const DEFAULT_PAYROLL_STATUTORY = {
  pfEmployeePercent: "12",
  pfEmployerPercent: "12",
  pfWageCeiling: "15000.00" as string | null,
  esiEmployeePercent: "0.75",
  esiEmployerPercent: "3.25",
  esiWageCeiling: "21000.00" as string | null,
  professionalTaxMonthly: "200.00",
  tdsMode: "DECLARATION" as const,
  tdsFlatPercent: null as string | null,
};
