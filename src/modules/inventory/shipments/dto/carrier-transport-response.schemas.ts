import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";
import { itemsPagedSchema } from "../../../../common/openapi/response-envelopes";

/**
 * INV-26 — what a carrier surface hands back.
 *
 * Note what is absent: no schema here has a field that could carry a
 * credential. `apiCredentialHint` is `maskSecretHint`'s "****3f9a" and
 * `webhookSecretSet` is a boolean, so the strongest statement this API can make
 * about a secret is that one exists and ends in four known characters.
 */

export const carrierCredentialsResponseSchema = z.object({
  carrierId: z.number().int(),
  /** Last four characters only. Never enough to reconstruct the key. */
  apiCredentialHint: z.string().nullable(),
  webhookSecretSet: z.boolean(),
});

export const carrierOperationSchema = z.object({
  id: z.number().int(),
  carrierId: z.number().int(),
  shipmentId: z.number().int(),
  transport: z.string(),
  operation: z.string(),
  outcome: z.string(),
  attempts: z.number().int(),
  carrierReference: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelUrl: z.string().nullable(),
  labelFormat: z.string().nullable(),
  errorCode: z.string().nullable(),
  /** The operator-facing half of "failure states visible". */
  errorMessage: z.string().nullable(),
  createdAt: wireDate(),
});
export const listCarrierOperationsResponseSchema = itemsPagedSchema(carrierOperationSchema);

export const carrierDeliverySchema = z.object({
  id: z.number().int(),
  carrierId: z.number().int(),
  eventKey: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  shipmentId: z.number().int().nullable(),
  receivedAt: wireDate(),
});
export const listCarrierDeliveriesResponseSchema = itemsPagedSchema(carrierDeliverySchema);

/**
 * What one book/label/track attempt did, as a value the sheet renders verbatim.
 *
 * `outcome` is carried through rather than collapsed to a boolean so the screen
 * can tell an operator the difference between "the courier said no" — go and
 * fix the address — and "the courier is down" — try again in ten minutes.
 */
export const carrierOperationResultSchema = z.object({
  shipmentId: z.number().int(),
  operation: z.string(),
  outcome: z.string(),
  attempts: z.number().int(),
  transport: z.string().nullable(),
  carrierReference: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelUrl: z.string().nullable(),
  labelFormat: z.string().nullable(),
  recorded: z.number().int(),
  message: z.string().nullable(),
});
