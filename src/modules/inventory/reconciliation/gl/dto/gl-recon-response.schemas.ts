import { z } from "zod";

/**
 * D6 — the shapes the GL reconciliation puts on the wire.
 *
 * Nothing here is a `Date`. Every figure comes out of `db.execute` on SQL that
 * casts it (`::text` for the money and quantity columns, `::int` for the counts,
 * `::text` for the dates), and `generatedAt` is stamped with `toISOString()` in
 * the service. So the contract is strings and integers all the way down.
 */
const glReconRowSchema = z.object({
  sourceType: z.string(),
  sourceId: z.string(),
  label: z.string(),
  sourceEvent: z.string(),
  postedOn: z.string(),
  movementValue: z.string(),
  netQuantity: z.string(),
  movementCount: z.number().int(),
  hasCost: z.boolean(),
  accountCodes: z.array(z.string()),
  /** The roles the entry names that no account in the book fills — the remedy. */
  missingAccountCodes: z.array(z.string()),
  journalEntryId: z.string().nullable(),
  journalEntryNumber: z.string().nullable(),
  journalEntryDate: z.string().nullable(),
  journalStatus: z.string().nullable(),
  journalValue: z.string().nullable(),
  status: z.string(),
});

/** The rule table, resolved against this organisation's chart. */
const resolvedGlPostingRuleSchema = z.object({
  sourceType: z.string(),
  sourceEvent: z.string(),
  label: z.string(),
  keyedOn: z.enum(["reference", "shipment"]),
  accountPurposes: z.array(z.string()),
  accountTags: z.array(z.string()),
  accountCodes: z.array(z.string()),
  missingAccountTags: z.array(z.string()),
});

const uncoveredGroupSchema = z.object({
  sourceType: z.string(),
  movementCount: z.number().int(),
  movementValue: z.string(),
});

export const glReconReportResponseSchema = z.object({
  generatedAt: z.string(),
  window: z.object({
    fromDate: z.string(),
    toDate: z.string(),
    period: z
      .object({
        periodId: z.string(),
        name: z.string(),
        startDate: z.string(),
        endDate: z.string(),
        status: z.string(),
      })
      .nullable(),
  }),
  accounting: z.object({
    journalsInstalled: z.boolean(),
    /** Said out loud: a tenant with no book has no gap, and must not read as one. */
    note: z.string().nullable(),
  }),
  rules: z.array(resolvedGlPostingRuleSchema),
  summary: z.object({
    groups: z.number().int(),
    matched: z.number().int(),
    valueMismatch: z.number().int(),
    missingCoa: z.number().int(),
    unmatched: z.number().int(),
    notInstalled: z.number().int(),
    movementValue: z.string(),
    journalValue: z.string(),
    unreconciledValue: z.string(),
  }),
  unpostedByDesign: z.array(uncoveredGroupSchema),
  postedByStockBridge: z.array(uncoveredGroupSchema),
  /** The other direction: a journal whose stock document moved nothing. */
  orphanJournals: z.array(
    z.object({
      journalEntryId: z.string(),
      journalEntryNumber: z.string(),
      journalEntryDate: z.string(),
      sourceType: z.string(),
      sourceId: z.string().nullable(),
      sourceEvent: z.string().nullable(),
      journalStatus: z.string(),
      journalValue: z.string(),
    }),
  ),
  items: z.array(glReconRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  totalPages: z.number().int(),
});

/**
 * `installed` means "this organisation keeps books". The tables always exist, so
 * an empty list with `installed: false` is a tenant with no default book rather
 * than a tenant whose calendar is empty.
 */
export const listGlReconPeriodsResponseSchema = z.object({
  installed: z.boolean(),
  items: z.array(
    z.object({
      periodId: z.string(),
      name: z.string(),
      startDate: z.string(),
      endDate: z.string(),
      status: z.string(),
    }),
  ),
});
