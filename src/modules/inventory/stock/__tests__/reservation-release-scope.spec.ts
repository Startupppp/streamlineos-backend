import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { InvStockReservationsService } from "../inv-stock-reservations.service";
import type { WarehouseScopeService } from "../../stock-engine/warehouse-scope.service";
import type { ReleaseReservationInput } from "../dto/inv-stock.schemas";
import {
  cacheWith,
  dbWith,
  scopeOf,
  sqlText,
  type DbHarness,
} from "../../__tests__/warehouse-scope-harness";

/**
 * A hold could be released out of a building the caller holds nothing in.
 *
 * `input.reservationId` came straight off the request body and went to
 * `ReservationService.releaseReservationInTx`, which locks the row on
 * `id = … AND org_id = …` and nothing else — it takes a `userId` and spends it
 * on nothing. `listReservations` beside it has resolved the caller's warehouses
 * since the scope work landed, so a reservation an operator could not see in
 * their own list was theirs to cancel by id.
 *
 * THIS ONE IS NOT INERT, which is what separates it from the return drafts.
 * Releasing flips the row to RELEASED and decrements `committed`, handing that
 * quantity straight back to general availability. The people who do hold the
 * building lose a promise they made to a customer, their availability moves
 * under them, and nothing in their view says who did it. The create-side gate's
 * note reads "it makes that quantity unavailable to the people who DO hold the
 * building" — this is the same sentence with the sign flipped, and the damage
 * is the kind nobody finds until an order is short.
 */

const ORG = "org-1";

function input(reservationId = 42): ReleaseReservationInput {
  return { reservationId };
}

function serviceWith(harness: DbHarness, scope: WarehouseScopeService) {
  const { cache } = cacheWith();
  const stub = {} as never;
  return new InvStockReservationsService(
    harness.db,
    cache,
    stub,
    stub,
    scope,
    stub,
    stub,
    stub,
  );
}

/** The scope test alone, with placeholder NUMBERS and line breaks normalised away. */
function shape(text: string): string {
  return text.replace(/\$\d+/g, "$?").replace(/\s+/g, " ");
}

