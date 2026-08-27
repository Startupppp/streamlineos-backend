import type { Db } from "../../db/drizzle.types";
import { businessParties, crmOrgPartyMap, partyRoles } from "../../db/schema/party";
import { ORGANISATION_MIRROR, type PartyRow } from "./party-legacy-mirror";
import {
  createMirroredOrganization,
  softDeleteMirroredOrganizations,
  updateMirroredOrganization,
  updateMirroredOrganizations,
} from "./party-legacy-orgs";

/**
 * What the `crm_organizations` writers hand back, now that there is no such table.
 *
 * Ticket 08 drops it, so the assertions here are about the **returned row** and
 * about which statements ran — not about what was inserted, because nothing is
 * inserted into a company table any more. That is the stronger of the two claims:
 * every consumer of these functions reads the returned row, and it is where an
 * echoed caller value or a dropped legacy-owned column would show up.
 *
 * The fake records the statement stream and which savepoint each ran in, so the
 * ordering claim — Party first, everything else derived from what it became —
 * survives without a database. `party-legacy-writer.db.spec.ts` is where a real
 * ROLLBACK TO SAVEPOINT is proved; this file deliberately does not pretend to.
 */

interface Statement {
  kind: "select" | "insert" | "update";
  table: unknown;
  values: Record<string, unknown>[];
  set: Record<string, unknown> | null;
  /** 0 is the caller's own transaction; anything else is a savepoint. */
  savepoint: number;
}

const PARTY: PartyRow = {
  partyId: "party-1",
  organizationId: "org-1",
  partyType: "CUSTOMER",
  name: "Northwind Traders",
  legalName: null,
  displayName: null,
  taxNumber: null,
  website: "https://northwind.example",
  email: null,
  phone: null,
  status: "active",
  customFields: null,
  notes: "Renews in March.",
  jobTitle: null,
  department: null,
  companyName: null,
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: "https://linkedin.example/northwind",
  socialProfiles: null,
  city: null,
  state: null,
  lifecycleStage: "QUALIFIED",
  priority: "HOT",
  qualificationScore: 0,
  convertedAt: null,
  lostReason: null,
  slaDueAt: null,
  nextFollowUpAt: null,
  followUpNotes: null,
  acquisitionSource: null,
  acquisitionSubSource: null,
  acquisitionCampaignId: null,
  acquisitionContext: null,
  referredBy: null,
  ownerUserId: null,
  assignedByUserId: null,
  assignedAt: null,
  verifiedByUserId: null,
  statedBudget: null,
  expectedValue: null,
  lifetimeValue: null,
  healthScore: 71,
  healthStatus: null,
  healthCheckedAt: null,
  churnRiskScore: null,
  churnRiskReasoning: null,
  tags: [],
  partyKind: "ORGANISATION",
  employerPartyId: null,
  convertedFromPartyId: null,
  parentPartyId: null,
  primaryDealId: null,
  domain: "northwind.example",
  industry: "Wholesale",
  companySize: "51-200",
  description: "Importers of speciality goods.",
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

type Answer = (statement: Statement) => unknown;

class FakeDb {
  readonly statements: Statement[] = [];
  private nextSavepoint = 1;

  constructor(private readonly answer: Answer) {}

  get db(): Db {
    return this.handle(0) as unknown as Db;
  }

  trace(): string[] {
    return this.statements.map((s) => `${s.kind}:${tableName(s.table)}@${String(s.savepoint)}`);
  }

  of(kind: Statement["kind"], table: unknown): Statement[] {
    return this.statements.filter((s) => s.kind === kind && s.table === table);
  }

  private handle(savepoint: number): Record<string, unknown> {
    return {
      select: () => this.builder(savepoint, "select"),
      insert: (table: unknown) => this.builder(savepoint, "insert", table),
      update: (table: unknown) => this.builder(savepoint, "update", table),
      transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
        fn(this.handle(this.nextSavepoint++)),
    };
  }

  private builder(savepoint: number, kind: Statement["kind"], table?: unknown) {
    const statement: Statement = { kind, table, values: [], set: null, savepoint };
    const self: Record<string, unknown> = {
      from: (source: unknown) => {
        statement.table = source;
        return self;
      },
      set: (payload: Record<string, unknown>) => {
        statement.set = payload;
        return self;
      },
      values: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        statement.values = Array.isArray(payload) ? payload : [payload];
        return self;
      },
      where: () => self,
      innerJoin: () => self,
      orderBy: () => self,
      limit: () => self,
      for: () => self,
      returning: () => self,
      onConflictDoNothing: () => self,
      then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
        Promise.resolve()
          .then(() => {
            this.statements.push(statement);
            return this.answer(statement);
          })
          .then(resolve, reject),
    };
    return self;
  }
}

