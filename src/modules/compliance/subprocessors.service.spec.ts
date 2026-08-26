import type { Db } from "../../db/drizzle.types";
import { SubprocessorsService } from "./subprocessors.service";

interface Recorded {
  wheres: unknown[];
  inserted: Record<string, unknown>[];
  conflictSets: Record<string, unknown>[];
  updates: Record<string, unknown>[];
}

function makeDb(rows: Record<string, unknown>[], recorded: Recorded): Db {
  const select = {
    from: () => select,
    where: (predicate: unknown) => {
      recorded.wheres.push(predicate);
      return select;
    },
    orderBy: async () => rows,
  };

  const insert = {
    values: (v: Record<string, unknown>) => {
      recorded.inserted.push(v);
      return insert;
    },
    onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
      recorded.conflictSets.push(set);
      return Promise.resolve();
    },
  };

  return {
    select: () => select,
    insert: () => insert,
    update: () => ({
      set: (v: Record<string, unknown>) => {
        recorded.updates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  } as unknown as Db;
}

const ROW = {
  name: "Neon",
  purpose: "Managed Postgres hosting",
  location: "Ireland",
  url: "https://neon.tech/privacy",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  retiredAt: null,
};

const RETIRED = { ...ROW, name: "Old Vendor", retiredAt: new Date("2026-06-01T00:00:00.000Z") };

function fresh(): Recorded {
  return { wheres: [], inserted: [], conflictSets: [], updates: [] };
}

describe("the register", () => {
  it("reads as dates a customer's counsel can act on", async () => {
    const service = new SubprocessorsService(makeDb([ROW], fresh()));
    const [entry] = await service.list();

    expect(entry).toEqual({
      name: "Neon",
      purpose: "Managed Postgres hosting",
      location: "Ireland",
      url: "https://neon.tech/privacy",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      retiredAt: null,
    });
  });

  it("includes retired processors by default", async () => {
    // A reviewer checking a past period needs to know who processed their data
    // *then*. A register that silently drops a departed processor cannot answer
    // the question it exists to answer.
    const recorded = fresh();
    const service = new SubprocessorsService(makeDb([ROW, RETIRED], recorded));

    const entries = await service.list();

    expect(entries).toHaveLength(2);
    expect(recorded.wheres[0]).toBeUndefined();
  });

  it("can narrow to the current set when a caller asks", async () => {
    const recorded = fresh();
    const service = new SubprocessorsService(makeDb([ROW], recorded));

    await service.list({ includeRetired: false });

    expect(recorded.wheres[0]).toBeDefined();
  });

  it("reports a retirement date rather than dropping the row", async () => {
    const service = new SubprocessorsService(makeDb([RETIRED], fresh()));
    const [entry] = await service.list();

    expect(entry?.retiredAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("subscribing", () => {
  it("normalises the address, so one person is not two subscribers", async () => {
    const recorded = fresh();
    const service = new SubprocessorsService(makeDb([], recorded));

    await service.subscribe("  Counsel@Example.COM ");

    expect(recorded.inserted[0]).toMatchObject({ email: "counsel@example.com" });
  });

  it("re-subscribing clears a previous unsubscribe rather than adding a row", async () => {
    // Two rows for one address is how unsubscribing stops working: the filter
    // finds one row cleared and another not, and keeps sending.
    const recorded = fresh();
    const service = new SubprocessorsService(makeDb([], recorded));

    await service.subscribe("counsel@example.com");

    expect(recorded.conflictSets[0]).toEqual({ unsubscribedAt: null });
  });

  it("unsubscribing stamps rather than deletes, so re-subscribing is one act", async () => {
    const recorded = fresh();
    const service = new SubprocessorsService(makeDb([], recorded));

    await service.unsubscribe("Counsel@Example.com");

    expect(recorded.updates[0]).toHaveProperty("unsubscribedAt");
    expect(recorded.updates[0]?.unsubscribedAt).toBeInstanceOf(Date);
  });

  it("lists only people who still want telling", async () => {
    const recorded = fresh();
    const service = new SubprocessorsService(
      makeDb([{ email: "a@example.com" }, { email: "b@example.com" }], recorded),
    );

    expect(await service.activeSubscribers()).toEqual(["a@example.com", "b@example.com"]);
    expect(recorded.wheres).toHaveLength(1);
  });
});

describe("changesSince", () => {
  it("reports retirements as well as additions", async () => {
    // A notification that only reported additions would let a customer believe a
    // departed processor still holds their data.
    const service = new SubprocessorsService(makeDb([ROW, RETIRED], fresh()));
    const changes = await service.changesSince(new Date("2025-12-01T00:00:00.000Z"));

    expect(changes.map((c) => c.name).sort()).toEqual(["Neon", "Old Vendor"]);
  });

  it("returns nothing when nothing changed", async () => {
    const service = new SubprocessorsService(makeDb([], fresh()));
    expect(await service.changesSince(new Date())).toEqual([]);
  });
});
