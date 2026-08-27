import { getTableName } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { CONTACT_MIRROR, type PartyRow } from "./party-legacy-mirror";
import {
  createMirroredContact,
  createMirroredContacts,
  softDeleteMirroredContacts,
  updateMirroredContact,
  updateMirroredContacts,
} from "./party-legacy-contacts";

/**
 * The contact half of ticket 08's contract, without a database.
 *
 * The claim under test is that these five entry points no longer write the
 * legacy identity table, and that nothing was lost when they stopped. Two things
 * have to hold at once for that to be true:
 *
 *   - the statement stream contains no write against `contacts`, and the
 *     identifier the caller is handed comes from `contact_party_map` instead;
 *   - the row the caller is handed is exactly what the derivation says, so a
 *     consumer that used to read the inserted row reads the same values.
 *
 * The assertions are on what each function RETURNS rather than on what it
 * wrote, which is the stronger of the two and the only one left: there is no
 * insert to inspect, and the return value is what every consumer depends on. An
 * echoed caller value -- the one failure mode a derivation-based writer can
 * still have -- shows up there and nowhere else.
 *
 * Tables are named through `getTableName` rather than by importing the schema
 * symbols, deliberately: `legacy-reader-ratchet.spec.ts` counts a file that
 * imports `contacts` as a reader of it, and a spec proving the writer stopped
 * reading it should not put itself on that register to do so.
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
  name: "Charles Babbage",
  legalName: null,
  displayName: null,
  taxNumber: null,
  website: "https://engines.test",
  email: null,
  phone: null,
  status: "active",
  customFields: null,
  notes: null,
  jobTitle: "Founder",
  department: "Engineering",
  companyName: "Analytical Engines",
  whatsappPhone: null,
  avatarUrl: null,
  linkedinUrl: "https://linkedin.test/babbage",
  socialProfiles: { twitter: "https://x.test/babbage" },
  city: null,
  state: null,
  lifecycleStage: null,
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
  lifetimeValue: null,
  healthScore: null,
  healthStatus: null,
  healthCheckedAt: null,
  churnRiskScore: null,
  churnRiskReasoning: null,
  tags: ["beta"],
  partyKind: "PERSON",
  employerPartyId: null,
  convertedFromPartyId: null,
  parentPartyId: null,
  primaryDealId: 12,
  domain: null,
  industry: null,
  companySize: null,
  description: null,
  deletedAt: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-02T00:00:00.000Z"),
};

type Answer = (statement: Statement, table: string) => unknown;

class FakeDb {
  readonly statements: Statement[] = [];
  private nextSavepoint = 1;

  constructor(private readonly answer: Answer) {}

  get db(): Db {
    return this.handle(0) as unknown as Db;
  }

  trace(): string[] {
    return this.statements.map((s) => `${s.kind}:${nameOf(s.table)}@${String(s.savepoint)}`);
  }

  /** Every statement that touched the legacy identity table, of any kind. */
  legacyWrites(): Statement[] {
    return this.statements.filter(
      (s) => nameOf(s.table) === "contacts" && s.kind !== "select",
    );
  }

  of(kind: Statement["kind"], table: string): Statement[] {
    return this.statements.filter((s) => s.kind === kind && nameOf(s.table) === table);
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
            return this.answer(statement, nameOf(statement.table));
          })
          .then(resolve, reject),
    };
    return self;
  }
}

function nameOf(table: unknown): string {
  if (!table || typeof table !== "object") return "none";
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return "unknown";
  }
}

/** One contact, already mapped to one party, and nothing else in the tenant. */
function world(overrides: Partial<Record<string, unknown[]>> = {}): Answer {
  return (statement, table) => {
    if (table === "business_parties") return overrides.parties ?? [PARTY];
    if (table === "contact_party_map" && statement.kind === "select")
      return overrides.contactMap ?? [{ contactId: 42, partyId: "party-1", id: 42 }];
    /**
     * The map mints the identifier now.
     *
     * Ticket 08: `contact_party_map.contact_id` defaults from the sequence
     * `contacts` used to own, so an insert that omits it gets one back. The fake
     * has to answer the same way or the writer cannot tell what the record is
     * called.
     */
    if (table === "contact_party_map") return overrides.contactMapInsert ?? [{ id: 42 }];
    if (table === "crm_org_party_map") return overrides.crmOrgMap ?? [];
    if (table === "lead_party_map") return overrides.leadMap ?? [];
    return [];
  };
}

