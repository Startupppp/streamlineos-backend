import type { Db } from "../../db/drizzle.types";
import {
  absorbEmployerColumn,
  crmOrgIdsOfParties,
  employerLegacyIds,
  partyIdsOfCrmOrgs,
} from "./party-legacy-employer";

/**
 * The one conversion in the mirror, and the only one the offline diff cannot
 * check.
 *
 * Every other mirrored column is a copy: `derive` produces it, `diff` re-runs
 * `derive` and compares. `contacts.organization_id` is an integer company id and
 * `employer_party_id` is a party id, so settling them needs `crm_org_party_map`
 * — a query, which a `MirrorCell` deliberately is not. These tests are what
 * stands in for the round-trip property the field map gets for free.
 *
 * The queries themselves are faked. What is worth asserting here is the
 * decisions: which id wins when a party answers to several, and what each of
 * `undefined`, `null` and "a company that is not here" means.
 */

interface Fake {
  db: Db;
  queries: number;
}

function fakeDb(rows: unknown[]): Fake {
  const fake = { queries: 0 } as Fake;
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => {
    fake.queries += 1;
    return Promise.resolve(rows);
  };
  fake.db = { select: () => chain } as unknown as Db;
  return fake;
}

const ORG = "org-1";

describe("party-legacy-employer — a party id and a company id are the same company", () => {
  it("picks the lowest company id when a party answers to several", async () => {
    /*
     * A merge re-points the loser's map row onto the survivor, so one party
     * legitimately answers to several company ids. Any of them is a correct
     * answer to "which company is this"; picking DETERMINISTICALLY is what stops
     * the mirror flapping between two of them on consecutive writes and
     * reporting itself as divergent forever. `findEmployerDisagreements` uses
     * `MIN(...)` for exactly this reason, and the two must agree.
     */
    const fake = fakeDb([
      { partyId: "party-acme", crmOrganizationId: 9 },
      { partyId: "party-acme", crmOrganizationId: 4 },
    ]);

    const resolved = await crmOrgIdsOfParties(fake.db, ORG, ["party-acme"]);

    expect(resolved.get("party-acme")).toBe(4);
  });

  it("asks nothing when there is nothing to ask about", async () => {
    const fake = fakeDb([]);

    expect(await crmOrgIdsOfParties(fake.db, ORG, [])).toEqual(new Map());
    expect(await partyIdsOfCrmOrgs(fake.db, ORG, [])).toEqual(new Map());
    // A tenantless call resolves to nothing rather than to everything.
    expect(await crmOrgIdsOfParties(fake.db, "", ["party-acme"])).toEqual(new Map());
    expect(fake.queries).toBe(0);
  });

  it("drops the parties with no employer before querying", async () => {
    const fake = fakeDb([]);

    await employerLegacyIds(fake.db, ORG, [null, null]);

    expect(fake.queries).toBe(0);
  });

  it("ignores a company id that is not an integer", async () => {
    const fake = fakeDb([]);

    await partyIdsOfCrmOrgs(fake.db, ORG, [Number.NaN]);

    expect(fake.queries).toBe(0);
  });
});

describe("party-legacy-employer — absorbing the legacy column", () => {
  it("leaves the employer alone when the patch never mentioned it", async () => {
    const fake = fakeDb([]);

    // `undefined` in, nothing out. A patch that says nothing about the employer
    // must not clear one, which is the difference between editing a phone number
    // and firing somebody.
    expect(await absorbEmployerColumn(fake.db, ORG, undefined)).toEqual({});
    expect(fake.queries).toBe(0);
  });

  it("clears the employer when the patch says null", async () => {
    const fake = fakeDb([]);

    expect(await absorbEmployerColumn(fake.db, ORG, null)).toEqual({ employerPartyId: null });
    expect(fake.queries).toBe(0);
  });

  it("translates a company id into the party it became", async () => {
    const fake = fakeDb([{ crmOrganizationId: 7, partyId: "party-acme" }]);

    expect(await absorbEmployerColumn(fake.db, ORG, 7)).toEqual({
      employerPartyId: "party-acme",
    });
  });

  it("refuses a company it cannot find rather than silently clearing the employer", async () => {
    const fake = fakeDb([]);

    // "The company you named does not exist here" and "this person has no
    // employer" are different answers, and only one of them is a request. A
    // company id from another tenant lands here too, because the query asserts
    // the tenant rather than trusting the caller.
    await expect(absorbEmployerColumn(fake.db, ORG, 7)).rejects.toThrow(/has no party/);
  });
});
