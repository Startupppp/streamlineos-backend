import type { Db } from "../../db/drizzle.types";
import { businessParties, leadPartyMap, partyRoles } from "../../db/schema/party";
import { LEAD_MIRROR, type PartyRow } from "./party-legacy-mirror";
import { updatePartyWithMirror } from "./party-legacy-writer";
import {
  createMirroredLead,
  softDeleteMirroredLeads,
  updateMirroredLeads,
} from "./party-legacy-leads";

/**
 * Order and atomicity, without a database.
 *
 * The claim under test is the ticket's first: the Party row is written before
 * the legacy row, and both are inside one transaction, so a partial write is not
 * a state anything can observe. Order is a property of the statement stream, so
 * a fake that records the stream — and which savepoint each statement ran in —
 * can show it. What it cannot show is that a real ROLLBACK TO SAVEPOINT takes
 * the party with it; `party-legacy-writer.db.spec.ts` does that against a real
 * database, and this file deliberately does not pretend to.
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
  name: "Ada Lovelace",
  legalName: null,
  displayName: null,
  taxNumber: null,
  website: null,
  email: null,
  phone: null,
  timezone: null,
  status: "active",
  customFields: null,
  notes: null,
  jobTitle: "Head of Computation",
  department: null,
  companyName: null,
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: null,
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
  healthScore: null,
  healthStatus: null,
  healthCheckedAt: null,
  churnRiskScore: null,
  churnRiskReasoning: null,
  tags: [],
  partyKind: null,
  employerPartyId: null,
  convertedFromPartyId: null,
  parentPartyId: null,
  primaryDealId: null,
  domain: null,
  industry: null,
  companySize: null,
  description: null,
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
 * Every table this writer is allowed to touch, by name.
 *
 * The four legacy tables used to be named here too. They are gone, and nothing
 * replaces the branches: a statement against a table this function does not
 * know reads as `other`, and every assertion below is an exact `toEqual` on the
 * whole trace. So a reintroduced write does not have to be anticipated to be
 * caught -- it shows up as an `other` nobody expected, which is the property
 * that made these traces worth inverting rather than deleting.
 */
function tableName(table: unknown): string {
  if (table === businessParties) return "party";
  if (table === leadPartyMap) return "leadMap";
  if (table === partyRoles) return "roles";
  return "other";
}

/** The default world: one lead, mapped to one party. */
function world(overrides: Partial<Record<string, unknown[]>> = {}): Answer {
  return (statement) => {
    if (statement.table === businessParties) return overrides.parties ?? [PARTY];
    if (statement.table === leadPartyMap && statement.kind === "select")
      return overrides.leadMap ?? [{ leadId: 7, partyId: "party-1", id: 7 }];
    /**
     * The map mints the identifier now.
     *
     * Ticket 08: `lead_party_map.lead_id` defaults from the sequence `leads`
     * used to own, so an insert that omits it gets one back. The fake has to
     * answer the same way or the writer cannot tell what the record is called.
     */
    if (statement.table === leadPartyMap && statement.kind === "insert")
      return overrides.leadMapInsert ?? [{ id: 7, leadId: 7 }];
    if (statement.kind === "select") return [];
    return [];
  };
}

