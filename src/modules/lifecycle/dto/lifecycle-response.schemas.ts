import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

/**
 * The renewal book's shapes.
 *
 * `startedOn`, `renewalOn` and `termStartedOn` are `date` columns and arrive as
 * strings; every instant column is a `Date` at the interceptor and so is a
 * `wireDate()`. Money is integer minor units on a `bigint` read in number mode.
 */

/** The whole `customer_lifecycles` row, which the write paths return. */
const lifecycleRowSchema = z.object({
  customerLifecycleId: z.string(),
  organizationId: z.string(),
  partyId: z.string(),
  sourceDealId: z.number().int(),
  status: z.string(),
  startedOn: z.string(),
  termMonths: z.number().int(),
  renewalOn: z.string(),
  contractValueMinor: z.number().int(),
  renewalCount: z.number().int(),
  riskScore: z.number().int(),
  riskComputedAt: nullableWireDate(),
  lastSignalAt: nullableWireDate(),
  closedReason: z.string().nullable(),
  closedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

/** `riskBand` — derived from the stored score, never stored beside it. */
const bandSchema = z.enum(["at-risk", "watch", "healthy"]);

const lifecycleSignalSchema = z.object({
  lifecycleSignalId: z.string(),
  kind: z.string(),
  /** Signed, -100..100. */
  impact: z.number().int(),
  observedAt: wireDate(),
  source: z.string(),
  recordedByUserId: z.string().nullable(),
  note: z.string().nullable(),
});

/**
 * `list` — the book, with the party name joined in.
 *
 * `partyName` comes off a tenant-matched LEFT JOIN, so it is null for a contract
 * whose party record has gone: money outlives a record.
 */
export const listLifecyclesResponseSchema = z.object({
  data: z.array(
    z.object({
      customerLifecycleId: z.string(),
      partyId: z.string(),
      partyName: z.string().nullable(),
      sourceDealId: z.number().int(),
      status: z.string(),
      startedOn: z.string(),
      termMonths: z.number().int(),
      renewalOn: z.string(),
      contractValueMinor: z.number().int(),
      renewalCount: z.number().int(),
      riskScore: z.number().int(),
      lastSignalAt: nullableWireDate(),
      band: bandSchema,
    }),
  ),
  hasMore: z.boolean(),
});

/** `get` — one contract with the evidence behind its score, newest signal first. */
export const getLifecycleResponseSchema = z.object({
  data: lifecycleRowSchema.extend({
    band: bandSchema,
    signals: z.array(lifecycleSignalSchema),
  }),
});

/** `recordSignal` — the filed signal and the score it moved. */
export const recordLifecycleSignalResponseSchema = z.object({
  data: z.object({
    signal: z.object({
      lifecycleSignalId: z.string(),
      organizationId: z.string(),
      customerLifecycleId: z.string(),
      kind: z.string(),
      impact: z.number().int(),
      observedAt: wireDate(),
      source: z.string(),
      recordedByUserId: z.string().nullable(),
      note: z.string().nullable(),
      createdAt: wireDate(),
    }),
    riskScore: z.number().int(),
    band: bandSchema,
  }),
});

/** `renew` — the advanced term, re-scored in the same transaction. */
export const renewLifecycleResponseSchema = z.object({
  data: lifecycleRowSchema.extend({
    riskScore: z.number().int(),
    band: bandSchema,
  }),
});

/** `close` — the ended contract. Its risk is zeroed; revenue already gone is not at risk. */
export const closeLifecycleResponseSchema = z.object({ data: lifecycleRowSchema });
