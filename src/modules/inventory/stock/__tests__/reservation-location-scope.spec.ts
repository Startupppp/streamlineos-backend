import { NotFoundException } from "@nestjs/common";
import { InvStockReservationsService } from "../inv-stock-reservations.service";

/**
 * Stock could be reserved at a location in a building the caller holds nothing in.
 *
 * `input.locationId` came straight off the request body and nothing on this path
 * checked it. `assertLotChoiceAllowed` answers a lot-selection policy question,
 * and neither `ReservationService` nor the engine's `assertLocationsInScope`
 * sees this — reserving posts no movements.
 *
 * Quieter than moving somebody else's stock and worse in one respect: it makes
 * that quantity unavailable to the people who do hold the building, and nothing
 * in their view says who took it.
 */

type VisibilityMock = jest.Mock<Promise<void>, [string, string, number | null | undefined]>;

function serviceWith(assertLocationVisible: VisibilityMock): InvStockReservationsService {
  const stub = {} as never;
  const db = {
    transaction: jest.fn(async () => {
      throw new Error("the transaction must not be reached");
    }),
  } as never;
  return new InvStockReservationsService(
    db,
    stub,
    stub,
    stub,
    { assertLocationVisible } as never,
    stub,
    stub,
    stub,
  );
}

describe("reserving stock", () => {
  it("refuses a location the caller cannot see, before it looks anything up", async () => {
    /*
     * ORDER IS THE ASSERTION HERE. The db stub has only `transaction`, so any
     * query before the visibility check TypeErrors — which is exactly what my
     * first version did, because I had put the check after the orderable-variant
     * lookup. A caller who may not see the location should not cause a query on
     * its behalf, nor learn from a refusal'''s shape whether the variant is
     * orderable.
     */
    const assertLocationVisible: VisibilityMock = jest.fn(
      async (_orgId: string, _userId: string, _locationId: number | null | undefined) => {
        throw new NotFoundException("Not found");
      },
    );
    const service = serviceWith(assertLocationVisible);

    await expect(
      service.createReservation(
        "org-1",
        "keeper-1",
        { locationId: 77, productVariantId: 11, quantity: "5" } as never,
        "key-1",
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(assertLocationVisible).toHaveBeenCalledWith("org-1", "keeper-1", 77);
  });
});
