import { BadRequestException, NotFoundException } from "@nestjs/common";

/**
 * B5, item 3 — the six gates a substitution passes before it rewrites anything.
 *
 * Written when `substitute` moved out of `PickExceptionReportService` into
 * `lib/pick-exception-branches.ts`, because the move exposed that nothing
 * tested it. `pick-allocation-constraints.spec.ts` reads this call site's
 * SOURCE and asserts the allocator is handed its constraints; no suite anywhere
 * ran the function. Measured rather than assumed: inserting `return;` as the
 * first statement of `resolveSubstitution` left every suite in
 * `src/modules/inventory` green — 91 tests across picking and sales-orders, and
 * 1725 across the module.
 *
 * Each gate below is a way an order has actually gone wrong, so each is asserted
 * on its own refusal rather than on "it threw". The four external helpers
 * (`assertSubstitutable`, `assertSubstitutionCoversLine`, `loadSoLineDemand`,
 * `rewriteSoLineDemand`) are doubles because they have their own tests and their
 * own tables; what is under test here is the ORDER and the CONDITIONS, which is
 * where the defect would be.
 */
jest.mock("../pick-substitution", () => ({
  assertSubstitutable: jest.fn(),
  assertSubstitutionCoversLine: jest.fn(),
  loadSoLineDemand: jest.fn(),
  pickedAgainstSoLine: jest.fn(),
  rewriteSoLineDemand: jest.fn(),
}));
jest.mock("../pick-allocation-constraints", () => ({
  resolvePickConstraints: jest.fn(),
}));

import {
  assertSubstitutable,
  assertSubstitutionCoversLine,
  loadSoLineDemand,
  pickedAgainstSoLine,
  rewriteSoLineDemand,
} from "../pick-substitution";
import { resolvePickConstraints } from "../pick-allocation-constraints";
import {
  resolveSubstitution,
  type PickSubstitutionDeps,
} from "../lib/pick-exception-branches";
import type { PickLineRow } from "../pick-line";

const mocked = <T>(fn: T) => fn as unknown as jest.Mock;

const LINE: PickLineRow = {
  id: 7,
  soLineId: 42,
  productVariantId: 100,
  locationId: 5,
  lotId: null,
  serialId: null,
  handlingUnitId: null,
  quantityToPick: "5.0000",
  quantityPicked: "0.0000",
  exceptionReason: null,
  exceptionStatus: null,
  substituteVariantId: null,
  substituteQuantity: null,
};

const INPUT = {
  pickLineId: 7,
  reason: "SUBSTITUTED",
  substituteVariantId: 200,
  quantityPicked: "5.0000",
} as never;

const DEMAND = {
  id: 42,
  soId: 9,
  productVariantId: 100,
  quantity: "5.0000",
  warehouseId: 1,
};

function makeDeps(found: unknown = { locationId: 5, lotId: 77 }): PickSubstitutionDeps {
  return {
    db: {} as never,
    settings: {
      get: jest.fn().mockResolvedValue({
        reservationStrategy: "FEFO",
        expiryReservationPolicy: "BLOCK",
      }),
    } as never,
    soCore: { findAvailableLotForLine: jest.fn().mockResolvedValue(found) } as never,
    reservations: {} as never,
  };
}

const TX = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
  mocked(loadSoLineDemand).mockResolvedValue(DEMAND);
  mocked(pickedAgainstSoLine).mockResolvedValue("0.0000");
  mocked(resolvePickConstraints).mockResolvedValue({
    nearExpiryPolicy: "BLOCK",
    nearExpiryWindowDays: 30,
    minShelfLifeDays: 60,
  });
  mocked(rewriteSoLineDemand).mockResolvedValue({
    releasedReservationIds: [1],
    newReservationId: 2,
    grains: [],
  });
});

describe("B5 — the gates a substitution passes before it rewrites demand", () => {
  it("refuses a task that belongs to no order line, before touching anything", async () => {
    await expect(
      resolveSubstitution(makeDeps(), TX, "org", "user", { ...LINE, soLineId: null }, INPUT),
    ).rejects.toThrow(/no order line/);
    // Before, not after: there is no demand to rewrite, so nothing should have
    // been read or asserted about the substitute at all.
    expect(assertSubstitutable).not.toHaveBeenCalled();
    expect(loadSoLineDemand).not.toHaveBeenCalled();
  });

  it("refuses when the order line behind the task is gone", async () => {
    mocked(loadSoLineDemand).mockResolvedValue(null);
    await expect(
      resolveSubstitution(makeDeps(), TX, "org", "user", LINE, INPUT),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(rewriteSoLineDemand).not.toHaveBeenCalled();
  });

  it("refuses a second substitution of the same line", async () => {
    // The order line now asks for the FIRST substitute, not for what this task
    // names — so a second swap would silently overwrite the first.
    mocked(loadSoLineDemand).mockResolvedValue({ ...DEMAND, productVariantId: 999 });
    await expect(
      resolveSubstitution(makeDeps(), TX, "org", "user", LINE, INPUT),
    ).rejects.toThrow(/already been substituted/);
    expect(rewriteSoLineDemand).not.toHaveBeenCalled();
  });

  it("refuses a quantity beyond what the task asked for, counting what is already picked", async () => {
    await expect(
      resolveSubstitution(
        makeDeps(),
        TX,
        "org",
        "user",
        { ...LINE, quantityPicked: "3.0000" },
        { ...(INPUT as object), quantityPicked: "3.0000" } as never,
      ),
    ).rejects.toThrow(/would exceed the 5.0000/);
    expect(assertSubstitutionCoversLine).not.toHaveBeenCalled();
  });

  it("refuses when there is no sellable stock of the substitute to re-promise against", async () => {
    await expect(
      resolveSubstitution(makeDeps(null), TX, "org", "user", LINE, INPUT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rewriteSoLineDemand).not.toHaveBeenCalled();
  });

  it("allocates through the shared allocator, carrying the order's own constraints", async () => {
    const deps = makeDeps();
    const out = await resolveSubstitution(deps, TX, "org", "user", LINE, INPUT);

    // D2 — the near-expiry tier and the customer shelf-life floor are forwarded,
    // which is the whole reason `resolvePickConstraints` is consulted here. The
    // source-text half of this is `pick-allocation-constraints.spec.ts`.
    expect(
      (deps.soCore.findAvailableLotForLine as unknown as jest.Mock).mock.calls[0],
    ).toEqual([
      "org",
      200,
      1,
      "5.0000",
      "FEFO",
      "BLOCK",
      { nearExpiryPolicy: "BLOCK", nearExpiryWindowDays: 30, minShelfLifeDays: 60 },
    ]);

    // The grain it returns is the SUBSTITUTE's real bin, which is the row the
    // projection credits and the row the new reservation stands at.
    expect(out.grain).toEqual({ locationId: 5, lotId: 77 });
    expect(rewriteSoLineDemand).toHaveBeenCalledTimes(1);
  });
});
