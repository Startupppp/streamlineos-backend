import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { checkWebhookUrl } from "../../../common/security/ssrf-guard";

/**
 * E6 — the contract a sales-channel integration has to satisfy, and the one
 * implementation that exists.
 *
 * ## What this is, plainly
 *
 * **No Shopify, Amazon or WooCommerce store is connected.** There is no OAuth
 * flow, no token, no connected account, and nothing in this repository has ever
 * fetched a real marketplace's inventory levels. So this is a *boundary*,
 * exercised against fakes (`__tests__/channel-adapter.spec.ts`,
 * `__tests__/channel-snapshot.service.spec.ts`), not an integration exercised
 * against a channel.
 *
 * With no configuration at all, **nothing outbound happens**: no adapter is
 * registered, every channel resolves to `MANUAL_CHANNEL_ADAPTER`, and a refetch
 * reports `NO_ADAPTER` without a socket being opened. `INV_CHANNEL_ADAPTER=fake`
 * registers `fake-channel-adapter.ts` so the whole path can be walked in
 * development.
 *
 * The half that is **not** a fake is the receiving half. `verifyChannelDelivery`
 * implements the schemes Shopify and WooCommerce actually use — base64
 * HMAC-SHA256 over the raw request body, compared in constant time — because
 * those are published, they are the part that is easy to get subtly wrong, and
 * they can be checked against a signature we mint ourselves without any store
 * existing.
 *
 * ## Where a real adapter's traffic must go
 *
 * Through Composio, in the backend `integrations` module, server-side only
 * (root CLAUDE.md §5). A channel adapter must never run its own provider OAuth
 * and must never put a provider token in our database. `ComposioGateway` today
 * knows three toolkits (`googlecalendar`, `gmail`, `outlook`) and its
 * `authConfigIdFor` is a total record on purpose, so adding a marketplace
 * toolkit is a compile error until somebody gives it an auth config — which is
 * the right shape for that work and is not this unit's.
 *
 * That is also why the webhook signing secret is a **deployment** secret read
 * from config per channel type, not a per-tenant column. A store's shared secret
 * is a provider credential; §5 says it does not live in our DB.
 *
 * ## What an adapter may not do
 *
 * An adapter never writes stock and never writes a channel row. It returns a
 * *snapshot*, and `ChannelSnapshotService` decides what that means under the
 * organisation's policy. That is what keeps E6's hard requirement true by
 * construction rather than by care — a snapshot cannot drive a
 * `quantity_change`, because this file cannot reach the stock engine: it does
 * not import it.
 */

/** The channel types that can have an adapter. `INTERNAL` is us, and has none. */
export const EXTERNAL_CHANNEL_TYPES = ["SHOPIFY", "WOOCOMMERCE", "MARKETPLACE", "B2B", "THREE_PL"] as const;
export type ExternalChannelType = (typeof EXTERNAL_CHANNEL_TYPES)[number];

/* ------------------------------------------------------------------ *
 * Inbound: verifying what a channel posted at us
 * ------------------------------------------------------------------ */

/**
 * Which headers a channel signs with, and where its delivery id lives.
 *
 * Shopify and WooCommerce use the identical algorithm — base64 of
 * HMAC-SHA256(secret, rawBody) — and differ only in header names, so they share
 * one scheme rather than one copy each. Amazon SP-API notifications arrive over
 * SNS and are signed differently; `MARKETPLACE` is therefore given the same
 * shape here only so the boundary compiles, and a real Amazon adapter must
 * bring its own verification rather than inherit this one.
 */
export interface ChannelWebhookScheme {
  readonly signatureHeader: string;
  readonly deliveryIdHeader: string;
  readonly topicHeader: string;
}

