/**
 * Real-database tests for the dual-write window's central claim: that a legacy
 * row and the Party it mirrors cannot be observed disagreeing, because they are
 * written in one transaction with the Party first.
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
import { clients, contacts } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
import { PartyDivergenceService } from "./party-divergence.service";
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
if (ENABLED) jest.setTimeout(60_000);
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

  it("leaves no orphan party when the legacy insert is refused", async () => {
    await withTenant(async (tx, orgId) => {
      const before = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(businessParties)
        .where(eq(businessParties.organizationId, orgId));

      await expect(
        createMirroredLead(tx, orgId, {
          orgId,
          name: "Doomed",
          // No such campaign: `leads.campaign_id` has a foreign key, so the
          // legacy insert fails after the party has already been written.
          campaignId: -1,
        }),
      ).rejects.toBeTruthy();

      const after = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(businessParties)
        .where(eq(businessParties.organizationId, orgId));

      // The savepoint took the party with it. A surviving party here would be a
      // record that exists on the Party surface and nowhere else.
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

      // Through the party surface: the lead follows.
      await updatePartyWithMirror(tx, orgId, map!.partyId, { jobTitle: "Commodore" });
      const [afterParty] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));
      const [afterLead] = await tx.select().from(leads).where(eq(leads.id, created.id));
      expect(afterLead?.designation).toBe("Commodore");
      expect(diffLegacyMirror("LEAD", afterParty!, afterLead!)).toEqual([]);
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

      // Scoped to the two rows this test wrote, via the service's own `after`
      // cursor. Asserting the WHOLE tenant is divergence-free only held while the
      // first organisation happened to have no CRM rows: on the production-shaped
      // seed it reports CONTACT 200 / LEAD 200 — the page size, not a defect — and
      // this read as a mirror bug. The claim being made is about these two writes.
      const report = await new PartyDivergenceService(tx).report(orgId, {
        kinds: ["CLIENT", "CONTACT"],
        after: { CLIENT: client.id - 1, CONTACT: contact.id - 1 },
      });
      // Anti-vacuity: an `after` past the end scans nothing and the filter below
      // is then empty for free, which is the failure this whole test guards.
      expect(report.scanned.CLIENT).toBeGreaterThan(0);
      expect(report.scanned.CONTACT).toBeGreaterThan(0);
      expect(
        report.divergent.filter(
          (row) =>
            (row.kind === "CLIENT" && row.legacyId === client.id) ||
            (row.kind === "CONTACT" && row.legacyId === contact.id),
        ),
      ).toEqual([]);
    });
  });

  it("reports a legacy row somebody wrote behind the mirror's back, and repairs nothing", async () => {
    await withTenant(async (tx, orgId) => {
      const created = await createMirroredLead(tx, orgId, {
        orgId,
        name: "Ada",
        designation: "Head of Computation",
      });

      // A write that did not go through the writer, which is exactly the
      // divergence the check exists to surface.
      await tx.update(leads).set({ designation: "Stale" }).where(eq(leads.id, created.id));

      const service = new PartyDivergenceService(tx);
      // `after` starts the scan at this lead. Unscoped, the seeded tenant fills the
      // 200-row page with older leads and this row never appears — `mine` came back
      // undefined, which reads as "the divergence was not detected" when in fact it
      // was never looked at.
      const scope = { kinds: ["LEAD"] as const, after: { LEAD: created.id - 1 } };
      const report = await service.report(orgId, scope);
      const mine = report.divergent.find((row) => row.legacyId === created.id);

      expect(mine?.fields).toEqual([
        expect.objectContaining({ column: "designation", partyColumn: "jobTitle" }),
      ]);

      // Run it again: still divergent. A check that repaired would go green here
      // and take the evidence of which write path did this with it.
      const second = await service.report(orgId, scope);
      expect(second.divergent.find((row) => row.legacyId === created.id)?.fields).toHaveLength(1);
      const [row] = await tx.select().from(leads).where(eq(leads.id, created.id));
      expect(row?.designation).toBe("Stale");
    });
  });

  it("adopts a legacy row that arrived without a party, rather than refusing the write", async () => {
    await withTenant(async (tx, orgId) => {
      // Inserted straight at the table, as a restore or an out-of-band import
      // would leave it.
      const [orphan] = await tx
        .insert(leads)
        .values({ orgId, name: "Out of band", company: "Elsewhere" })
        .returning();

      const updated = await updateMirroredLead(tx, orgId, orphan!.id, { notes: "now mirrored" });
      expect(updated?.notes).toBe("now mirrored");

      const [map] = await tx
        .select()
        .from(leadPartyMap)
        .where(and(eq(leadPartyMap.organizationId, orgId), eq(leadPartyMap.leadId, orphan!.id)));
      // Recorded as an adoption, so an operator can tell these apart from rows
      // that were always mirrored.
      expect(map?.linkedBy).toBe("mirror:adopt");

      const [party] = await tx
        .select()
        .from(businessParties)
        .where(eq(businessParties.partyId, map!.partyId));
      // The legacy row was read as truth exactly once, which is correct only
      // because there was no party to contradict it.
      expect(party?.companyName).toBe("Elsewhere");
      expect(diffLegacyMirror("LEAD", party!, updated!)).toEqual([]);
    });
  });

  it("keeps the mirror inside the tenant that owns the party", async () => {
    await withTenant(async (tx, orgId) => {
      const created = await createMirroredLead(tx, orgId, { orgId, name: "Tenant check" });
      const [row] = await tx.select().from(leads).where(eq(leads.id, created.id));
      expect(row?.orgId).toBe(orgId);
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

  it("still has the tables this ticket does not touch", async () => {
    // A cheap guard that the fixtures above are hitting the schema the rest of
    // the suite assumes, rather than a database mid-migration.
    await withTenant(async (tx) => {
      await expect(tx.select({ n: sql<number>`1` }).from(clients).limit(1)).resolves.toBeDefined();
      await expect(tx.select({ n: sql<number>`1` }).from(contacts).limit(1)).resolves.toBeDefined();
    });
  });
});
