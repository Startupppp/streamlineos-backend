import {
  CHANNEL_CALL_TIMEOUT_MS,
  ChannelEndpointRejected,
  ChannelTimeoutError,
  planChannelAttempt,
  withChannelTimeout,
} from "../channel-adapter";
import type {
  ChannelCallFailure,
  ChannelCommerceAdapter,
  ChannelTarget,
} from "./channel-commerce.port";
import {
  channelOrderPayloadSchema,
  channelPullPayloadSchema,
  channelShipPayloadSchema,
  type ChannelCommerceLookup,
  type ChannelJob,
  type ChannelJobStore,
  type ChannelSyncContext,
} from "./channel-job.store";

/**
 * INV-27 — running one channel job, and deciding what happens when it fails.
 *
 * ## The acceptance, restated as code
 *
 * "DLQ/retry visible" is three properties, and each has a line here:
 *
 *  1. **Every failure lands somewhere durable.** There is exactly one exit from
 *     a failed job — `fail`, below — and it writes the reason, the code and the
 *     attempt count onto the row. Nothing in this file throws a failure at a
 *     caller, so no failure can escape by being unhandled.
 *  2. **Retrying is bounded and it stops.** `planChannelAttempt` is E6's ladder,
 *     shared rather than copied, so a channel job and a channel delivery walk
 *     the same schedule and dead-letter at the same point. A `terminal` failure
 *     skips the ladder entirely: retrying a revoked token turns one wrong answer
 *     into four requests to a marketplace already refusing us.
 *  3. **The row is retryable by hand.** `ChannelSyncService.retry` sets a DEAD or
 *     FAILED row back to PENDING with `next_attempt_at = now`. It deliberately
 *     does **not** reset `attempt_count`: an operator who has fixed the cause
 *     gets one attempt and an immediate answer, and the count keeps telling the
 *     true story — "this has failed six times" — rather than resetting to zero
 *     every time somebody looks at it.
 *
 * ## Why a failure is never a throw
 *
 * Every adapter call returns a value. The three places a throw could still come
 * from — a rejected endpoint, the deadline, an adapter that ignores its own
 * contract — are caught in `callAdapter` and converted, because a sweep that
 * dies on one tenant's bad channel URL stops draining every other tenant's work.
 *
 * ## What this file cannot do
 *
 * It cannot reach the stock engine, the sales-order tables or Drizzle: it
 * imports none of them. Everything it writes goes through `ChannelJobStore`,
 * which is what keeps "a marketplace cannot move our ledger by itself" a
 * property of the module's shape rather than of anybody's care.
 */

export interface ChannelSyncDeps {
  readonly store: ChannelJobStore;
  readonly commerce: ChannelCommerceLookup;
  /**
   * The shared SSRF guard. Injected rather than imported so a spec can run the
   * worker against a loopback stub without disabling the guard in production
   * code — and so the guard being *called at all* is an assertable fact.
   */
  readonly assertEndpointAllowed: (url: string) => Promise<void>;
}

export interface ChannelSyncOutcome {
  /** PROCESSED. */
  succeeded: number;
  /** FAILED, with a next attempt scheduled. */
  retried: number;
  /** DEAD. Visible on the dead-letter screen, retryable by hand. */
  dead: number;
  /** ORDER_IMPORT rows an ORDER_PULL created. */
  enqueued: number;
  /** Channel orders an ORDER_PULL saw that were already imported. */
  duplicates: number;
}

export function emptyOutcome(): ChannelSyncOutcome {
  return { succeeded: 0, retried: 0, dead: 0, enqueued: 0, duplicates: 0 };
}

/**
 * Run one job to completion, whatever that turns out to mean.
 *
 * Never throws. A job that cannot even be understood dead-letters with a reason,
 * which is the whole point of the row existing.
 */