export const CHANNEL_WEBHOOK_SCHEMES: Readonly<Record<ExternalChannelType, ChannelWebhookScheme>> = {
  SHOPIFY: {
    signatureHeader: "x-shopify-hmac-sha256",
    deliveryIdHeader: "x-shopify-webhook-id",
    topicHeader: "x-shopify-topic",
  },
  WOOCOMMERCE: {
    signatureHeader: "x-wc-webhook-signature",
    deliveryIdHeader: "x-wc-webhook-delivery-id",
    topicHeader: "x-wc-webhook-topic",
  },
  MARKETPLACE: {
    signatureHeader: "x-marketplace-signature",
    deliveryIdHeader: "x-marketplace-delivery-id",
    topicHeader: "x-marketplace-topic",
  },
  B2B: {
    signatureHeader: "x-channel-signature",
    deliveryIdHeader: "x-channel-delivery-id",
    topicHeader: "x-channel-topic",
  },
  THREE_PL: {
    signatureHeader: "x-channel-signature",
    deliveryIdHeader: "x-channel-delivery-id",
    topicHeader: "x-channel-topic",
  },
};

export type ChannelDeliveryRejection =
  | "unknown-channel-type"
  | "no-secret-configured"
  | "missing-signature"
  | "missing-delivery-id"
  | "signature-mismatch";

export type ChannelDeliveryCheck =
  | { readonly valid: true; readonly deliveryId: string; readonly topic: string }
  | { readonly valid: false; readonly reason: ChannelDeliveryRejection };

export function signChannelPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

/**
 * Verify one inbound delivery.
 *
 * Three things about this are load-bearing:
 *
 *  1. **It signs the raw body, not the parsed one.** `JSON.parse` followed by
 *     `JSON.stringify` reorders keys and normalises whitespace, so a digest
 *     taken over a re-serialised body verifies nothing about what was sent.
 *     Nest's `rawBody: true` (set in `main.ts`) is what makes the original bytes
 *     available at all.
 *  2. **It compares with `timingSafeEqual`.** A `===` on a digest leaks the
 *     length of a candidate's shared prefix, and a signature is exactly the kind
 *     of value an attacker gets unlimited guesses at. `timingSafeEqual` throws
 *     on a length mismatch and the length of a base64 SHA-256 is public, so the
 *     length is compared first rather than letting the throw escape.
 *  3. **No secret is not "skip verification".** An unconfigured channel type
 *     rejects every delivery. A boundary that quietly accepts unsigned traffic
 *     when its secret is missing is worse than one that refuses, because it
 *     looks like it is working.
 */
