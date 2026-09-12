import { z } from "zod";

const qtyString = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "Quantity must be a positive decimal with up to 4 places");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const quickCommerceProviderSchema = z.enum(["BLINKIT", "INSTAMART", "ZEPTO"]);

export const ingestPlatformPoSchema = z
  .object({
    provider: quickCommerceProviderSchema,
    /**
     * The provider's own document, unparsed. `z.unknown()` deliberately: the
     * shape is the adapter's business, and validating it twice — once loosely
     * here and once properly there — is how the two definitions drift.
     */
    payload: z.unknown(),
    warehouseId: z.number().int().positive().optional(),
  })
  .strict();

export const acceptPlatformPoSchema = z
  .object({
    vendorId: z.number().int().positive(),
    warehouseId: z.number().int().positive(),
    orderDate: isoDate,
    /**
     * Whether accepting also claims the stock for the platform's channel pool.
     * Default on: the whole point of accepting a Blinkit order is that those
     * units stop being offered on the storefront.
     */
    reserveIntoChannelPool: z.boolean().default(true),
  })
  .strict();

export const listPlatformPosQuerySchema = z
  .object({
    provider: quickCommerceProviderSchema.optional(),
    status: z.enum(["RECEIVED", "REJECTED", "ACCEPTED", "CANCELLED"]).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

const asnLineSchema = z
  .object({
    poLineId: z.number().int().positive().optional(),
    productVariantId: z.number().int().positive(),
    quantityExpected: qtyString,
    lotNumber: z.string().max(120).optional(),
    expiryDate: isoDate.optional(),
    mrpPaise: z.number().int().positive().optional(),
  })
  .strict();

export const createAsnSchema = z
  .object({
    poId: z.number().int().positive(),
    platformPoId: z.number().int().positive().optional(),
    warehouseId: z.number().int().positive().optional(),
    locationId: z.number().int().positive().optional(),
    carrierName: z.string().max(200).optional(),
    trackingRef: z.string().max(200).optional(),
    appointmentStart: z.string().datetime().optional(),
    appointmentEnd: z.string().datetime().optional(),
    expectedArrival: isoDate.optional(),
    notes: z.string().max(2000).optional(),
    lines: z.array(asnLineSchema).min(1),
  })
  .strict()
  .refine(
    (v) =>
      v.appointmentStart === undefined ||
      v.appointmentEnd === undefined ||
      new Date(v.appointmentEnd) > new Date(v.appointmentStart),
    { message: "An appointment must end after it starts", path: ["appointmentEnd"] },
  );

export const listAsnsQuerySchema = z
  .object({
    poId: z.coerce.number().int().positive().optional(),
    status: z.enum(["DRAFT", "CONFIRMED", "IN_TRANSIT", "ARRIVED", "CLOSED", "CANCELLED"]).optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export type IngestPlatformPoInput = z.infer<typeof ingestPlatformPoSchema>;
export type AcceptPlatformPoInput = z.infer<typeof acceptPlatformPoSchema>;
export type ListPlatformPosQuery = z.infer<typeof listPlatformPosQuerySchema>;
export type CreateAsnInput = z.infer<typeof createAsnSchema>;
export type ListAsnsQuery = z.infer<typeof listAsnsQuerySchema>;

/**
 * NEO-3 - one line of a platform payout file.
 *
 * `amountPaise` is integer minor units. A payout is money, and a payout that
 * arrives as 4199 and leaves as 41.98999999999999 is not a rounding preference.
 */
const payoutLineSchema = z
  .object({
    providerPoNumber: z.string().max(120).optional(),
    providerSku: z.string().max(120).optional(),
    ean: z.string().max(64).optional(),
    quantity: qtyString,
    amountPaise: z.number().int(),
  })
  .strict()
  .refine((v) => Boolean(v.providerSku) || Boolean(v.ean), {
    message: "A payout line must name a SKU or an EAN",
    path: ["providerSku"],
  });

export const uploadPayoutSchema = z
  .object({
    provider: quickCommerceProviderSchema,
    /** The platform's own settlement reference. Half of the idempotency fence. */
    payoutRef: z.string().min(1).max(120),
    settledOn: isoDate.optional(),
    lines: z.array(payoutLineSchema).min(1).max(2000),
  })
  .strict();

export const fillRateQuerySchema = z
  .object({
    platformPoId: z.coerce.number().int().positive(),
  })
  .strict();

export type UploadPayoutInput = z.infer<typeof uploadPayoutSchema>;
export type FillRateQuery = z.infer<typeof fillRateQuerySchema>;