export async function runChannelJob(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
): Promise<void> {
  // The second fence on order-import idempotency. The first is the unique
  // natural key, which stops a second job existing; this stops a job that
  // already produced an order from producing another, which is what would
  // happen after a crash between the sales-order write and the status update.
  if (job.kind === "ORDER_IMPORT" && job.salesOrderId !== null) {
    await succeed(deps, job, outcome, { alreadyImported: true, salesOrderId: job.salesOrderId });
    return;
  }

  const context = await deps.store.loadContext(job.orgId, job.channelId);
  if (!context) {
    await fail(deps, job, outcome, {
      ok: false,
      code: "CHANNEL_GONE",
      message: "The channel this job names no longer exists.",
      terminal: true,
    });
    return;
  }

  const adapter = deps.commerce.resolve(context.channelType);
  if (!adapter) {
    await fail(deps, job, outcome, {
      ok: false,
      code: "NO_ADAPTER",
      message: `No channel integration is registered for ${context.channelType}. This work has to be done by hand.`,
      terminal: true,
    });
    return;
  }
  if (!adapter.isConfigured()) {
    await fail(deps, job, outcome, {
      ok: false,
      code: "NO_CREDENTIAL",
      // The adapter names variables, never values — this string reaches a row an
      // operator reads and a log line that outlives the deployment.
      message: `${adapter.name} is not connected: ${adapter.configurationProblem() ?? "no credentials"}.`,
      terminal: true,
    });
    return;
  }

  // The store URL is tenant-supplied, so it is an SSRF surface the moment
  // anything fetches it. Guarded here, before any adapter sees it, and the
  // rejection is a terminal failure rather than a throw: a misconfigured store
  // URL dead-letters like any other bad channel instead of killing the sweep for
  // every other tenant.
  if (context.storeUrl) {
    try {
      await deps.assertEndpointAllowed(context.storeUrl);
    } catch (error: unknown) {
      await fail(deps, job, outcome, {
        ok: false,
        code: "ENDPOINT_BLOCKED",
        message: error instanceof ChannelEndpointRejected ? error.message : String(error),
        terminal: true,
      });
      return;
    }
  }

  const target: ChannelTarget = {
    channelType: context.channelType,
    storeUrl: context.storeUrl,
    settings: context.settings,
  };

  switch (job.kind) {
    case "STOCK_PUSH":
      return pushStock(deps, job, outcome, adapter, target, context);
    case "STOCK_PULL":
      return pullStock(deps, job, outcome, adapter, target, context);
    case "ORDER_PULL":
      return pullOrders(deps, job, outcome, adapter, target);
    case "ORDER_IMPORT":
      return importOrder(deps, job, outcome);
    case "SHIP_CONFIRM":
      return confirmShipment(deps, job, outcome, adapter, target);
  }
}

/* ------------------------------------------------------------------ *
 * 1. Stock sync — push
 * ------------------------------------------------------------------ */

async function pushStock(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
  adapter: ChannelCommerceAdapter,
  target: ChannelTarget,
  context: ChannelSyncContext,
): Promise<void> {
  const offers = await deps.store.readOffers(context.orgId, context.channelId);
  if (offers.length === 0) {
    // Not a failure. A channel nothing has been published to has nothing to
    // push, and dead-lettering that would fill an operator's screen with rows
    // whose only fault is that the operator has not published anything yet.
    await succeed(deps, job, outcome, { pushed: 0, note: "Nothing is published to this channel." });
    return;
  }

  const result = await callAdapter(() => adapter.pushStock(target, offers));
  if (!result.ok) {
    await fail(deps, job, outcome, result);
    return;
  }

  // Only now. `syncStock` writes every non-INTERNAL publication FAILED /
  // "Provider not connected", which is accurate at the moment it runs — nothing
  // has been told anything. This is the moment the channel was actually told, so
  // this is where the row stops saying so.
  await deps.store.markPublications(context.orgId, context.channelId, {
    accepted: result.accepted,
    refused: result.refused,
  });

  await succeed(deps, job, outcome, {
    answeredAt: result.answeredAt.toISOString(),
    accepted: result.accepted.length,
    // Kept whole, not counted: "the store has never heard of SKU-7" is the most
    // useful thing a push ever says, and a count says none of it.
    refused: result.refused,
  });
}