export function verifyChannelDelivery(input: {
  readonly channelType: string;
  readonly secret: string | null | undefined;
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): ChannelDeliveryCheck {
  const scheme = CHANNEL_WEBHOOK_SCHEMES[input.channelType as ExternalChannelType] as
    | ChannelWebhookScheme
    | undefined;
  if (!scheme) return { valid: false, reason: "unknown-channel-type" };
  if (!input.secret) return { valid: false, reason: "no-secret-configured" };

  const provided = input.headers[scheme.signatureHeader];
  if (!provided) return { valid: false, reason: "missing-signature" };

  const deliveryId = input.headers[scheme.deliveryIdHeader];
  // Without a delivery id there is nothing to deduplicate on, so a channel that
  // omits it could replay the same event into a second refetch forever. Refused
  // rather than substituted with a body digest: two genuinely distinct events
  // can carry byte-identical bodies (the same SKU restocked to the same figure
  // twice), and collapsing those would silently drop the second.
  if (!deliveryId) return { valid: false, reason: "missing-delivery-id" };

  const expected = Buffer.from(signChannelPayload(input.secret, input.rawBody), "utf8");
  const candidate = Buffer.from(provided, "utf8");
  if (expected.length !== candidate.length) return { valid: false, reason: "signature-mismatch" };
  if (!timingSafeEqual(expected, candidate)) return { valid: false, reason: "signature-mismatch" };

  return { valid: true, deliveryId, topic: input.headers[scheme.topicHeader] ?? "unknown" };
}

/* ------------------------------------------------------------------ *
 * Outbound: refetching the channel's current position
 * ------------------------------------------------------------------ */

export interface ChannelSnapshotItem {
  /** The channel's SKU, which is the only handle it and we both hold. */
  readonly sku: string;
  /** Decimal string. A quantity that becomes a float on the way in is a defect. */
  readonly quantity: string;
}

/**
 * What a refetch came back with.
 *
 * `complete` is the field this whole unit turns on. A channel that answers 200
 * with an empty list is indistinguishable, at the HTTP layer, from a channel
 * that genuinely has nothing — and treating the first as the second would
 * manufacture a "channel says 0" difference for every SKU we publish. Under
 * `ALLOW_ADJUSTMENT` that is a one-request path to zeroing a warehouse. So an
 * adapter must say whether it listed everything, and
 * `ChannelSnapshotService` never synthesises a zero for a SKU the channel did
 * not mention.
 *
 * A failure is a **value**, not a throw, for the reason the carrier boundary
 * gives: every caller's correct response to a marketplace being unreachable is
 * the same — carry on, retry later — and an exception invites a caller to roll
 * back work that must not be rolled back.
 */
export type ChannelSnapshotResult =
  | {
      readonly ok: true;
      readonly complete: boolean;
      readonly capturedAt: Date;
      readonly items: readonly ChannelSnapshotItem[];
      /** SKUs the channel was asked about and refused to answer for. */
      readonly failures: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** A failure no number of retries will fix — a revoked grant, a dead store. */
      readonly terminal: boolean;
    };

export interface ChannelSnapshotRequest {
  readonly channelType: string;
  /** The store's own endpoint, as the tenant configured it. Untrusted. */
  readonly storeUrl: string | null;
  /** The SKUs we publish to this channel, which is what we ask it about. */
  readonly skus: readonly string[];
}

export interface ChannelAdapter {
  readonly code: string;
  /**
   * Whether there is anybody to ask. `false` is a first-class answer, not a
   * degraded one: an organisation that reconciles its marketplace by hand is a
   * real way to run.
   */
  readonly canFetch: boolean;
  fetchSnapshot(request: ChannelSnapshotRequest): Promise<ChannelSnapshotResult>;
}

/**
 * The store endpoint is tenant-supplied, so it is an SSRF surface the moment
 * anything fetches it.
 *
 * Delegates to `common/security/ssrf-guard.ts` rather than re-deriving the
 * check. A fresh guard written here would miss the packed `::ffff:7f00:1` form
 * that `new URL()` actually produces for `::ffff:127.0.0.1`, which is precisely
 * how a second copy of this check becomes a hole. Callers must also disable
 * redirect following: a permitted host can 302 to an internal one.
 */
export async function assertChannelEndpointAllowed(storeUrl: string): Promise<void> {
  const check = await checkWebhookUrl(storeUrl);
  if (!check.allowed) {
    throw new ChannelEndpointRejected(`Channel endpoint rejected: ${check.reason}`);
  }
}

export class ChannelEndpointRejected extends Error {}

/* ------------------------------------------------------------------ *
 * Attempt policy
 * ------------------------------------------------------------------ */

/**
 * Delay before each *retry*, in order. Attempt 1 is immediate, so the first
 * entry is the gap between attempt 1 and attempt 2.
 *
 * Minutes rather than milliseconds, unlike the carrier ladder: this runs in a
 * background sweep that owns a durable row, not inside a request somebody is
 * waiting on, so it can afford to come back later — and a marketplace throttling
 * us is best answered by waiting rather than by three attempts in a second.
 */
export const CHANNEL_REFETCH_SCHEDULE_MS: readonly number[] = [60_000, 300_000, 900_000];

/** Attempt 1 plus one per scheduled retry. */
export const CHANNEL_REFETCH_MAX_ATTEMPTS = CHANNEL_REFETCH_SCHEDULE_MS.length + 1;

/**
 * Per-attempt timeout. A marketplace that has not answered in fifteen seconds is
 * not about to, and unbounded is not an option: a socket a channel never closes
 * would hold a worker slot for as long as it felt like it.
 */
export const CHANNEL_CALL_TIMEOUT_MS = 15_000;

export function nextChannelAttemptDelayMs(attempts: number): number | null {
  if (attempts < 1) return 0;
  return CHANNEL_REFETCH_SCHEDULE_MS[attempts - 1] ?? null;
}

export interface ChannelAttemptPlan {
  readonly attempts: number;
  readonly retryInMs: number | null;
  readonly deadLettered: boolean;
}

/**
 * The next state of one refetch, as a value.
 *
 * Pure and separate from the executor: that a failure retries, that the schedule
 * is walked in order, and that it stops being retryable exactly when the
 * schedule runs out are the properties a reader has to be able to check, and
 * none of them is legible spread through the branches of a function that is also
 * doing I/O.
 *
 * `terminal` is the escape hatch for a failure that will never succeed later —
 * a revoked grant, a store that no longer exists. Retrying that turns one wrong
 * answer into four.
 */
export function planChannelAttempt(input: {
  readonly attempts: number;
  readonly ok: boolean;
  readonly terminal?: boolean;
}): ChannelAttemptPlan {
  const attempts = input.attempts + 1;
  if (input.ok) return { attempts, retryInMs: null, deadLettered: false };

  const delay = input.terminal ? null : nextChannelAttemptDelayMs(attempts);
  if (delay === null || attempts >= CHANNEL_REFETCH_MAX_ATTEMPTS) {
    return { attempts, retryInMs: null, deadLettered: true };
  }
  return { attempts, retryInMs: delay, deadLettered: false };
}

export class ChannelTimeoutError extends Error {}

/**
 * Runs one adapter call under a deadline.
 *
 * Raced rather than aborted: an adapter is third-party-shaped code and cannot be
 * relied on to honour an `AbortSignal`. The losing promise is left to settle on
 * its own and its rejection is swallowed here — that is what stops a late
 * failure surfacing as an unhandled rejection minutes after the sweep that
 * owned it finished.
 */
export async function withChannelTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  // `unref` so a deadline that has already been beaten does not hold the event
  // loop open for the remaining fifteen seconds. It still fires while the
  // process is alive — a server always has a listening handle — so the race is
  // unchanged; what changes is that a CLI or a test run ends when its work does
  // instead of waiting on timers whose result nobody is reading.
  timer: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
): Promise<T> {
  let timedOut = false;
  const attempt = work().catch((error: unknown) => {
    if (timedOut) return Promise.reject(new ChannelTimeoutError("discarded"));
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  });
  attempt.catch(() => undefined);

  const deadline = timer(timeoutMs).then(() => {
    timedOut = true;
    throw new ChannelTimeoutError(`channel did not answer within ${timeoutMs}ms`);
  });
  deadline.catch(() => undefined);

  return Promise.race([attempt, deadline]);
}