/**
 * `crm_organizations` is deliberately not named here.
 *
 * Naming it would mean importing the table, which would put this spec on
 * `legacy-reader-ratchet.spec.ts`'s register of files that still read the tables
 * ticket 08 removes — a file that reads nothing landing on the debt register is
 * exactly the rot that register guards against. It shows up as `other`, and the
 * traces below are asserted with exact equality, so a company write reappearing
 * fails them either way.
 */
function tableName(table: unknown): string {
  if (table === businessParties) return "party";
  if (table === crmOrgPartyMap) return "orgMap";
  if (table === partyRoles) return "roles";
  return "other";
}

/**
 * The default world: one company, id 7, mapped to one party.
 *
 * An `update` on `business_parties` answers with the party the patch produced
 * rather than with the party it started as, because that is what `RETURNING`
 * does and because every row these writers hand back is derived from what the
 * party *became*. A fake that answered with the old row would let a writer that
 * ignores its own update look correct.
 */
function world(overrides: Partial<Record<string, unknown[]>> = {}): Answer {
  return (statement) => {
    if (statement.table === businessParties) {
      if (statement.kind === "update")
        return (overrides.parties ?? [PARTY]).map((party) => ({
          ...(party as PartyRow),
          ...statement.set,
        }));
      return overrides.parties ?? [PARTY];
    }
    /**
     * The map mints the identifier now.
     *
     * Ticket 08: `crm_org_party_map.crm_organization_id` defaults from the
     * sequence `crm_organizations` used to own (0277), so an insert that omits it
     * gets one back. The fake has to answer the same way or the writer cannot
     * tell what the record is called.
     */
    if (statement.table === crmOrgPartyMap && statement.kind === "insert")
      return overrides.orgMapInsert ?? [{ id: 7, crmOrganizationId: 7 }];
    if (statement.table === crmOrgPartyMap)
      return overrides.orgMap ?? [{ crmOrganizationId: 7, partyId: "party-1" }];
    return [];
  };
}