/* ------------------------------------------------------------------ *
 * 1. Stock sync — pull
 * ------------------------------------------------------------------ */

async function pullStock(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
  adapter: ChannelCommerceAdapter,
  target: ChannelTarget,
  context: ChannelSyncContext,
): Promise<void> {
  const snapshot = await callAdapter(() =>
    adapter.fetchSnapshot({
      channelType: target.channelType,
      storeUrl: target.storeUrl,
      skus: [...context.skuToVariant.keys()],
    }),
  );
  if (!snapshot.ok) {
    await fail(deps, job, outcome, {
      ok: false,
      code: snapshot.code,
      message: snapshot.message,
      terminal: snapshot.terminal,
    });
    return;
  }

  // The difference is recorded before the completeness check, because the rows
  // that DID come back are facts. E6's rule holds all the way down: nothing here
  // manufactures a figure for a SKU the channel did not mention.
  const recorded = await deps.store.recordSnapshot(context, snapshot);

  if (!snapshot.complete || snapshot.failures.length > 0) {
    // Retryable, not dead. Marking this PROCESSED would declare a reconciliation
    // finished that never covered half the catalogue — the same trap the E6
    // delivery drain documents, and the same answer.
    await fail(deps, job, outcome, {
      ok: false,
      code: "PARTIAL_SNAPSHOT",
      message: `The channel answered for only part of the catalogue: ${snapshot.failures.length} sku(s) unanswered. ${recorded} difference(s) from the part it did answer were recorded.`,
      terminal: false,
    });
    return;
  }

  await succeed(deps, job, outcome, {
    capturedAt: snapshot.capturedAt.toISOString(),
    differencesRecorded: recorded,
    skusAnswered: snapshot.items.length,
  });
}

/* ------------------------------------------------------------------ *
 * 2. Order import — the pull, then one row per order
 * ------------------------------------------------------------------ */

async function pullOrders(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
  adapter: ChannelCommerceAdapter,
  target: ChannelTarget,
): Promise<void> {
  const payload = channelPullPayloadSchema.safeParse(job.request ?? { since: null });
  const since = payload.success && payload.data.since ? new Date(payload.data.since) : null;

  const result = await callAdapter(() => adapter.fetchOrders(target, since));
  if (!result.ok) {
    await fail(deps, job, outcome, result);
    return;
  }

  let enqueued = 0;
  let duplicates = 0;
  for (const order of result.orders) {
    // The channel's own order id is the external ref, so the unique natural key
    // on (org, channel, kind, external_ref) is what makes a re-import a no-op.
    // A conflict is the ordinary case — every marketplace lists an order again
    // on the next pull until it is fulfilled — not an error.
    const created = await deps.store.enqueue({
      orgId: job.orgId,
      channelId: job.channelId,
      kind: "ORDER_IMPORT",
      externalRef: order.externalOrderId,
      request: {
        externalOrderId: order.externalOrderId,
        externalOrderNumber: order.externalOrderNumber,
        placedAt: order.placedAt.toISOString(),
        currency: order.currency,
        shippingAddress: order.shippingAddress,
        lines: order.lines.map((line) => ({ ...line })),
      },
      // Inherited, not invented. The operator who asked for the import is the
      // one the resulting sales orders are raised by.
      enqueuedBy: job.enqueuedBy,
    });
    if (created) enqueued += 1;
    else duplicates += 1;
  }

  outcome.enqueued += enqueued;
  outcome.duplicates += duplicates;

  if (!result.complete) {
    // The orders that were listed are already enqueued durably, so nothing is
    // lost — but there are more, and a PROCESSED row would say this channel was
    // swept when half its orders were never seen.
    await fail(deps, job, outcome, {
      ok: false,
      code: "PARTIAL_ORDER_PULL",
      message: `The channel has more orders than one page. ${enqueued} new and ${duplicates} already-imported order(s) were seen; the rest need another pull.`,
      terminal: false,
    });
    return;
  }

  await succeed(deps, job, outcome, { seen: result.orders.length, enqueued, duplicates });
}

