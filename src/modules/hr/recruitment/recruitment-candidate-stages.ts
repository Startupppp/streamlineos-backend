export type CandidateStage =
  | "NEW"
  | "SCREENING"
  | "INTERVIEW"
  | "OFFER"
  | "HIRED"
  | "REJECTED";

/**
 * The board's stage machine, and the one definition of it.
 *
 * It used to live privately inside `RecruitmentCandidatesService`, which was
 * fine while `moveStage` was the only writer. Offer acceptance is now a second
 * one: accepting an offer has to land the candidate on `HIRED`, and doing that
 * with a raw `UPDATE … SET status = 'HIRED'` would be a path the map forbids
 * (`NEW → HIRED` is not a transition anyone may make). Sharing the map means
 * the second writer walks the same legal route rather than going around it.
 */
export const STAGE_TRANSITIONS: Record<CandidateStage, CandidateStage[]> = {
  NEW: ["SCREENING", "REJECTED"],
  SCREENING: ["INTERVIEW", "REJECTED"],
  INTERVIEW: ["OFFER", "REJECTED"],
  OFFER: ["HIRED", "REJECTED"],
  HIRED: [],
  REJECTED: ["SCREENING"],
};

/**
 * The wider map the candidate PATCH endpoint allows: a recruiter correcting a
 * mis-drag may step a candidate back one stage, which a drag on the board may
 * not do.
 */
export const UPDATE_TRANSITIONS: Record<string, CandidateStage[]> = {
  NEW: ["SCREENING", "REJECTED"],
  SCREENING: ["NEW", "INTERVIEW", "REJECTED"],
  INTERVIEW: ["SCREENING", "OFFER", "REJECTED"],
  OFFER: ["INTERVIEW", "HIRED", "REJECTED"],
  HIRED: [],
  REJECTED: ["SCREENING"],
};

/**
 * The application status each stage implies.
 *
 * `candidate_applications.status` and `candidates.status` had drifted into two
 * unrelated stories: the board moved and the application the candidate can see
 * on `/application-status/:token` never changed. This is the mapping that
 * reunites them — a stage with no entry here (`NEW`) leaves the application
 * alone, because an application is `APPLIED` the moment it exists.
 */
export const APPLICATION_STATUS_FOR_STAGE: Partial<
  Record<CandidateStage, "SHORTLISTED" | "INTERVIEWING" | "OFFERED" | "ACCEPTED" | "REJECTED">
> = {
  SCREENING: "SHORTLISTED",
  INTERVIEW: "INTERVIEWING",
  OFFER: "OFFERED",
  HIRED: "ACCEPTED",
  REJECTED: "REJECTED",
};

/**
 * The stages to walk, in order, to get from `from` to `to` without making a
 * move the map forbids. Empty when already there; `null` when no legal route
 * exists (nothing leaves `HIRED`).
 *
 * Breadth-first rather than a hardcoded ladder, so it stays correct if the map
 * gains a stage — and so `REJECTED → HIRED` resolves through the one re-open
 * edge the map actually has (`REJECTED → SCREENING`) rather than being assumed
 * impossible.
 */
export function legalPathBetween(
  from: CandidateStage,
  to: CandidateStage,
): CandidateStage[] | null {
  if (from === to) return [];
  const queue: CandidateStage[][] = [[from]];
  const seen = new Set<CandidateStage>([from]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const tail = path[path.length - 1];
    if (tail === undefined) break;
    for (const next of STAGE_TRANSITIONS[tail] ?? []) {
      if (seen.has(next)) continue;
      const extended = [...path, next];
      if (next === to) return extended.slice(1);
      seen.add(next);
      queue.push(extended);
    }
  }
  return null;
}
