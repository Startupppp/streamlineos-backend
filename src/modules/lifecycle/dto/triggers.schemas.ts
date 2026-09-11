import { z } from "zod";
import {
  LIFECYCLE_TRIGGER_KINDS,
  LIFECYCLE_TRIGGER_OUTCOMES,
} from "../../../db/schema/crm/lifecycle";

/**
 * The trigger surface's boundary.
 *
 * Same two decisions as `lifecycle.schemas.ts`: every bound rejects rather than
 * clamps, and the write body is `.strict()`. The sweep's body is strict for a
 * sharper reason than usual — it carries `asOf`, and a misspelled key silently
 * ignored would mean a caller who asked to consider the book as of next quarter
 * got today's answer and no indication of it.
 */

const identifier = z.string().trim().min(1).max(64);

export const sweepTriggersSchema = z
  .object({
    /**
     * How many contracts one sweep may consider.
     *
     * Fifty by default and two hundred at the cap, both deliberately modest:
     * each candidate that turns out to be due costs a provider call, so this
     * number is a bill as much as a page size. A tenant with a larger book runs
     * more sweeps rather than one bigger one, and because the order is the
     * renewal date the contracts a truncated sweep leaves behind are the ones
     * with the most time left.
     */
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /**
     * Consider the book as of a given moment rather than now.
     *
     * Present for the operational case that actually happens: a sweep that did
     * not run for three days, replayed for the day it missed, so a renewal is
     * dated by when it became due rather than by when somebody noticed. It
     * cannot manufacture a message on its own — everything downstream reads the
     * real clock, and `send-guardrails.ts` takes its snapshot at send time.
     */
    asOf: z.coerce.date().optional(),
  })
  .strict();

export type SweepTriggersQuery = z.infer<typeof sweepTriggersSchema>;

export const listTriggersQuerySchema = z
  .object({
    kind: z.enum(LIFECYCLE_TRIGGER_KINDS).optional(),
    /**
     * `skipped` is the filter this log exists for. "Which renewals did the loop
     * decline, and what did it say" is the only question that leads to somebody
     * doing something; a log that could only be read in full would bury it.
     */
    outcome: z.enum(LIFECYCLE_TRIGGER_OUTCOMES).optional(),
    partyId: identifier.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .strict();

export type ListTriggersQuery = z.infer<typeof listTriggersQuerySchema>;