async function importOrder(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
): Promise<void> {
  const payload = channelOrderPayloadSchema.safeParse(job.request);
  if (!payload.success) {
    await fail(deps, job, outcome, {
      ok: false,
      code: "MALFORMED_JOB",
      message: `This job's recorded order cannot be read (${payload.error.issues[0]?.path.join(".") || "root"}). Pull the order again rather than retrying this row.`,
      terminal: true,
    });
    return;
  }

  const applied = await deps.store.applyImport(job, payload.data);
  if (!applied.applied) {
    await fail(deps, job, outcome, {
      ok: false,
      code: applied.code,
      message: applied.message,
      terminal: applied.terminal,
    });
    return;
  }

  await succeed(deps, job, outcome, {
    salesOrderId: applied.salesOrderId,
    externalOrderNumber: payload.data.externalOrderNumber,
  });
}

/* ------------------------------------------------------------------ *
 * 3. Ship confirm
 * ------------------------------------------------------------------ */

async function confirmShipment(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
  adapter: ChannelCommerceAdapter,
  target: ChannelTarget,
): Promise<void> {
  const payload = channelShipPayloadSchema.safeParse(job.request);
  if (!payload.success) {
    await fail(deps, job, outcome, {
      ok: false,
      code: "MALFORMED_JOB",
      message: `This job's recorded shipment cannot be read (${payload.error.issues[0]?.path.join(".") || "root"}).`,
      terminal: true,
    });
    return;
  }

  const result = await callAdapter(() =>
    adapter.confirmShipment(target, {
      externalOrderId: job.externalRef,
      trackingNumber: payload.data.trackingNumber,
      carrierName: payload.data.carrierName,
      trackingUrl: payload.data.trackingUrl,
      lines: payload.data.lines,
    }),
  );
  if (!result.ok) {
    await fail(deps, job, outcome, result);
    return;
  }

  // INV-27 asks us to record what the channel answered, and "it worked" is not a
  // record. The fulfilment id is what an operator quotes to the marketplace's
  // support desk when a customer says they were never told.
  await succeed(deps, job, outcome, {
    answeredAt: result.answeredAt.toISOString(),
    externalFulfilmentId: result.externalFulfilmentId,
    status: result.status,
  });
}

/* ------------------------------------------------------------------ *
 * The two exits
 * ------------------------------------------------------------------ */

async function succeed(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
  response: Record<string, unknown>,
): Promise<void> {
  outcome.succeeded += 1;
  await deps.store.complete(job, response);
}

/**
 * The only way a job fails, so that "every failure is visible with its reason
 * and its attempt count" is one line of code rather than a convention.
 */
async function fail(
  deps: ChannelSyncDeps,
  job: ChannelJob,
  outcome: ChannelSyncOutcome,
  failure: ChannelCallFailure,
): Promise<void> {
  const plan = planChannelAttempt({
    attempts: job.attemptCount,
    ok: false,
    terminal: failure.terminal,
  });
  if (plan.deadLettered) outcome.dead += 1;
  else outcome.retried += 1;
  await deps.store.fail(job, plan, failure);
}

/**
 * One adapter call, bounded and defended.
 *
 * An adapter is third-party-shaped code: it may ignore its own contract and
 * throw, and it may never answer at all. Both become the same kind of value
 * every other failure is, because the caller's correct response is identical and
 * because an escaping exception here would abandon the job row mid-flight —
 * leased, un-failed, and invisible until the lease expired.
 */
async function callAdapter<T extends { ok: boolean }>(
  work: () => Promise<T>,
): Promise<T | ChannelCallFailure> {
  try {
    return await withChannelTimeout(work, CHANNEL_CALL_TIMEOUT_MS);
  } catch (error: unknown) {
    if (error instanceof ChannelTimeoutError) {
      return { ok: false, code: "TIMEOUT", message: error.message, terminal: false };
    }
    return {
      ok: false,
      code: "ADAPTER_THREW",
      message: error instanceof Error ? error.message : String(error),
      terminal: false,
    };
  }
}
