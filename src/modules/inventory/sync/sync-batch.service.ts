import { ConflictException, HttpException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { invIdempotencyKeys } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { INV_ERRORS } from "../stock-engine/stock-engine.types";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { PickConfirmService } from "../picking/pick-confirm.service";
import { GrnService } from "../purchase-orders/grn.service";
import { InvBarcodeService } from "../barcode/inv-barcode.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { adjustmentMovementType } from "../stock/lib/write-off";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { randomUUID } from "node:crypto";
import { logger } from "../../../common/logger/logger.service";
import type {
  SyncBatchInput,
  SyncBatchResult,
  SyncOperation,
  SyncOperationResult,
} from "./dto/sync.schemas";

/**
 * B8 — the structured code a Nest exception was thrown with, if it carries one.
 *
 * The inventory services throw `new BadRequestException({ code, message })`, so
 * the name of the failure is already on the wire — it is just buried in the
 * response body rather than on `Error.message`. Reading it here is what lets
 * the device answer "the stock is not there" differently from "the document
 * moved on" without matching prose, which is a classification that drifts the
 * first time somebody rewords a message.
 */
function structuredCodeOf(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const body: unknown = error.getResponse();
  if (typeof body !== "object" || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * The three answers a device can usefully give a human, and no more.
 *
 * A conflict the operator cannot act on is noise, so this collapses everything
 * to one of: the stock is not there (show them what is), the document moved on
 * (show them what changed), or the same operation is already in flight (wait,
 * do not ask anybody anything). Anything else keeps its own name rather than
 * being flattened into a category that would make the UI lie about it.
 */
export function conflictCodeOf(error: unknown, message: string): string {
  const structured = structuredCodeOf(error);
  if (structured) return structured;
  if (/insufficient|not enough|exceeds? (?:the )?available/i.test(message))
    return INV_ERRORS.INSUFFICIENT_STOCK;
  if (/closed|cancelled|no longer|already|not found|state/i.test(message))
    return INV_ERRORS.INVALID_DOCUMENT_STATE;
  return "UNCLASSIFIED";
}

@Injectable()
export class SyncBatchService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly engine: StockEngineService,
    private readonly picking: PickConfirmService,
    private readonly receiving: GrnService,
    private readonly barcode: InvBarcodeService,
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
      const replayed = await this.runOperation(orgId, userId, operation, key);
      if (replayed) {
        return { clientOperationId: operation.clientOperationId, outcome: "duplicate" };
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
        // B8. A machine-readable name for the conflict, because the device has
        // to answer three of them differently: the stock is not there, the
        // document moved on, or something else entirely. Matching the prose in
        // the UI would put this classification in two places and let the
        // operator's options drift from the reason they were shown.
        code: conflictCodeOf(error, message),
      };
    }
  }

  /**
   * B8 — run one queued operation through the service that owns it online.
   *
   * Returns whether the operation had already been applied. Nothing here writes
   * stock, receives a delivery or closes a pick line itself: an offline path
   * with its own copy of any of those would be a second, weaker set of rules
   * for exactly the operations that got the least supervision.
   *
   * Every branch but `stock.adjust` shares one shape — claim the device's key
   * first, in its own transaction, then do the work under a *derived* key. The
   * claim has to come first, not after: `confirmPick` and `receiveGoods` both
   * accumulate relatively, so two copies of one operation arriving together
   * would both get past the COMPLETED read in `applyOne` and both apply.
   * (`stock.adjust` needs no wrapper because the engine claims this exact key
   * inside its own transaction, before its movement.) The inner key is derived
   * rather than the same string because claiming one key twice would read as a
   * duplicate rather than a nesting, and 409 every first attempt.
   */
  private async runOperation(
    orgId: string,
    userId: string,
    operation: SyncOperation,
    key: string,
  ): Promise<boolean> {
    switch (operation.type) {
      case "stock.adjust":
        await this.engine.execute(orgId, userId, {
          idempotencyKey: key,
          sourceType: "offline-sync",
          sourceId: operation.clientOperationId,
          postingDate: operation.occurredAt.slice(0, 10),
          movements: [
            {
              /**
               * B8. The ledger type follows the sign of the delta.
               *
               * Every offline adjustment was posted `ADJUSTMENT_IN` whatever
               * its sign, so a queued correction of −5 landed as an *inbound*
               * movement of −5: the arithmetic was right, and the ledger said
               * stock had arrived. Nothing that reads `transaction_type` —
               * shrinkage reporting, the AI adjustment summary, an auditor
               * separating a recount from a write-off — could tell an offline
               * removal from an offline receipt. `adjustmentMovementType` is
               * the same function the online adjustment path uses, so the two
               * cannot drift, and it also gives a condemned line `SCRAP`
               * rather than `ADJUSTMENT_OUT`.
               *
               * The quantity itself is passed through untouched. The sign is
               * the instruction; a direction flag beside an absolute value
               * would be a second place for it to be stated and a first place
               * for it to disagree.
               */
              transactionType: adjustmentMovementType(
                operation.reasonCode ?? "",
                operation.quantityDelta,
              ),
              productVariantId: operation.productVariantId,
              locationId: operation.locationId,
              quantityDelta: operation.quantityDelta,
            },
          ],
        });
        return false;

      case "pick.confirm":
        return this.claimThen(orgId, key, operation, async () => {
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
        });

      case "receive.count":
        return this.claimThen(orgId, key, operation, async () => {
          // The whole delivery — document, PO arithmetic, movements, events,
          // journal — through the one command the dock uses online. A queued
          // count is a delivery that was counted with no signal, not a
          // different kind of document.
          await this.receiving.receiveGoods(
            orgId,
            operation.poId,
            userId,
            `${key}:receive`,
            {
              receivedDate: operation.receivedDate,
              locationId: operation.locationId,
              notes: operation.notes,
              lines: operation.lines,
            },
          );
        });

      case "scan.capture":
        return this.claimThen(orgId, key, operation, async () => {
          // Resolved against the catalogue as it stands now, not as the device
          // last saw it. The raw payload is the fact; what it means is an
          // interpretation, and the device's copy of the catalogue is the
          // stalest one in the system.
          await this.barcode.captureScan(
            orgId,
            userId,
            `${key}:scan`,
            operation.payload,
          );
        });
    }
  }

  /**
   * Claim the device's key, then do the work under it. `true` means a prior
   * attempt already did it.
   */
  private claimThen(
    orgId: string,
    key: string,
    request: unknown,
    work: () => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        key,
        request,
        async () => {
          await work();
          return false;
        },
        () => true,
      ),
    );
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