describe("releasing a reservation by id", () => {
  it("refuses one outside the caller's warehouses, before the row is ever locked", async () => {
    /*
     * The PREDICATE is the assertion, not the throw. The fixture answers with no
     * row whichever way the service is written, so `rejects` alone would pass
     * against the unguarded code it was written to reject. An empty scope
     * compiles both arms to FALSE, and that is what a database acts on.
     *
     * `transaction` is the second half and the sharper one. The harness's mock
     * DOES run its callback — a mock that silently skipped it would void every
     * assertion inside — and the tx it hands over throws on `execute`, so a gate
     * that failed to refuse fails loudly rather than passing quietly. Asserting
     * the transaction was never opened is asserting the `FOR UPDATE` was never
     * issued and `committed` was never touched.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).releaseReservation(ORG, "nobody-1", input(), "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.transaction).not.toHaveBeenCalled();
    expect(shape(sqlText(harness.wheres[0] as SQL))).toBe(
      '("inv_stock_reservations"."org_id" = $? and "inv_stock_reservations"."id" = $? ' +
        "and (FALSE OR FALSE))",
    );
  });

  it("narrows a scoped caller through the warehouse OR the location", async () => {
    /*
     * `anyOf`, and this row is the example in `ResolvedWarehouseScope`'s own
     * note: both columns are nullable, so requiring both would deny a
     * reservation whose location is in scope purely because its warehouse column
     * is null. A row attributed by NEITHER names no warehouse at all and stays
     * invisible — `NULL IN (…)` is NULL, `NULL OR NULL` is NULL, and that is not
     * true. Hence the absence of any `IS NULL` escape is asserted rather than
     * merely left out.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([7, 9]);

    await expect(
      serviceWith(harness, scope).releaseReservation(ORG, "picker-1", input(), "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    const text = shape(sqlText(harness.wheres[0] as SQL));
    expect(text).toContain('"inv_stock_reservations"."warehouse_id" IN ($?, $?)');
    expect(text).toContain(
      '"inv_stock_reservations"."location_id" IN ( SELECT id FROM inv_locations ' +
        "WHERE warehouse_id IN ($?, $?) )",
    );
    expect(text).toContain(" OR ");
    expect(text).not.toContain("IS NULL");
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("never claims the idempotency key for a release it is going to refuse", async () => {
    /*
     * Why the gate sits in front of `db.transaction` rather than inside the
     * claim. `runIdempotent` stores the first result against (key + tenant) and
     * replays it, so a refusal taken inside would be the stored result: a client
     * that mistyped the id, noticed, and retried the SAME key with the right one
     * would be handed back the 404 instead of the release. The return posts gate
     * in the same place for the same reason.
     *
     * The transaction is where the claim is taken, so "never opened" is the
     * assertion — there is nothing else to observe from outside.
     */
    const harness = dbWith();
    const { service: scope } = scopeOf([]);

    await expect(
      serviceWith(harness, scope).releaseReservation(ORG, "nobody-1", input(), "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("lets one through when the reservation is in a warehouse the caller holds", async () => {
    /*
     * The other direction, and the reason the assertions above are not vacuous:
     * the same fixture with the gate SATISFIED opens the transaction. It then
     * dies inside, because the harness's tx throws on `execute` — that is the
     * loud failure the mock exists to produce, and here it is the proof the
     * command got past the gate rather than being refused by it.
     */
    const harness = dbWith({ reads: [[{ id: 42 }]] });
    const { service: scope } = scopeOf([7]);

    const outcome = await serviceWith(harness, scope)
      .releaseReservation(ORG, "picker-1", input(), "key-1")
      .then(() => null, (error: unknown) => error);

    expect(outcome).not.toBeInstanceOf(NotFoundException);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it("consults the scope even for an org-wide caller, and then narrows nothing", async () => {
    // "No predicate" cannot on its own tell an UNRESTRICTED caller from an
    // UNGATED method — which is the defect — so the absence is asserted
    // alongside proof that the scope was resolved at all.
    const harness = dbWith({ reads: [[{ id: 42 }]] });
    const { service: scope, consulted } = scopeOf(null);

    await serviceWith(harness, scope)
      .releaseReservation(ORG, "auditor-1", input(), "key-1")
      .catch(() => undefined);

    expect(consulted).toHaveBeenCalledWith(ORG, "auditor-1");
    expect(sqlText(harness.wheres[0] as SQL)).not.toContain("inv_locations");
  });

  it("builds exactly the predicate the list builds", async () => {
    /*
     * The drift guard, and the reason the predicate lives in one private method
     * rather than a second copy. Two hand-copied predicates agreeing today is
     * not the same as them being one predicate: this list gained its scope and
     * the release beside it was simply never told, which is the whole defect.
     */
    const { service: scope } = scopeOf([7, 9]);

    const list = dbWith();
    await serviceWith(list, scope).listReservations(ORG, "picker-1", {
      page: 1,
      limit: 20,
    } as never);

    const release = dbWith();
    await expect(
      serviceWith(release, scope).releaseReservation(ORG, "picker-1", input(), "key-1"),
    ).rejects.toBeInstanceOf(NotFoundException);

    // The row id is bound before the scope clause on the release and not at all
    // on the list, so every `$n` inside is shifted; the shapes are compared with
    // the numbers normalised away, which is the question either way.
    const scopeClauseOf = (text: string) => shape(text).slice(shape(text).indexOf("("));
    const fromList = scopeClauseOf(sqlText(list.wheres[0] as SQL));
    const fromRelease = scopeClauseOf(sqlText(release.wheres[0] as SQL));

    expect(fromList).toContain('"inv_stock_reservations"."warehouse_id" IN ($?, $?)');
    expect(fromRelease.slice(fromRelease.indexOf('and ("inv_stock_reservations"."warehouse_id"')))
      .toBe(fromList.slice(fromList.indexOf('and ("inv_stock_reservations"."warehouse_id"')));
  });
});

describe("the ungated release that is allowed to stay", () => {
  it("is the shared in-transaction helper, whose callers own their own aggregate", () => {
    /*
     * `releaseReservationInTx` is deliberately NOT gated, the same split as
     * `createTransfer` / `createTransferInTx`. Five modules call it — cancelling
     * a transfer, cancelling a sales order, a project standing down a
     * requirement, a pick substitution — and each releases the reservations
     * belonging to its own aggregate, found by `source_type`/`source_id` rather
     * than by an id a client named. A sales order legitimately spans two
     * buildings, so a gate there would refuse the operator cancelling it.
     *
     * The public `releaseReservation` that used to sit beside it in
     * `ReservationService` is gone rather than left ungated next to the gate:
     * it wrapped the helper in a transaction, had no caller anywhere, and was
     * the obvious wrong thing for a new route to reach for. Asserted by absence,
     * so re-adding one without a gate fails here rather than shipping quietly.
     */
    const engine = readFileSync(
      join(__dirname, "..", "..", "stock-engine", "reservation.service.ts"),
      "utf8",
    );
    expect(engine).toContain("async releaseReservationInTx(");
    expect(engine).not.toMatch(/^ {2}async releaseReservation\(/m);

    // The half a census cannot see: the gate has to be on the method the
    // controller actually reaches.
    const controller = readFileSync(join(__dirname, "..", "inv-stock.controller.ts"), "utf8");
    expect(controller).toContain(
      "this.reservations.releaseReservation(u.orgId, u.userId, body, idempotencyKey)",
    );
  });
});
