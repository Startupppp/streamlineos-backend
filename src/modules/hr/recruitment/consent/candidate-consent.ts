/**
 * What a candidate's personal data may be used for, how long it may be kept,
 * and whether a given record is due for erasure.
 *
 * Pure, because all three are policy rather than plumbing, and because the
 * retention clock is the kind of rule that quietly stops holding when somebody
 * adds a column. Today `candidate_applications.consent_at` is a bare timestamp:
 * it records that somebody clicked something, on some date, for a purpose
 * nobody wrote down. Under DPDP that is not consent — consent is to a stated
 * purpose, and a purpose nobody recorded cannot be honoured, evidenced, or
 * withdrawn from.
 *
 * The two harms this file exists to prevent point in opposite directions, which
 * is why every answer here is a named decision rather than a boolean:
 *
 *   - Keeping a résumé for years because no clock ever started. The candidate
 *     was told "this role"; the row outlives the role, the requisition and the
 *     recruiter.
 *   - Erasing a record early, which is irreversible and destroys the evidence
 *     that the hiring decision was lawful.
 *
 * A caller that can only see true/false picks one of those harms at random. A
 * caller holding `{ decision: "WITHIN_RETENTION", retainUntil }` can tell the
 * candidate the date.
 */

/**
 * The closed list of purposes a candidate's data may be processed for.
 *
 * Closed, and stored as text with a CHECK behind it, because an open field
 * becomes free text within a quarter and free text cannot be reasoned about by
 * a retention sweep — a sweep that cannot classify a row is a sweep that keeps
 * it forever.
 */
export const CANDIDATE_CONSENT_PURPOSES = [
  "THIS_ROLE_ONLY",
  "FUTURE_ROLES",
  "BACKGROUND_VERIFICATION",
  "STATUTORY_RECORD",
] as const;

export type CandidateConsentPurpose = (typeof CANDIDATE_CONSENT_PURPOSES)[number];

/**
 * Why the data may be held, which decides whether withdrawal ends the matter.
 *
 * `LEGAL_OBLIGATION` is not a loophole and must never be used to keep a
 * rejected applicant on file: it covers the records an employer is separately
 * required to retain about somebody it actually hired. Consent cannot be
 * withdrawn from an obligation that does not rest on consent, and pretending
 * otherwise would have the erase path delete records the organisation is
 * required to produce.
 */
export type LawfulBasis = "CONSENT" | "LEGAL_OBLIGATION";

export interface RetentionRule {
  /** Months the record may be kept after the last activity on it. */
  readonly months: number;
  readonly lawfulBasis: LawfulBasis;
  /**
   * The purpose in the words the candidate is shown. Held here rather than in
   * the frontend so that the text the consent hash covers and the text the
   * candidate reads cannot drift apart.
   */
  readonly description: string;
}

/**
 * How long each purpose may hold a record after its last activity.
 *
 * Measured from last activity rather than from consent, because a candidate
 * still moving through a pipeline has not gone stale — a clock from the consent
 * date would erase somebody mid-process.
 *
 * The numbers are decisions, not facts, so they are named and stated here
 * rather than appearing as literals at a call site.
 */
export const RETENTION_POLICY: Readonly<Record<CandidateConsentPurpose, RetentionRule>> = {
  /*
    Six months covers the opening itself plus the period in which a rejected
    candidate might question the decision. Beyond that the role is filled and
    the résumé is being kept for a purpose nobody consented to.
  */
  THIS_ROLE_ONLY: {
    months: 6,
    lawfulBasis: "CONSENT",
    description: "Considering you for the role you applied to.",
  },
  /*
    Two years, and only on a separate affirmative choice. This is the purpose
    that silently becomes "forever" in most ATSs, because a talent pool has no
    natural end — so the end is set here.
  */
  FUTURE_ROLES: {
    months: 24,
    lawfulBasis: "CONSENT",
    description: "Keeping you on file so we can contact you about future openings.",
  },
  /*
    Twelve months. A verification report is the most sensitive thing in the
    vault and the least useful once stale; it outlives the role only far enough
    to answer a dispute about the check itself.
  */
  BACKGROUND_VERIFICATION: {
    months: 12,
    lawfulBasis: "CONSENT",
    description: "Running the background and reference checks for this role.",
  },
  /*
    Eight years, for somebody who was actually hired, against statutory
    employment record-keeping. Long, and deliberately not a consent purpose:
    see LawfulBasis.
  */
  STATUTORY_RECORD: {
    months: 96,
    lawfulBasis: "LEGAL_OBLIGATION",
    description: "Employment records we are required by law to keep after a hire.",
  },
};

/**
 * Narrows a stored string to a known purpose.
 *
 * A type guard rather than a cast, because the value arrives from a database
 * column that a migration, an import or an older release may have written. A
 * cast would assert that every historical row already complies, which is
 * exactly the assumption this task exists to disprove.
 */
export function isCandidateConsentPurpose(
  value: string | null | undefined,
): value is CandidateConsentPurpose {
  return (
    typeof value === "string" &&
    (CANDIDATE_CONSENT_PURPOSES as readonly string[]).includes(value)
  );
}

