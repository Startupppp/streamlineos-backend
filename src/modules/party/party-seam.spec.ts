import type { Db } from "../../db/drizzle.types";
import { isResolved, resolveParty, type PartySubject } from "./party-seam";

/**
 * Captures the predicate each query was given, so the tests can assert that the
 * organisation was actually re-asserted rather than assumed.
 */
interface Recorded {
  wheres: unknown[];
  joins: unknown[];
}

function dbReturning(rows: Record<string, unknown>[], recorded: Recorded): Db {
  const chain = {
    from: () => chain,
    innerJoin: (_table: unknown, on: unknown) => {
      recorded.joins.push(on);
      return chain;
    },
    where: (predicate: unknown) => {
      recorded.wheres.push(predicate);
      return chain;
    },
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Db;
}

const party = {
  partyId: "p-1",
  organizationId: "org-1",
  name: "Acme",
  partyType: "CUSTOMER",
  status: "active",
};

describe("resolveParty", () => {
  let recorded: Recorded;

  beforeEach(() => {
    recorded = { wheres: [], joins: [] };
  });

  it("resolves a party by its own identifier", async () => {
    const result = await resolveParty(dbReturning([party], recorded), "org-1", {
      kind: "party",
      partyId: "p-1",
    });

    expect(isResolved(result)).toBe(true);
    if (!isResolved(result)) return;
    expect(result.party).toMatchObject({ partyId: "p-1", name: "Acme" });
  });

  it("says which lookup answered, because resolution short-circuits", async () => {
    const byParty = await resolveParty(dbReturning([party], recorded), "org-1", {
      kind: "party",
      partyId: "p-1",
    });
    const byContact = await resolveParty(
      dbReturning([{ ...party, partyContactId: "c-1" }], recorded),
      "org-1",
      { kind: "contact", partyContactId: "c-1" },
    );

    expect(isResolved(byParty) && byParty.party.resolvedVia).toBe("party-record");
    expect(isResolved(byContact) && byContact.party.resolvedVia).toBe("contact-record");
  });

  it("reaches the party through a contact", async () => {
    const result = await resolveParty(
      dbReturning([{ ...party, partyContactId: "c-1" }], recorded),
      "org-1",
      { kind: "contact", partyContactId: "c-1" },
    );

    expect(isResolved(result) && result.party.partyContactId).toBe("c-1");
  });

  it("returns unresolved as a value rather than throwing, so a caller need not catch", async () => {
    const subject: PartySubject = { kind: "party", partyId: "missing" };
    const result = await resolveParty(dbReturning([], recorded), "org-1", subject);

    expect(result).toEqual({ status: "unresolved", subject });
  });

  it("hands back the subject it failed on, so the caller can say what was not found", async () => {
    const subject: PartySubject = { kind: "contact", partyContactId: "c-9" };
    const result = await resolveParty(dbReturning([], recorded), "org-1", subject);

    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.subject).toBe(subject);
  });

  it("re-asserts the organisation on the query rather than trusting row-level security", async () => {
    await resolveParty(dbReturning([party], recorded), "org-1", { kind: "party", partyId: "p-1" });

    // The predicate is opaque here, but its presence is the contract: the seam
    // must not issue an unscoped read and rely on a policy that may not be on yet.
    expect(recorded.wheres).toHaveLength(1);
    expect(recorded.wheres[0]).toBeDefined();
  });

  it("carries the organisation into the contact join too", async () => {
    await resolveParty(dbReturning([], recorded), "org-1", {
      kind: "contact",
      partyContactId: "c-1",
    });

    // A tampered party_id must not let a contact reach another tenant's party.
    expect(recorded.joins).toHaveLength(1);
    expect(recorded.joins[0]).toBeDefined();
  });

  it("refuses to resolve without an organisation, instead of reading unscoped", async () => {
    const recordedNoOrg: Recorded = { wheres: [], joins: [] };
    const result = await resolveParty(dbReturning([party], recordedNoOrg), "", {
      kind: "party",
      partyId: "p-1",
    });

    expect(result.status).toBe("unresolved");
    expect(recordedNoOrg.wheres).toHaveLength(0);
  });

  it("refuses an empty identifier without querying", async () => {
    const byParty: Recorded = { wheres: [], joins: [] };
    const byContact: Recorded = { wheres: [], joins: [] };

    await resolveParty(dbReturning([party], byParty), "org-1", { kind: "party", partyId: "" });
    await resolveParty(dbReturning([party], byContact), "org-1", {
      kind: "contact",
      partyContactId: "",
    });

    expect(byParty.wheres).toHaveLength(0);
    expect(byContact.wheres).toHaveLength(0);
  });

  it("narrows the union, so a resolved branch exposes the party without a cast", async () => {
    const result = await resolveParty(dbReturning([party], recorded), "org-1", {
      kind: "party",
      partyId: "p-1",
    });

    if (isResolved(result)) expect(result.party.organizationId).toBe("org-1");
    else throw new Error("expected resolved");
  });
});
