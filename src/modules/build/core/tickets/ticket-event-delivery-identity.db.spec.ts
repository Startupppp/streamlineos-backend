import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { InboxConsumer } from "../../../../common/outbox/inbox-consumer";
import type { Db } from "../../../../db/drizzle.types";

type Sql = ReturnType<typeof postgres>;

const CONSUMER = "build.ticket.status-projector";

interface Fixture {
  orgId: string;
  userId: string;
  ticketId: number;
}

async function seed(sql: Sql): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const orgId = `ted-${tag}`;
  const userId = `ted-u-${tag}`;

  return sql.begin(async (tx) => {
    await tx`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${userId}@example.test`}, 'Event Delivery Fixture')`;
    await tx`
      INSERT INTO organizations (id, name, slug, owner_membership_id, currency)
      VALUES (${orgId}, ${`EventDelivery ${tag}`}, ${orgId}, 1, 'USD')
    `;
    const [member] = await tx<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status)
      VALUES (${userId}, ${orgId}, 'OWNER', true, 'ACTIVE') RETURNING id
    `;
    await tx`UPDATE organizations SET owner_membership_id = ${member.id} WHERE id = ${orgId}`;
    const [project] = await tx<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key, manager_membership_id)
      VALUES (${orgId}, ${`TED ${tag}`}, ${`TE${tag.slice(0, 4).toUpperCase()}`}, ${member.id})
      RETURNING id
    `;
    await tx`
      INSERT INTO build.project_statuses (org_id, project_id, name, "order", type)
      VALUES (${orgId}, ${project.id}, 'TODO', 0, 'unstarted')
    `;
    const [ticket] = await tx<{ id: number }[]>`
      INSERT INTO build.tickets (org_id, project_id, title, ticket_number, status)
      VALUES (${orgId}, ${project.id}, 'TED ticket', 1, 'TODO') RETURNING id
    `;
    return { orgId, userId, ticketId: ticket.id };
  });
}

async function drop(sql: Sql, fixtures: Fixture[]): Promise<void> {
  if (fixtures.length === 0) return;
  const orgIds = fixtures.map((f) => f.orgId);
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM inbox_records WHERE organization_id = ANY(${orgIds})`;
    await tx`DELETE FROM organizations WHERE id = ANY(${orgIds})`;
    await tx`DELETE FROM organization_members WHERE org_id = ANY(${orgIds})`;
    await tx`DELETE FROM users WHERE id = ANY(${fixtures.map((f) => f.userId)})`;
  });
}

describe("ticket status event delivery: identity is unique, redelivery is idempotent, and a superseded late event is recorded as skipped rather than silently dropped", () => {
  let rawSql: Sql;
  let db: Db;
  const fixtures: Fixture[] = [];

  const event = (f: Fixture, eventId: string, aggregateVersion: number) => ({
    eventId,
    organizationId: f.orgId,
    aggregateType: "ticket",
    aggregateId: String(f.ticketId),
    aggregateVersion,
  });

  const statusOf = async (eventId: string) => {
    const rows = await rawSql<{ status: string }[]>`
      SELECT status FROM inbox_records
      WHERE producer_event_id = ${eventId} AND consumer_name = ${CONSUMER}
    `;
    return rows.map((r) => r.status);
  };

  const complete = async (eventId: string) => {
    await rawSql`
      UPDATE inbox_records SET status = 'COMPLETED'
      WHERE producer_event_id = ${eventId} AND consumer_name = ${CONSUMER}
    `;
  };

  beforeAll(async () => {
    const url = requireApprovedDatabaseUrl({
      spec: "ticket-event-delivery-identity.db.spec.ts",
      vars: ["DATABASE_URL"],
    });
    rawSql = postgres(url, { max: 4, prepare: false });
    db = drizzle(rawSql, { schema });
  }, 60_000);

  afterAll(async () => {
    await drop(rawSql, fixtures);
    await rawSql?.end({ timeout: 5 });
  }, 60_000);

  async function fresh(): Promise<Fixture> {
    const f = await seed(rawSql);
    fixtures.push(f);
    return f;
  }

  it("admits exactly one of two concurrent claims of the same event, because identity is enforced by a unique index and not by a read-then-write", async () => {
    const f = await fresh();
    const consumer = new InboxConsumer(db);
    const eventId = randomUUID();

    const [a, b] = await Promise.all([
      consumer.claim(CONSUMER, event(f, eventId, 3)),
      consumer.claim(CONSUMER, event(f, eventId, 3)),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await statusOf(eventId)).toHaveLength(1);
  }, 30_000);

  it("admits both of two concurrent claims of two distinct events on the same ticket, so the control above is identity and not a per-ticket lock", async () => {
    const f = await fresh();
    const consumer = new InboxConsumer(db);
    const first = randomUUID();
    const second = randomUUID();

    const [a, b] = await Promise.all([
      consumer.claim(CONSUMER, event(f, first, 4)),
      consumer.claim(CONSUMER, event(f, second, 5)),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
  }, 30_000);

  it("refuses a redelivery of an event it has already completed, so applying it twice is impossible", async () => {
    const f = await fresh();
    const consumer = new InboxConsumer(db);
    const eventId = randomUUID();

    expect(await consumer.claim(CONSUMER, event(f, eventId, 7))).toBe(true);
    await complete(eventId);

    expect(await consumer.claim(CONSUMER, event(f, eventId, 7))).toBe(false);
    expect(await statusOf(eventId)).toEqual(["COMPLETED"]);
  }, 30_000);

  it("records a superseded late event as SKIPPED rather than dropping it, so the decision to not apply it is observable afterwards", async () => {
    const f = await fresh();
    const consumer = new InboxConsumer(db);
    const newer = randomUUID();
    const late = randomUUID();

    expect(await consumer.claim(CONSUMER, event(f, newer, 9))).toBe(true);
    await complete(newer);

    expect(await consumer.claim(CONSUMER, event(f, late, 4))).toBe(false);
    expect(await statusOf(late)).toEqual(["SKIPPED"]);
  }, 30_000);

  it("admits a later event after a completed one, so the skip above is the ordering policy and not a stuck watermark", async () => {
    const f = await fresh();
    const consumer = new InboxConsumer(db);
    const earlier = randomUUID();
    const later = randomUUID();

    expect(await consumer.claim(CONSUMER, event(f, earlier, 2))).toBe(true);
    await complete(earlier);

    expect(await consumer.claim(CONSUMER, event(f, later, 3))).toBe(true);
  }, 30_000);

  it("keeps the watermark per ticket, so a completed event on one ticket cannot skip an event on another", async () => {
    const f = await fresh();
    const other = await fresh();
    const consumer = new InboxConsumer(db);
    const high = randomUUID();
    const lowOnOtherTicket = randomUUID();

    expect(await consumer.claim(CONSUMER, event(f, high, 50))).toBe(true);
    await complete(high);

    expect(await consumer.claim(CONSUMER, event(other, lowOnOtherTicket, 2))).toBe(true);
  }, 30_000);

  it("keeps the watermark per consumer, so one consumer completing an event cannot skip the same event for another", async () => {
    const f = await fresh();
    const consumer = new InboxConsumer(db);
    const eventId = randomUUID();

    expect(await consumer.claim(CONSUMER, event(f, eventId, 11))).toBe(true);
    await complete(eventId);

    expect(await consumer.claim("build.ticket.other-projector", event(f, eventId, 11))).toBe(true);
  }, 30_000);
});
