import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";
import { cursorPageSchema, successSchema } from "../../../common/openapi/response-envelopes";

const componentRowSchema = z.object({
  offerFulfillmentComponentId: z.number(),
  orgId: z.string(),
  crmOfferId: z.number().int(),
  crmOfferOrgId: z.string(),
  invSkuId: z.number().int(),
  invSkuOrgId: z.string(),
  quantityPerUnit: z.string(),
  uom: z.string().nullable(),
  status: z.string(),
  effectiveFrom: nullableWireDate(),
  effectiveTo: nullableWireDate(),
  notes: z.string().nullable(),
  createdBy: z.string(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const componentListSchema = cursorPageSchema(componentRowSchema);
export const componentDetailSchema = componentRowSchema;
export { successSchema };
