import { outboundRequest } from "../../../../common/http/outbound-request";
import {
  blockedProvider,
  resolveProvider,
  type BlockedCode,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";

/**
 * The seam every job-board integration comes through, and the reason "posted to
 * LinkedIn" cannot be said until a vendor says it first.
 *
 * `POST /jobs/:id/publish` used to answer `PUBLISHED` and write a synthetic
 * external id — `{platform}-{jobId}-{timestamp}` — whenever an oauth token
 * happened to be stored, and `POST /portals/:platform/sync` answered
 * `SYNC_INITIATED` with "New applications will appear in the ATS pipeline
 * shortly". No HTTP request left the server on either path. A recruiter reading
 * those screens had every reason to stop advertising the role elsewhere.
 *
 * Three adapters now exist and each one makes a real request through
 * `outboundRequest` (SSRF-guarded, timed out, traced). The rule that replaces
 * the old lie is stated once, in `readPosting`: **a posting is only `LIVE` when
 * the vendor returned 2xx carrying an id.** Anything else — a 401 from an
 * expired key, a 422 from a rejected description, a timeout — is `FAILED` with
 * the vendor's own status on it. There is no code path that invents an id.
 *
 * None of the three has a partnership on this deployment, so in practice every
 * organisation resolves `no-integration` and nothing is sent. That is the
 * honest state, and it is reported as a blocked state with a reason rather than
 * as a success. When a partnership does arrive, connecting it is a row in
 * `candidate_sources` and nothing here changes.
 */

export const SUPPORTED_BOARDS = ["LINKEDIN", "NAUKRI", "INDEED"] as const;
export type BoardPlatform = (typeof SUPPORTED_BOARDS)[number];

export function isSupportedBoard(value: string): value is BoardPlatform {
  return (SUPPORTED_BOARDS as readonly string[]).includes(value);
}

export interface BoardPostRequest {
  readonly jobId: number;
  readonly title: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly employmentType?: string | null;
  readonly applyUrl?: string | null;
}

export interface BoardPostResult {
  readonly externalPostingId: string;
  readonly url: string | null;
}

/** What a poll can find. `CLOSED` is the vendor saying the ad has ended. */
export type BoardPostingState = "LIVE" | "CLOSED" | "REJECTED";

export interface BoardStatusResult {
  readonly state: BoardPostingState;
  readonly applicantCount: number | null;
  readonly detail: string | null;
}

export interface BoardSyncResult {
  readonly fetched: number;
}

export interface JobBoardAdapter {
  readonly platform: BoardPlatform;
  post(credentials: ProviderCredentials, request: BoardPostRequest): Promise<BoardPostResult>;
  pollStatus(credentials: ProviderCredentials, externalPostingId: string): Promise<BoardStatusResult>;
  unpublish(credentials: ProviderCredentials, externalPostingId: string): Promise<void>;
  sync(credentials: ProviderCredentials): Promise<BoardSyncResult>;
}

/**
 * A vendor answered, and what it said was not success.
 *
 * Carrying the status and a short body excerpt is the whole point: "Naukri
 * refused this job (422): description exceeds 25000 characters" is actionable,
 * and "publish failed" is not. The excerpt is capped because a vendor error
 * page can be a megabyte of HTML.
 */
export class BoardVendorError extends Error {
  constructor(
    readonly platform: BoardPlatform,
    readonly httpStatus: number | null,
    readonly detail: string,
  ) {
    super(`${platform} refused the request${httpStatus ? ` (${httpStatus})` : ""}: ${detail}`);
    this.name = "BoardVendorError";
  }
}

const TIMEOUT_MS = 12_000;
const DETAIL_LIMIT = 300;

/** Where each vendor's API lives, unless the org's `meta.baseUrl` overrides it. */
const DEFAULT_BASE_URL: Record<BoardPlatform, string> = {
  NAUKRI: "https://api.naukri.com/v1",
  LINKEDIN: "https://api.linkedin.com/v2",
  INDEED: "https://apis.indeed.com/v1",
};

function baseUrlFor(platform: BoardPlatform, credentials: ProviderCredentials): string {
  const override = credentials.meta.baseUrl;
  return typeof override === "string" && override.length > 0
    ? override.replace(/\/$/, "")
    : DEFAULT_BASE_URL[platform];
}

async function excerpt(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, DETAIL_LIMIT) || response.statusText || "no response body";
  } catch {
    return response.statusText || "unreadable response body";
  }
}

