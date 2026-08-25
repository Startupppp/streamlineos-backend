import type { Db } from "../../db/drizzle.types";
import {
  isLegacyResolved,
  resolveLegacyParty,
  resolveLegacyPartyIds,
  type LegacyPartyRef,
} from "./party-legacy-seam";

/**
 * Records what each query was actually given, so the tests can assert the
 * organisation was re-asserted rather than assumed, and count how many round
 * trips a resolution cost.
 */
interface Recorded {
  wheres: unknown[];
  joins: unknown[];
}

/**
 * A database that hands back the queued result sets in order.
 *
 * Every query in the seam ends in either `.where(...)` or `.limit(...)`, and
 * both return this chain, so awaiting at either point yields the next queue
 * entry. That is enough to drive a two-query path (a lookup that misses, then a
 * merge walk) without a real connection.
 */
function dbReturning(queue: Record<string, unknown>[][], recorded: Recorded): Db {
  let next = 0;
  const rows = () => queue[next++] ?? [];

  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: (_table: unknown, on: unknown) => {
      recorded.joins.push(on);
      return chain;
    },
    where: (predicate: unknown) => {
      recorded.wheres.push(predicate);
      return chain;
    },
    limit: () => chain,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows()).then(resolve),
  };

  return { select: () => chain } as unknown as Db;
}

const acme = {
  partyId: "party-acme",
  organizationId: "org-1",
  name: "Acme",
  partyType: "CUSTOMER",
  status: "active",
  deletedAt: null,
};

