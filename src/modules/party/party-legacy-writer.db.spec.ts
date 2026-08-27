/**
 * Real-database tests for what the writer promises now that the mirror is gone.
 *
 * The dual-write window's claim was that a legacy row and the Party it mirrors
 * could not be observed disagreeing. Ticket 08 made that claim vacuous in the
 * strongest way available: there is one row, the party, and the legacy shape is
 * derived from it when somebody asks. Two copies cannot disagree if there is
 * only one.
 *
 * What still needs a real database is atomicity. A record is a party, a map row
 * and a role grant, written in one transaction, and a half-written record is
 * still the state this file exists to make impossible -- only the constraint
 * that catches it has moved. `leads.campaign_id` used to be the foreign key that
 * failed after the party was written; `business_parties.acquisition_campaign_id`
 * is the same key on the surviving table, so the test below is the same test.
 *
 * Guarded by CRM_DB_TESTS=1 so the default hermetic `jest` run is unaffected and
 * CI without a database does not fail. Run with:
 *   CRM_DB_TESTS=1 npx jest --runInBand --testPathPattern="party-legacy-writer.db"
 *
 * Atomicity is the property a mocked database cannot demonstrate. A fake rolls
 * back whatever it was told to roll back; only a real savepoint, and a real
 * constraint violation inside it, shows whether a half-written record can
 * survive — and a Party with no legacy row is precisely the state the ticket
 * exists to make impossible.
 *
 * Everything happens inside a transaction that is rolled back, fixtures
 * included, so the tests leave the database exactly as they found it.
 */
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import dotenv from "dotenv";
import postgres from "postgres";
import * as schema from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import { businessParties, leadPartyMap, partyRoles } from "../../db/schema/party";
import { diffLegacyMirror, LEAD_MIRROR } from "./party-legacy-mirror";
import { updatePartyWithMirror } from "./party-legacy-writer";
import {
  createMirroredLead,
  softDeleteMirroredLeads,
  updateMirroredLead,
} from "./party-legacy-leads";
import { createMirroredClient } from "./party-legacy-clients";
import { createMirroredContact } from "./party-legacy-contacts";

const ENABLED = process.env.CRM_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  if (!process.env.DATABASE_URL) dotenv.config({ path: ".env" });
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for CRM_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

