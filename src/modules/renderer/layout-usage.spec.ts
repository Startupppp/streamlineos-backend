import type { Db } from "../../db/drizzle.types";
import { layoutUsage } from "./layout-usage";

function dbReturning(rows: Record<string, unknown>[], seen: string[]): Db {
  return {
    execute: async (query: unknown) => {
      seen.push(String(query));
      return rows;
    },
  } as unknown as Db;
}

describe("layoutUsage", () => {
  it("counts the optional columns of a party, keyed as the layout names them", async () => {
    // The database is snake_case and the layout description is camelCase; the
    // caller addresses fields by the description's names.
    const usage = await layoutUsage(
      dbReturning([{ sample: 100, website: 12, tax_number: 90, legal_name: 4 }], []),
      "org-1",
      "party",
    );

    expect(usage.sample).toBe(100);
    expect(usage.filled.website).toBe(12);
    expect(usage.filled.taxNumber).toBe(90);
    expect(usage.filled.legalName).toBe(4);
  });

  it("reads a subject type's own declared fields", async () => {
    const usage = await layoutUsage(
      dbReturning([{ sample: 40, filled: { bedrooms: 38, floorPlan: 2 } }], []),
      "org-1",
      "subject:property",
    );

    expect(usage).toEqual({ sample: 40, filled: { bedrooms: 38, floorPlan: 2 } });
  });

  it("returns an empty proposal for a layout it does not know, without querying", async () => {
    // Thirty-nine layouts are registered and this knows two. A backend map of
    // all of them would be a second copy of the frontend registry, drifting
    // silently -- and a wrong proposal tells an administrator to hide a field
    // their team uses, which is worse than no proposal.
    const seen: string[] = [];
    const usage = await layoutUsage(dbReturning([], seen), "org-1", "deal");

    expect(usage).toEqual({ sample: 0, filled: {} });
    expect(seen).toHaveLength(0);
  });

  it("does not mistake a crafted key for a subject type", async () => {
    const seen: string[] = [];
    for (const key of ["subject:", "subject:Property", "subject:a:b", "subjects:property"])
      expect(await layoutUsage(dbReturning([], seen), "org-1", key)).toEqual({
        sample: 0,
        filled: {},
      });

    expect(seen).toHaveLength(0);
  });

  it("survives a query that returns nothing", async () => {
    expect(await layoutUsage(dbReturning([], []), "org-1", "party")).toEqual({
      sample: 0,
      filled: {},
    });
  });

  it("treats a missing count as zero rather than NaN", async () => {
    const usage = await layoutUsage(dbReturning([{ sample: 10 }], []), "org-1", "party");
    expect(usage.filled.website).toBe(0);
    expect(Number.isNaN(usage.filled.website)).toBe(false);
  });
});
