/**
 * Why a candidate left the pipeline, as a closed list of codes.
 *
 * The code is what is stored and the label is one rendering of it, never the
 * other way round. A label is prose a hiring team rewrites — "Notice period"
 * becomes "Notice period too long" the first time somebody finds it ambiguous
 * in a report — and storing the prose freezes each quarter's wording into that
 * quarter's rows. Group by it afterwards and one reason arrives as two
 * categories, which is how a rejection report quietly stops adding up and how a
 * diversity or drop-off analysis reaches a wrong conclusion from real data.
 * With codes stored, renaming a label is a display change: history keeps its
 * shape and a series stays a series.
 *
 * Closed rather than free text for the same reason. A typed reason produces
 * "comp", "CTC", "salary expectation" and "budget" for one fact, and nothing
 * downstream can count them. Recruiters who need to say more get `OTHER` plus a
 * note, which keeps the uncountable thing out of the countable column.
 */
export const REJECTION_REASONS = [
  "SKILLS_MISMATCH",
  "EXPERIENCE_MISMATCH",
  /** Expected CTC above the band — the single most common Indian disposition. */
  "COMPENSATION",
  /** Base location, relocation refused, or an office the candidate cannot reach. */
  "LOCATION",
  /**
   * 60 and 90-day notices are ordinary here and buy-outs are not always
   * possible, so "could not join in time" is a reason in its own right rather
   * than a flavour of the candidate withdrawing. Folding it into `WITHDREW`
   * would hide the one disposition a hiring plan can actually act on, by
   * starting the search earlier.
   */
  "NOTICE_PERIOD",
  /**
   * The candidate stopped, we did not.
   *
   * Kept apart from every reason above because it is not a judgement about
   * them: a withdrawn candidate is re-approachable for the next opening, and
   * merging them into a rejection bucket both loses that and overstates how
   * many people the team turned down.
   */
  "WITHDREW",
  /** The requisition closed or was put on hold — a fact about us, not them. */
  "POSITION_CLOSED",
  "FAILED_ASSESSMENT",
  /** A BGV or identity check that did not clear. */
  "BACKGROUND_CHECK",
  /** The same person already in the pipeline under another record. */
  "DUPLICATE",
  "OTHER",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * Display text, and only display text.
 *
 * Nothing persists these strings and nothing keys on them, so they can be
 * reworded or translated without a migration and without splitting a report.
 */
export const REJECTION_REASON_LABELS: Record<RejectionReason, string> = {
  SKILLS_MISMATCH: "Skills mismatch",
  EXPERIENCE_MISMATCH: "Experience mismatch",
  COMPENSATION: "Compensation expectations",
  LOCATION: "Location or relocation",
  NOTICE_PERIOD: "Notice period",
  WITHDREW: "Candidate withdrew",
  POSITION_CLOSED: "Position closed or on hold",
  FAILED_ASSESSMENT: "Did not clear assessment",
  BACKGROUND_CHECK: "Background check",
  DUPLICATE: "Duplicate record",
  OTHER: "Other",
};

/**
 * Long enough for a paragraph of context, short enough that the column does not
 * become a place to paste an interview transcript. The DTO repeats this bound
 * so an over-long note is refused at the edge with a field error, and this
 * module repeats it so a caller that skips the DTO cannot write past it.
 */
export const REJECTION_NOTE_MAX_LENGTH = 2000;

export interface RejectionInput {
  reason?: string | null;
  note?: string | null;
}

/**
 * `message` rather than `reason` on the refusal arm: `reason` in this module
 * means the disposition code, and one field holding both a code and a sentence
 * about a code is how a refusal string ends up written to the column.
 */
export type RejectionDecision =
  | { allowed: true; reason: RejectionReason; note: string | null }
  | { allowed: false; message: string };

function isRejectionReason(value: string): value is RejectionReason {
  return (REJECTION_REASONS as readonly string[]).includes(value);
}

/**
 * Whether a rejection may be recorded, and in what shape.
 *
 * Refusing an absent reason is the whole point: a reject used to be one drag
 * with nothing attached, so the only record of why anybody was turned down was
 * whatever the recruiter happened to remember. That costs a hiring team its
 * funnel analysis, and it costs a candidate the ability to be told anything
 * true — an employer that cannot say why cannot answer a DPDP request about a
 * decision it made.
 *
 * `OTHER` without a note is refused separately, because `OTHER` is the escape
 * hatch and an unexplained escape hatch is where a required field goes to die:
 * one click and the catalog is back to meaning nothing. Requiring the note is
 * what keeps `OTHER` more expensive than picking the right code.
 *
 * The caller gets back the trimmed note (or null) rather than the raw input, so
 * a whitespace-only note cannot reach the column and read as an explanation.
 */
export function decideRejection(input: RejectionInput): RejectionDecision {
  const code = input.reason?.trim() ?? "";
  if (code.length === 0) {
    return {
      allowed: false,
      message: "A rejection reason is required. Pick the reason that best describes this decision.",
    };
  }

  if (!isRejectionReason(code)) {
    return {
      allowed: false,
      message: `"${code}" is not a rejection reason. Pick one of: ${REJECTION_REASONS.join(", ")}.`,
    };
  }

  const note = input.note?.trim() ?? "";

  if (code === "OTHER" && note.length === 0) {
    return {
      allowed: false,
      message: "Choosing Other requires a note saying why this candidate was rejected.",
    };
  }

  if (note.length > REJECTION_NOTE_MAX_LENGTH) {
    return {
      allowed: false,
      message: `The rejection note must be at most ${REJECTION_NOTE_MAX_LENGTH} characters.`,
    };
  }

  return { allowed: true, reason: code, note: note.length > 0 ? note : null };
}