describe("party-legacy-orgs — the company row is assembled, not stored", () => {
  it("creates the party, takes its values, then mints the identifier from the map", async () => {
    const fake = new FakeDb(world());

    await createMirroredOrganization(fake.db, "org-1", {
      orgId: "org-1",
      name: "Northwind Traders",
    });

    expect(fake.trace()).toEqual([
      // The bare party, then the values it takes, then the map row that names it.
      //
      // The `insert:crm_organizations` that used to sit third is gone: the row it
      // wrote was already derived from the party, and the table's only unique
      // contribution was the serial, which `crm_org_party_map` mints now.
      "insert:party@1",
      "update:party@1",
      "insert:orgMap@1",
    ]);
    // A company gets no `party_roles` row -- `crm_organizations` records that a
    // company exists, not a relationship we have with it. `grantRole` is still
    // called, so the decision stays in `ROLE_FOR_KIND` rather than in an omission.
    expect(fake.of("insert", partyRoles)).toHaveLength(0);
  });

  it("returns what the party became, not what the caller asked for", async () => {
    const fake = new FakeDb((statement) => {
      /*
       * The row the database hands back is not the patch that was sent: a
       * default, an `$onUpdate`, or another writer in the same transaction has a
       * say. The company row is derived from the party, so the party as stored
       * is what must come back -- an assembly that echoed the caller's values
       * would report Aerospace here and disagree with Party forever.
       */
      if (statement.table === businessParties && statement.kind === "update")
        return [{ ...PARTY, ...statement.set, industry: "Wholesale", healthScore: 71 }];
      return world()(statement);
    });

    const company = await createMirroredOrganization(fake.db, "org-1", {
      orgId: "org-1",
      name: "Northwind Traders",
      industry: "Aerospace",
      healthScore: 3,
    });

    expect(company).toMatchObject(ORGANISATION_MIRROR.derive(PARTY));
    expect(company.industry).toBe("Wholesale");
    expect(company.healthScore).toBe(71);
    expect(company.id).toBe(7);
    expect(company.orgId).toBe("org-1");
    // Both timestamps come from the party; the table that used to stamp them is
    // gone, and 0241 carried the legacy values onto the party when it ran.
    expect(company.createdAt).toEqual(PARTY.createdAt);
    expect(company.updatedAt).toEqual(PARTY.updatedAt);
  });

  it("keeps the merge pointer null rather than absent", async () => {
    const fake = new FakeDb(world());

    const company = await createMirroredOrganization(fake.db, "org-1", {
      orgId: "org-1",
      name: "Northwind Traders",
    });

    // `merged_into_id` is legacy-owned and nothing writes it any more --
    // `PartyMergeService` re-points the map row instead. A consumer reading it
    // must still get the null it always got, not `undefined`.
    expect(company.mergedIntoId).toBeNull();
    expect("mergedIntoId" in company).toBe(true);
  });

  it("resolves the hierarchy across id spaces, both ways", async () => {
    const fake = new FakeDb(
      world({
        orgMap: [
          { crmOrganizationId: 4, partyId: "party-parent" },
          { crmOrganizationId: 7, partyId: "party-1" },
        ],
        parties: [{ ...PARTY, parentPartyId: "party-parent" }],
      }),
    );

    const company = await createMirroredOrganization(fake.db, "org-1", {
      orgId: "org-1",
      name: "Northwind Traders",
      parentId: 4,
    });

    // In as an integer company id, absorbed to `parent_party_id` on the party,
    // and back out as the integer the caller speaks. `parent_id` is the one
    // column on this table that a `MirrorCell` cannot carry, because translating
    // it needs `crm_org_party_map` and therefore a query.
    expect(fake.of("update", businessParties)[0]?.set?.parentPartyId).toBe("party-parent");
    expect(company.parentId).toBe(4);
  });

  it("updates the party and derives the answer from what it became", async () => {
    const fake = new FakeDb(world());

    const updated = await updateMirroredOrganization(fake.db, "org-1", 7, {
      notes: "Renewed for another year.",
    });

    expect(fake.trace()).toEqual([
      "select:orgMap@1",
      "select:party@1",
      "update:party@1",
      // No `update:crm_organizations` follows it. There is nothing left to keep
      // in step, which is the whole point of the contract step.
    ]);
    expect(fake.of("update", businessParties)[0]?.set).toEqual({
      notes: "Renewed for another year.",
    });
    expect(updated?.notes).toBe("Renewed for another year.");
    expect(updated?.id).toBe(7);
    // The rest of the row is the whole derivation, not just the field that
    // changed, so a column that drifted for any other reason is corrected too.
    expect(updated?.domain).toBe("northwind.example");
  });

  it("keeps a bulk update to a fixed number of statements", async () => {
    const fake = new FakeDb(
      world({
        orgMap: [
          { crmOrganizationId: 7, partyId: "party-1" },
          { crmOrganizationId: 8, partyId: "party-2" },
        ],
        parties: [PARTY, { ...PARTY, partyId: "party-2" }],
      }),
    );

    const updated = await updateMirroredOrganizations(fake.db, "org-1", [7, 8], {
      industry: "Logistics",
    });

    // Deriving per row is what keeps the answer correct; grouping identical
    // payloads is what stops a bulk operation costing a statement per record.
    expect(fake.of("select", businessParties)).toHaveLength(1);
    expect(fake.of("update", businessParties)).toHaveLength(1);
    expect(updated.map((row) => row.id)).toEqual([7, 8]);
    expect(updated.every((row) => row.industry === "Logistics")).toBe(true);
  });

  it("skips an id that is in neither the map nor the legacy table", async () => {
    const fake = new FakeDb(world({ orgMap: [] }));

    const updated = await updateMirroredOrganizations(fake.db, "org-1", [999], { notes: "x" });

    // Adoption is offered and finds nothing, so the id names nothing and is
    // skipped rather than conjured. That is also what happens once the table is
    // dropped and adoption goes with it, which is why nothing else here depends
    // on the adoption read.
    expect(updated).toEqual([]);
    expect(fake.of("update", businessParties)).toHaveLength(0);
  });

  it("checks the party is live before deleting, so a delete does not move the timestamp", async () => {
    const fake = new FakeDb(world({ orgMap: [] }));

    const removed = await softDeleteMirroredOrganizations(fake.db, "org-1", [7]);

    // Liveness is asked of `business_parties.deleted_at` now -- the column the
    // legacy one was derived from -- and nothing came back, so nothing was
    // written at all.
    expect(removed).toEqual([]);
    expect(fake.trace()).toEqual(["select:orgMap@0"]);
  });

  it("soft-deletes the party and leaves the map row standing", async () => {
    const fake = new FakeDb(world());

    const [removed] = await softDeleteMirroredOrganizations(fake.db, "org-1", [7]);

    expect(fake.trace()).toEqual([
      "select:orgMap@0",
      "select:orgMap@1",
      "select:party@1",
      "update:party@1",
    ]);
    expect(fake.of("update", businessParties)[0]?.set?.deletedAt).toBeInstanceOf(Date);
    // The row still answers to id 7 afterwards. The map row is the record of what
    // this company is *called*; deleting it would orphan an identifier that is
    // still in URLs and in every other module's copy of the number.
    expect(removed?.id).toBe(7);
    expect(removed?.deletedAt).toBeInstanceOf(Date);
  });

  it("nests inside a transaction the caller already opened", async () => {
    const fake = new FakeDb(world());

    await fake.db.transaction(async (tx) => {
      await createMirroredOrganization(tx, "org-1", { orgId: "org-1", name: "Northwind" });
    });

    // Savepoint 2, inside the caller's savepoint 1: `this.db` is the ambient
    // tenant transaction, so this nests rather than opening a second connection.
    expect(fake.trace().every((entry) => entry.endsWith("@2"))).toBe(true);
  });
});
