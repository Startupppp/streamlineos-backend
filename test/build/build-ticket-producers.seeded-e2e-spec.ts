import { and, eq, notInArray } from "drizzle-orm";
import request from "supertest";
import { z } from "zod";
import { projectStatuses, tickets } from "src/db/schema";
import { createBuildWorkflowFixture, type BuildWorkflowFixture } from "./build-workflow-fixtures";

const ticketPageSchema = z.object({ data: z.array(z.object({ id: z.number(), type: z.string() })) });

describe("[seeded-e2e] Build ticket producer capacity", () => {
  let fixture: BuildWorkflowFixture;
  beforeAll(async () => { fixture = await createBuildWorkflowFixture(); }, 180_000);
  afterAll(async () => { if (fixture) await fixture.close(); }, 120_000);
  beforeEach(async () => {
    await fixture.seeded.seedDb.delete(tickets).where(and(
      eq(tickets.orgId, fixture.home.orgId), eq(tickets.projectId, fixture.projectId), notInArray(tickets.id, fixture.ticketIds),
    ));
    await fixture.seeded.seedDb.update(projectStatuses).set({ wipLimit: 7 }).where(and(
      eq(projectStatuses.orgId, fixture.home.orgId), eq(projectStatuses.projectId, fixture.projectId), eq(projectStatuses.name, "TODO"),
    ));
  });

  function api() { return request(fixture.seeded.app.getHttpServer()); }
  function importRows(count: number, projectId = fixture.projectId, token = fixture.managerToken) {
    return api().post(`/build/${projectId}/tickets/import`).set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", crypto.randomUUID()).send({ rows: Array.from({ length: count }, (_, index) => ({ title: `Capacity import ${index}`, status: "TODO" })) });
  }
  function createEpic(projectId = fixture.projectId, token = fixture.managerToken) {
    return api().post(`/build/${projectId}/epics`).set("Authorization", `Bearer ${token}`).send({ title: "Capacity epic" });
  }
  async function currentTickets() {
    const response = await api().get(`/build/${fixture.projectId}/tickets`).query({ limit: 100 }).set("Authorization", `Bearer ${fixture.managerToken}`);
    expect(response.status).toBe(200);
    return ticketPageSchema.parse(response.body).data;
  }

  it("rejects an oversized import atomically and allows the final free slot", async () => {
    expect((await importRows(2)).status).toBe(409);
    expect(await currentTickets()).toHaveLength(6);
    const accepted = await importRows(1);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ created: 1, skipped: [] });
    expect(await currentTickets()).toHaveLength(7);
    expect((await importRows(1)).status).toBe(409);
    expect(await currentTickets()).toHaveLength(7);
  });

  it("serializes two epic creations competing for one slot", async () => {
    const results = await Promise.all([createEpic(), createEpic()]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const rows = await currentTickets();
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.type === "EPIC")).toHaveLength(1);
  });

  it("shares the capacity lock across import and epic producers", async () => {
    const [imported, epic] = await Promise.all([importRows(1), createEpic()]);
    expect([[200, 409], [409, 201]]).toContainEqual([imported.status, epic.status]);
    expect(await currentTickets()).toHaveLength(7);
  });

  it("rejects denied actors and foreign projects without producing tickets", async () => {
    expect((await importRows(1, fixture.projectId, fixture.deniedToken)).status).toBe(403);
    expect((await createEpic(fixture.projectId, fixture.deniedToken)).status).toBe(403);
    expect((await importRows(1, fixture.foreignProjectId)).status).toBe(404);
    expect((await createEpic(fixture.foreignProjectId)).status).toBe(404);
    expect(await currentTickets()).toHaveLength(6);
  });

  it("rejects a removed destination status instead of treating it as unlimited", async () => {
    await fixture.seeded.seedDb.update(tickets).set({ status: "IN_PROGRESS" }).where(and(eq(tickets.orgId, fixture.home.orgId), eq(tickets.projectId, fixture.projectId)));
    await fixture.seeded.seedDb.update(projectStatuses).set({ name: "RENAMED" }).where(and(eq(projectStatuses.orgId, fixture.home.orgId), eq(projectStatuses.projectId, fixture.projectId), eq(projectStatuses.name, "TODO")));
    try {
      expect((await createEpic()).status).toBe(409);
      expect(await currentTickets()).toHaveLength(6);
    } finally {
      await fixture.seeded.seedDb.update(projectStatuses).set({ name: "TODO" }).where(and(eq(projectStatuses.orgId, fixture.home.orgId), eq(projectStatuses.projectId, fixture.projectId), eq(projectStatuses.name, "RENAMED")));
    }
  });

  it("rejects creation in a project without a configured destination status", async () => {
    expect((await createEpic(fixture.home.projects.private.projectId)).status).toBe(409);
  });
});
