import { z } from "zod";

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, "Must be a non-negative decimal");

export const samplingMethods = ["ALL", "PERCENTAGE", "FIXED_QUANTITY"] as const;
export type SamplingMethod = (typeof samplingMethods)[number];

interface SamplingRule {
  samplingMethod: SamplingMethod;
  sampleValue?: string | undefined;
}

/**
 * The sampling rule, checked as a unit rather than field by field.
 *
 * `sampleValue` means a different thing under each method and nothing at all
 * under ALL, so a per-field `optional()` would accept "inspect 250% of the
 * delivery" and "inspect ALL, twelve of them". The database carries the same
 * rule as a CHECK; this is what turns a violation into a 400 rather than a 500.
 */
function checkSamplingRule(rule: SamplingRule, ctx: z.RefinementCtx): void {
  const path = ["sampleValue"];
  if (rule.samplingMethod === "ALL") {
    if (rule.sampleValue !== undefined)
      ctx.addIssue({ code: "custom", path, message: "A plan that inspects everything takes no sample size" });
    return;
  }
  if (rule.sampleValue === undefined) {
    ctx.addIssue({ code: "custom", path, message: `sampleValue is required for ${rule.samplingMethod}` });
    return;
  }
  const value = Number(rule.sampleValue);
  if (!(value > 0)) {
    ctx.addIssue({ code: "custom", path, message: "Must be greater than zero" });
    return;
  }
  if (rule.samplingMethod === "PERCENTAGE" && value > 100)
    ctx.addIssue({ code: "custom", path, message: "A percentage cannot exceed 100" });
}

/**
 * Scope is an exclusive arc: at most one of the three ids, and none of them is
 * the organisation-wide plan. Checked here as well as by the CHECK constraint so
 * the caller is told which field is the problem.
 */
function checkScope(
  scope: { productVariantId?: number | null; productId?: number | null; categoryId?: number | null },
  ctx: z.RefinementCtx,
): void {
  const named = [scope.productVariantId, scope.productId, scope.categoryId].filter(
    (value) => value !== undefined && value !== null,
  );
  if (named.length > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["productVariantId"],
      message: "A plan targets one of a variant, a product or a category — never several",
    });
  }
}

export const listInspectionPlansQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    isActive: z.enum(["true", "false"]).optional(),
    appliesOn: z.enum(["RECEIPT", "RETURN"]).optional(),
    productVariantId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListInspectionPlansQueryInput = z.infer<typeof listInspectionPlansQuerySchema>;

export const createInspectionPlanSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/, "Uppercase letters, digits, hyphen and underscore only"),
    name: z.string().min(1).max(160),
    description: z.string().max(2000).optional(),
    productVariantId: z.number().int().positive().optional(),
    productId: z.number().int().positive().optional(),
    categoryId: z.number().int().positive().optional(),
    appliesOnReceipt: z.boolean().default(true),
    appliesOnReturn: z.boolean().default(false),
    samplingMethod: z.enum(samplingMethods).default("ALL"),
    sampleValue: decimalString.optional(),
    instructions: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.appliesOnReceipt && !input.appliesOnReturn) {
      ctx.addIssue({
        code: "custom",
        path: ["appliesOnReceipt"],
        message: "A plan that applies to nothing would never be consulted",
      });
    }
    checkScope(input, ctx);
    checkSamplingRule(input, ctx);
  });
export type CreateInspectionPlanInput = z.infer<typeof createInspectionPlanSchema>;

/**
 * What may change on a live plan: its label, its scope, and which arrivals it
 * covers. The sampling rule is deliberately absent — changing it is a new
 * version, because a completed inspection names the version it was judged
 * against and editing that version rewrites the past.
 */
export const updateInspectionPlanSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
    productVariantId: z.number().int().positive().nullable().optional(),
    productId: z.number().int().positive().nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    appliesOnReceipt: z.boolean().optional(),
    appliesOnReturn: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => checkScope(input, ctx));
export type UpdateInspectionPlanInput = z.infer<typeof updateInspectionPlanSchema>;

export const createPlanVersionSchema = z
  .object({
    samplingMethod: z.enum(samplingMethods).default("ALL"),
    sampleValue: decimalString.optional(),
    instructions: z.string().max(2000).optional(),
    /** Publish immediately, superseding whichever version is live. */
    activate: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, ctx) => checkSamplingRule(input, ctx));
export type CreatePlanVersionInput = z.infer<typeof createPlanVersionSchema>;

export const correctInspectionSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();
export type CorrectInspectionInput = z.infer<typeof correctInspectionSchema>;