describe("party-legacy-writer — the party is written first, in one transaction", () => {
  it("creates the party, then derives the lead from it, then links them", async () => {
    const fake = new FakeDb(world());

    await createMirroredLead(fake.db, "org-1", { orgId: "org-1", name: "Ada Lovelace" });

    expect(fake.trace()).toEqual([
      // The bare party, then the values it takes, then everything that is a
      // function of it.
      //
      // Ticket 08's contract removed the `insert:leads` that used to sit third.
      // The row it wrote was already derived from the party -- the table's only
      // unique contribution was the serial, and the map mints that now. So the
      // trace is what it always was, minus a write that produced nothing the
      // derivation did not already know.
      "insert:party@1",
      "update:party@1",
      "insert:leadMap@1",
      "insert:roles@1",
    ]);
  });

  it("writes the lead from the derivation, not from the caller's values", async () => {
    const fake = new FakeDb(world());

    const lead = await createMirroredLead(fake.db, "org-1", {
      orgId: "org-1",
      name: "Ada Lovelace",
      // The party the fake returns says QUALIFIED/HOT regardless. If the writer
      // echoed the caller instead of deriving, these would come back.
      status: "NEW",
      priority: "COLD",
    });

    /**
     * Asserted on what the writer *returns* now, not on what it inserted.
     *
     * Ticket 08's contract: there is no `leads` insert to inspect. That is not a
     * weaker test -- it is a stronger one. Inspecting the insert checked what
     * was written; this checks what the caller is handed, which is the thing
     * every consumer actually depends on and is where an echoed value would
     * show up.
     */
    expect(lead).toMatchObject(LEAD_MIRROR.derive(PARTY));
    expect(lead.status).toBe("QUALIFIED");
    expect(lead.priority).toBe("HOT");
  });

  it("carries a column the party does not own straight onto the legacy row", async () => {
    const fake = new FakeDb(world());

    const lead = await createMirroredLead(fake.db, "org-1", {
      orgId: "org-1",
      name: "Ada",
      dmLeadId: 99,
    });

    // A legacy-owned column has no Party home, so it can only survive by being
    // carried through the assembly. `dm_lead_id` is the one lead column in that
    // position -- everything else the table owned maps somewhere.
    expect(lead.dmLeadId).toBe(99);
  });

  it("updates the party, and derives the lead it returns rather than writing one", async () => {
    const fake = new FakeDb(world());

    const [updated] = await updateMirroredLeads(fake.db, "org-1", [7], {
      designation: "Rear Admiral",
    });

    // Ticket 08: the trailing `update:leads` is gone. The party write is the
    // only write, because the lead is computed when somebody asks for it.
    expect(fake.trace()).toEqual(["select:leadMap@1", "select:party@1", "update:party@1"]);

    // The party takes the merged model's name for the field.
    expect(fake.of("update", businessParties)[0]?.set).toEqual({ jobTitle: "Rear Admiral" });

    /*
      The returned lead is still the WHOLE derivation, not just the field that
      changed — which is the property the old assertion was protecting when it
      checked what the UPDATE `set`. It matters for the same reason: a caller
      reading one field off this row must not find the rest stale.
    */
    expect(updated).toMatchObject(LEAD_MIRROR.derive(PARTY));
  });

  it("keeps a bulk update to a fixed number of statements", async () => {
    const fake = new FakeDb(
      world({
        leadMap: [
          { leadId: 7, partyId: "party-1" },
          { leadId: 8, partyId: "party-2" },
        ],
        parties: [PARTY, { ...PARTY, partyId: "party-2" }],
      }),
    );

    await updateMirroredLeads(fake.db, "org-1", [7, 8], { designation: "Rear Admiral" });

    // Deriving per row is what keeps every returned lead correct; grouping
    // identical payloads is what stops a bulk operation costing a statement per
    // record. Two leads, two parties, one statement each way — and since ticket
    // 08 there is no third statement, because there is no second copy to write.
    expect(fake.of("select", businessParties)).toHaveLength(1);
    expect(fake.of("update", businessParties)).toHaveLength(1);
  });

  it("checks a lead is live before deleting it, so a delete does not move the timestamp", async () => {
    // Liveness is the party's `deleted_at` now, read through the map — ticket 08
    // removed the last read of `leads`. The property under test is unchanged: a
    // lead already deleted must not have its timestamp moved by a second delete.
    const fake = new FakeDb(world({ leadMap: [] }));

    await softDeleteMirroredLeads(fake.db, "org-1", [7]);

    // Nothing live came back, so nothing was written at all.
    expect(fake.trace()).toEqual(["select:leadMap@0"]);
  });

  it("soft-deletes the party, which is the whole of deleting the lead", async () => {
    const fake = new FakeDb(world());

    await softDeleteMirroredLeads(fake.db, "org-1", [7]);

    /*
      Ticket 08: the liveness read is the map joined to the party, and the
      trailing `update:leads` is gone.

      The test's name changed with it, and the change is the point rather than
      cosmetic: there is no longer a lead to delete *alongside* the party. The
      lead is a view of the party, so stamping the party IS deleting it, and a
      second write could only ever have disagreed.
    */
    expect(fake.trace()).toEqual([
      // Depth 0: the liveness check, outside the transaction, exactly where the
      // read of `leads` used to sit.
      "select:leadMap@0",
      "select:leadMap@1",
      "select:party@1",
      "update:party@1",
    ]);
    expect(fake.of("update", businessParties)[0]?.set?.deletedAt).toBeInstanceOf(Date);
  });

  /**
   * The inverse of what this used to assert, and the point of the contract.
   *
   * A party write used to fan out: read all four maps, then UPDATE every legacy
   * row that mirrored the party — five statements to keep a second copy in step.
   * There is no second copy now. A legacy shape is derived from the party at the
   * moment somebody reads it, so writing the party IS writing them, and a fan-out
   * would be writing to tables that no longer exist.
   *
   * Asserted as an exact trace rather than "does not touch leads", because the
   * failure worth catching is a *reintroduced* write, and only an exact trace
   * catches one that goes to a table this test did not think to name.
   */
  it("no longer fans a party write out, because there is nothing to fan out to", async () => {
    const fake = new FakeDb((statement) => {
      if (statement.table === businessParties) return [PARTY];
      if (statement.table === leadPartyMap) return [{ id: 7 }];
      return [];
    });

    await updatePartyWithMirror(fake.db, "org-1", "party-1", { jobTitle: "Commodore" });

    expect(fake.trace()).toEqual(["update:party@1"]);
  });

  it("nests inside a transaction the caller already opened", async () => {
    const fake = new FakeDb(world());

    await fake.db.transaction(async (tx) => {
      await createMirroredLead(tx, "org-1", { orgId: "org-1", name: "Ada" });
    });

    // Savepoint 2, inside the caller's savepoint 1: `this.db` is the ambient
    // tenant transaction, so this nests rather than opening a second connection.
    expect(fake.trace().every((entry) => entry.endsWith("@2"))).toBe(true);
  });
});
