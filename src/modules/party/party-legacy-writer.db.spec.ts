/**
 * Real-database tests for the dual-write window's central claim: that a legacy
 * row and the Party it mirrors cannot be observed disagreeing, because they are
 * written in one transaction with the Party first.
 *
 * Run via `pnpm test:db-specs`. The default hermetic jest config ignores this file.
 *   DATABASE_URL=... npx jest --config jest-db.json --runInBand --testPathPattern="party-legacy-writer.db"
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
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { requireApprovedDatabaseUrl } from "../../test/db-spec-guard";
import postgres from "postgres";
import * as schema from "../../db/schema";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  contactPartyMap,
  leadPartyMap,
  partyIdentifiers,
  partyRoles,
} from "../../db/schema/party";
import { clients, contacts, crmOrganizations } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
import { PartyDivergenceService } from "./party-divergence.service";
import { diffLegacyMirror, LEAD_MIRROR } from "./party-legacy-mirror";
import { updatePartyWithMirror } from "./party-legacy-writer";
import {
  createMirroredLead,
  softDeleteMirroredLeads,
  updateMirroredLead,
  updateMirroredLeads,
} from "./party-legacy-leads";
import { createMirroredClient } from "./party-legacy-clients";
import { createMirroredContact } from "./party-legacy-contacts";
import { createMirroredOrganization } from "./party-legacy-orgs";
import { refreshEmployerColumns } from "./party-legacy-employer";

jest.setTimeout(60_000);

/** Thrown to roll the transaction back once the assertions have run. */
class Rollback extends Error {}

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "party-legacy-writer.db.spec.ts",
    vars: ["DATABASE_URL"],
  });
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

