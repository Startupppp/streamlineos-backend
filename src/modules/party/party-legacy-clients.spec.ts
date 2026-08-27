import type { Db } from "../../db/drizzle.types";
import { businessParties, clientPartyMap, leadPartyMap, partyRoles } from "../../db/schema/party";
import { CLIENT_MIRROR, type PartyRow } from "./party-legacy-mirror";
import {
  createMirroredClient,
  updateMirroredClient,
  updateMirroredClients,
} from "./party-legacy-clients";

/**
 * What the client writer hands back, and what it no longer writes.
 *
 * Ticket 08 took the `clients` insert and the `clients` update out of this file:
 * the row they wrote was already `CLIENT_MIRROR.derive(party)`, and the serial
 * they were being asked for now comes from `client_party_map`. So the assertions
 * here are on the **returned row** rather than on a statement's payload. That is
 * not the weaker test of the two -- what a consumer holds is the returned row,
 * and it is exactly where a value echoed back from the caller instead of derived
 * from the party would show up.
 *
 * The trace is still asserted, for the claim that survived the change: the party
 * is written first, everything else is a function of it, and all of it is inside
 * one savepoint.
 *
 * No database. Atomicity is the one property a fake cannot demonstrate;
 * `party-legacy-writer.db.spec.ts` does that against a real one.
 *
 * This file deliberately imports no legacy table symbol -- there is no longer a
 * statement against one to inspect, so `legacy-reader-ratchet.spec.ts` never
 * needs to hear about it.
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
  name: "Analytical Engines",
  legalName: null,
  displayName: null,
  taxNumber: "29ABCDE1234F1Z5",
  website: null,
  email: null,
  phone: null,
  status: "active",
  customFields: null,
  notes: null,
  jobTitle: "Managing Director",
  department: null,
  companyName: null,
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: null,
  socialProfiles: null,
  city: "Bengaluru",
  state: "KA",
  lifecycleStage: "CUSTOMER",
  priority: null,
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
  lifetimeValue: "125000.00",
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
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
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
  if (table === clientPartyMap) return "clientMap";
  if (table === leadPartyMap) return "leadMap";
  if (table === partyRoles) return "roles";
  return "other";
}

/** The default world: one client, id 5, mapped to one party. */
function world(overrides: Partial<Record<string, unknown[]>> = {}): Answer {
  return (statement) => {
    if (statement.table === businessParties) return overrides.parties ?? [PARTY];
    if (statement.table === clientPartyMap && statement.kind === "select")
      return overrides.clientMap ?? [{ clientId: 5, partyId: "party-1" }];
    /**
     * The map mints the identifier now.
     *
     * `client_party_map.client_id` defaults from the sequence `clients` used to
     * own, so an insert that omits it gets one back. The fake has to answer the
     * same way or the writer cannot tell what the record is called.
     */
    if (statement.table === clientPartyMap && statement.kind === "insert")
      return overrides.clientMapInsert ?? [{ id: 5, clientId: 5 }];
    if (statement.table === leadPartyMap)
      return overrides.leadMap ?? [{ leadId: 7, partyId: "party-lead" }];
    return [];
  };
}