describeDb("party-legacy-writer — real database", () => {
  let client: ReturnType<typeof connect>;
  let db: Db;

  beforeAll(() => {
    client = connect();
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  /** Runs the body inside a rolled-back transaction, scoped to a real tenant. */
  async function withTenant<T>(body: (tx: Db, orgId: string) => Promise<T>): Promise<T> {
    let captured: T | undefined;
    try {
      await db.transaction(async (tx) => {
        const [org] = await tx.select({ id: schema.organizations.id }).from(schema.organizations).limit(1);
        if (!org)
          throw new Error("CRM_DB_TESTS needs at least one organization to scope fixtures to");
        captured = await body(tx, org.id);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return captured as T;
  }

  it("writes the party first and derives the lead from it", async () => {
    await withTenant(async (tx, orgId) => {
      const lead = await createMirroredLead(tx, orgId, {
        orgId,
        name: "Ada Lovelace",
        email: "ada@lovelace.test",
        designation: "Head of Computation",
        company: "Analytical Engines",
        priority: "HOT",
        status: "QUALIFIED",
        potentialValue: "75000.00",
        tags: ["vip"],
      });

      const [map] = await tx
        .select()
        .from(leadPartyMap)
        .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, lead.id)));
      expect(map?.linkedBy).toBe("mirror:create");

      const [party] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));

      // The merged model's names, on the party; the legacy names, on the lead.
      expect(party?.jobTitle).toBe("Head of Computation");
      expect(party?.lifecycleStage).toBe("QUALIFIED");
      expect(party?.expectedValue).toBe("75000.00");
      expect(diffLegacyMirror("LEAD", party!, lead)).toEqual([]);

      // 0241 gave every backfilled lead a PROSPECT role; new ones match.
      const roles = await tx
        .select({ role: partyRoles.role })
        .from(partyRoles)
        .where(eq(partyRoles.partyId, map!.partyId));
      expect(roles.map((row) => row.role)).toEqual(["PROSPECT"]);
    });
  });

  it("leaves no half-written record when a constraint refuses the patch", async () => {
    await withTenant(async (tx, orgId) => {
      const before = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(businessParties)
        .where(eq(businessParties.organizationId, orgId));

      await expect(
        createMirroredLead(tx, orgId, {
          orgId,
          name: "Doomed",
          // No such campaign: `fk_business_parties_acquisition_campaign` fails
          // when the patch lands, after the bare party has already been written.
          campaignId: -1,
        }),
      ).rejects.toBeTruthy();

      const after = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(businessParties)
        .where(eq(businessParties.organizationId, orgId));

      // The savepoint took the bare party with it. A surviving party here would
      // be a record with no map row -- reachable by nothing, named by nothing.
      expect(after[0]?.n).toBe(before[0]?.n);
    });
  });

  it("moves both sides on an update, whichever surface asked", async () => {
    await withTenant(async (tx, orgId) => {
      const created = await createMirroredLead(tx, orgId, { orgId, name: "Grace Hopper" });

      // Through the legacy surface: a `leads`-shaped patch.
      const updated = await updateMirroredLead(tx, orgId, created.id, {
        designation: "Rear Admiral",
        notes: "Compiler.",
      });
      expect(updated?.designation).toBe("Rear Admiral");

      const [map] = await tx
        .select()
        .from(leadPartyMap)
        .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, created.id)));
      const [party] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));
      expect(party?.jobTitle).toBe("Rear Admiral");

      // Through the party surface: the lead view follows, because it is the
      // party. There is no second row to read back, so the lead is derived --
      // which is what every reader of a lead does now.
      await updatePartyWithMirror(tx, orgId, map!.partyId, { jobTitle: "Commodore" });
      const [afterParty] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));
      const afterLead = LEAD_MIRROR.derive(afterParty!);
      expect(afterLead.designation).toBe("Commodore");
      expect(diffLegacyMirror("LEAD", afterParty!, afterLead)).toEqual([]);
    });
  });

  it("soft-deletes the party and its mirror together, and does it once", async () => {
    await withTenant(async (tx, orgId) => {
      const created = await createMirroredLead(tx, orgId, { orgId, name: "Deleted Soon" });

      const [deleted] = await softDeleteMirroredLeads(tx, orgId, [created.id]);
      expect(deleted?.deletedAt).toBeInstanceOf(Date);

      const [map] = await tx
        .select()
        .from(leadPartyMap)
        .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, created.id)));
      const [party] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));
      expect(party?.deletedAt).toBeInstanceOf(Date);

      // Idempotent: re-deleting must not move the timestamp that says when it
      // went, which is what the legacy `WHERE deleted_at IS NULL` guaranteed.
      const stamp = party!.deletedAt!.getTime();
      await softDeleteMirroredLeads(tx, orgId, [created.id]);
      const [again] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));
      expect(again?.deletedAt?.getTime()).toBe(stamp);
    });
  });

  it("mirrors a client and a contact from their own parties", async () => {
    await withTenant(async (tx, orgId) => {
      const client = await createMirroredClient(tx, orgId, {
        orgId,
        name: "Analytical Engines",
        gstin: "29ABCDE1234F1Z5",
        isVendor: true,
        investmentValue: "125000.00",
        healthScore: 82,
      });
      expect(client.isVendor).toBe(true);
      expect(client.healthScore).toBe(82);

      const contact = await createMirroredContact(tx, orgId, {
        orgId,
        name: "Charles Babbage",
        title: "Founder",
        twitterUrl: "https://x.test/babbage",
        tags: ["beta"],
      });
      expect(contact.title).toBe("Founder");
      expect(contact.twitterUrl).toBe("https://x.test/babbage");

      /*
        There used to be a divergence report here, asserting the two copies
        agreed. `PartyDivergenceService` went with the tables it compared: a
        report that can only ever say zero is not a check, it is a constant.

        What replaces it is the assertion that the returned rows carry the
        values -- which is the same claim, made where it can still fail. Every
        column above is a legacy-owned or mirrored one, so a derivation that
        dropped it shows up right here.
      */
    });
  });

  /*
    Two tests stood here and both went with the table.

    One wrote to `leads` behind the writer's back and asserted the divergence
    check reported it without repairing it. The other inserted a `leads` row
    with no party -- a restore, or an out-of-band import -- and asserted the
    next write adopted it rather than refusing.

    Neither can be written now, and that is the contract rather than a loss of
    coverage: there is no table to write behind the writer's back, and no way to
    arrive with an identifier that no party answers for, because the map row IS
    the identifier. `adoptLead` and its siblings went with them.
  */

  it("keeps the mirror inside the tenant that owns the party", async () => {
    await withTenant(async (tx, orgId) => {
      const created = await createMirroredLead(tx, orgId, { orgId, name: "Tenant check" });
      expect(created.orgId).toBe(orgId);
      expect(LEAD_MIRROR.derive({ ...(await onlyParty(tx, orgId, created.id)) }).orgId).toBe(orgId);
    });
  });

  async function onlyParty(tx: Db, orgId: string, leadId: number) {
    const [map] = await tx
      .select()
      .from(leadPartyMap)
      .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, leadId)));
    const [party] = await tx
      .select()
      .from(businessParties)
      .where(eq(businessParties.partyId, map!.partyId));
    return party!;
  }

  /**
   * The inverse of what stood here, and the only place the drop is observable.
   *
   * This used to check the four tables were still present -- a guard that the
   * fixtures were hitting the schema the rest of the suite assumed rather than a
   * database mid-migration. Migration 0278 is the end of that migration, so the
   * same guard now asks the opposite question, against the same catalogue.
   *
   * Asked of `pg_class` rather than by selecting from them, because the point is
   * a database whose schema no longer has these tables, and there is no Drizzle
   * symbol left to select from. A tree that typechecks proves the code stopped
   * naming them; only this proves the database did.
   */
  it("no longer has the four legacy identity tables", async () => {
    await withTenant(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT c.relname::text AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname IN ('leads', 'clients', 'contacts', 'crm_organizations')
      `);
      expect([...rows].map((row) => (row as { name: string }).name)).toEqual([]);
    });
  });

  /**
   * The sequences outlived the tables, which is what kept the identifiers.
   *
   * `leads.id` was the CRM's public identifier -- in twenty controller routes
   * behind `ParseIntPipe` and in every `/crm/leads/[leadId]` a browser has
   * bookmarked. Migration 0277 detached each sequence with `OWNED BY NONE` and
   * pointed the map column's DEFAULT at it, so numbering continues from where
   * the table left off instead of restarting and colliding with every id
   * already issued. If a sequence had gone with its table, the next lead created
   * would take an id somebody else's lead already has.
   */
  it("kept the sequences that mint the identifiers", async () => {
    await withTenant(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT c.relname::text AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'S'
          AND c.relname IN ('leads_id_seq', 'clients_id_seq', 'contacts_id_seq', 'crm_organizations_id_seq')
      `);
      expect([...rows].map((row) => (row as { name: string }).name).sort()).toEqual([
        "clients_id_seq",
        "contacts_id_seq",
        "crm_organizations_id_seq",
        "leads_id_seq",
      ]);
    });
  });
});
