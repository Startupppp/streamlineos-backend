import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import { z } from "zod";
import { organizationMembers, projectMembers, projectStatuses, tickets, users } from "src/db/schema";
import { createBuildWorkflowFixture, type BuildWorkflowFixture } from "./build-workflow-fixtures";

describe("[seeded-e2e] Build project list summaries", () => {
  let fixture: BuildWorkflowFixture;
  beforeAll(async () => { fixture = await createBuildWorkflowFixture(); }, 180_000);
  afterAll(async () => { if (fixture) await fixture.close(); }, 120_000);

  it("counts completion by the configured status category, not the status name", async () => {
    await fixture.seeded.seedDb.insert(projectStatuses).values({
      orgId: fixture.home.orgId, projectId: fixture.projectId, name: "SHIPPED", type: "completed",
    });
    await fixture.seeded.seedDb.update(tickets).set({ status: "SHIPPED" })
      .where(and(eq(tickets.orgId, fixture.home.orgId), inArray(tickets.id, fixture.ticketIds.slice(0, 2))));
    await fixture.seeded.seedDb.update(tickets).set({ status: "DONE" })
      .where(and(eq(tickets.orgId, fixture.home.orgId), eq(tickets.id, fixture.ticketIds[2])));
    const response = await request(fixture.seeded.app.getHttpServer()).get("/build")
      .set("Authorization", `Bearer ${fixture.managerToken}`);
    expect(response.status).toBe(200);
    const body = z.object({ data: z.array(z.object({
      id: z.number(), progress: z.object({ total: z.number(), done: z.number(), percentage: z.number() }),
      members: z.array(z.object({ id: z.string() })),
    })) }).parse(response.body);
    const project = body.data.find(row => row.id === fixture.projectId);
    expect(project?.progress).toEqual({ total: 6, done: 2, percentage: 33 });
    expect(project?.members.map(member => member.id)).toEqual([
      fixture.home.members.manager.userId, fixture.home.members.limited.userId,
    ]);
  });

  it("limits project progress to tickets visible through the caller's DataScope", async () => {
    const response = await request(fixture.seeded.app.getHttpServer()).get("/build")
      .set("Authorization", `Bearer ${fixture.limitedToken}`);
    expect(response.status).toBe(200);
    const body = z.object({ data: z.array(z.object({
      id: z.number(), progress: z.object({ total: z.number(), done: z.number(), percentage: z.number() }),
    })) }).parse(response.body);
    expect(body.data.find(row => row.id === fixture.projectId)?.progress)
      .toEqual({ total: 1, done: 0, percentage: 0 });
  });

  it("refreshes a warm project summary after a ticket status mutation", async () => {
    const api = request(fixture.seeded.app.getHttpServer());
    const authorization = { Authorization: `Bearer ${fixture.managerToken}` };
    expect((await api.get("/build").set(authorization)).status).toBe(200);
    const updated = await api.patch(`/build/${fixture.projectId}/tickets/${fixture.ticketIds[0]}`)
      .set(authorization).send({ status: "TODO" });
    expect(updated.status).toBe(200);
    const response = await api.get("/build").set(authorization);
    expect(response.status).toBe(200);
    const body = z.object({ data: z.array(z.object({
      id: z.number(), progress: z.object({ total: z.number(), done: z.number(), percentage: z.number() }),
    })) }).parse(response.body);
    expect(body.data.find(row => row.id === fixture.projectId)?.progress)
      .toEqual({ total: 6, done: 1, percentage: 17 });
  });

  it("returns at most five ordered member previews independently for each project", async () => {
    const people = Array.from({ length: 7 }, () => ({ id: crypto.randomUUID(), email: `${crypto.randomUUID()}@preview.example.test` }));
    await fixture.seeded.seedDb.insert(users).values(people);
    const members = await fixture.seeded.seedDb.insert(organizationMembers)
      .values(people.map(person => ({ orgId: fixture.home.orgId, userId: person.id })))
      .returning({ id: organizationMembers.id, userId: organizationMembers.userId });
    const projectIds = [fixture.projectId, fixture.home.projects.private.projectId];
    await fixture.seeded.seedDb.insert(projectMembers).values(projectIds.flatMap(projectId =>
      members.map(member => ({ orgId: fixture.home.orgId, projectId, membershipId: member.id })),
    ));
    const response = await request(fixture.seeded.app.getHttpServer()).get("/build")
      .set("Authorization", `Bearer ${fixture.managerToken}`);
    expect(response.status).toBe(200);
    const body = z.object({ data: z.array(z.object({ id: z.number(), members: z.array(z.object({ id: z.string() })) })) }).parse(response.body);
    const ordered = members.sort((left, right) => left.id - right.id).map(member => member.userId);
    expect(body.data.find(row => row.id === fixture.projectId)?.members.map(member => member.id))
      .toEqual([fixture.home.members.manager.userId, fixture.home.members.limited.userId, ...ordered.slice(0, 3)]);
    expect(body.data.find(row => row.id === fixture.home.projects.private.projectId)?.members.map(member => member.id))
      .toEqual(ordered.slice(0, 5));
  });
});
