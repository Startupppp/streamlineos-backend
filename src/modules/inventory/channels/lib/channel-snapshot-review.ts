import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { type Db } from "../../../../db/drizzle.module";
import { invChannels, invChannelSnapshotDiffs } from "../../../../db/schema";
import { StockEngineService } from "../../stock-engine/stock-engine.service";
import { InventoryAuditService } from "../../stock-engine/inventory-audit.service";
import type {
  ListSnapshotDiffsQueryInput,
  ResolveSnapshotDiffInput,
} from "../dto/channel-snapshot.schemas";

/**
 * The operator surface: read the open differences, and resolve one.
 *
 * The only part of the snapshot path a human triggers, and the only part that
 * may reach `StockEngineService` at all — see contract 2 in
 * `channel-snapshot.service.ts`. Nothing in the receiver or the drain worker
 * can post a movement; that has to be a named person acting here.
 */
export interface ReviewDeps {
  readonly db: Db;
  readonly stockEngine: StockEngineService;
  readonly audit: InventoryAuditService;
}

/* ---------------------------------------------------------------- *
 * Operator surface
 * ---------------------------------------------------------------- */

export async function listDiffs(
  deps: ReviewDeps,orgId: string, channelId: number, query: ListSnapshotDiffsQueryInput) {
  const channel = await deps.db.query.invChannels.findFirst({
    where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, channelId)),
    columns: { id: true, snapshotPolicy: true },
  });
  if (!channel) throw new NotFoundException("Channel not found");

  const conditions = [
    eq(invChannelSnapshotDiffs.orgId, orgId),
    eq(invChannelSnapshotDiffs.channelId, channelId),
    ...(query.status ? [eq(invChannelSnapshotDiffs.status, query.status)] : []),
  ];

  const offset = (query.page - 1) * query.limit;
  const [items, [countRow]] = await Promise.all([
    deps.db
      .select({
        id: invChannelSnapshotDiffs.id,
        externalSku: invChannelSnapshotDiffs.externalSku,
        productVariantId: invChannelSnapshotDiffs.productVariantId,
        channelQty: invChannelSnapshotDiffs.channelQty,
        internalQty: invChannelSnapshotDiffs.internalQty,
        difference: invChannelSnapshotDiffs.difference,
        status: invChannelSnapshotDiffs.status,
        snapshotAt: invChannelSnapshotDiffs.snapshotAt,
        resolvedAt: invChannelSnapshotDiffs.resolvedAt,
        resolutionNote: invChannelSnapshotDiffs.resolutionNote,
        stockTransactionId: invChannelSnapshotDiffs.stockTransactionId,
      })
      .from(invChannelSnapshotDiffs)
      .where(and(...conditions))
      .orderBy(desc(invChannelSnapshotDiffs.snapshotAt))
      .limit(query.limit)
      .offset(offset),
    deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(invChannelSnapshotDiffs)
      .where(and(...conditions)),
  ]);

  const total = countRow?.count ?? 0;
  return {
    items,
    total,
    page: query.page,
    totalPages: Math.ceil(total / query.limit),
    // So a screen can render "accepting is not permitted here" rather than
    // offering a button that 409s.
    snapshotPolicy: channel.snapshotPolicy,
  };
}

/**
 * Accept one difference, which posts one ordinary stock movement.
 *
 * This is the only path from a channel snapshot to the ledger, and every gate
 * E6 asks for sits on it:
 *
 *  - the channel's policy must be `ALLOW_ADJUSTMENT`, or it refuses;
 *  - the channel must name a reconciliation location, or it refuses rather
 *    than guessing where a correction belongs;
 *  - the movement goes through `StockEngineService.execute` under the
 *    operator's own user id, so warehouse scope, the accounting-period gate,
 *    costing and the outbox event all apply exactly as they do to a manual
 *    adjustment;
 *  - the idempotency key is derived from the difference row, so accepting the
 *    same difference twice posts once. That is what makes this an *idempotent
 *    command* rather than a button somebody can double-click into two
 *    movements.
 *
 * The status transition is guarded on `OPEN` and the affected-row count is
 * checked, so two operators racing produce one movement and one 409 rather
 * than two movements.
 */
