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
   * B1. Construction and interior materials — catalogue attributes, dark stores
   * with a delivery zone, and the projects that consume them.
   */
  packMaterials: z.boolean().optional(),
  /**
   * E2. The organisation's GST registration. Only meaningful while the `gst`
   * pack is on, and the service refuses `COMPOSITION` without it — a composition
   * rule that silently does nothing is worse than one that will not save.
   */
  gstMode: z.enum(["REGULAR", "COMPOSITION"]).optional(),
  /**
   * D2. Short-dated stock. The window is capped at a year because one wider than
   * the shelf life it describes silently blocks the whole catalogue, which reads
   * as "allocation is broken" rather than as a setting somebody chose.
   */
  nearExpiryPolicy: z.enum(["ALLOW", "DEPRIORITIZE", "BLOCK"]).optional(),
  nearExpiryWindowDays: z.number().int().min(0).max(365).optional(),
  /**
   * E5. Statutory adapters. Separate from `packGst`: the pack decides whether
   * HSN fields exist, these decide whether this deployment talks to an authority.
   * `stub` is the only implementation; any other name refuses with NO_CREDENTIALS.
   */
  gstEinvoiceEnabled: z.boolean().optional(),
  gstEwaybillEnabled: z.boolean().optional(),
  tallyExportEnabled: z.boolean().optional(),
  complianceAdapter: z.string().min(1).max(50).optional(),
  /**
   * E3. The Schedule H1 register export, off unless this organisation's
   * jurisdiction requires the register. Its own switch rather than something
   * `packPharmacy` implies: a hospital store and a retail chemist under one roof
   * answer to different rules. The service refuses it while the pharmacy pack is
   * off — nothing carries a drug schedule then, so the export would be a
   * permanently empty screen claiming to be a register.
   */
  pharmacyH1RegisterEnabled: z.boolean().optional(),
}).strict();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const updateNumberSequenceSchema = z.object({
  prefix: z.string().min(1).optional(),
  padding: z.number().int().min(1).max(10).optional(),
  nextNumber: z.number().int().min(1).optional(),
}).strict();

export type UpdateNumberSequenceInput = z.infer<typeof updateNumberSequenceSchema>;

/**
 * D2. The minimum remaining shelf life a destination contracted for.
 *
 * `clientId: null` (or omitted) is the organisation's house floor — the one that
 * applies to every customer without a rule of their own.
 *
 * `minShelfLifeDays: 0` clears the rule rather than storing a zero: "no floor"
 * is the absence of a row, and a stored zero would read on a settings screen as
 * a rule somebody set. The upper bound is ten years, because a floor longer than
 * any shelf life in the catalogue refuses every lot and presents as "allocation
 * is broken" rather than as a setting.
 */
export const putShelfLifeRuleSchema = z.object({
  clientId: z.number().int().positive().nullable().optional(),
  minShelfLifeDays: z.number().int().min(0).max(3650),
  notes: z.string().max(500).nullable().optional(),
}).strict();

export type PutShelfLifeRuleInput = z.infer<typeof putShelfLifeRuleSchema>;
