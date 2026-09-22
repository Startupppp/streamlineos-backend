import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { z } from "zod";
import { encodeCursor } from "src/common/pagination/cursor";
import { cycles, projectStatuses, sprintScopeEvents, tickets, workItemRelations } from "src/db/schema";
import { createBuildWorkflowFixture, type BuildWorkflowFixture } from "./build-workflow-fixtures";

describe("[seeded-e2e] Build report correctness and bounds", () => {
  let f: BuildWorkflowFixture;

  beforeAll(async () => { f = await createBuildWorkflowFixture(); }, 180_000);
  afterAll(async () => { if (f) await f.close(); }, 120_000);

  it("counts custom completed statuses in cycle and lead time", async () => {
    await f.seeded.seedDb.insert(projectStatuses).values({ orgId: f.home.orgId, projectId: f.projectId, name: "Shipped", type: "completed" });
    await f.seeded.seedDb.update(tickets).set({ status: "Shipped", updatedAt: new Date() })
      .where(and(eq(tickets.orgId, f.home.orgId), eq(tickets.id, f.ticketIds[0])));
    for (const report of ["cycle-time", "lead-time"]) {
      const response = await request(f.seeded.app.getHttpServer())
        .get(`/build/${f.projectId}/reports/${report}`).set("Authorization", `Bearer ${f.managerToken}`);
      expect(response.status).toBe(200);
      const rows = z.array(z.object({ count: z.number() })).parse(response.body);
      expect(rows.reduce((count, row) => count + row.count, 0)).toBe(1);
    }
  });

  it("paginates tied cycle timestamps without duplicates after a concurrent newer cycle", async () => {
    const cycleRows: (typeof cycles.$inferInsert)[] = Array.from({ length: 3 }, (_, index) => ({
      orgId: f.home.orgId, projectId: f.projectId, name: `Velocity ${index}`, status: "completed",
      startDate: "2026-09-01", endDate: "2026-09-08", createdBy: f.home.members.manager.userId,
    }));
    const inserted = await f.seeded.seedDb.insert(cycles).values(cycleRows).returning({ id: cycles.id });
    await f.seeded.seedDb.update(cycles).set({ startDate: sql`'2026-09-01'::date` })
      .where(and(eq(cycles.orgId, f.home.orgId), eq(cycles.projectId, f.projectId)));
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const response = await request(f.seeded.app.getHttpServer()).get(`/build/${f.projectId}/reports/velocity`)
        .query({ limit: 1, ...(cursor ? { cursor } : {}) }).set("Authorization", `Bearer ${f.managerToken}`);
      expect(response.status).toBe(200);
      const data = z.array(z.object({ cycleId: z.number() })).parse(response.body);
      expect(data).toHaveLength(1);
      seen.push(...data.map(row => row.cycleId));
      cursor = response.headers["x-next-cursor"];
      expect(response.headers["x-has-more"]).toBe(String(page < 2));
      if (page === 0) {
        expect(response.headers["link"]).toContain('rel="next"');
        expect(response.headers["access-control-expose-headers"]).toContain("X-Next-Cursor");
        await f.seeded.seedDb.insert(cycles).values({ orgId: f.home.orgId, projectId: f.projectId, name: "Concurrent cycle", status: "completed", startDate: "2026-09-02", endDate: "2026-09-09", createdBy: f.home.members.manager.userId });
      }
    }
    expect(seen).toEqual(inserted.map(row => row.id).sort((left, right) => right - left));
    expect(cursor).toBe("");
  });

  it("rejects burnup ranges longer than 366 days instead of allocating an unbounded chart", async () => {
    const [cycle] = await f.seeded.seedDb.insert(cycles).values({
      orgId: f.home.orgId, projectId: f.projectId, name: "Oversized report range", status: "completed",
      startDate: "2020-01-01", endDate: "2026-09-09", createdBy: f.home.members.manager.userId,
    }).returning({ id: cycles.id });
    if (!cycle) throw new Error("Report cycle missing");
    const response = await request(f.seeded.app.getHttpServer()).get(`/build/${f.projectId}/reports/burnup`)
      .query({ cycleId: cycle.id }).set("Authorization", `Bearer ${f.managerToken}`);
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("366");
  });

  it("rejects burnup replay over 20000 events without returning a partial chart", async () => {
    const [cycle] = await f.seeded.seedDb.insert(cycles).values({
      orgId: f.home.orgId, projectId: f.projectId, name: "Oversized report replay", status: "completed",
      startDate: "2026-09-01", endDate: "2026-09-08", createdBy: f.home.members.manager.userId,
    }).returning({ id: cycles.id });
    if (!cycle) throw new Error("Report cycle missing");
    await f.seeded.seedDb.execute(sql`INSERT INTO ${sprintScopeEvents} (org_id, sprint_id, ticket_id, event_type, new_points, created_at)
      SELECT ${f.home.orgId}, ${cycle.id}, ${f.ticketIds[0]}, 'estimate_changed', 1, '2026-09-01'::timestamptz FROM generate_series(1, 20001)`);
    const response = await request(f.seeded.app.getHttpServer()).get(`/build/${f.projectId}/reports/burnup`)
      .query({ cycleId: cycle.id }).set("Authorization", `Bearer ${f.managerToken}`);
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("20000");
  });

  it("rejects critical-path graphs over 20000 dependencies instead of truncating the graph", async () => {
    await f.seeded.seedDb.execute(sql`INSERT INTO ${tickets} (org_id, project_id, ticket_number, title, status, reporter_id)
      SELECT ${f.home.orgId}, ${f.projectId}, n, 'Graph node ' || n, 'TODO', ${f.home.members.manager.userId} FROM generate_series(7, 156) n`);
    await f.seeded.seedDb.execute(sql`INSERT INTO ${workItemRelations} (org_id, work_item_id, related_work_item_id, relation_type)
      SELECT ${f.home.orgId}, a.id, b.id, 'blocks' FROM ${tickets} a CROSS JOIN ${tickets} b
      WHERE a.org_id = ${f.home.orgId} AND b.org_id = ${f.home.orgId}
        AND a.project_id = ${f.projectId} AND b.project_id = ${f.projectId} AND a.id <> b.id LIMIT 20001`);
    const response = await request(f.seeded.app.getHttpServer()).get(`/build/${f.projectId}/reports/critical-path`)
      .set("Authorization", `Bearer ${f.managerToken}`);
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("20000");
  });

  it("rejects critical-path projects over 5000 tickets without returning a partial graph", async () => {
    await f.seeded.seedDb.delete(workItemRelations).where(eq(workItemRelations.orgId, f.home.orgId));
    await f.seeded.seedDb.execute(sql`INSERT INTO ${tickets} (org_id, project_id, ticket_number, title, status, reporter_id)
      SELECT ${f.home.orgId}, ${f.projectId}, n, 'Graph node ' || n, 'TODO', ${f.home.members.manager.userId} FROM generate_series(157, 5001) n`);
    const response = await request(f.seeded.app.getHttpServer()).get(`/build/${f.projectId}/reports/critical-path`)
      .set("Authorization", `Bearer ${f.managerToken}`);
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("5000");
  });

  it.each([
    { sortValue: "1", id: "1" },
    { sortValue: "0000-01-01 00:00:00", id: "1" },
    { sortValue: "2026-02-30 00:00:00", id: "1" },
    { sortValue: "2026-09-01 00:00:00.123456", id: "2147483648" },
  ])("rejects malformed velocity cursor %j with 400", async position => {
    const response = await request(f.seeded.app.getHttpServer()).get(`/build/${f.projectId}/reports/velocity`)
      .query({ cursor: encodeCursor(position) }).set("Authorization", `Bearer ${f.managerToken}`);
    expect(response.status).toBe(400);
  });
});
