import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invIdempotencyKeys } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { PickWaveService } from "../picking/pick-wave.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { randomUUID } from "node:crypto";
import type {
  SyncBatchInput,
  SyncBatchResult,
  SyncOperation,
  SyncOperationResult,
} from "./dto/sync.schemas";

@Injectable()
export class SyncBatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly picking: PickWaveService,
  ) {}

  /**
   * INV-208 — replay a device's offline queue.
   *
   * Three properties, and each is a refusal to do the convenient thing:
   *
   *   **No last-write-wins.** An operation whose world has moved -- the stock
   *   is gone, the pick line is closed -- is reported as a conflict and not
   *   applied. Forcing it through would let a device that has been offline for
   *   six hours silently overwrite six hours of decisions made by people who
   *   could see the shelf.
   *
   *   **Per-operation outcomes, not a batch verdict.** Operations are applied
   *   one at a time in their own transactions, so one conflict does not discard
   *   ninety-nine good ones. A device told only "batch failed" has no way to
   *   know what to resend, and will resend everything.
   *
   *   **Ordered by when the operator did it**, not by when the payload happened
   *   to be serialised. Two adjustments to the same bin have to replay in the
   *   order the human made them, or the final position is a coin toss.
   *
   * Every operation goes through the same services an online request would.
   * Nothing here writes stock directly: an offline path that bypassed the
   * engine would be a second, weaker set of rules for exactly the operations
   * that got least supervision.
   */
  async apply(
    orgId: string,
    userId: string,
    input: SyncBatchInput,
  ): Promise<SyncBatchResult> {
    const ordered = [...input.operations].sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        a.clientOperationId.localeCompare(b.clientOperationId),
    );

    const results: SyncOperationResult[] = [];
    for (const operation of ordered) {
      results.push(await this.applyOne(orgId, userId, operation));
    }

    const count = (outcome: string) =>
      results.filter((r) => r.outcome === outcome).length;

    return {
      applied: count("applied"),
      duplicates: count("duplicate"),
      conflicts: count("conflict"),
      failures: count("failed"),
      results,
    };
  }

  private async applyOne(
    orgId: string,
    userId: string,
    operation: SyncOperation,
  ): Promise<SyncOperationResult> {
    // The device's own id is the idempotency key throughout, so a resend of a
    // request whose response was lost costs nothing.
    const key = `sync:${operation.clientOperationId}`;

    const alreadyDone = await this.db.query.invIdempotencyKeys.findFirst({
      where: and(
        eq(invIdempotencyKeys.orgId, orgId),
        eq(invIdempotencyKeys.idempotencyKey, key),
      ),
      columns: { id: true },
    });
    if (alreadyDone) {
      return { clientOperationId: operation.clientOperationId, outcome: "duplicate" };
    }

    try {
      if (operation.type === "stock.adjust") {
        await this.engine.execute(orgId, userId, {
          idempotencyKey: key,
          sourceType: "offline-sync",
          sourceId: operation.clientOperationId,
          postingDate: operation.occurredAt.slice(0, 10),
          movements: [
            {
              transactionType: "ADJUSTMENT_IN",
              productVariantId: operation.productVariantId,
              locationId: operation.locationId,
              quantityDelta: operation.quantityDelta,
            },
          ],
        });
      } else {
        await this.picking.confirmPick(orgId, userId, operation.pickListId, {
          pickLineId: operation.pickLineId,
          quantityPicked: operation.quantityPicked,
        });
        // The picking path has its own idempotency story, so the claim is
        // recorded here to keep the device's view of "already sent" uniform
        // across operation types.
        await this.db
          .insert(invIdempotencyKeys)
          .values({
            orgId,
            idempotencyKey: key,
            requestHash: operation.clientOperationId,
            status: "COMPLETED",
            expiresAt: new Date(Date.now() + 86_400_000),
            leaseExpiresAt: new Date(Date.now() + 900_000),
          })
          .onConflictDoNothing();
      }

      await this.db.transaction(async (tx) => {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "inv_sync",
          aggregateId: operation.clientOperationId,
          aggregateVersion: Date.now(),
          eventType: "inventory.sync.offline_batch_applied",
          payload: {
            type: operation.type,
            clientOperationId: operation.clientOperationId,
            occurredAt: operation.occurredAt,
            appliedBy: userId,
          },
          occurredAt: new Date(),
          actorMembershipId: null,
        });
      });

      return { clientOperationId: operation.clientOperationId, outcome: "applied" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A conflict is a fact about the world, not a bug: the shelf emptied, the
      // line closed, somebody got there first. It is reported so the device can
      // show it to a human, never resolved by force.
      const isConflict =
        error instanceof ConflictException ||
        /insufficient|exceed|not found|closed|capacity/i.test(message);
      return {
        clientOperationId: operation.clientOperationId,
        outcome: isConflict ? "conflict" : "failed",
        reason: message,
      };
    }
  }
}
