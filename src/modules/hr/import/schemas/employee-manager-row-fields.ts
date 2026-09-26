import { z } from "zod";

const optionalEmail = z.string().trim().email("Invalid manager email").optional().or(z.literal(""));

const cellBoolean = z.union([z.boolean(), z.string(), z.number()]).optional()
  .transform((value) => value === true || value === 1 || (typeof value === "string" && ["true", "yes", "1", "y"].includes(value.trim().toLowerCase())));

/**
 * HRM-15 §4.22: the staged employee import's manager columns. Legacy manager headers are rewritten
 * to `primaryManagerEmail` before the row schema runs (`normaliseManagerColumns`); a row whose
 * headers disagree carries `managerColumnConflict`. The `resolved*` keys are written by the
 * preflight from org-scoped queries, never read from a cell.
 */
export const employeeManagerRowFields = {
  resolvedPrimaryManagerUserId: z.string().optional(),
  primaryManagerResolution: z.enum(["SELECTED", "IN_FILE", "FALLBACK_CONFIGURED", "FALLBACK_UPLOADER"]).optional(),
  resolvedExistingEmployee: z.boolean().optional(),
  primaryManagerEmail: optionalEmail,
  secondaryManagerEmail1: optionalEmail,
  secondaryManagerEmail2: optionalEmail,
  secondaryManagerEmail3: optionalEmail,
  topLevelRoleReason: z.string().trim().max(500, "Top-level reason must be at most 500 characters").optional(),
  clearPrimaryManager: cellBoolean,
  managerColumnConflict: z.undefined({ message: "The manager columns name different people. Keep only primaryManagerEmail." }).optional(),
};

type ManagerColumns = {
  topLevelRoleReason?: string;
  primaryManagerEmail?: string;
  secondaryManagerEmail1?: string;
  secondaryManagerEmail2?: string;
  secondaryManagerEmail3?: string;
  clearPrimaryManager: boolean;
};

export function refineEmployeeManagerColumns(row: ManagerColumns, ctx: z.RefinementCtx): void {
  const topLevel = Boolean(row.topLevelRoleReason?.trim());
  if (topLevel && (row.primaryManagerEmail || row.secondaryManagerEmail1 || row.secondaryManagerEmail2 || row.secondaryManagerEmail3))
    ctx.addIssue({ code: "custom", message: "A top-level row cannot also name a manager.", path: ["topLevelRoleReason"] });
  if (row.clearPrimaryManager && !topLevel)
    ctx.addIssue({ code: "custom", message: "clearPrimaryManager is only allowed on a top-level row that gives a topLevelRoleReason.", path: ["clearPrimaryManager"] });
}
