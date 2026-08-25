import type { Db } from "../../db/drizzle.types";
import { businessParties, leadPartyMap, partyRoles } from "../../db/schema/party";
import { clients, contacts } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
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

function tableName(table: unknown): string {
  if (table === businessParties) return "party";
  if (table === leads) return "leads";
  if (table === clients) return "clients";
  if (table === contacts) return "contacts";
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
    if (statement.table === leads)
      return overrides.leads ?? [{ id: 7, orgId: "org-1", name: "Ada Lovelace" }];
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
      // function of it. Nothing touches `leads` before `business_parties`.
      "insert:party@1",
      "update:party@1",
      "insert:leads@1",
      "insert:leadMap@1",
      "insert:roles@1",
    ]);
  });

  it("writes the lead from the derivation, not from the caller's values", async () => {
    const fake = new FakeDb(world());

    await createMirroredLead(fake.db, "org-1", {
      orgId: "org-1",
      name: "Ada Lovelace",
      // The party the fake returns says QUALIFIED/HOT regardless. If the writer
      // echoed the caller instead of deriving, these would land on the row.
      status: "NEW",
      priority: "COLD",
    });

    const [inserted] = fake.of("insert", leads);
    expect(inserted?.values[0]).toMatchObject(LEAD_MIRROR.derive(PARTY));
    expect(inserted?.values[0]?.status).toBe("QUALIFIED");
    expect(inserted?.values[0]?.priority).toBe("HOT");
  });

  it("carries a column the party does not own straight onto the legacy row", async () => {
    const fake = new FakeDb(world());

    await createMirroredLead(fake.db, "org-1", {
      orgId: "org-1",
      name: "Ada",
      dmLeadId: 99,
    });

    expect(fake.of("insert", leads)[0]?.values[0]?.dmLeadId).toBe(99);
  });

  it("updates the party before the lead, both in one savepoint", async () => {
    const fake = new FakeDb(world());

    await updateMirroredLeads(fake.db, "org-1", [7], { designation: "Rear Admiral" });

    expect(fake.trace()).toEqual([
      "select:leadMap@1",
      "select:party@1",
      "update:party@1",
      "update:leads@1",
    ]);
    // The party takes the merged model's name for the field.
    expect(fake.of("update", businessParties)[0]?.set).toEqual({ jobTitle: "Rear Admiral" });
    // The lead takes the whole derivation, not just the field that changed, so a
    // column that drifted for any other reason is corrected by the next write.
    expect(fake.of("update", leads)[0]?.set).toEqual(LEAD_MIRROR.derive(PARTY));
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

    // Deriving per row is what keeps the mirror correct; grouping identical
    // payloads is what stops a bulk operation from costing four statements per
    // record. Two leads, two parties, one statement each way.
    expect(fake.of("select", businessParties)).toHaveLength(1);
    expect(fake.of("update", businessParties)).toHaveLength(1);
    expect(fake.of("update", leads)).toHaveLength(1);
  });

  it("checks a lead is live before deleting it, so a delete does not move the timestamp", async () => {
    const fake = new FakeDb(world({ leads: [] }));

    await softDeleteMirroredLeads(fake.db, "org-1", [7]);

    // No live lead came back, so nothing was written at all.
    expect(fake.trace()).toEqual(["select:leads@0"]);
  });

  it("soft-deletes the party and the lead together when the lead is live", async () => {
    const fake = new FakeDb(world());

    await softDeleteMirroredLeads(fake.db, "org-1", [7]);

    expect(fake.trace()).toEqual([
      "select:leads@0",
      "select:leadMap@1",
      "select:party@1",
      "update:party@1",
      "update:leads@1",
    ]);
    expect(fake.of("update", businessParties)[0]?.set?.deletedAt).toBeInstanceOf(Date);
  });

  it("pushes a party write out to every legacy row that mirrors it", async () => {
    const fake = new FakeDb((statement) => {
      if (statement.table === businessParties) return [PARTY];
      if (statement.table === leadPartyMap) return [{ id: 7 }];
      return [];
    });

    await updatePartyWithMirror(fake.db, "org-1", "party-1", { jobTitle: "Commodore" });

    expect(fake.trace()).toEqual([
      "update:party@1",
      // All three maps are asked, because a merge can leave one party answering
      // for a lead, a client and a contact at once.
      "select:leadMap@1",
      "select:other@1",
      "select:other@1",
      "update:leads@1",
    ]);
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
