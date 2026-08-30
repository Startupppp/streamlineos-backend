import { z } from "zod";

const qtyString = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Quantity must be a positive decimal with up to 4 places")
  .refine((v) => Number(v) > 0, "Quantity must be greater than zero");

const costString = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Cost must be a decimal with up to 4 places");

export const ownershipSchema = z.enum(["OWNED", "VENDOR", "CUSTOMER"]);

export const convertOwnershipSchema = z
  .object({
    productVariantId: z.number().int().positive(),
    locationId: z.number().int().positive(),
    lotId: z.number().int().positive().optional(),
    quantity: qtyString,
    fromOwnership: ownershipSchema,
    toOwnership: ownershipSchema,
    /**
     * The price agreed with the supplier. Required, and deliberately so:
     * consigned stock carries no cost of ours until this moment, so there is
     * nothing to inherit and nothing to estimate. A default would be a number
     * somebody would find on a balance sheet and be unable to explain.
     */
    unitCost: costString,
  })
  .strict();

export const listConsignedQuerySchema = z
  .object({ warehouseId: z.coerce.number().int().positive().optional() })
  .strict();

export type ConvertOwnershipInput = z.infer<typeof convertOwnershipSchema>;
export type ListConsignedQuery = z.infer<typeof listConsignedQuerySchema>;