describe("party-legacy-contacts — the party is the record, the map is the name", () => {
  it("creates the party, takes the identifier from the map, and writes no contact row", async () => {
    const fake = new FakeDb(world());

    const contact = await createMirroredContact(fake.db, "org-1", {
      orgId: "org-1",
      name: "Charles Babbage",
    });

    expect(fake.trace()).toEqual([
      // The bare party, then the values it takes, then everything that is a
      // function of it. The `insert:contacts` that used to sit third is gone:
      // the row it wrote was already derived from the party, and the only thing
      // the table contributed that mattered -- the serial -- the map mints.
      "insert:business_parties@1",
      "update:business_parties@1",
      "insert:contact_party_map@1",
      "insert:party_roles@1",
    ]);
    expect(fake.legacyWrites()).toEqual([]);
    expect(contact.id).toBe(42);
  });

  it("hands back the contact the derivation says, not the values the caller passed", async () => {
    const fake = new FakeDb(world());

    const contact = await createMirroredContact(fake.db, "org-1", {
      orgId: "org-1",
      name: "Charles Babbage",
      // The party the fake returns says Founder/Engineering regardless. If the
      // writer echoed the caller instead of deriving, these would come back.
      title: "Difference Engineer",
      department: "Sales",
    });

    expect(contact).toMatchObject(CONTACT_MIRROR.derive(PARTY));
    expect(contact.title).toBe("Founder");
    expect(contact.department).toBe("Engineering");
    // The jsonb bag unpacks to the one column `contacts` has for it, and the
    // deal id crosses no id space, so it arrives through the ordinary cells.
    expect(contact.twitterUrl).toBe("https://x.test/babbage");
    expect(contact.dealId).toBe(12);
    // The two timestamps the table used to stamp come off the party, which has
    // carried both since 0241.
    expect(contact.createdAt).toEqual(PARTY.createdAt);
    expect(contact.updatedAt).toEqual(PARTY.updatedAt);
  });

  it("carries a column the party does not own onto the returned row", async () => {
    const fake = new FakeDb(world());

    const contact = await createMirroredContact(fake.db, "org-1", {
      orgId: "org-1",
      name: "Charles Babbage",
      mergedIntoId: 7,
    });

    // `merged_into_id` is the one contact column with no Party source at all, so
    // it can only survive by being carried through the assembly.
    expect(contact.mergedIntoId).toBe(7);
  });

  it("answers null for the merge pointer nobody set, as every read of it does", async () => {
    const fake = new FakeDb(world());

    const contact = await createMirroredContact(fake.db, "org-1", {
      orgId: "org-1",
      name: "Charles Babbage",
    });

    // `CONTACT_PARTY_COLUMNS` projects this as a literal null on every read,
    // because the merge that sets it soft-deletes the row in the same breath.
    // The writer agrees rather than leaving the column absent.
    expect(contact.mergedIntoId).toBeNull();
  });

  it("translates the employer and the source lead back into their own id spaces", async () => {
    const employed: PartyRow = {
      ...PARTY,
      employerPartyId: "party-employer",
      convertedFromPartyId: "party-lead",
    };
    const fake = new FakeDb(
      world({
        parties: [employed],
        crmOrgMap: [{ partyId: "party-employer", crmOrganizationId: 5 }],
        leadMap: [{ partyId: "party-lead", leadId: 9 }],
      }),
    );

    const contact = await createMirroredContact(fake.db, "org-1", {
      orgId: "org-1",
      name: "Charles Babbage",
    });

    // Neither column is a mirror cell: both cross an id space, so both are
    // resolved through a `*_party_map` on the way out. A cell cannot do that,
    // which is the whole reason the two translations are separate files.
    expect(contact.organizationId).toBe(5);
    expect(contact.leadId).toBe(9);
  });

  it("keeps a bulk create atomic, the way the importer's chunking needs", async () => {
    const fake = new FakeDb(world());

    const created = await createMirroredContacts(fake.db, "org-1", [
      { orgId: "org-1", name: "Charles Babbage" },
      { orgId: "org-1", name: "Ada Lovelace" },
    ]);

    expect(created).toHaveLength(2);
    // Savepoint 1 is the bulk call's own; each row nests inside it, so a rejected
    // row takes the whole chunk with it and the importer's bisect still means
    // what it meant.
    expect(fake.trace().every((entry) => !entry.endsWith("@0"))).toBe(true);
    expect(fake.legacyWrites()).toEqual([]);
  });

  it("updates the party and derives the answer from it, touching no contact row", async () => {
    const fake = new FakeDb(world());

    const updated = await updateMirroredContact(fake.db, "org-1", 42, { title: "Founder" });

    expect(fake.trace()).toEqual([
      "select:contact_party_map@1",
      "select:business_parties@1",
      "update:business_parties@1",
    ]);
    // The party takes the merged model's name for the field.
    expect(fake.of("update", "business_parties")[0]?.set).toEqual({ jobTitle: "Founder" });
    expect(fake.legacyWrites()).toEqual([]);
    // The whole derivation comes back, not just the field that changed, so a
    // consumer reading any other column reads what the party says.
    expect(updated).toMatchObject(CONTACT_MIRROR.derive(PARTY));
    expect(updated?.id).toBe(42);
  });

  it("keeps a bulk update to a fixed number of statements", async () => {
    const fake = new FakeDb(
      world({
        contactMap: [
          { contactId: 42, partyId: "party-1" },
          { contactId: 43, partyId: "party-2" },
        ],
        parties: [PARTY, { ...PARTY, partyId: "party-2" }],
      }),
    );

    const updated = await updateMirroredContacts(fake.db, "org-1", [42, 43], { title: "Founder" });

    // Two contacts, two parties, one read and one write between them: the
    // grouping that used to keep the legacy UPDATE cheap still keeps the party
    // UPDATE cheap.
    expect(fake.of("select", "business_parties")).toHaveLength(1);
    expect(fake.of("update", "business_parties")).toHaveLength(1);
    expect(fake.legacyWrites()).toEqual([]);
    // One row per identifier, not per party: after a merge one party legitimately
    // answers for several, and each of them is still called what it was called.
    expect(updated.map((row) => row.id)).toEqual([42, 43]);
  });

  it("checks a contact is live before deleting it, so a delete does not move the timestamp", async () => {
    // Liveness is the party's `deleted_at` now, read through the map — ticket 08
    // removed the last read of `contacts`. The property is unchanged: a contact
    // already deleted must not have its timestamp moved by a second delete.
    const fake = new FakeDb(world({ contactMap: [] }));

    await softDeleteMirroredContacts(fake.db, "org-1", [42]);

    // Nothing live came back, so nothing was written at all.
    expect(fake.trace()).toEqual(["select:contact_party_map@0"]);
  });

  it("soft-deletes the party and leaves the map row standing", async () => {
    const fake = new FakeDb(world());

    await softDeleteMirroredContacts(fake.db, "org-1", [42]);

    expect(fake.trace()).toEqual([
      // Depth 0: the liveness check, exactly where the read of `contacts` used
      // to sit — the map joined to the party that decides.
      "select:contact_party_map@0",
      "select:contact_party_map@1",
      "select:business_parties@1",
      "update:business_parties@1",
    ]);
    expect(fake.of("update", "business_parties")[0]?.set?.deletedAt).toBeInstanceOf(Date);
    // The map row is the record of what the thing is called. Deleting it would
    // orphan an identifier that is in somebody's URL, so a soft delete never
    // touches it.
    expect(fake.of("update", "contact_party_map")).toEqual([]);
    expect(fake.legacyWrites()).toEqual([]);
  });
});
