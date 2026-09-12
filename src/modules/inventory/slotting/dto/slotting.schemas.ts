import { z } from "zod";

export const slottingMatchSchema = z.enum(["VELOCITY_CLASS", "CATEGORY", "PRODUCT_VARIANT"]);
export const velocityClassSchema = z.enum(["A", "B", "C"]);
const locationTypeSchema = z.enum([
  "ZONE", "AISLE", "RACK", "BIN", "RECEIVING", "SHIPPING", "QUARANTINE", "SCRAP", "TRANSIT", "RETURNS",
]);

/**
 * The discriminator and its payload move together, mirroring the table CHECK.
 * A rule that reads as configured and matches nothing is worse than one that was
 * refused: the planner believes the gold zone is being used.
 */
export const createSlottingRuleSchema = z
  .object({
    warehouseId: z.number().int().positive(),
    name: z.string().min(1).max(120),
    matchType: slottingMatchSchema,
    velocityClass: velocityClassSchema.optional(),
    categoryId: z.number().int().positive().optional(),
    productVariantId: z.number().int().positive().optional(),
    targetZoneLocationId: z.number().int().positive(),
    targetLocationType: locationTypeSchema.optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected: Record<z.infer<typeof slottingMatchSchema>, keyof typeof value> = {
      VELOCITY_CLASS: "velocityClass",
      CATEGORY: "categoryId",
      PRODUCT_VARIANT: "productVariantId",
    };
    const required = expected[value.matchType];
    if (value[required] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [required],
        message: `A ${value.matchType} rule must name a ${required}`,
      });
    }
    for (const [matchType, field] of Object.entries(expected)) {
      if (matchType !== value.matchType && value[field as keyof typeof value] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `A ${value.matchType} rule must not also name a ${field}`,
        });
      }
    }
  });

export const setSlottingRuleActiveSchema = z.object({ isActive: z.boolean() }).strict();

export const listSlottingRulesQuerySchema = z
  .object({ warehouseId: z.coerce.number().int().positive().optional() })
  .strict();

export const listRecommendationsQuerySchema = z
  .object({
    warehouseId: z.coerce.number().int().positive().optional(),
    status: z.enum(["PENDING", "APPROVED", "DISMISSED", "SUPERSEDED"]).default("PENDING"),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export const approveRecommendationSchema = z
  .object({
    /** The bin inside the target zone. Named by a person: see the service note. */
    toLocationId: z.number().int().positive(),
  })
  .strict();

export const dismissRecommendationSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();

export type CreateSlottingRuleInput = z.infer<typeof createSlottingRuleSchema>;
export type SetSlottingRuleActiveInput = z.infer<typeof setSlottingRuleActiveSchema>;
export type ListSlottingRulesQuery = z.infer<typeof listSlottingRulesQuerySchema>;
export type ListRecommendationsQuery = z.infer<typeof listRecommendationsQuerySchema>;
export type ApproveRecommendationInput = z.infer<typeof approveRecommendationSchema>;
export type DismissRecommendationInput = z.infer<typeof dismissRecommendationSchema>;
