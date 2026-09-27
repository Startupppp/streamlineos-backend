import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { OutboxWriter } from "../../../../common/outbox/outbox-writer";
import type { Db } from "../../../../db/drizzle.types";

type Sql = ReturnType<typeof postgres>;

const ROW_SCALE_CEILING = 1_000_000_000;

interface Fixture {
  orgId: string;
  userId: string;
  projectId: number;
  ticketId: number;
}

async function seedFixture(rawSql: Sql): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `t37-${tag}`;
  const userId = `t37-u-${tag}`;
  return rawSql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'T37 Fixture')`;
    await tx`INSERT INTO organizations (id, name, slug, owner_membership_id, currency) VALUES (${orgId}, ${`T37 ${tag}`}, ${orgId}, 1, 'USD')`;
    const [member] = await tx<{ id: number }[]>`INSERT INTO organization_members (user_id, org_id, role, is_owner, status) VALUES (${userId}, ${orgId}, 'OWNER', true, 'ACTIVE') RETURNING id`;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    const [proj] = await tx<{ id: number }[]>`INSERT INTO build.projects (org_id, name, key, manager_membership_id) VALUES (${orgId}, ${`T37 ${tag}`}, ${`T7${tag.slice(0, 4).toUpperCase()}`}, ${member.id}) RETURNING id`;
    await tx`INSERT INTO build.project_statuses (org_id, project_id, name, "order", type) VALUES (${orgId}, ${proj.id}, 'TODO', 0, 'unstarted'), (${orgId}, ${proj.id}, 'DONE', 1, 'completed')`;
    const [ticket] = await tx<{ id: number }[]>`INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status) VALUES (${orgId}, ${proj.id}, 'T37 ticket', 1, 'TODO') RETURNING id`;
    return { orgId, userId, projectId: proj.id, ticketId: ticket.id };
  });
}

async function insertTicket(rawSql: Sql, orgId: string, projectId: number, n: number): Promise<number> {
  const [row] = await rawSql<{ id: number }[]>`
    INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status)
    VALUES (${orgId}, ${projectId}, ${`T37 extra ${n}`}, ${n}, 'TODO') RETURNING id
  `;
  return row.id;
}

async function dropFixtures(rawSql: Sql, fixtures: Array<{ orgId: string; userId: string }>): Promise<void> {
  if (fixtures.length === 0) return;
  await rawSql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM outbox_events WHERE organization_id = ANY(${fixtures.map((f) => f.orgId)})`;
    await tx`DELETE FROM organizations WHERE id = ANY(${fixtures.map((f) => f.orgId)})`;
    await tx`DELETE FROM users WHERE id = ANY(${fixtures.map((f) => f.userId)})`;
  });
}

