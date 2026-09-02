import { z } from "zod";
import { pageSizeField } from "../../../common/pagination/list-query.schema";

export const listOfferFulfillmentQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
  crmOfferId: z.coerce.number().int().positive().optional(),
  invSkuId: z.coerce.number().int().positive().optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).strict();

export const createOfferFulfillmentSchema = z.object({
  crmOfferId: z.number().int().positive(),
  invSkuId: z.number().int().positive(),
  quantityPerUnit: z.number().positive().max(999999).default(1),
  uom: z.string().min(1).max(32).optional(),
  status: z.enum(["active", "inactive"]).default("active"),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export const updateOfferFulfillmentSchema = z
  .object({
    quantityPerUnit: z.number().positive().max(999999).optional(),
    uom: z.string().min(1).max(32).nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    effectiveFrom: z.coerce.date().nullable().optional(),
    effectiveTo: z.coerce.date().nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  }).strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export type ListOfferFulfillmentQuery = z.infer<typeof listOfferFulfillmentQuerySchema>;
export type CreateOfferFulfillmentInput = z.infer<typeof createOfferFulfillmentSchema>;
export type UpdateOfferFulfillmentInput = z.infer<typeof updateOfferFulfillmentSchema>;
