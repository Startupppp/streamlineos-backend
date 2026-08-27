import { z } from "zod";
import {
  CUSTOMER_LIFECYCLE_STATUSES,
  LIFECYCLE_SIGNAL_KINDS,
} from "../../../db/schema/crm/lifecycle";
import { RISK_BANDS, MAX_SIGNAL_IMPACT, MIN_SIGNAL_IMPACT } from "../lifecycle-risk";
import { MAX_TERM_MONTHS, MIN_TERM_MONTHS } from "../lifecycle-terms";

/**
 * The renewal book's boundary.
 *
 * Two decisions here are worth stating. Every bound rejects rather than clamps,
 * because a caller who asked for a thousand rows and silently got fifty will
 * conclude the tenant has fifty contracts — a 400 is the only answer that
 * cannot be mistaken for data. And the write bodies are `.strict()`: the term
 * and the value on this row are money, and a key nobody validated arriving in a
 * spread would be the way one changes without a route for it.
 */

const identifier = z.string().trim().min(1).max(64);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * A page of the renewal book. Fifty is a screen; two hundred is the cap because
 * the book is bounded by a tenant's live contracts rather than by its history.
 */
export const listLifecyclesQuerySchema = z
  .object({
    status: z.enum(CUSTOMER_LIFECYCLE_STATUSES).optional(),
    /** Only this customer's contracts. The account view's question. */
    partyId: identifier.optional(),
    band: z.enum(RISK_BANDS).optional(),
    /**
     * The whole point of the feature, as a filter: what comes up for renewal
     * inside the next N days. A year and a day is the cap — beyond that a
     * "renewing soon" list is just the book.
     */
    renewingWithinDays: z.coerce.number().int().min(0).max(366).optional(),
    /**
     * `renewal` is the planning order and the default; `risk` is the triage
     * order. No free-text sort column — an order-by the caller names is an
     * index the planner has not got.
     */
    order: z.enum(["renewal", "risk"]).default("renewal"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .strict();

export type ListLifecyclesQuery = z.infer<typeof listLifecyclesQuerySchema>;

export const recordSignalSchema = z
  .object({
    kind: z.enum(LIFECYCLE_SIGNAL_KINDS),
    /**
     * Optional, and the kind's default is used when it is absent. Present so a
     * producer that actually measured something ("usage fell 8%", not 80%) can
     * say how much, rather than filing the same 30 as everything else.
     */
    impact: z.number().int().min(MIN_SIGNAL_IMPACT).max(MAX_SIGNAL_IMPACT).optional(),
    /**
     * When it happened. Accepted from the caller because a producer reading a
     * support system files last week's escalation today, and dating it now would
     * make an import look like a crisis this morning.
     */
    observedAt: z.coerce.date().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export type RecordSignalInput = z.infer<typeof recordSignalSchema>;

/**
 * Advancing the term. Everything is optional because the common renewal is
 * "same again": same length, same money, one year later.
 */
export const renewLifecycleSchema = z
  .object({
    termMonths: z.number().int().min(MIN_TERM_MONTHS).max(MAX_TERM_MONTHS).optional(),
    /**
     * The new recurring value in minor units. Integer minor units at the
     * boundary too — a float here is where the missing cent comes from, and
     * this number is summed across a book.
     */
    contractValueMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    /**
     * Where the new term starts. Defaults to the date the old one ended, which
     * is the only value that leaves no gap and no overlap in the book. Offered
     * because a renewal signed late genuinely starts late.
     */
    startedOn: isoDate.optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export type RenewLifecycleInput = z.infer<typeof renewLifecycleSchema>;

export const closeLifecycleSchema = z
  .object({
    /**
     * Which ending. `active` is not offered — reopening a closed contract is not
     * a correction, it is a new term, and it comes through renewal or a new won
     * deal so that the book keeps a reason for every ending.
     */
    status: z.enum(["churned", "cancelled"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type CloseLifecycleInput = z.infer<typeof closeLifecycleSchema>;
