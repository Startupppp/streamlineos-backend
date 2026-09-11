/**
 * The cross-tenant write `bola-body-id-binding` recorded and nothing repaired.
 *
 * THE DEFECT. `createEventSchema` validates `linkedDealId` and `linkedLeadId` as positive
 * integers and nothing more, and both travelled straight into the `calendar_events` insert
 * literal beside `orgId`. That is the shape the body-id sweep calls `written-unresolved`: the
 * tenant column on the row being WRITTEN says nothing about the tenant of the row being
 * REFERENCED. `PUT /calendar/events/{eventId}` carried the same two fields through
 * `updateData` and the sweep never even saw that one, because the field name reaches the
 * `.set()` through a `Record<string, unknown>`.
 *
 * WHY THE DATABASE DOES NOT CATCH IT. Measured in `pg_constraint`, not inferred — the
 * `refuses nothing on its own` case below re-measures it every run:
 *
 *   fk_calendar_events_linked_deal  FOREIGN KEY (linked_deal_id) REFERENCES deals(id)
 *   fk_calendar_events_linked_lead  FOREIGN KEY (linked_lead_id) REFERENCES leads(id)
 *
 * Single-column references with no `org_id` in them — `bare-fk` in
 * `test/security/bola/live/body-id-integrity.json`. So another organisation's deal id LANDS,
 * while an id belonging to nobody raises 23503. Both consequences follow: a cross-tenant write,
 * and an existence oracle in the difference between the two answers.
 *
 * WHY THIS IS A `.db.spec.ts` AND NOT A UNIT TEST. A mocked `db` answers whatever it was told
 * to; it cannot demonstrate that the row the guard refuses is a row Postgres would otherwise
 * have accepted. The `refuses nothing on its own` case writes the cross-tenant event for real
 * and asserts the database took it — that is the anti-vacuity proof, and it is what makes the
 * refusals below mean something.
 *
 * ANTI-VACUITY, second half: this connects as the OWNER role deliberately. `deals` and `leads`
 * both carry `relrowsecurity = t`; under the app role RLS alone would hide the other tenant's
 * row and every assertion here would pass with the guard deleted. The `sees both tenants` case
 * pins that this connection can in fact read org B's deal, so a guard that did nothing would be
 * observed doing nothing.
 *
 * Run with:
 *   DATABASE_URL=postgres://neondb_owner@localhost:5432/scratch_gates_head \
 *     npx jest --config jest-db.json --runInBand --forceExit --testPathPattern="calendar-linked-crm-tenant-binding"
 *
 * Everything happens inside a transaction that is rolled back, fixtures included.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { NotFoundException } from "@nestjs/common";
import { assertLinkedCrmRecordsInOrg } from "./calendar-linked-crm";
import type { TenantTx } from "../../db/drizzle.types";

jest.setTimeout(120_000);

class Rollback extends Error {}

function connect() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("calendar-linked-crm-tenant-binding.db.spec.ts requires DATABASE_URL");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 1,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

type Seed = {
  orgA: string;
  orgB: string;
  dealA: number;
  dealB: number;
  leadA: number;
  leadB: number;
  membershipA: number;
};

/**
 * Two organisations, each with one deal and one lead, plus a member of A to author an event.
 *
 * `organizations.owner_membership_id` is NOT NULL behind a DEFERRABLE INITIALLY DEFERRED
 * composite FK back to `organization_members`, so a placeholder is legal until COMMIT — and
 * this transaction never commits.
 */
async function seed(tx: TenantTx): Promise<Seed> {
  const orgA = `t22-a-${randomUUID()}`;
  const orgB = `t22-b-${randomUUID()}`;
  const userA = `t22-u-${randomUUID()}`;
  for (const org of [orgA, orgB])
    await tx.execute(
      sql`insert into organizations (id, name, slug, owner_membership_id) values (${org}, ${org}, ${org}, 0)`,
    );
  await tx.execute(sql`insert into users (id, email) values (${userA}, ${`${userA}@example.test`})`);
  const memberRows = await tx.execute(
    sql`insert into organization_members (user_id, org_id, role) values (${userA}, ${orgA}, 'MEMBER') returning id`,
  );
  const ids: Record<string, number> = {};
  for (const [key, org] of [
    ["dealA", orgA],
    ["dealB", orgB],
  ] as const) {
    const rows = await tx.execute(
      sql`insert into deals (org_id, name, value_minor) values (${org}, ${key}, 0) returning id`,
    );
    ids[key] = Number((rows as unknown as { id: number }[])[0]?.id);
  }
  for (const [key, org] of [
    ["leadA", orgA],
    ["leadB", orgB],
  ] as const) {
    const rows = await tx.execute(sql`insert into leads (org_id, name) values (${org}, ${key}) returning id`);
    const leadId = Number((rows as unknown as { id: number }[])[0]?.id);
    ids[key] = leadId;
    const partyId = `party-${key}-${randomUUID()}`;
    await tx.execute(
      sql`insert into business_parties (party_id, organization_id, name) values (${partyId}, ${org}, ${key})`,
    );
    await tx.execute(
      sql`insert into lead_party_map (organization_id, lead_id, party_id) values (${org}, ${leadId}, ${partyId})`,
    );
  }
  return {
    orgA,
    orgB,
    dealA: ids.dealA as number,
    dealB: ids.dealB as number,
    leadA: ids.leadA as number,
    leadB: ids.leadB as number,
    membershipA: Number((memberRows as unknown as { id: number }[])[0]?.id),
  };
}

