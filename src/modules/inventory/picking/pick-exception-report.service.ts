import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { InventoryAuditService } from "../stock-engine/inventory-audit.service";
import { InventorySettingsService } from "../stock-engine/inventory-settings.service";
import { ReservationService } from "../stock-engine/reservation.service";
import { runIdempotent } from "../stock-engine/idempotency";
import { SoCoreService } from "../sales-orders/so-core.service";
import type { ReportPickExceptionInput } from "./dto/picking.schemas";
import { type PickExceptionResult, reviveException } from "./pick-line";
import { PickCompletionService } from "./pick-completion.service";
import {
  reportPickExceptionInTx,
  type PickExceptionDeps,
} from "./lib/pick-exception-report";

/**
 * B5 — why a line could not close as asked, and what that does to the promise
 * behind it.
 *
 * Split from `PickConfirmService` because it is the other half of the shelf: one
 * records what a picker found, the other records what they did not, and only the
 * second has to unwind a reservation, rewrite a sales-order line or send the row
 * to a supervisor. They share `PickCompletionService`, which is where the
 * sequence they both depend on lives, and nothing else.
 *
 * `PickExceptionService` is the third piece and deliberately not this one: it
 * owns what happens to an exception *after* the picker has walked away, which is
 * a different audience and a different permission.
 */
@Injectable()
export class PickExceptionReportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly completion: PickCompletionService,
    private readonly audit: InventoryAuditService,
    private readonly reservations: ReservationService,
    private readonly settings: InventorySettingsService,
    private readonly soCore: SoCoreService,
  ) {}

  private get exceptionDeps(): PickExceptionDeps {
    return {
      db: this.db,
      completion: this.completion,
      audit: this.audit,
      reservations: this.reservations,
      settings: this.settings,
      soCore: this.soCore,
    };
  }

  /**
   * INV-205 / B5 — record why a line could not close as asked, and put the
   * reservation behind it right.
   *
   * The distinction being preserved is between a line short because the shelf
   * was empty and a line short because the picker moved on. The first is a stock
   * problem and the second is a process problem; a warehouse that cannot tell
   * them apart fixes neither, and the quantity alone cannot tell them apart.
   *
   * **The defect B5 closes.** Reporting an exception used to write the reason and
   * stop, leaving the reservation still holding the units nobody was going to
   * pick. `committed` stayed at the whole ordered quantity, `EXPECTED_OUTGOING`
   * subtracts the entire remaining `committed` and so clamped to zero, and a
   * five-unit line short-picked at two withdrew five units from availability for
   * good — three of them sitting on the shelf, unsellable, with no document
   * anywhere saying why. So a closing exception now releases the line's
   * reservations, in the same transaction and before the recompute, and the
   * recompute picks the toted units back up through `outgoing_qty`.
   *
   * The reasons behave differently on purpose, and each difference is a fact
   * about the world rather than a policy knob:
   *
   *   * `SHORT` · `NOT_FOUND` · `DAMAGED` — the rest is not coming. Release.
   *   * `WRONG_LOCATION` — the goods exist, the wave sent the picker to the
   *     wrong bin. Retarget the line and keep the reservation: the demand still
   *     stands and the walk is not over.
   *   * `SUBSTITUTED` — something else is in the tote, so the demand itself
   *     changes. See `rewriteSoLineDemand`.
   */
  async reportException(
    orgId: string,
    userId: string,
    pickListId: number,
    input: ReportPickExceptionInput,
    idempotencyKey: string,
  ): Promise<PickExceptionResult> {
    // A3. Claimed as the first statement inside the same transaction as the
    // work, and around every branch rather than only the ones that post
    // something: a substitution records picked stock against a second variant
    // and would take it out of availability twice on a retry, and a release that
    // claimed nothing would let a retry release a reservation somebody had
    // meanwhile re-created.
    return this.db.transaction((tx) =>
      runIdempotent(
        tx,
        orgId,
        idempotencyKey,
        { command: "inventory.picking.exception", pickListId, input },
        () =>
          reportPickExceptionInTx(
            this.exceptionDeps,
            tx,
            orgId,
            userId,
            pickListId,
            input,
            idempotencyKey,
          ),
        (stored) => reviveException(stored),
      ),
    );
  }
}
