import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { supportTickets, supportTicketWatchers } from "src/db/schema";
import { createSeededE2eApp, signSeededToken, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * `support_ticket_watchers.user_id` was NOT NULL in the database and absent from the Drizzle
 * declaration, so every `POST /support/:supportTicketId/follow` inserted a row without it and
 * raised 23502 — a 500 for every caller, in every tenant. Migration 1046 contracts the pair onto
 * `user_membership_id`. This pins the route answering, and pins the cross-tenant answer at 404.
 */
describe("[seeded-e2e] POST /support/:supportTicketId/follow", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeTicketId = 0;
  let neighbourTicketId = 0;
  let token = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("support")
      .addMember("agent", { permissionKeys: ["support:tickets:view"] })
      .build();
    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("support")
      .addMember("agent", { permissionKeys: ["support:tickets:view"] })
      .build();

    const [homeTicket] = await seeded.seedDb
      .insert(supportTickets)
      .values({
        orgId: home.orgId,
        title: "follow-contract home ticket",
        createdByMembershipId: home.members.agent.membershipId,
      })
      .returning({ id: supportTickets.id });
    const [neighbourTicket] = await seeded.seedDb
      .insert(supportTickets)
      .values({
        orgId: neighbour.orgId,
        title: "follow-contract neighbour ticket",
        createdByMembershipId: neighbour.members.agent.membershipId,
      })
      .returning({ id: supportTickets.id });
    homeTicketId = homeTicket?.id ?? 0;
    neighbourTicketId = neighbourTicket?.id ?? 0;

    token = await signSeededToken(seeded, home.members.agent.userId, home.orgId);
  }, 180_000);

  afterAll(async () => {
    if (homeTicketId > 0)
      await seeded.seedDb.delete(supportTicketWatchers).where(eq(supportTicketWatchers.ticketId, homeTicketId));
    if (homeTicketId > 0)
      await seeded.seedDb.delete(supportTickets).where(eq(supportTickets.id, homeTicketId));
    if (neighbourTicketId > 0)
      await seeded.seedDb.delete(supportTickets).where(eq(supportTickets.id, neighbourTicketId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("records the caller's membership as a watcher instead of raising 23502", async () => {
    const response = await request(server as never)
      .post(`/support/${String(homeTicketId)}/follow`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(200);

    const rows = await seeded.seedDb
      .select({ membershipId: supportTicketWatchers.userMembershipId })
      .from(supportTicketWatchers)
      .where(
        and(
          eq(supportTicketWatchers.orgId, home.orgId),
          eq(supportTicketWatchers.ticketId, homeTicketId),
        ),
      );
    expect(rows).toEqual([{ membershipId: home.members.agent.membershipId }]);
  }, 60_000);

  it("is idempotent — a second follow does not duplicate the watcher", async () => {
    const response = await request(server as never)
      .post(`/support/${String(homeTicketId)}/follow`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(200);

    const rows = await seeded.seedDb
      .select({ id: supportTicketWatchers.id })
      .from(supportTicketWatchers)
      .where(
        and(
          eq(supportTicketWatchers.orgId, home.orgId),
          eq(supportTicketWatchers.ticketId, homeTicketId),
        ),
      );
    expect(rows).toHaveLength(1);
  }, 60_000);

  it("answers 404, never 403, for a ticket owned by another organisation", async () => {
    const response = await request(server as never)
      .post(`/support/${String(neighbourTicketId)}/follow`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", randomUUID());

    expect(response.status).toBe(404);

    const rows = await seeded.seedDb
      .select({ id: supportTicketWatchers.id })
      .from(supportTicketWatchers)
      .where(eq(supportTicketWatchers.ticketId, neighbourTicketId));
    expect(rows).toEqual([]);
  }, 60_000);
});