describe("calendar linked deal/lead — tenant binding against a real database", () => {
  let client: ReturnType<typeof connect>;

  beforeAll(() => {
    client = connect();
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  async function inRolledBackTx(body: (tx: TenantTx, s: Seed) => Promise<void>) {
    const db = drizzle(client);
    try {
      await db.transaction(async (tx) => {
        const s = await seed(tx as unknown as TenantTx);
        await body(tx as unknown as TenantTx, s);
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  }

  it("sees both tenants' rows, so a guard that did nothing would be observed doing nothing", async () => {
    await inRolledBackTx(async (tx, s) => {
      const rows = await tx.execute(
        sql`select org_id from deals where id in (${s.dealA}, ${s.dealB}) order by org_id`,
      );
      expect((rows as unknown as { org_id: string }[]).map((r) => r.org_id).sort()).toEqual(
        [s.orgA, s.orgB].sort(),
      );
    });
  });

  it("refuses nothing on its own — the foreign keys are bare, and Postgres takes the cross-tenant row", async () => {
    await inRolledBackTx(async (tx, s) => {
      const fks = await tx.execute(sql`
        select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
        where conrelid = 'calendar_events'::regclass
          and conname in ('fk_calendar_events_linked_deal', 'fk_calendar_events_linked_lead')
      `);
      const defs = (fks as unknown as { conname: string; def: string }[]);
      expect(defs).toHaveLength(2);
      for (const fk of defs) expect(fk.def).not.toMatch(/org_id/);

      await tx.execute(sql`
        insert into calendar_events (org_id, title, start_date, end_date, category, created_by_membership_id, linked_deal_id, linked_lead_id)
        values (${s.orgA}, 'cross-tenant', now(), now(), 'meeting', ${s.membershipA}, ${s.dealB}, ${s.leadB})
      `);
      const landed = await tx.execute(sql`
        select count(*)::int as n from calendar_events
        where org_id = ${s.orgA} and linked_deal_id = ${s.dealB} and linked_lead_id = ${s.leadB}
      `);
      expect(Number((landed as unknown as { n: number }[])[0]?.n)).toBe(1);
    });
  });

  it("refuses another organisation's deal", async () => {
    await inRolledBackTx(async (tx, s) => {
      await expect(assertLinkedCrmRecordsInOrg(tx, s.orgA, s.dealB, null)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it("refuses another organisation's lead", async () => {
    await inRolledBackTx(async (tx, s) => {
      await expect(assertLinkedCrmRecordsInOrg(tx, s.orgA, null, s.leadB)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it("refuses an id belonging to nobody with the SAME answer, so the two cases are indistinguishable", async () => {
    await inRolledBackTx(async (tx, s) => {
      const foreign = await assertLinkedCrmRecordsInOrg(tx, s.orgA, s.dealB, null).catch(
        (error: unknown) => (error as Error).message,
      );
      const absent = await assertLinkedCrmRecordsInOrg(tx, s.orgA, 2_147_483_000, null).catch(
        (error: unknown) => (error as Error).message,
      );
      expect(foreign).toBe("Deal not found");
      expect(absent).toBe(foreign);
    });
  });

  it("CONTROL — accepts the caller's own deal and lead, so the refusals are not blanket", async () => {
    await inRolledBackTx(async (tx, s) => {
      await expect(assertLinkedCrmRecordsInOrg(tx, s.orgA, s.dealA, s.leadA)).resolves.toBeUndefined();
    });
  });

  it("CONTROL — an event that names neither is untouched", async () => {
    await inRolledBackTx(async (tx, s) => {
      await expect(assertLinkedCrmRecordsInOrg(tx, s.orgA, undefined, null)).resolves.toBeUndefined();
    });
  });
});