export interface ConsentFacts {
  /** `candidate_applications.consent_purpose`, exactly as stored. */
  purpose: string | null;
  /** `candidate_applications.consent_at`. */
  consentAt: Date | null;
  /** The most recent activity on the record — application, interview, message. */
  lastActivityAt: Date | null;
  /**
   * `candidate_applications.retain_until` when the row already carries one.
   * Null on every row written before that column existed.
   */
  retainUntil: Date | null;
}

/**
 * Why a record may or may not be erased. Never a boolean: a sweep that erases
 * without being able to say which purpose expired, and on what date, cannot be
 * audited afterwards, and "should we have deleted this?" is the one question a
 * DPDP complaint actually asks.
 */
export type ErasureDecision =
  | { decision: "ERASE_DUE"; reason: string; retainUntil: Date }
  | { decision: "WITHIN_RETENTION"; reason: string; retainUntil: Date }
  | { decision: "RETAINED_BY_LAW"; reason: string }
  | { decision: "PURPOSE_NOT_RECOGNISED"; reason: string }
  | { decision: "CONSENT_NOT_RECORDED"; reason: string };

/**
 * Whether this record is due for erasure.
 *
 * Every path that cannot compute an answer refuses rather than erasing.
 * Erasure is irreversible, so "I do not know" must never resolve to "delete" —
 * but it equally must not resolve to a silent "keep", which is why the refusals
 * are distinct decision values a sweep can count and report rather than one
 * catch-all `false`.
 */
export function decideErasure(facts: ConsentFacts, now: Date): ErasureDecision {
  if (facts.purpose === null) {
    /*
      The pre-migration state: a consent timestamp with no purpose beside it.
      These rows are surfaced rather than swept, because guessing a purpose
      would pick the retention window on the candidate's behalf.
    */
    return {
      decision: "CONSENT_NOT_RECORDED",
      reason:
        "No processing purpose is recorded against this application, so its retention period cannot be determined. It needs review rather than automatic erasure.",
    };
  }

  if (!isCandidateConsentPurpose(facts.purpose)) {
    return {
      decision: "PURPOSE_NOT_RECOGNISED",
      reason: `"${facts.purpose}" is not one of the recorded processing purposes (${CANDIDATE_CONSENT_PURPOSES.join(", ")}), so no retention period applies to it. It needs review rather than automatic erasure.`,
    };
  }

  const rule = RETENTION_POLICY[facts.purpose];

  if (rule.lawfulBasis === "LEGAL_OBLIGATION") {
    return {
      decision: "RETAINED_BY_LAW",
      reason: `This record is kept under a statutory obligation (${rule.description}) rather than consent, so it is not erased on request.`,
    };
  }

  if (facts.consentAt === null) {
    return {
      decision: "CONSENT_NOT_RECORDED",
      reason:
        "A purpose is recorded but no consent date is, so there is nothing to measure a retention period from. It needs review rather than automatic erasure.",
    };
  }

  /*
    Falling back to the consent date when no activity is recorded, rather than
    treating the record as having no clock at all. An application nobody ever
    touched is the most likely thing to sit forever, so it is the case that most
    needs an expiry.
  */
  const measuredFrom = facts.lastActivityAt ?? facts.consentAt;
  const derived = addMonthsUtc(measuredFrom, rule.months);

  /*
    The later of the stored and derived dates wins.

    The asymmetry is deliberate. Erasing early is irreversible and destroys the
    evidence that the hiring decision was lawful; keeping a record a little
    longer than strictly necessary is a fault that can still be corrected. So a
    stored `retain_until` that somebody extended deliberately is honoured, and a
    stored value that is somehow earlier than the policy allows does not get to
    pull the deletion forward.
  */
  const retainUntil =
    facts.retainUntil !== null && facts.retainUntil.getTime() > derived.getTime()
      ? facts.retainUntil
      : derived;

  if (now.getTime() < retainUntil.getTime()) {
    return {
      decision: "WITHIN_RETENTION",
      reason: `Kept until ${formatUtcDate(retainUntil)} for: ${rule.description}`,
      retainUntil,
    };
  }

  return {
    decision: "ERASE_DUE",
    reason: `The ${rule.months}-month retention period for "${rule.description}" ended on ${formatUtcDate(retainUntil)}.`,
    retainUntil,
  };
}

/**
 * The retention date to store on a record when consent is captured.
 *
 * Materialised onto the row rather than computed on read, so that the date the
 * candidate was told is the date the sweep uses. A policy edit years later must
 * not silently shorten the window somebody was promised.
 */
export function computeRetainUntil(
  purpose: CandidateConsentPurpose,
  measuredFrom: Date,
): Date {
  return addMonthsUtc(measuredFrom, RETENTION_POLICY[purpose].months);
}

/**
 * Adds whole months in UTC, clamping to the end of the target month.
 *
 * Without the clamp, 31 January plus one month is 31 February, which JavaScript
 * rolls forward into March — so a retention date would land in a different
 * month than the one the policy names, and the length of February would decide
 * when somebody's résumé is deleted.
 */
export function addMonthsUtc(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(from.getUTCDate(), lastDayOfTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