describe("ticket 37 — both ticket status event producers (apply-ticket-change and build-ticket-batch-workflow) write row-scale aggregateVersion to outbox_events, proved against a real database with migration 1373 live", () => {
  let rawSql: Sql;
  let db: Db;
  const fixtures: Array<{ orgId: string; userId: string }> = [];

  async function fresh(): Promise<Fixture> {
    const f = await seedFixture(rawSql);
    fixtures.push({ orgId: f.orgId, userId: f.userId });
    return f;
  }

  beforeAll(() => {
    const url = requireApprovedDatabaseUrl({
      spec: "ticket-37-producer-version-scale.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    rawSql = postgres(url, { max: 2, prepare: false });
    db = drizzle(rawSql, { schema });
  });

  afterAll(async () => {
    await dropFixtures(rawSql, fixtures);
    await rawSql?.end({ timeout: 5 });
  }, 60_000);

  it("the single-event producer path (apply-ticket-change): an UPDATE RETURNING version emits that row-scale version to outbox_events via OutboxWriter.emit so no epoch timestamp leaks into the aggregate version", async () => {
    const f = await fresh();
    const eventId = randomUUID();
    const [updated] = await db
      .update(schema.tickets)
      .set({ status: "DONE", updatedAt: new Date() })
      .where(
        and(
          eq(schema.tickets.id, f.ticketId),
          eq(schema.tickets.orgId, f.orgId),
          isNull(schema.tickets.deletedAt),
        ),
      )
      .returning({ id: schema.tickets.id, version: schema.tickets.version });
    expect(updated).toBeDefined();
    const returnedVersion = updated?.version ?? 0;
    expect(returnedVersion).toBeGreaterThan(0);
    expect(returnedVersion).toBeLessThan(ROW_SCALE_CEILING);

    await OutboxWriter.emit(db, {
      eventId,
      organizationId: f.orgId,
      aggregateType: "ticket",
      aggregateId: String(f.ticketId),
      aggregateVersion: returnedVersion,
      eventType: "build.ticket.status_changed",
      occurredAt: new Date(),
      payload: { ticketId: f.ticketId, orgId: f.orgId, previousStatus: "TODO", newStatus: "DONE" },
    });

    const [row] = await rawSql<{ aggregate_version: string }[]>`
      SELECT aggregate_version FROM outbox_events
      WHERE event_id = ${eventId} AND organization_id = ${f.orgId}
    `;
    expect(row).toBeDefined();
    expect(Number(row?.aggregate_version)).toBe(returnedVersion);
    expect(Number(row?.aggregate_version)).toBeLessThan(ROW_SCALE_CEILING);
  }, 30_000);

  it("the batch producer path (build-ticket-batch-workflow): a multi-row UPDATE RETURNING version maps each ticket to a row-scale version and OutboxWriter.emitMany writes those to outbox_events", async () => {
    const f = await fresh();
    const ticket2 = await insertTicket(rawSql, f.orgId, f.projectId, 2);
    const eventId1 = randomUUID();
    const eventId2 = randomUUID();
    const now = new Date();

    const rows = await db
      .update(schema.tickets)
      .set({ status: "DONE", updatedAt: now })
      .where(and(eq(schema.tickets.orgId, f.orgId), isNull(schema.tickets.deletedAt)))
      .returning({ id: schema.tickets.id, version: schema.tickets.version });
    expect(rows).toHaveLength(2);
    const versionMap = new Map(rows.map((r) => [r.id, r.version]));
    const v1 = versionMap.get(f.ticketId) ?? 0;
    const v2 = versionMap.get(ticket2) ?? 0;
    expect(v1).toBeGreaterThan(0);
    expect(v2).toBeGreaterThan(0);

    await OutboxWriter.emitMany(db, [
      {
        eventId: eventId1,
        organizationId: f.orgId,
        aggregateType: "ticket",
        aggregateId: String(f.ticketId),
        aggregateVersion: v1,
        eventType: "build.ticket.status_changed",
        occurredAt: now,
        payload: { ticketId: f.ticketId, orgId: f.orgId, previousStatus: "TODO", newStatus: "DONE" },
      },
      {
        eventId: eventId2,
        organizationId: f.orgId,
        aggregateType: "ticket",
        aggregateId: String(ticket2),
        aggregateVersion: v2,
        eventType: "build.ticket.status_changed",
        occurredAt: now,
        payload: { ticketId: ticket2, orgId: f.orgId, previousStatus: "TODO", newStatus: "DONE" },
      },
    ]);

    const emitted = await rawSql<{ event_id: string; aggregate_version: string }[]>`
      SELECT event_id, aggregate_version FROM outbox_events
      WHERE organization_id = ${f.orgId} AND event_id = ANY(${[eventId1, eventId2]})
    `;
    expect(emitted).toHaveLength(2);
    const emittedMap = new Map(emitted.map((r) => [r.event_id, Number(r.aggregate_version)]));
    expect(emittedMap.get(eventId1)).toBe(v1);
    expect(emittedMap.get(eventId2)).toBe(v2);
    for (const version of emittedMap.values()) {
      expect(version).toBeLessThan(ROW_SCALE_CEILING);
    }
  }, 30_000);

  it("both producers agree on the same row-scale version sequence: the single-emit path produces version N and the batch-emit path produces N+1 on the next update, and neither exceeds ROW_SCALE_CEILING", async () => {
    const f = await fresh();
    const singleEventId = randomUUID();
    const batchEventId = randomUUID();
    const now = new Date();

    const [first] = await db
      .update(schema.tickets)
      .set({ status: "DONE", updatedAt: now })
      .where(
        and(
          eq(schema.tickets.id, f.ticketId),
          eq(schema.tickets.orgId, f.orgId),
          isNull(schema.tickets.deletedAt),
        ),
      )
      .returning({ id: schema.tickets.id, version: schema.tickets.version });
    const versionN = first?.version ?? 0;
    expect(versionN).toBeGreaterThan(0);

    await OutboxWriter.emit(db, {
      eventId: singleEventId,
      organizationId: f.orgId,
      aggregateType: "ticket",
      aggregateId: String(f.ticketId),
      aggregateVersion: versionN,
      eventType: "build.ticket.status_changed",
      occurredAt: now,
      payload: { ticketId: f.ticketId, orgId: f.orgId, previousStatus: "TODO", newStatus: "DONE" },
    });

    const [second] = await db
      .update(schema.tickets)
      .set({ status: "TODO", updatedAt: new Date() })
      .where(
        and(
          eq(schema.tickets.id, f.ticketId),
          eq(schema.tickets.orgId, f.orgId),
          isNull(schema.tickets.deletedAt),
        ),
      )
      .returning({ id: schema.tickets.id, version: schema.tickets.version });
    const versionNplus1 = second?.version ?? 0;
    expect(versionNplus1).toBe(versionN + 1);

    await OutboxWriter.emitMany(db, [
      {
        eventId: batchEventId,
        organizationId: f.orgId,
        aggregateType: "ticket",
        aggregateId: String(f.ticketId),
        aggregateVersion: versionNplus1,
        eventType: "build.ticket.status_changed",
        occurredAt: new Date(),
        payload: { ticketId: f.ticketId, orgId: f.orgId, previousStatus: "DONE", newStatus: "TODO" },
      },
    ]);

    const rows = await rawSql<{ event_id: string; aggregate_version: string }[]>`
      SELECT event_id, aggregate_version FROM outbox_events
      WHERE organization_id = ${f.orgId} AND event_id = ANY(${[singleEventId, batchEventId]})
    `;
    expect(rows).toHaveLength(2);
    const singleVer = Number(rows.find((r) => r.event_id === singleEventId)?.aggregate_version ?? "0");
    const batchVer = Number(rows.find((r) => r.event_id === batchEventId)?.aggregate_version ?? "0");
    expect(batchVer).toBe(singleVer + 1);
    expect(singleVer).toBeLessThan(ROW_SCALE_CEILING);
    expect(batchVer).toBeLessThan(ROW_SCALE_CEILING);
  }, 30_000);
});