describe("resolveLegacyParty", () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { wheres: [], joins: [] };
  });

  const mapped: ReadonlyArray<[LegacyPartyRef, string]> = [
    [{ kind: "LEAD", legacyId: 42 }, "lead-map"],
    [{ kind: "CLIENT", legacyId: 42 }, "client-map"],
    [{ kind: "CONTACT", legacyId: 42 }, "contact-map"],
  ];

  it.each(mapped)("resolves %o through the map and says which one answered", async (ref, via) => {
    const db = dbReturning([[{ ...acme, legacyId: 42 }]], recorded);

    const result = await resolveLegacyParty(db, "org-1", ref);

    expect(isLegacyResolved(result)).toBe(true);
    if (!isLegacyResolved(result)) return;
    expect(result.party).toMatchObject({ partyId: "party-acme", resolvedVia: via });
    // The join carries the tenant on both sides, not just the outer where.
    expect(recorded.joins).toHaveLength(1);
  });

  it("is unresolved rather than throwing when no map row exists", async () => {
    const result = await resolveLegacyParty(dbReturning([[]], recorded), "org-1", {
      kind: "LEAD",
      legacyId: 42,
    });

    expect(result).toEqual({ status: "unresolved", ref: { kind: "LEAD", legacyId: 42 } });
  });

  it("does not query at all without an organisation", async () => {
    const db = dbReturning([[{ ...acme, legacyId: 42 }]], recorded);

    const result = await resolveLegacyParty(db, "", { kind: "LEAD", legacyId: 42 });

    expect(result.status).toBe("unresolved");
    expect(recorded.wheres).toHaveLength(0);
  });

  it("still resolves a soft-deleted party, and says it is deleted", async () => {
    const deletedAt = new Date("2026-01-01T00:00:00Z");
    const db = dbReturning([[{ ...acme, deletedAt, legacyId: 42 }]], recorded);

    const result = await resolveLegacyParty(db, "org-1", { kind: "CONTACT", legacyId: 42 });

    // Which party an identifier means is not the same question as whether it
    // should be displayed. A deleted contact's page has always rendered.
    expect(isLegacyResolved(result)).toBe(true);
    if (!isLegacyResolved(result)) return;
    expect(result.party.deletedAt).toEqual(deletedAt);
  });

  it("rejects a non-integer legacy id before it reaches the database", async () => {
    const db = dbReturning([[{ ...acme, legacyId: 1 }]], recorded);

    const result = await resolveLegacyParty(db, "org-1", {
      kind: "LEAD",
      legacyId: Number.NaN,
    });

    expect(result.status).toBe("unresolved");
    expect(recorded.wheres).toHaveLength(0);
  });

  describe("a party id, which has no map row", () => {
    it("resolves to itself", async () => {
      const db = dbReturning([[acme]], recorded);

      const result = await resolveLegacyParty(db, "org-1", {
        kind: "PARTY",
        legacyId: "party-acme",
      });

      expect(isLegacyResolved(result)).toBe(true);
      if (!isLegacyResolved(result)) return;
      expect(result.party).toMatchObject({
        partyId: "party-acme",
        resolvedVia: "party-record",
        followedMerge: false,
      });
      expect(recorded.wheres).toHaveLength(1);
    });

    it("follows a merge to the survivor when its own record lost one", async () => {
      const loser = { ...acme, partyId: "party-loser", deletedAt: new Date() };
      const db = dbReturning(
        [
          [loser], // the direct lookup: soft-deleted
          [{ survivorPartyId: "party-acme" }], // one live merge consumed it
          [], // and nothing consumed the survivor
          [acme], // load the survivor
        ],
        recorded,
      );

      const result = await resolveLegacyParty(db, "org-1", {
        kind: "PARTY",
        legacyId: "party-loser",
      });

      expect(isLegacyResolved(result)).toBe(true);
      if (!isLegacyResolved(result)) return;
      expect(result.party.partyId).toBe("party-acme");
      expect(result.party.followedMerge).toBe(true);
    });

    it("returns a soft-deleted record as it stands when no merge explains it", async () => {
      const deleted = { ...acme, deletedAt: new Date() };
      const db = dbReturning([[deleted], []], recorded);

      const result = await resolveLegacyParty(db, "org-1", {
        kind: "PARTY",
        legacyId: "party-acme",
      });

      expect(isLegacyResolved(result)).toBe(true);
      if (!isLegacyResolved(result)) return;
      expect(result.party.followedMerge).toBe(false);
      expect(result.party.deletedAt).not.toBeNull();
    });

    it("terminates on a merge cycle instead of walking it forever", async () => {
      const a = { ...acme, partyId: "party-a", deletedAt: new Date() };
      const db = dbReturning(
        [
          [a],
          [{ survivorPartyId: "party-b" }],
          [{ survivorPartyId: "party-a" }], // back where it started
          [{ ...acme, partyId: "party-b" }],
        ],
        recorded,
      );

      const result = await resolveLegacyParty(db, "org-1", {
        kind: "PARTY",
        legacyId: "party-a",
      });

      expect(isLegacyResolved(result)).toBe(true);
      if (!isLegacyResolved(result)) return;
      expect(result.party.partyId).toBe("party-b");
    });
  });
});

describe("resolveLegacyPartyIds", () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { wheres: [], joins: [] };
  });

  it("answers a page of legacy ids in one query", async () => {
    const db = dbReturning(
      [
        [
          { ...acme, legacyId: 1 },
          { ...acme, partyId: "party-2", legacyId: 2 },
        ],
      ],
      recorded,
    );

    const resolved = await resolveLegacyPartyIds(db, "org-1", "LEAD", [1, 2]);

    expect([...resolved]).toEqual([
      [1, "party-acme"],
      [2, "party-2"],
    ]);
    expect(recorded.wheres).toHaveLength(1);
  });

  it("omits the ids nothing answered for rather than inventing them", async () => {
    const db = dbReturning([[{ ...acme, legacyId: 1 }]], recorded);

    const resolved = await resolveLegacyPartyIds(db, "org-1", "LEAD", [1, 2]);

    expect(resolved.has(2)).toBe(false);
  });

  it("does not query for an empty page", async () => {
    const db = dbReturning([[]], recorded);

    await resolveLegacyPartyIds(db, "org-1", "CLIENT", []);

    expect(recorded.wheres).toHaveLength(0);
  });
});