describe("party-legacy-clients — the row is derived from the party, and no legacy row is written", () => {
  it("creates the party, then mints the identifier the record is known by", async () => {
    const fake = new FakeDb(world());

    const client = await createMirroredClient(fake.db, "org-1", {
      orgId: "org-1",
      name: "Analytical Engines",
    });

    expect(fake.trace()).toEqual([
      // The bare party, then the values it takes, then everything that is a
      // function of it.
      //
      // Ticket 08's contract removed the legacy insert that used to sit third.
      // What it wrote was already derived from the party -- the table's only
      // unique contribution was the serial, and the map mints that now.
      "insert:party@1",
      "update:party@1",
      "insert:clientMap@1",
      "insert:roles@1",
    ]);
    // The number comes back from the map's default, not from a serial the writer
    // had to insert a legacy row to reach.
    expect(client.id).toBe(5);
    expect(fake.of("insert", clientPartyMap)[0]?.values[0]).toEqual({
      organizationId: "org-1",
      partyId: "party-1",
      linkedBy: "mirror:create",
    });
  });

  it("hands back the derivation, not the caller's values", async () => {
    const fake = new FakeDb(world());

    const client = await createMirroredClient(fake.db, "org-1", {
      orgId: "org-1",
      name: "Analytical Engines",
      // The party the fake returns says active, and says nothing at all about
      // health. If the writer echoed the caller instead of deriving, these would
      // come back.
      status: "archived",
      healthScore: 3,
      healthStatus: "critical",
    });

    expect(client).toMatchObject(CLIENT_MIRROR.derive(PARTY));
    expect(client.status).toBe("active");
    // NOT NULL on the legacy side and nullable on Party's: the derivation fills
    // the gap, and it is the only thing allowed to.
    expect(client.healthScore).toBe(50);
    expect(client.healthStatus).toBe("healthy");
    // Timestamps come off the party, which is the only row that has them now.
    expect(client.createdAt).toEqual(PARTY.createdAt);
    expect(client.updatedAt).toEqual(PARTY.updatedAt);
    expect(client.orgId).toBe("org-1");
  });

  it("carries a column the party does not own straight onto the returned row", async () => {
    const fake = new FakeDb(world());

    const client = await createMirroredClient(fake.db, "org-1", {
      orgId: "org-1",
      name: "Analytical Engines",
      leadId: 7,
    });

    // `lead_id` is legacy-owned in shape -- it is an integer id where Party holds
    // a party id -- so it can only survive by being carried through the assembly,
    // which is where the insert's `...legacyOwnedPatch` used to put it.
    expect(client.leadId).toBe(7);
  });

  it("translates the party's conversion link back into the integer id the column holds", async () => {
    const fake = new FakeDb(
      world({ parties: [{ ...PARTY, convertedFromPartyId: "party-lead" }] }),
    );

    const client = await createMirroredClient(fake.db, "org-1", {
      orgId: "org-1",
      name: "Analytical Engines",
    });

    // The one mirrored column outside the pure derivation: it crosses an id
    // space, so producing it costs a read of the lead map.
    expect(fake.trace()).toContain("select:leadMap@1");
    expect(client.leadId).toBe(7);
  });

  it("grants the vendor role alongside the customer one when the party is both", async () => {
    const fake = new FakeDb(world({ parties: [{ ...PARTY, partyType: "BOTH" }] }));

    const client = await createMirroredClient(fake.db, "org-1", {
      orgId: "org-1",
      name: "Analytical Engines",
    });

    expect(client.isVendor).toBe(true);
    expect(fake.of("insert", partyRoles).map((s) => s.values[0]?.role)).toEqual([
      "CUSTOMER",
      "VENDOR",
    ]);
  });

  it("moves the party and derives the answer from what it became", async () => {
    const fake = new FakeDb(world());

    const client = await updateMirroredClient(fake.db, "org-1", 5, {
      designation: "Rear Admiral",
    });

    expect(fake.trace()).toEqual([
      "select:clientMap@1",
      "select:party@1",
      "update:party@1",
    ]);
    // The party takes the merged model's name for the field.
    expect(fake.of("update", businessParties)[0]?.set).toEqual({ jobTitle: "Rear Admiral" });
    // And the caller is handed the whole derivation, not just the field that
    // changed -- the party the fake returns still says Managing Director, so the
    // answer is what the row *is*, never what the patch asked for.
    expect(client).toMatchObject(CLIENT_MIRROR.derive(PARTY));
    expect(client?.id).toBe(5);
    expect(client?.designation).toBe("Managing Director");
  });

  it("keeps a bulk update to a fixed number of statements", async () => {
    const fake = new FakeDb(
      world({
        clientMap: [
          { clientId: 5, partyId: "party-1" },
          { clientId: 6, partyId: "party-2" },
        ],
        parties: [PARTY, { ...PARTY, partyId: "party-2" }],
      }),
    );

    const rows = await updateMirroredClients(fake.db, "org-1", [5, 6], {
      designation: "Rear Admiral",
    });

    // Two clients, two parties, one read and one write between them. Grouping
    // identical payloads is what stops a bulk operation from costing a statement
    // per record; it lives in `movePartiesFor` now, because the second table it
    // used to group writes for is gone.
    expect(fake.of("select", businessParties)).toHaveLength(1);
    expect(fake.of("update", businessParties)).toHaveLength(1);
    expect(rows.map((row) => row.id)).toEqual([5, 6]);
  });

  it("says nothing about a client id that resolves to no party", async () => {
    const fake = new FakeDb(world({ clientMap: [], parties: [] }));

    // No map row and no legacy row to adopt: the id is unknown here, and an
    // unknown id yields no row rather than an invented one.
    expect(await updateMirroredClients(fake.db, "org-1", [5], { notes: "n" })).toEqual([]);
  });

  it("nests inside a transaction the caller already opened", async () => {
    const fake = new FakeDb(world());

    await fake.db.transaction(async (tx) => {
      await createMirroredClient(tx, "org-1", { orgId: "org-1", name: "Analytical Engines" });
    });

    // Savepoint 2, inside the caller's savepoint 1: `this.db` is the ambient
    // tenant transaction, so this nests rather than opening a second connection.
    expect(fake.trace().every((entry) => entry.endsWith("@2"))).toBe(true);
  });
});
