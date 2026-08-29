import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invIdempotencyKeys } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { PickWaveService } from "../picking/pick-wave.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { randomUUID } from "node:crypto";
import { logger } from "../../../common/logger/logger.service";
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

    // COMPLETED only. Matching on the key alone treated a *failed* prior
    // attempt as a duplicate -- the row is left behind IN_FLIGHT or FAILED --
    // so a device retrying an operation that genuinely did not land was told it
    // had, and the adjustment was lost silently. That is the exact failure this
    // whole service exists to prevent.
    const alreadyDone = await this.db.query.invIdempotencyKeys.findFirst({
      where: and(
        eq(invIdempotencyKeys.orgId, orgId),
        eq(invIdempotencyKeys.idempotencyKey, key),
        eq(invIdempotencyKeys.status, "COMPLETED"),
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
        // A3. This branch used to run the pick and *then* insert a COMPLETED
        // row for the key, which is a receipt rather than a claim. The two
        // operation types were not equally protected: `stock.adjust` claims
        // inside the engine, before its movement; the pick claimed after its
        // own. `confirmPick` adds to `quantity_picked` relatively and
        // decrements the outgoing bucket, so two copies of one operation
        // arriving together — exactly what a device on a failing network
        // sends — both got past the COMPLETED read above, both picked, and the
        // trailing `onConflictDoNothing` recorded that silently. The claim now
        // comes first and shares the pick's transaction, so the second copy
        // waits on the key and replays instead of picking again.
        const replayed = await this.db.transaction((tx) =>
          runIdempotent(
            tx,
            orgId,
            key,
            operation,
            async () => {
              // Derived, not the same key: `confirmPick` claims one of its own
              // now, and claiming a key twice in one transaction is a duplicate
              // rather than a nesting — it would 409 every first attempt.
              await this.picking.confirmPick(
                orgId,
                userId,
                operation.pickListId,
                {
                  pickLineId: operation.pickLineId,
                  quantityPicked: operation.quantityPicked,
                },
                `${key}:confirm`,
              );
              return false;
            },
            () => true,
          ),
        );
        if (replayed) {
          return { clientOperationId: operation.clientOperationId, outcome: "duplicate" };
        }
      }

      // Emitted after the operation has committed, and its failure must not be
      // reported as the operation's. Telling a device its stock movement failed
      // when it landed is worse than a missing event: the device will send it
      // again, and the second one will be applied.
      await this.emitApplied(orgId, userId, operation);

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

  private async emitApplied(
    orgId: string,
    userId: string,
    operation: SyncOperation,
  ): Promise<void> {
    try {
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
    } catch (error) {
      // Swallowed deliberately and loudly: the movement is committed, and the
      // device's view of what landed must not depend on whether we managed to
      // announce it.
      logger.error("inventory.sync: applied operation but failed to emit its event", {
        orgId,
        clientOperationId: operation.clientOperationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
