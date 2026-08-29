import { z } from "zod";

export const updateSettingsSchema = z.object({
  allowNegativeStock: z.boolean().optional(),
  allowBackorders: z.boolean().optional(),
  reservationStrategy: z.enum(["MANUAL", "AUTO_ON_CONFIRM", "FEFO", "FIFO"]).optional(),
  defaultCostingMethod: z.enum(["STANDARD", "WEIGHTED_AVERAGE", "FIFO"]).optional(),
  expiryReservationPolicy: z.enum(["BLOCK", "WARN", "ALLOW"]).optional(),
  inspectionOnReceipt: z.boolean().optional(),
  inspectionOnReturn: z.boolean().optional(),
  overReceiptTolerancePct: z.string().optional(),
  requirePoApproval: z.boolean().optional(),
  adjustmentApprovalThreshold: z.string().nullable().optional(),
  /**
   * D8. Above this much inventory value an adjustment — a write-off above all —
   * needs a second signature. Distinct from the quantity threshold beside it,
   * which cannot tell forty screws from forty turbines.
   */
  adjustmentApprovalValueThreshold: z.string().nullable().optional(),
  autoReserveOnConfirm: z.boolean().optional(),
  allowPartialShipment: z.boolean().optional(),
  packageRequiredForShipping: z.boolean().optional(),
  channelPublishPolicy: z.string().nullable().optional(),
  /**
   * E1. The packs, sent as the columns they are. `packWarehouse` is accepted so
   * an organisation that genuinely does not run a warehouse can say so, but the
   * service refuses to leave every pack off — an inventory module with no pack
   * has no fields and no rules, which is a support ticket rather than a
   * configuration.
   */
  packWarehouse: z.boolean().optional(),
  packKirana: z.boolean().optional(),
  packPharmacy: z.boolean().optional(),
  packGst: z.boolean().optional(),
  /**
   * E2. The organisation's GST registration. Only meaningful while the `gst`
   * pack is on, and the service refuses `COMPOSITION` without it — a composition
   * rule that silently does nothing is worse than one that will not save.
   */
  gstMode: z.enum(["REGULAR", "COMPOSITION"]).optional(),
}).strict();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const updateNumberSequenceSchema = z.object({
  prefix: z.string().min(1).optional(),
  padding: z.number().int().min(1).max(10).optional(),
  nextNumber: z.number().int().min(1).optional(),
}).strict();

export type UpdateNumberSequenceInput = z.infer<typeof updateNumberSequenceSchema>;
