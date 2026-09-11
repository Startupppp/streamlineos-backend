import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";

export const crmProductSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string().nullable(),
  category: z.string().nullable(),
  unitPrice: z.number().int(),
  currency: z.string(),
  taxRate: z.number().int(),
  isActive: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  deletedAt: nullableWireDate(),
});

export const crmProductsListSchema = z.object({
  products: z.array(crmProductSchema),
  total: z.number().int(),
});
