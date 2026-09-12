import { z } from "zod";
import { pageNumberField, pageSizeField } from "../../../../common/pagination/list-query.schema";

/**
 * INV-26 — what an administrator may say about a courier account, and what an
 * operator may ask about its failures.
 *
 * `.strict()` throughout, and the credential fields are `.nullable()` rather
 * than merely optional, because the three states are genuinely different:
 * absent means "leave this alone" (an administrator rotating the webhook secret
 * must not silently clear the API key), `null` means "remove it", and a string
 * means "replace it".
 */
export const setCarrierCredentialsSchema = z
  .object({
    /**
     * Which registered adapter speaks for this carrier. Checked against the
     * registry in the service, not listed here: a `z.enum` would have to be
     * kept in step with the registry by hand, and the copy is what goes stale.
     */
    transport: z.string().min(1).max(100).nullable().optional(),
    /**
     * Where that adapter posts — the tenant's own sandbox or production
     * endpoint. Re-checked against the SSRF guard on write AND on every call,
     * because DNS is not immutable.
     */
    apiBaseUrl: z.string().url().max(500).nullable().optional(),
    /** The courier key. Stored encrypted, never returned. */
    apiCredential: z.string().min(1).max(2000).nullable().optional(),
    /**
     * The shared secret the courier signs its callbacks with. 32 characters is
     * the floor because a short shared secret is guessable offline against one
     * captured callback, and the public ingest gives an attacker unlimited
     * attempts at exactly that.
     */
    webhookSecret: z.string().min(32).max(2000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Send at least one field; an empty body would silently do nothing.",
  );
export type SetCarrierCredentialsInput = z.infer<typeof setCarrierCredentialsSchema>;

/** Which failures an operator is looking at. */
export const carrierOperationsQuerySchema = z
  .object({
    shipmentId: z.coerce.number().int().positive().optional(),
    operation: z.enum(["book", "label", "track"]).optional(),
    /**
     * Defaults to nothing, i.e. every outcome. The operator's queue is
     * `outcome=rejected` and `outcome=unavailable`; the shipment sheet wants
     * all three so a reader can see the failure the retry recovered from.
     */
    outcome: z.enum(["accepted", "rejected", "unavailable"]).optional(),
    page: pageNumberField,
    limit: pageSizeField(20, 100),
  })
  .strict();
export type CarrierOperationsQuery = z.infer<typeof carrierOperationsQuerySchema>;

/** The dead-letter queue: callbacks that verified and could not be applied. */
export const carrierDeliveriesQuerySchema = z
  .object({
    status: z.enum(["applied", "ignored", "dead_lettered"]).optional(),
    page: pageNumberField,
    limit: pageSizeField(20, 100),
  })
  .strict();
export type CarrierDeliveriesQuery = z.infer<typeof carrierDeliveriesQuerySchema>;