/* ------------------------------------------------------------------ *
 * The one adapter that exists
 * ------------------------------------------------------------------ */

/**
 * A channel that cannot be asked anything.
 *
 * `canFetch: false` and a snapshot that reports `complete: false` with no items
 * is not a stub of a channel — it is the accurate description of an
 * organisation whose "integration" is a person exporting a CSV. Making that a
 * registered adapter rather than an `if (!adapter) return` somewhere means the
 * manual case and a real channel take the same path through
 * `ChannelSnapshotService`, so the first real adapter cannot quietly acquire a
 * second set of rules.
 *
 * `complete: false` specifically: an unreachable channel has told us nothing,
 * and "nothing" must never read as "zero".
 */
export const MANUAL_CHANNEL_ADAPTER: ChannelAdapter = {
  code: "manual",
  canFetch: false,
  fetchSnapshot: () =>
    Promise.resolve({
      ok: true as const,
      complete: false,
      capturedAt: new Date(),
      items: [],
      failures: [],
    }),
};

/**
 * Which adapter speaks for a channel.
 *
 * Resolution is by the channel's *type*, which is one of our own enum values
 * rather than a tenant string — but an unregistered type still resolves to the
 * manual adapter rather than throwing, because an organisation adding a channel
 * we have no adapter for should get manual reconciliation, not a 500.
 * Registration is the deliberate act: an adapter exists because this process
 * registered it, never because a tenant typed something.
 */
@Injectable()
export class ChannelAdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  forChannelType(channelType: string | null | undefined): ChannelAdapter {
    if (!channelType) return MANUAL_CHANNEL_ADAPTER;
    return this.adapters.get(channelType.trim().toUpperCase()) ?? MANUAL_CHANNEL_ADAPTER;
  }

  /** Used by the boundary's tests, and by whichever real adapter ships first. */
  register(channelType: string, adapter: ChannelAdapter): void {
    this.adapters.set(channelType.trim().toUpperCase(), adapter);
  }
}
