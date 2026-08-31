import { positiveDecimalQuantity } from "../../stock-engine/dto/quantity.schemas";
import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

export const listReturnsSchema = z.object({
  status: z.enum(["DRAFT", "APPROVED", "POSTED", "CANCELLED"]).optional(),
  page: pageNumberField,
  limit: pageSizeField(50, 100),
}).strict();
export type ListReturnsInput = z.infer<typeof listReturnsSchema>;

/**
 * B9, items 1 and 5 — the sign-off, and the credit it expects.
 *
 * `creditReference` is an opaque pointer into whatever system issues credit
 * notes or refunds. It is recorded and carried on the posted event so an
 * accounting adapter can reconcile against it; nothing in the stock path reads
 * it, because a credit that has not been raised yet is not a reason to leave
 * the goods off the shelf. There is no payments integration here and this field
 * is not the beginning of one.
 */
export const approveReturnSchema = z.object({
  creditReference: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ApproveReturnInput = z.infer<typeof approveReturnSchema>;

const vendorReturnLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: positiveDecimalQuantity,
  reason: z.enum(["DAMAGED", "WRONG_ITEM", "EXCESS", "EXPIRED", "QUALITY_REJECTED"]),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
  unitCost: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
}).strict();

export const createVendorReturnSchema = z.object({
  vendorId: z.number().int().positive(),
  poId: z.number().int().positive().optional(),
  grnId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(vendorReturnLineSchema).min(1),
}).strict();
export type CreateVendorReturnInput = z.infer<typeof createVendorReturnSchema>;

export const postVendorReturnSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type PostVendorReturnInput = z.infer<typeof postVendorReturnSchema>;

/**
 * B9. `RETURN_TO_VENDOR` is the fourth verdict: faulty, and the supplier's
 * fault. Declared once so the intake guess and the inspection decision cannot
 * offer different sets.
 */
const customerReturnDisposition = z.enum([
  "RESTOCK",
  "QUARANTINE",
  "SCRAP",
  "RETURN_TO_VENDOR",
]);

const customerReturnLineSchema = z.object({
  productVariantId: z.number().int().positive(),
  quantity: positiveDecimalQuantity,
  reason: z.string().max(500),
  /**
   * INV-209. Optional now. A disposition asserted before anybody opened the
   * box is a guess, and it used to be the guess that posted stock. Omit it and
   * the line waits for inspection.
   */
  disposition: customerReturnDisposition.optional(),
  targetLocationId: z.number().int().positive().optional(),
  lotId: z.number().int().positive().optional(),
  serialId: z.number().int().positive().optional(),
}).strict();

export const createCustomerReturnSchema = z.object({
  soId: z.number().int().positive().optional(),
  shipmentId: z.number().int().positive().optional(),
  clientId: z.number().int().positive().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(customerReturnLineSchema).min(1),
}).strict();
export type CreateCustomerReturnInput = z.infer<typeof createCustomerReturnSchema>;

export const postCustomerReturnSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();
export type PostCustomerReturnInput = z.infer<typeof postCustomerReturnSchema>;

/** INV-209. The decision made after actually looking at the goods. */
export const inspectReturnLineSchema = z
  .object({
    lineId: z.number().int().positive(),
    disposition: customerReturnDisposition,
    inspectionNotes: z.string().max(1000).optional(),
  })
  .strict();
export type InspectReturnLineInput = z.infer<typeof inspectReturnLineSchema>;
