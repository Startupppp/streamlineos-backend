import { z } from "zod";

/**
 * Query schemas for `/accounting/reports/*`.
 *
 * Zod, strict, one schema per payload (backend/CLAUDE.md §2). `.strict()`
 * matters more than usual here: a typo'd `asof=` that silently fell back to
 * today would hand someone a balance sheet for the wrong date and look right.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

/** Query strings arrive as `"true"`/`"false"`; `z.coerce.boolean` would not do. */
const queryBoolean = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const labelMode = z.enum(["founder", "accountant"]).default("founder");
const format = z.enum(["json", "csv"]).default("json");
const bookId = z.string().min(1).max(64).optional();

/**
 * Optional dimension filters (PRD 06 S4). A dimension lives on the journal
 * line, not the account, so a filtered report is a slice of activity and is not
 * required to balance — the services say so in the response.
 */
const branchId = z.string().min(1).max(64).optional();
const projectId = z.coerce.number().int().positive().optional();

const baseFields = {
  bookId,
  labelMode,
  format,
};

const dimensionFields = {
  branchId,
  projectId,
};

export const trialBalanceQuerySchema = z
  .object({
    ...baseFields,
    ...dimensionFields,
    asOf: isoDate,
    includeZeroActivity: queryBoolean.optional(),
  })
  .strict();
export type TrialBalanceQueryDto = z.infer<typeof trialBalanceQuerySchema>;

export const profitLossQuerySchema = z
  .object({
    ...baseFields,
    ...dimensionFields,
    from: isoDate,
    to: isoDate,
    comparative: queryBoolean.optional(),
    /** Off only for a deliberate multi-year window; see ProfitLossService. */
    clampToFiscalYear: queryBoolean.optional(),
    includeZeroActivity: queryBoolean.optional(),
  })
  .strict();
export type ProfitLossQueryDto = z.infer<typeof profitLossQuerySchema>;

export const balanceSheetQuerySchema = z
  .object({
    ...baseFields,
    asOf: isoDate,
    includeZeroActivity: queryBoolean.optional(),
  })
  .strict();
export type BalanceSheetQueryDto = z.infer<typeof balanceSheetQuerySchema>;

export const cashFlowQuerySchema = z
  .object({
    ...baseFields,
    from: isoDate,
    to: isoDate,
  })
  .strict();
export type CashFlowQueryDto = z.infer<typeof cashFlowQuerySchema>;

export const agingQuerySchema = z
  .object({
    ...baseFields,
    side: z.enum(["ar", "ap"]),
    asOf: isoDate,
    basis: z.enum(["due", "issue"]).default("due"),
    includeDocuments: queryBoolean.optional(),
  })
  .strict();
export type AgingQueryDto = z.infer<typeof agingQuerySchema>;

export const taxSummaryQuerySchema = z
  .object({
    ...baseFields,
    from: isoDate,
    to: isoDate,
  })
  .strict();
export type TaxSummaryQueryDto = z.infer<typeof taxSummaryQuerySchema>;

/**
 * The export endpoint. One route rather than six `/export` siblings, so the
 * `accounting:reports:export` permission is asserted in exactly one place —
 * six copies of a permission check is five chances to forget one.
 */
export const reportExportQuerySchema = z
  .discriminatedUnion("report", [
    trialBalanceQuerySchema.extend({ report: z.literal("trial-balance") }),
    profitLossQuerySchema.extend({ report: z.literal("pnl") }),
    balanceSheetQuerySchema.extend({ report: z.literal("balance-sheet") }),
    cashFlowQuerySchema.extend({ report: z.literal("cash-flow") }),
    agingQuerySchema.extend({ report: z.literal("aging") }),
    taxSummaryQuerySchema.extend({ report: z.literal("tax-summary") }),
  ])
  .describe("Report selector plus that report's own parameters");
export type ReportExportQueryDto = z.infer<typeof reportExportQuerySchema>;
