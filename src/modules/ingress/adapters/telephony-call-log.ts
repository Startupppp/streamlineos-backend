import { z } from "zod";
import type { TelephonyCallForIngress, TelephonyDirection } from "./telephony-to-inbound-event";

/**
 * Reading a carrier's call log, as far as that can be done without a carrier.
 *
 * Pure, and separated from the service for the same reason `mailbox-sync` is
 * separated from `crm-mailbox.service`: everything decidable from a payload is
 * decidable from a fixture, and a fixture is the only contract available here.
 *
 * The honest position on verification, stated once so nobody has to guess later.
 * Nothing in this repo has ever called a telephony provider through Composio, so
 * there is no call site to copy an argument name from. Two consequences shaped
 * every choice below.
 *
 * First, the response shape is **refused rather than defaulted**. `parseCallPage`
 * throws when the payload is not what it expects, and says what it got instead.
 * The alternative — a permissive schema that yields an empty array — is the
 * exact failure this module has already lived through once on the mail side: a
 * sweep that reports itself healthy, delivers nothing, and leaves somebody
 * believing their calls are in the CRM.
 *
 * Second, the request is kept to the smallest thing that can be wrong. There is
 * no date filter and no page-size parameter, because both would mean inventing a
 * query-parameter name that a provider silently ignores when it is wrong —
 * ignored, not rejected, which is how a channel ingests the wrong window for
 * weeks. The floor is applied here instead, exactly as the Outlook sweep applies
 * its own, and pagination follows the URI the *provider* hands back rather than
 * one assembled from guesses.
 *
 * What remains unverified is one path: `CALL_LOG_PATH` below. The
 * `2010-04-01/Accounts/{sid}` prefix is taken from `email/dispatch/twilio.gateway.ts`,
 * which is a live call site in this repo. The `Calls.json` leaf is not, and if it
 * is wrong the provider answers 404 — which `ComposioGateway.executeProxy` turns
 * into a thrown `ComposioToolError`, because it throws on any status at or above
 * 400. A wrong path here is loud. That is the whole reason this adapter reaches
 * the provider through the HTTP proxy rather than through a named Composio tool:
 * a mistyped tool argument is dropped in silence, a mistyped URL is a 404.
 */

/** The adapter label on every event this channel produces. Opaque below the seam. */
export const TELEPHONY_PROVIDER = "twilio";

/**
 * The `user_integration_connections.toolkit` value a telephony connection would
 * carry.
 *
 * Not a member of `IntegrationToolkit` yet — widening that union is a change to
 * a shared schema file and is reported rather than made. The column is plain
 * `text`, so the value is representable today; nothing can create it.
 */
export const TELEPHONY_TOOLKIT = "twilio";

/** One page, as the provider's own pagination defines it. */
export const MAX_PAGES_PER_SWEEP = 20;

const subresourceSchema = z.object({ recordings: z.string().nullish() });

/**
 * One call, with everything optional except the identifier.
 *
 * Nullable rather than absent on purpose: a field the provider omits and a field
 * the provider sends empty mean the same thing to this adapter — we do not know
 * — and the normaliser refuses on that rather than filling it in.
 */
const callResourceSchema = z.object({
  sid: z.string().min(1),
  direction: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  start_time: z.string().nullish(),
  duration: z.union([z.string(), z.number()]).nullish(),
  caller_name: z.string().nullish(),
  recording_url: z.string().nullish(),
  subresource_uris: subresourceSchema.nullish(),
  /**
   * Present on the resource, deliberately unused.
   *
   * A transcript is a separate resource on every carrier this could run against,
   * and inventing a second request to fetch one is precisely the unverifiable
   * argument-naming this file refuses to do. A call arrives here with no
   * transcript, which the seam adapter turns into an event with no body — the
   * required behaviour, not a degraded one.
   */
  status: z.string().nullish(),
});

const callPageSchema = z.object({
  calls: z.array(callResourceSchema),
  /** The provider's own next-page URI. Followed verbatim; never assembled here. */
  next_page_uri: z.string().nullish(),
});

