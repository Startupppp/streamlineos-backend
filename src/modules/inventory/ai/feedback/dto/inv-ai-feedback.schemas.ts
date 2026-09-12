import { z } from "zod";

/**
 * F6 — what a person says about an AI answer they were shown.
 *
 * ## Four verdicts, not a thumb
 *
 * `USEFUL` · `WRONG` · `STALE` · `UNSAFE`. The four exist because they are acted
 * on by different people for different reasons, and a satisfaction ratio
 * destroys exactly that information:
 *
 *   * `WRONG` is a claim about the arithmetic, and points at the deterministic
 *     layer rather than at the model — the figures come from the inventory
 *     engine, so a wrong number is an engine bug wearing a narration.
 *   * `STALE` says the figures were right when computed and are not any more.
 *     That is an evidence-hash question, not a model one, and it is why the
 *     evidence hash travels on this payload.
 *   * `UNSAFE` says the answer invited an operator to do something they should
 *     not. It must never be averaged into a score: one of these outranks a
 *     hundred `USEFUL`s, and the summary reports it separately for that reason.
 *
 * ## What the client may and may not tell us
 *
 * It may tell us **which call** it is talking about — the gateway correlation
 * id — and **what it was reading**: the surface, the prompt key and version, the
 * contract version and the evidence hash. All of those are identifiers the
 * client legitimately holds, all are bounded, and none of them decides anything.
 *
 * It may **not** tell us what the call cost. Tokens, credits and provider cost
 * are read back from the gateway's own usage log by correlation id, because a
 * browser-supplied cost figure is a number nobody should store and a report
 * about a call that never happened is not feedback.
 */

/**
 * The AI surfaces a person can be looking at when they file a verdict. Closed,
 * because an open string here would make the summary ungroupable within a week
 * and would let a client invent a surface that no screen corresponds to.
 */
export const INV_AI_SURFACES = [
  "ops_brief",
  "insight_explain",
  "anomaly_queue",
  "demand_risk",
  "report_builder",
  "copilot",
  "reorder_proposal",
  "supplier_delay",
  "digest",
] as const;
export type InvAiSurface = (typeof INV_AI_SURFACES)[number];

export const INV_AI_VERDICTS = ["USEFUL", "WRONG", "STALE", "UNSAFE"] as const;
export type InvAiVerdict = (typeof INV_AI_VERDICTS)[number];

/** Verdicts that are a complaint, and therefore need a sentence to act on. */
export const VERDICTS_REQUIRING_NOTE: readonly InvAiVerdict[] = ["WRONG", "UNSAFE"];

export const NOTE_MIN = 10;
export const NOTE_MAX = 1000;

export const createInvAiFeedbackSchema = z
  .object({
    surface: z.enum(INV_AI_SURFACES),
    verdict: z.enum(INV_AI_VERDICTS),
    /** The gateway's id for the call being judged. */
    correlationId: z.string().trim().min(1).max(64),
    promptKey: z.string().trim().min(1).max(120),
    promptVersion: z.number().int().min(1).max(10_000),
    contractVersion: z.number().int().min(1).max(10_000),
    /** The fingerprint the answer was built on, when the surface carries one. */
    evidenceHash: z.string().trim().min(1).max(64).optional(),
    note: z.string().trim().min(1).max(NOTE_MAX).optional(),
  })
  .strict()
  /**
   * A complaint with no sentence is unactionable, which defeats the whole
   * table. The database refuses it too — this is the readable half of the same
   * rule, so a user gets a 400 explaining what to write rather than a 500 from
   * a constraint.
   */
  .refine(
    (value) =>
      !VERDICTS_REQUIRING_NOTE.includes(value.verdict) ||
      (value.note !== undefined && value.note.length >= NOTE_MIN),
    {
      path: ["note"],
      message: `A verdict of WRONG or UNSAFE needs a note of at least ${NOTE_MIN} characters saying what was wrong.`,
    },
  );
export type CreateInvAiFeedbackInput = z.infer<typeof createInvAiFeedbackSchema>;

export const invAiFeedbackSummaryQuerySchema = z
  .object({
    surface: z.enum(INV_AI_SURFACES).optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();
export type InvAiFeedbackSummaryQuery = z.infer<typeof invAiFeedbackSummaryQuerySchema>;
