/**
 * The seam every job-board integration has to come through, and the reason
 * "posted to LinkedIn" cannot be said until one exists.
 *
 * `POST /jobs/:id/publish` used to answer `PUBLISHED` and write a synthetic
 * external id — `{platform}-{jobId}-{timestamp}` — whenever an oauth token
 * happened to be stored, and `POST /portals/:platform/sync` answered
 * `SYNC_INITIATED` with "New applications will appear in the ATS pipeline
 * shortly". No HTTP request left the server on either path. A recruiter reading
 * those screens had every reason to stop advertising the role elsewhere.
 *
 * `ADAPTERS` is empty, and that is the honest state of this product: no board
 * partnership is live. It is a registry rather than a boolean so that adding
 * one is a matter of implementing `JobBoardAdapter` and registering it here —
 * and so `blockedReason` keeps distinguishing "you have not connected this
 * board" from "we cannot post to this board at all", which are different
 * problems with different answers for the recruiter.
 */

export const SUPPORTED_BOARDS = ["LINKEDIN", "NAUKRI", "INDEED"] as const;
export type BoardPlatform = (typeof SUPPORTED_BOARDS)[number];

export function isSupportedBoard(value: string): value is BoardPlatform {
  return (SUPPORTED_BOARDS as readonly string[]).includes(value);
}

export interface BoardCredentials {
  readonly isActive: boolean;
  readonly oauthToken: string | null;
}

export interface BoardPostRequest {
  readonly jobId: number;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
}

export interface BoardPostResult {
  readonly externalPostingId: string;
  readonly url: string | null;
}

export interface BoardSyncResult {
  readonly fetched: number;
}

export interface JobBoardAdapter {
  readonly platform: BoardPlatform;
  post(credentials: BoardCredentials, request: BoardPostRequest): Promise<BoardPostResult>;
  sync(credentials: BoardCredentials): Promise<BoardSyncResult>;
}

/** Empty on purpose. See the file comment. */
export const ADAPTERS: ReadonlyMap<BoardPlatform, JobBoardAdapter> = new Map();

export type BoardBlockedCode =
  /** The org has no `candidate_sources` row for this board. */
  | "no-integration"
  /** There is a row, switched off. */
  | "inactive"
  /** There is an active row with no credentials on it. */
  | "needs-keys"
  /** There are credentials, and no adapter that can use them. */
  | "not-implemented";

export interface BoardOutcomeBlocked {
  readonly platform: string;
  readonly status: "BLOCKED";
  readonly code: BoardBlockedCode;
  readonly message: string;
}

export interface BoardOutcomePosted {
  readonly platform: string;
  readonly status: "POSTED";
  readonly externalPostingId: string;
  readonly url: string | null;
}

export type BoardOutcome = BoardOutcomeBlocked | BoardOutcomePosted;

export const BLOCKED_MESSAGE: Record<BoardBlockedCode, string> = {
  "no-integration": "This board is not connected. Add it under Integrations first.",
  inactive: "This board's integration is switched off. Enable it under Integrations.",
  "needs-keys": "This board is not connected — no credentials are saved for it.",
  "not-implemented":
    "Posting to this board is not available yet. Post the job on the board yourself and record the link under External boards.",
};

export function blocked(platform: string, code: BoardBlockedCode): BoardOutcomeBlocked {
  return { platform, status: "BLOCKED", code, message: BLOCKED_MESSAGE[code] };
}

/**
 * The single decision "can this org post this job to this board right now",
 * before any of it is attempted. Returns the adapter when there is one, and the
 * reason when there is not.
 */
export function resolveBoard(
  platform: string,
  credentials: BoardCredentials | null,
): { adapter: JobBoardAdapter } | BoardOutcomeBlocked {
  if (!credentials) return blocked(platform, "no-integration");
  if (!credentials.isActive) return blocked(platform, "inactive");
  if (!credentials.oauthToken) return blocked(platform, "needs-keys");
  if (!isSupportedBoard(platform)) return blocked(platform, "not-implemented");
  const adapter = ADAPTERS.get(platform);
  if (!adapter) return blocked(platform, "not-implemented");
  return { adapter };
}