export async function acceptDiff(
  deps: ReviewDeps,
  orgId: string,
  userId: string,
  diffId: number,
  input: ResolveSnapshotDiffInput,
) {
  const diff = await deps.db.query.invChannelSnapshotDiffs.findFirst({
    where: and(eq(invChannelSnapshotDiffs.orgId, orgId), eq(invChannelSnapshotDiffs.id, diffId)),
  });
  if (!diff) throw new NotFoundException("Snapshot difference not found");
  if (diff.status !== "OPEN") {
    throw new ConflictException("This difference has already been resolved");
  }
  if (diff.productVariantId === null) {
    throw new BadRequestException(
      `The channel SKU "${diff.externalSku}" matches no product variant, so there is nothing to adjust. Map the SKU first, or dismiss this difference.`,
    );
  }

  const channel = await deps.db.query.invChannels.findFirst({
    where: and(eq(invChannels.orgId, orgId), eq(invChannels.id, diff.channelId)),
    columns: { id: true, snapshotPolicy: true, reconciliationLocationId: true },
  });
  if (!channel) throw new NotFoundException("Channel not found");

  if (channel.snapshotPolicy !== "ALLOW_ADJUSTMENT") {
    throw new ConflictException(
      "This channel's snapshot policy records differences only. A marketplace's stock figure is not permitted to move this ledger until an administrator changes the policy.",
    );
  }
  if (channel.reconciliationLocationId === null) {
    throw new BadRequestException(
      "This channel has no reconciliation location, so there is nowhere to post the correction. Set one on the channel first.",
    );
  }

  const result = await deps.stockEngine.execute(orgId, userId, {
    // Derived from the row, not minted per request: accepting the same
    // difference twice claims the same key and posts nothing the second time.
    idempotencyKey: `channel-snapshot-diff:${diff.id}`,
    sourceType: "channel_snapshot_diff",
    sourceId: String(diff.id),
    reason: input.note,
    movements: [
      {
        transactionType: "ADJUSTMENT",
        productVariantId: diff.productVariantId,
        locationId: channel.reconciliationLocationId,
        quantityDelta: diff.difference,
      },
    ],
  });

  const transactionId = result.transactionIds[0] ?? null;
  const updated = await deps.db
    .update(invChannelSnapshotDiffs)
    .set({
      status: "ACCEPTED",
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: input.note,
      stockTransactionId: transactionId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invChannelSnapshotDiffs.orgId, orgId),
        eq(invChannelSnapshotDiffs.id, diffId),
        eq(invChannelSnapshotDiffs.status, "OPEN"),
      ),
    )
    .returning({ id: invChannelSnapshotDiffs.id });

  if (updated.length === 0) {
    // Lost the race. The engine's idempotency key means the winner's movement
    // is the only one that posted, so nothing has to be undone here.
    throw new ConflictException("This difference has already been resolved");
  }

  await deps.audit.insert(deps.db, {
    orgId,
    actorUserId: userId,
    action: "channel.snapshot_difference_accepted",
    resourceType: "inv_channel_snapshot_diff",
    resourceId: String(diffId),
    metadata: { channelId: diff.channelId, difference: diff.difference, stockTransactionId: transactionId },
  });

  return { diffId, stockTransactionId: transactionId };
}

/** Close a difference without touching stock — the answer for a mapping error. */
export async function dismissDiff(
  deps: ReviewDeps,
  orgId: string,
  userId: string,
  diffId: number,
  input: ResolveSnapshotDiffInput,
) {
  const updated = await deps.db
    .update(invChannelSnapshotDiffs)
    .set({
      status: "DISMISSED",
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: input.note,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invChannelSnapshotDiffs.orgId, orgId),
        eq(invChannelSnapshotDiffs.id, diffId),
        eq(invChannelSnapshotDiffs.status, "OPEN"),
      ),
    )
    .returning({ id: invChannelSnapshotDiffs.id });

  if (updated.length === 0) {
    // 404 rather than 403 or 409 for a row in another tenant: a distinct
    // answer for "exists but not yours" turns a probe into an existence
    // oracle (§4).
    const exists = await deps.db
      .select({ id: invChannelSnapshotDiffs.id })
      .from(invChannelSnapshotDiffs)
      .where(
        and(eq(invChannelSnapshotDiffs.orgId, orgId), eq(invChannelSnapshotDiffs.id, diffId)),
      )
      .limit(1);
    if (exists.length === 0) throw new NotFoundException("Snapshot difference not found");
    throw new ConflictException("This difference has already been resolved");
  }

  await deps.audit.insert(deps.db, {
    orgId,
    actorUserId: userId,
    action: "channel.snapshot_difference_dismissed",
    resourceType: "inv_channel_snapshot_diff",
    resourceId: String(diffId),
    metadata: { note: input.note },
  });

  return { diffId };
}
