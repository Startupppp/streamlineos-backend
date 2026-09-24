import type { BlockedCode } from "../integrations/provider-blocked";

/**
 * What a `job_board_postings` row can say about an advertisement, and the one
 * place that vocabulary is defined.
 *
 * The column was free text defaulting to `DRAFT`, and the publish path wrote
 * `POSTED` the moment a token existed. Five states replace it, and the
 * distinction that matters is between the three the product controls and the
 * two only a vendor can grant:
 *
 * - `BLOCKED` — we did not try, and `statusDetail` says why. No request left.
 * - `QUEUED`  — we are about to try. The outbox holds the work.
 * - `FAILED`  — we tried and the vendor refused. `statusDetail` carries its words.
 * - `LIVE`    — **only** reachable from a 2xx that named a posting id.
 * - `CLOSED`  — the ad has ended, either because we closed it or the vendor did.
 *
 * `LIVE` having exactly one producer is the whole design. `markLive` is the
 * only function that returns it and it demands an `externalPostingId`, so there
 * is no expression anywhere in the codebase that produces a live advertisement
 * without a vendor's own identifier for it.
 */
export const PUBLICATION_STATES = ["BLOCKED", "QUEUED", "FAILED", "LIVE", "CLOSED"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export interface PublicationRow {
  status: PublicationState;
  statusDetail: string | null;
  externalPostingId: string | null;
  externalPostUrl: string | null;
  lastAttemptAt: Date | null;
  lastSyncedAt: Date | null;
}

export function markBlocked(code: BlockedCode, message: string): PublicationRow {
  return {
    status: "BLOCKED",
    statusDetail: `${code}: ${message}`,
    externalPostingId: null,
    externalPostUrl: null,
    lastAttemptAt: null,
    lastSyncedAt: null,
  };
}

export function markQueued(): Pick<PublicationRow, "status" | "statusDetail"> {
  return { status: "QUEUED", statusDetail: null };
}

/**
 * The only way to reach `LIVE`.
 *
 * Takes the id rather than an optional one, so a caller holding a 2xx with no
 * id in it cannot reach this function at all — it has nothing to pass.
 */
export function markLive(
  externalPostingId: string,
  externalPostUrl: string | null,
  now: Date,
): PublicationRow {
  return {
    status: "LIVE",
    statusDetail: null,
    externalPostingId,
    externalPostUrl,
    lastAttemptAt: now,
    lastSyncedAt: now,
  };
}

export function markFailed(detail: string, now: Date): Pick<
  PublicationRow,
  "status" | "statusDetail" | "lastAttemptAt"
> {
  return { status: "FAILED", statusDetail: detail.slice(0, 500), lastAttemptAt: now };
}

export function markClosed(detail: string | null, now: Date): Pick<
  PublicationRow,
  "status" | "statusDetail" | "lastSyncedAt"
> {
  return { status: "CLOSED", statusDetail: detail, lastSyncedAt: now };
}

/** True when the ad is visible to a jobseeker right now. Nothing else counts. */
export function isAdvertised(state: string): boolean {
  return state === "LIVE";
}
