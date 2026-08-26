import type { Db } from "../../db/drizzle.types";
import { RecordLayoutsService } from "./record-layouts.service";

interface Recorded {
  wheres: unknown[];
  inserted: Record<string, unknown>[];
  conflictSets: Record<string, unknown>[];
  deletes: number;
}

function makeDb(rows: Record<string, unknown>[], recorded: Recorded): Db {
  const select = {
    from: () => select,
    where: (predicate: unknown) => {
      recorded.wheres.push(predicate);
      return select;
    },
    limit: async () => rows,
  };

  const insert = {
    values: (v: Record<string, unknown>) => {
      recorded.inserted.push(v);
      return insert;
    },
    onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
      recorded.conflictSets.push(set);
      return insert;
    },
    returning: async () => rows,
  };

  return {
    select: () => select,
    insert: () => insert,
    delete: () => ({
      where: (predicate: unknown) => {
        recorded.wheres.push(predicate);
        recorded.deletes += 1;
        return Promise.resolve();
      },
    }),
  } as unknown as Db;
}

const STORED = {
  layoutKey: "party",
  order: ["name", "email"],
  hidden: ["website"],
  groups: [{ title: "Contact", fields: ["email", "phone"] }],
  updatedAt: new Date("2026-08-26T10:00:00.000Z"),
};

describe("RecordLayoutsService.get", () => {
  let recorded: Recorded;
  beforeEach(() => {
    recorded = { wheres: [], inserted: [], conflictSets: [], deletes: 0 };
  });

  it("returns the tenant's arrangement", async () => {
    const service = new RecordLayoutsService(makeDb([STORED], recorded));
    const found = await service.get("org-1", "party");

    expect(found).toEqual({
      layoutKey: "party",
      order: ["name", "email"],
      hidden: ["website"],
      groups: [{ title: "Contact", fields: ["email", "phone"] }],
      updatedAt: "2026-08-26T10:00:00.000Z",
    });
  });

  it("returns null rather than throwing when nothing is arranged", async () => {
    // A tenant that has never arranged anything is the common case, and every
    // record surface reads this on load. Absent is a value.
    const service = new RecordLayoutsService(makeDb([], recorded));
    expect(await service.get("org-1", "party")).toBeNull();
  });

  it("omits the parts a tenant did not set, rather than sending nulls", async () => {
    const service = new RecordLayoutsService(
      makeDb([{ ...STORED, order: null, hidden: null, groups: null }], recorded),
    );
    const found = await service.get("org-1", "party");

    expect(found).toEqual({ layoutKey: "party", updatedAt: "2026-08-26T10:00:00.000Z" });
    expect(Object.keys(found ?? {})).not.toContain("order");
  });

  it("scopes the read to the organisation rather than trusting row-level security", async () => {
    const service = new RecordLayoutsService(makeDb([STORED], recorded));
    await service.get("org-1", "party");
    expect(recorded.wheres).toHaveLength(1);
  });
});

describe("RecordLayoutsService.save", () => {
  let recorded: Recorded;
  beforeEach(() => {
    recorded = { wheres: [], inserted: [], conflictSets: [], deletes: 0 };
  });

  it("upserts, because a tenant has exactly one arrangement per type", async () => {
    // Two rows would make the rendered layout depend on which the next read saw.
    const service = new RecordLayoutsService(makeDb([STORED], recorded));
    await service.save("org-1", "party", { order: ["name"] });

    expect(recorded.inserted[0]).toMatchObject({ organizationId: "org-1", layoutKey: "party" });
    expect(recorded.conflictSets).toHaveLength(1);
  });

  it("stores an absent part as null, not as an empty array", async () => {
    // An empty array would mean "arranged to have nothing", which reads the same
    // as the default and then needs special-casing at every render.
    const service = new RecordLayoutsService(makeDb([STORED], recorded));
    await service.save("org-1", "party", { order: ["name"] });

    expect(recorded.inserted[0]).toMatchObject({ hidden: null, groups: null });
  });

  it("moves updatedAt on conflict, so a stale reader can tell", async () => {
    const service = new RecordLayoutsService(makeDb([STORED], recorded));
    await service.save("org-1", "party", { hidden: ["website"] });
    expect(recorded.conflictSets[0]).toHaveProperty("updatedAt");
  });

  it("copies the arrays it is given rather than storing the caller's", async () => {
    const service = new RecordLayoutsService(makeDb([STORED], recorded));
    const order = ["name", "email"];
    await service.save("org-1", "party", { order });
    order.push("mutated");

    expect(recorded.inserted[0]?.order).toEqual(["name", "email"]);
  });
});

describe("RecordLayoutsService.reset", () => {
  it("deletes rather than storing an empty arrangement", async () => {
    const recorded: Recorded = { wheres: [], inserted: [], conflictSets: [], deletes: 0 };
    const service = new RecordLayoutsService(makeDb([], recorded));
    await service.reset("org-1", "party");

    expect(recorded.deletes).toBe(1);
    expect(recorded.wheres).toHaveLength(1);
  });
});