async function callVendor(
  platform: BoardPlatform,
  url: string,
  credentials: ProviderCredentials,
  init: { method: string; body?: unknown },
): Promise<Response> {
  let response: Response;
  try {
    response = await outboundRequest(url, {
      provider: `job-board:${platform.toLowerCase()}`,
      timeoutMs: TIMEOUT_MS,
      method: init.method,
      headers: {
        authorization: `Bearer ${credentials.token ?? ""}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    // A transport failure is not a posting. Name it and stop.
    throw new BoardVendorError(
      platform,
      null,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) throw new BoardVendorError(platform, response.status, await excerpt(response));
  return response;
}

/**
 * The rule that replaces the synthetic id: a 2xx is not enough on its own —
 * the vendor has to have named the posting it created. A body without an id is
 * a vendor that accepted the call and did nothing we can later poll, close, or
 * link a recruiter to, so it is a failure rather than a silent success.
 */
async function readPosting(platform: BoardPlatform, response: Response): Promise<BoardPostResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BoardVendorError(platform, response.status, "response was not JSON");
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const id = record.id ?? record.postingId ?? record.jobId ?? record.externalId;
  if (typeof id !== "string" && typeof id !== "number")
    throw new BoardVendorError(platform, response.status, "response carried no posting id");
  const url = record.url ?? record.publicUrl ?? record.jobUrl;
  return { externalPostingId: String(id), url: typeof url === "string" ? url : null };
}

function readState(raw: unknown): BoardPostingState {
  const value = typeof raw === "string" ? raw.toUpperCase() : "";
  if (value === "CLOSED" || value === "EXPIRED" || value === "ENDED") return "CLOSED";
  if (value === "REJECTED" || value === "DENIED") return "REJECTED";
  return "LIVE";
}

/**
 * The three adapters differ only in where they post and what they call the
 * fields, so the shape is declared once. Writing three near-identical classes
 * would have made the differences that DO matter — the path, the payload key
 * names — harder to see, not easier.
 */
interface VendorShape {
  readonly platform: BoardPlatform;
  readonly postPath: string;
  readonly statusPath: (id: string) => string;
  readonly closePath: (id: string) => string;
  readonly syncPath: string;
  readonly body: (request: BoardPostRequest) => Record<string, unknown>;
}

const VENDORS: readonly VendorShape[] = [
  {
    platform: "NAUKRI",
    postPath: "/jobposting",
    statusPath: (id) => `/jobposting/${encodeURIComponent(id)}`,
    closePath: (id) => `/jobposting/${encodeURIComponent(id)}/close`,
    syncPath: "/applies",
    body: (request) => ({
      jobTitle: request.title,
      jobDescription: request.description ?? "",
      location: request.location ?? "",
      employmentType: request.employmentType ?? "FULL_TIME",
      applyUrl: request.applyUrl ?? null,
      referenceId: String(request.jobId),
    }),
  },
  {
    platform: "LINKEDIN",
    postPath: "/simpleJobPostings",
    statusPath: (id) => `/simpleJobPostings/${encodeURIComponent(id)}`,
    closePath: (id) => `/simpleJobPostings/${encodeURIComponent(id)}/close`,
    syncPath: "/jobApplications",
    body: (request) => ({
      title: request.title,
      description: request.description ?? "",
      location: request.location ?? "",
      employmentStatus: request.employmentType ?? "FULL_TIME",
      applyMethod: request.applyUrl ? { companyApplyUrl: request.applyUrl } : undefined,
      externalJobPostingId: String(request.jobId),
    }),
  },
  {
    platform: "INDEED",
    postPath: "/jobs",
    statusPath: (id) => `/jobs/${encodeURIComponent(id)}`,
    closePath: (id) => `/jobs/${encodeURIComponent(id)}`,
    syncPath: "/applications",
    body: (request) => ({
      title: request.title,
      description: request.description ?? "",
      location: request.location ?? "",
      jobType: request.employmentType ?? "fulltime",
      applyUrl: request.applyUrl ?? null,
      sourceId: String(request.jobId),
    }),
  },
];

function adapterFor(shape: VendorShape): JobBoardAdapter {
  return {
    platform: shape.platform,
    async post(credentials, request) {
      const response = await callVendor(
        shape.platform,
        `${baseUrlFor(shape.platform, credentials)}${shape.postPath}`,
        credentials,
        { method: "POST", body: shape.body(request) },
      );
      return readPosting(shape.platform, response);
    },
    async pollStatus(credentials, externalPostingId) {
      const response = await callVendor(
        shape.platform,
        `${baseUrlFor(shape.platform, credentials)}${shape.statusPath(externalPostingId)}`,
        credentials,
        { method: "GET" },
      );
      let body: Record<string, unknown> = {};
      try {
        body = ((await response.json()) ?? {}) as Record<string, unknown>;
      } catch {
        throw new BoardVendorError(shape.platform, response.status, "status response was not JSON");
      }
      const applicants = body.applicantCount ?? body.applies ?? body.applications;
      return {
        state: readState(body.status ?? body.state),
        applicantCount: typeof applicants === "number" ? applicants : null,
        detail: typeof body.statusDetail === "string" ? body.statusDetail : null,
      };
    },
    async unpublish(credentials, externalPostingId) {
      await callVendor(
        shape.platform,
        `${baseUrlFor(shape.platform, credentials)}${shape.closePath(externalPostingId)}`,
        credentials,
        { method: shape.platform === "INDEED" ? "DELETE" : "POST" },
      );
    },
    async sync(credentials) {
      const response = await callVendor(
        shape.platform,
        `${baseUrlFor(shape.platform, credentials)}${shape.syncPath}`,
        credentials,
        { method: "GET" },
      );
      let body: Record<string, unknown> = {};
      try {
        body = ((await response.json()) ?? {}) as Record<string, unknown>;
      } catch {
        throw new BoardVendorError(shape.platform, response.status, "sync response was not JSON");
      }
      const items = body.items ?? body.applications ?? body.applies;
      return { fetched: Array.isArray(items) ? items.length : 0 };
    },
  };
}

export const ADAPTERS: ReadonlyMap<BoardPlatform, JobBoardAdapter> = new Map(
  VENDORS.map((shape) => [shape.platform, adapterFor(shape)] as const),
);

export type BoardBlockedCode = BlockedCode;
export type BoardOutcomeBlocked = ProviderBlocked & { platform: string };

export interface BoardOutcomePosted {
  readonly platform: string;
  readonly status: "POSTED";
  readonly externalPostingId: string;
  readonly url: string | null;
}

export interface BoardOutcomeQueued {
  readonly platform: string;
  readonly status: "QUEUED";
  readonly postingId: number;
}

export interface BoardOutcomeFailed {
  readonly platform: string;
  readonly status: "FAILED";
  readonly message: string;
  readonly httpStatus: number | null;
}

export type BoardOutcome =
  | BoardOutcomeBlocked
  | BoardOutcomePosted
  | BoardOutcomeQueued
  | BoardOutcomeFailed;

const MANUAL_FALLBACK =
  "Post the job on the board yourself and record the link under External boards.";

export const BLOCKED_MESSAGE: Record<BoardBlockedCode, string> = {
  "no-integration": "This board is not connected. Add it under Integrations first.",
  inactive: "This board's integration is switched off. Enable it under Integrations.",
  "needs-keys": "This board is not connected — no credentials are saved for it.",
  "not-implemented": `Posting to this board is not available yet. ${MANUAL_FALLBACK}`,
};

export function blocked(platform: string, code: BoardBlockedCode): BoardOutcomeBlocked {
  return { ...blockedProvider(platform, code, "This board", MANUAL_FALLBACK), platform };
}

/**
 * The single decision "can this org post this job to this board right now",
 * before any of it is attempted. Returns the adapter when there is one, and the
 * reason when there is not.
 */
export function resolveBoard(
  platform: string,
  credentials: ProviderCredentials | null,
): { adapter: JobBoardAdapter; credentials: ProviderCredentials } | BoardOutcomeBlocked {
  if (!isSupportedBoard(platform) && credentials?.isActive && credentials.token)
    return blocked(platform, "not-implemented");
  const resolved = resolveProvider<JobBoardAdapter>(
    platform,
    credentials,
    ADAPTERS as ReadonlyMap<string, JobBoardAdapter>,
    "This board",
    MANUAL_FALLBACK,
  );
  if (!("adapter" in resolved)) return { ...resolved, platform };
  return resolved;
}
