/**
 * What a candidate is allowed to see about their own application.
 *
 * The coarse vocabulary is the point of this file. Internally an application
 * moves through APPLIED, SHORTLISTED, INTERVIEWING, OFFERED, ACCEPTED,
 * REJECTED and WITHDRAWN; a candidate seeing SHORTLISTED learns they beat other
 * people, and a candidate seeing the transition from SHORTLISTED back to
 * APPLIED learns something nobody meant to tell them. Six states say everything
 * a candidate needs to plan around and nothing about how the decision is being
 * made.
 *
 * Everything here is pure so the leak guard below can be tested as a claim
 * about shapes rather than by reading a controller.
 */

export const PORTAL_STATUSES = [
  "received",
  "in_review",
  "interview",
  "offer",
  "hired",
  "rejected",
] as const;

export type PortalStatus = (typeof PORTAL_STATUSES)[number];

/** The internal vocabulary, as `application_status` spells it. */
export type ApplicationStatus =
  | "APPLIED"
  | "SHORTLISTED"
  | "INTERVIEWING"
  | "OFFERED"
  | "ACCEPTED"
  | "REJECTED"
  | "WITHDRAWN";

/**
 * SHORTLISTED collapses into `in_review` rather than getting a state of its own.
 *
 * It is the single most tempting one to expose — it is good news — and the most
 * damaging, because its absence is then information too: a candidate who
 * watches a peer's status change and not their own has been told where they
 * stand by a system that never said anything.
 *
 * WITHDRAWN maps to `rejected` because from outside they are the same terminal
 * fact: this application is over. A candidate who withdrew knows they withdrew.
 */
const STATUS_MAP: Record<ApplicationStatus, PortalStatus> = {
  APPLIED: "received",
  SHORTLISTED: "in_review",
  INTERVIEWING: "interview",
  OFFERED: "offer",
  ACCEPTED: "hired",
  REJECTED: "rejected",
  WITHDRAWN: "rejected",
};

export function toPortalStatus(status: string): PortalStatus {
  /*
    An unrecognised status becomes `in_review`, not `received`.

    A value this build does not know about is most likely one added later in the
    pipeline, and the safe direction is the vaguer one — "we are looking at it"
    is true of every intermediate state, while "received" would tell a candidate
    at offer stage that nothing has happened.
  */
  return STATUS_MAP[status as ApplicationStatus] ?? "in_review";
}

/** What the candidate is told, in words, for each state. */
export const PORTAL_STATUS_COPY: Record<PortalStatus, string> = {
  received: "We have your application.",
  in_review: "Your application is being reviewed.",
  interview: "You are in the interview stage.",
  offer: "There is an offer for you.",
  hired: "You have accepted the offer. Welcome aboard.",
  rejected: "This application is closed.",
};

export interface PortalApplicationView {
  status: PortalStatus;
  statusText: string;
  appliedAt: Date;
  updatedAt: Date;
  jobTitle: string;
  jobLocation: string | null;
  jobType: string | null;
  organisationName: string;
  candidateFirstName: string;
  /** Present only while there is a live booking link for this candidate. */
  bookingUrl: string | null;
  /** Present only while there is an offer they have not answered. */
  offerUrl: string | null;
}

/**
 * The exact set of keys a portal response may carry.
 *
 * `assertNoLeak` checks a built response against this list rather than trusting
 * a projection somewhere upstream. The failure this guards is specific and has
 * happened in products like this one: a `with: { candidate: true }` added to
 * fix a missing name pulls in `notes`, `rating`, `aiScore` and `bgvNotes`, and
 * the endpoint that serves it is public and unauthenticated.
 */
const ALLOWED_KEYS: readonly string[] = [
  "status",
  "statusText",
  "appliedAt",
  "updatedAt",
  "jobTitle",
  "jobLocation",
  "jobType",
  "organisationName",
  "candidateFirstName",
  "bookingUrl",
  "offerUrl",
];

/** Fields whose presence means something internal has escaped. */
const FORBIDDEN_SUBSTRINGS = [
  "note",
  "score",
  "rating",
  "feedback",
  "rubric",
  "bgv",
  "salary",
  "transcript",
  "internal",
  "email",
  "phone",
  "token",
  "secret",
];

export class PortalLeakError extends Error {
  constructor(key: string) {
    super(`Portal response carried a field it must not: ${key}`);
    this.name = "PortalLeakError";
  }
}

/**
 * Throws if a response object carries anything outside the allowed set.
 *
 * Deliberately a throw rather than a strip. Silently removing a field would let
 * the mistake live in the code and only stop it reaching this one endpoint; a
 * 500 on the first request in development is how the mistake gets fixed.
 */
export function assertNoLeak(response: Record<string, unknown>): void {
  for (const key of Object.keys(response)) {
    if (!ALLOWED_KEYS.includes(key)) throw new PortalLeakError(key);
    const lower = key.toLowerCase();
    if (FORBIDDEN_SUBSTRINGS.some((bad) => lower.includes(bad))) {
      throw new PortalLeakError(key);
    }
  }
}