export interface TelephonyCallPage {
  readonly calls: readonly TelephonyCallForIngress[];
  readonly nextPath: string | null;
}

/**
 * The first page's path, relative to the provider's API base.
 *
 * Composio's proxy resolves the base from the connected account — the Outlook
 * provider passes `/me/messages` the same way — so this is a path, not a URL.
 */
export function callLogPath(accountReference: string): string {
  return `/2010-04-01/Accounts/${encodeURIComponent(accountReference.trim())}/Calls.json`;
}

export class TelephonyCallLogShapeError extends Error {
  constructor(received: string) {
    super(
      `The call log response was not a page of calls. Nothing was read, and nothing has been marked as read. Received: ${received}`,
    );
  }
}

/**
 * A provider payload as calls, or an error.
 *
 * Never an empty page as a way of coping. An unrecognised payload means the
 * request was wrong, the account was wrong, or the provider changed — and all
 * three have to stop the sweep rather than let it advance over a window it never
 * actually read.
 */
export function parseCallPage(raw: unknown): TelephonyCallPage {
  const parsed = callPageSchema.safeParse(raw);
  if (!parsed.success) throw new TelephonyCallLogShapeError(describe(raw));

  return {
    calls: parsed.data.calls.map(toCall),
    nextPath: parsed.data.next_page_uri?.trim() || null,
  };
}

/**
 * What came back instead, in one line, without the contents.
 *
 * A call log holds customers' phone numbers, so the diagnostic names the keys
 * and stops there — enough to tell a wrong path from a wrong account, not enough
 * to put somebody's number in a log line.
 */
function describe(raw: unknown): string {
  if (raw === null || raw === undefined) return "nothing";
  if (typeof raw !== "object") return typeof raw;
  if (Array.isArray(raw)) return `an array of ${raw.length}`;
  const keys = Object.keys(raw).slice(0, 8);
  return keys.length > 0 ? `an object with keys ${keys.join(", ")}` : "an empty object";
}

function toCall(resource: z.infer<typeof callResourceSchema>): TelephonyCallForIngress {
  return {
    id: resource.sid,
    direction: toDirection(resource.direction),
    fromNumber: resource.from ?? null,
    toNumber: resource.to ?? null,
    startedAt: resource.start_time ?? null,
    durationSeconds: toSeconds(resource.duration),
    recordingReference: toRecordingReference(resource),
    /**
     * Never populated from a call-log entry, and never fabricated from one.
     *
     * See `callResourceSchema.status`: the transcript is a separate resource and
     * fetching it needs a request nothing here can verify. The seam adapter's
     * contract handles the consequence exactly — no transcript, no body, and the
     * extraction tier does nothing rather than guessing.
     */
    transcript: null,
    callerName: resource.caller_name?.trim() || null,
  };
}

/**
 * The provider's direction vocabulary, narrowed to the two that matter.
 *
 * Carriers say `outbound-api`, `outbound-dial` and `trunking-terminating` where
 * they mean "we placed it", so the prefixes are matched rather than the whole
 * strings. Anything unrecognised becomes `null`, which the seam adapter refuses
 * — a direction we cannot read is not a direction we may assume.
 */
function toDirection(value: string | null | undefined): TelephonyDirection | null {
  const direction = value?.trim().toLowerCase() ?? "";
  if (direction.startsWith("inbound")) return "inbound";
  if (direction.startsWith("outbound")) return "outbound";
  return null;
}

/** Carriers send seconds as a string. A blank or unparseable one is unknown, not zero. */
function toSeconds(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Where the audio for this call would be found.
 *
 * `recording_url` is a recording. The recordings sub-resource is a *collection*
 * that exists on every call whether or not one was made, so it locates audio
 * rather than asserting it — which is all a reference is being asked to do, and
 * is why it is the fallback rather than the first choice.
 */
function toRecordingReference(resource: z.infer<typeof callResourceSchema>): string | null {
  const direct = resource.recording_url?.trim();
  if (direct) return direct;
  return resource.subresource_uris?.recordings?.trim() || null;
}