describe("party-legacy-writer — real database", () => {
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
          throw new Error("party-legacy-writer.db.spec.ts requires at least one seeded organization");
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

  it("soft-deletes two leads in one batch, and both mirrors agree", async () => {
    await withTenant(async (tx, orgId) => {
      const first = await createMirroredLead(tx, orgId, { orgId, name: "Batch One" });
      const second = await createMirroredLead(tx, orgId, { orgId, name: "Batch Two" });
      expect(first.id).not.toBe(second.id);

      const deleted = await softDeleteMirroredLeads(tx, orgId, [first.id, second.id]);

      expect(deleted).toHaveLength(2);
      expect(deleted.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
      for (const row of deleted) expect(row.deletedAt).toBeInstanceOf(Date);

      const maps = await tx
        .select()
        .from(leadPartyMap)
        .where(
          and(
            eq(leadPartyMap.organizationId, orgId),
            inArray(leadPartyMap.leadId, [first.id, second.id]),
          ),
        );
      expect(maps).toHaveLength(2);

      const partyIds = maps.map((row) => row.partyId);
      expect(new Set(partyIds).size).toBe(2);

      const parties = await tx
        .select()
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, orgId),
            inArray(businessParties.partyId, partyIds),
          ),
        );
      expect(parties).toHaveLength(2);
      for (const party of parties) expect(party.deletedAt).toBeInstanceOf(Date);

      const rows = await tx
        .select()
        .from(leads)
        .where(and(eq(leads.orgId, orgId), inArray(leads.id, [first.id, second.id])));
      expect(rows.map((row) => row.name).sort()).toEqual(["Batch One", "Batch Two"]);
      for (const row of rows) expect(row.deletedAt).toBeInstanceOf(Date);
    });
  });

  it("claims a shared address once when two parties are updated in one statement", async () => {
    await withTenant(async (tx, orgId) => {
      const first = await createMirroredLead(tx, orgId, { orgId, name: "Sharer One" });
      const second = await createMirroredLead(tx, orgId, { orgId, name: "Sharer Two" });

      const shared = `shared-${randomUUID().slice(0, 8)}@example.test`;
      const updated = await updateMirroredLeads(tx, orgId, [first.id, second.id], {
        email: shared.toUpperCase(),
      });
      expect(updated).toHaveLength(2);
      for (const row of updated) expect(row.email).toBe(shared.toUpperCase());

      const maps = await tx
        .select()
        .from(leadPartyMap)
        .where(
          and(
            eq(leadPartyMap.organizationId, orgId),
            inArray(leadPartyMap.leadId, [first.id, second.id]),
          ),
        );
      const partyIds = maps.map((row) => row.partyId);
      expect(new Set(partyIds).size).toBe(2);

      const claims = await tx
        .select()
        .from(partyIdentifiers)
        .where(
          and(
            eq(partyIdentifiers.organizationId, orgId),
            eq(partyIdentifiers.normalisedValue, shared),
          ),
        );

      expect(claims).toHaveLength(1);
      expect(claims[0]?.kind).toBe("email");
      expect(partyIds).toContain(claims[0]?.partyId);

      const held = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(partyIdentifiers)
        .where(
          and(
            eq(partyIdentifiers.organizationId, orgId),
            inArray(partyIdentifiers.partyId, partyIds),
          ),
        );
      expect(held[0]?.n).toBe(1);
    });
  });

  it("gives each contact its own employer id in one bulk update", async () => {
    await withTenant(async (tx, orgId) => {
      const marker = randomUUID().slice(0, 8);
      const employerOne = await createMirroredOrganization(tx, orgId, {
        orgId,
        name: `Employer A ${marker}`,
      });
      const employerTwo = await createMirroredOrganization(tx, orgId, {
        orgId,
        name: `Employer B ${marker}`,
      });
      expect(employerOne.id).not.toBe(employerTwo.id);

      const contactOne = await createMirroredContact(tx, orgId, {
        orgId,
        name: `Employee A ${marker}`,
        organizationId: employerOne.id,
      });
      const contactTwo = await createMirroredContact(tx, orgId, {
        orgId,
        name: `Employee B ${marker}`,
        organizationId: employerTwo.id,
      });

      const maps = await tx
        .select()
        .from(contactPartyMap)
        .where(
          and(
            eq(contactPartyMap.organizationId, orgId),
            inArray(contactPartyMap.contactId, [contactOne.id, contactTwo.id]),
          ),
        );
      const partyOf = new Map(maps.map((row) => [row.contactId, row.partyId]));
      const partyOne = partyOf.get(contactOne.id);
      const partyTwo = partyOf.get(contactTwo.id);
      expect(typeof partyOne).toBe("string");
      expect(typeof partyTwo).toBe("string");
      expect(partyOne).not.toBe(partyTwo);

      await tx
        .update(contacts)
        .set({ organizationId: null })
        .where(
          and(eq(contacts.orgId, orgId), inArray(contacts.id, [contactOne.id, contactTwo.id])),
        );
      const cleared = await tx
        .select({ id: contacts.id, organizationId: contacts.organizationId })
        .from(contacts)
        .where(
          and(eq(contacts.orgId, orgId), inArray(contacts.id, [contactOne.id, contactTwo.id])),
        );
      expect(cleared.map((row) => row.organizationId)).toEqual([null, null]);

      await refreshEmployerColumns(tx, orgId, [String(partyOne), String(partyTwo)]);

      const repaired = await tx
        .select({ id: contacts.id, organizationId: contacts.organizationId })
        .from(contacts)
        .where(
          and(eq(contacts.orgId, orgId), inArray(contacts.id, [contactOne.id, contactTwo.id])),
        );
      const byContact = new Map(repaired.map((row) => [row.id, row.organizationId]));
      expect(byContact.get(contactOne.id)).toBe(employerOne.id);
      expect(byContact.get(contactTwo.id)).toBe(employerTwo.id);
      expect(byContact.get(contactOne.id)).not.toBe(byContact.get(contactTwo.id));

      const employers = await tx
        .select({ id: crmOrganizations.id, name: crmOrganizations.name })
        .from(crmOrganizations)
        .where(
          and(
            eq(crmOrganizations.orgId, orgId),
            inArray(crmOrganizations.id, [employerOne.id, employerTwo.id]),
          ),
        );
      expect(employers).toHaveLength(2);
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
