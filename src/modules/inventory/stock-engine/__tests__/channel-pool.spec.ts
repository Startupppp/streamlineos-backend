import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { ChannelPoolService } from "../channel-pool.service";
import { channelReservedQtySql } from "../available-sql";
import { netAvailableQty } from "../decimal";

const render = (sql: ReturnType<typeof channelReservedQtySql>) => new PgDialect().sqlToQuery(sql);

describe("NEO-1 — netAvailableQty", () => {
  it("subtracts what other channels hold", () => {
    expect(netAvailableQty("10.0000", "6.0000")).toBe("4.0000");
  });

  it("treats an absent claim as nothing claimed", () => {
    expect(netAvailableQty("10.0000", null)).toBe("10.0000");
    expect(netAvailableQty("10.0000", undefined)).toBe("10.0000");
  });

  it("clamps at zero rather than reporting negative availability", () => {
    // A pool larger than the stock behind it is an over-promise somebody has to
    // unwind. It is not "-2 available", which is a number no caller can act on.
    expect(netAvailableQty("10.0000", "12.0000")).toBe("0.0000");
  });
});

describe("NEO-1 — channelReservedQtySql", () => {
  it("counts every pool for the variant when no warehouse is named", () => {
    const q = render(channelReservedQtySql({ orgId: "org1", productVariantId: 7 }));
    expect(q.sql).toContain("inv_channel_pools");
    expect(q.sql).not.toContain("cp.warehouse_id =");
    expect(q.params).toEqual(["org1", 7]);
  });

  it("counts pinned and unpinned pools when a warehouse is named", () => {
    // The over-subtracting rule from `channel-pools.ts`, made visible: an
    // org-wide claim reduces every warehouse's answer, deliberately.
    const q = render(channelReservedQtySql({ orgId: "org1", productVariantId: 7, warehouseId: 3 }));
    expect(q.sql).toContain("cp.warehouse_id IS NULL OR cp.warehouse_id =");
  });

  it("excludes the asking channel's own claim", () => {
    const q = render(
      channelReservedQtySql({ orgId: "org1", productVariantId: 7, excludeChannelId: 9 }),
    );
    expect(q.sql).toContain("cp.channel_id <>");
    expect(q.params).toContain(9);
  });
});

interface Row {
  [key: string]: unknown;
}

/**
 * A stand-in for the raw reads `availability` and `assertPromisable` make, keyed
 * by a fragment of each statement. Matching on the statement rather than on call
 * order means a reordering inside the service does not silently feed the wrong
 * answer to the wrong query, which is exactly the failure a positional mock hides.
 *
 * The fragments are the result *aliases*, not table names: `availableQtySumSql`
 * embeds its own `EXISTS (SELECT 1 FROM inv_locations …)` sellability gate, so
 * matching on `EXISTS` or on `inv_locations` answers the availability query with
 * the pool probe's row and every figure reads as zero.
 */
function executor(answers: Array<[string, Row[]]>) {
  const execute = jest.fn(async (query: unknown) => {
    const text = JSON.stringify(query);
    for (const [fragment, rows] of answers) {
      if (text.includes(fragment)) return rows;
    }
    return [];
  });
  return { execute };
}

function service(overrides: Partial<{ audit: unknown; scope: unknown; db: unknown }> = {}) {
  return new ChannelPoolService(
    (overrides.db ?? {}) as never,
    (overrides.audit ?? { insert: jest.fn() }) as never,
    (overrides.scope ?? { assertWarehouseVisible: jest.fn(), resolve: jest.fn() }) as never,
  );
}

describe("NEO-1 — availability", () => {
  it("splits other channels' claims from the asking channel's own", async () => {
    const tx = executor([
      ["AS available", [{ available: "10.0000" }]],
      ["AS others", [{ others: "6.0000", mine: "2.0000" }]],
    ]);

    const result = await service().availability(tx as never, "org1", {
      productVariantId: 7,
      warehouseId: 3,
      forChannelId: 9,
    });

    expect(result.available).toBe("10.0000");
    expect(result.reservedByOthers).toBe("6.0000");
    expect(result.reservedForChannel).toBe("2.0000");
    expect(result.netAvailable).toBe("4.0000");
  });
});

describe("NEO-1 — assertPromisable", () => {
  it("costs nothing on a variant no channel has claimed", async () => {
    // The overwhelmingly common case. If this ever stops short-circuiting, every
    // reservation in the product pays for two aggregates.
    const tx = executor([["AS present", [{ present: false }]]]);
    await service().assertPromisable(tx as never, "org1", {
      productVariantId: 7,
      warehouseId: 3,
      qty: "5.0000",
    });
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a direct sale of 5 when 6 of 10 are reserved to a channel", async () => {
    const tx = executor([
      ["AS present", [{ present: true }]],
      ["AS available", [{ available: "10.0000" }]],
      ["AS others", [{ others: "6.0000", mine: "0" }]],
    ]);

    await expect(
      service().assertPromisable(tx as never, "org1", {
        productVariantId: 7,
        warehouseId: 3,
        qty: "5.0000",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("lets the owning channel take the units it is holding", async () => {
    // Same stock, same pool — the only difference is that the promise names the
    // channel, so the claim is its own and does not count against it.
    const tx = executor([
      ["AS present", [{ present: true }]],
      ["AS available", [{ available: "10.0000" }]],
      ["AS others", [{ others: "0", mine: "6.0000" }]],
    ]);

    await expect(
      service().assertPromisable(tx as never, "org1", {
        productVariantId: 7,
        warehouseId: 3,
        qty: "6.0000",
        forChannelId: 9,
      }),
    ).resolves.toBeUndefined();
  });

  it("holds even where backorders are allowed", async () => {
    // Backorders mean "you may promise stock you have not received". They have
    // never meant "you may promise the same unit twice", and the gate is placed
    // after the backorder branch in `ReservationService` for that reason.
    const tx = executor([
      ["AS present", [{ present: true }]],
      ["AS available", [{ available: "0" }]],
      ["AS others", [{ others: "6.0000", mine: "0" }]],
    ]);

    await expect(
      service().assertPromisable(tx as never, "org1", {
        productVariantId: 7,
        warehouseId: 3,
        qty: "1.0000",
      }),
    ).rejects.toThrow(/may be promised here/);
  });
});
