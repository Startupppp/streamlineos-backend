import { and, eq, inArray, sql } from "drizzle-orm";
import request from "supertest";
import { z } from "zod";
import { cycles, projects, projectStatuses, sprints, ticketAssignees, tickets } from "src/db/schema";
import { createBuildWorkflowFixture, type BuildWorkflowFixture } from "./build-workflow-fixtures";

const idSchema = z.object({ id: z.number().int().positive() });
const pageSchema = z.object({
  data: z.array(idSchema),
  pagination: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});
const workPageSchema = z.object({ data: z.array(idSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() })
  .transform(({ data, ...pagination }) => ({ data, pagination }));

describe("[seeded-e2e] Build workflow lifecycle and concurrent mutations", () => {
  let f: BuildWorkflowFixture;
  const sprintInput = { name: "Certification sprint", startDate: "2026-09-09", endDate: "2026-09-23" };

  beforeAll(async () => { f = await createBuildWorkflowFixture(); }, 180_000);
  afterAll(async () => { if (f) await f.close(); }, 120_000);

  function api() { return request(f.seeded.app.getHttpServer()); }
  function auth() { return { Authorization: `Bearer ${f.managerToken}` }; }
  function ticketPath(ticketId: number) { return `/build/${f.projectId}/tickets/${ticketId}`; }

  it("rejects anonymous project, ticket and sprint reads with 401", async () => {
    for (const path of [`/build/${f.projectId}`, `/build/${f.projectId}/tickets`, `/build/${f.projectId}/sprints`])
      expect((await api().get(path)).status).toBe(401);
  });

  it("rejects an authenticated member without Build permissions with 403", async () => {
    for (const path of [`/build/${f.projectId}`, `/build/${f.projectId}/tickets`, `/build/${f.projectId}/sprints`])
      expect((await api().get(path).set("Authorization", `Bearer ${f.deniedToken}`)).status).toBe(403);
    const write = await api().post(`/build/${f.projectId}/tickets`).set("Authorization", `Bearer ${f.deniedToken}`).send({ title: "Denied creation" });
    expect(write.status).toBe(403);
  });

  it("filters project lists to explicit membership under own scope", async () => {
    const limited = await api().get("/build").set("Authorization", `Bearer ${f.limitedToken}`);
    expect(limited.status).toBe(200);
    const ids = z.object({ data: z.array(idSchema) }).parse(limited.body).data.map(row => row.id);
    expect(ids).toContain(f.projectId);
    expect(ids).not.toContain(f.home.projects.private.projectId);
    expect(ids).not.toContain(f.foreignProjectId);
  });

  it("counts board columns through ticket DataScope", async () => {
    const all = await api().get(`/build/${f.projectId}/tickets/column-counts`).set(auth());
    const own = await api().get(`/build/${f.projectId}/tickets/column-counts`).set("Authorization", `Bearer ${f.limitedToken}`);
    expect(all.status).toBe(200);
    expect(own.status).toBe(200);
    expect(all.body).toMatchObject({ TODO: 6 });
    expect(own.body).toMatchObject({ TODO: 1 });
  });

  it("traverses tied rank values without omissions or duplicate cursor rows", async () => {
    await f.seeded.seedDb.update(tickets).set({ rank: "1000" }).where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, f.ticketIds)));
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const response = await api().get(`/build/${f.projectId}/tickets`).query({ limit: 2, orderBy: "rank", ...(cursor ? { cursor } : {}) }).set(auth());
      expect(response.status).toBe(200);
      const body = pageSchema.parse(response.body);
      seen.push(...body.data.map(row => row.id));
      cursor = body.pagination.nextCursor;
      if (!body.pagination.hasMore) break;
      expect(cursor).not.toBeNull();
    }
    expect(new Set(seen).size).toBe(6);
    expect(seen).toHaveLength(6);
    expect([...seen].sort((a, b) => a - b)).toEqual([...f.ticketIds].sort((a, b) => a - b));
    for (const [index, id] of f.ticketIds.entries())
      await f.seeded.seedDb.update(tickets).set({ rank: String((index + 1) * 1000) }).where(eq(tickets.id, id));
  });

  it("rejects foreign projects and foreign ticket IDs with exact 404", async () => {
    for (const path of [`/build/${f.foreignProjectId}`, `/build/${f.foreignProjectId}/tickets`, ticketPath(f.foreignTicketId)])
      expect((await api().get(path).set(auth())).status).toBe(404);
    expect((await api().get(`/build/${f.foreignProjectId}/sprints`).set(auth())).status).toBe(410);
    expect((await api().patch(ticketPath(f.foreignTicketId)).set(auth()).send({ title: "Foreign mutation" })).status).toBe(404);
    expect((await api().delete(ticketPath(f.foreignTicketId)).set(auth())).status).toBe(404);
    const [foreign] = await f.seeded.seedDb.select({ title: tickets.title, deletedAt: tickets.deletedAt }).from(tickets).where(eq(tickets.id, f.foreignTicketId));
    expect(foreign).toEqual({ title: "foreign workflow ticket", deletedAt: null });
  });

  it.each(["project", "all-work"])("paginates every %s ticket sharing an exact PostgreSQL microsecond timestamp", async surface => {
    await f.seeded.seedDb.update(tickets).set({ createdAt: sql`'2026-09-09 00:00:00.123456'::timestamp` }).where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, f.ticketIds)));
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 7; page++) {
      const response: request.Response = await api().get(surface === "project" ? `/build/${f.projectId}/tickets` : "/build/all-work")
        .query({ limit: 1, orderBy: "created", orderDir: "desc", ...(surface === "all-work" ? { projectIds: String(f.projectId) } : {}), ...(cursor ? { cursor } : {}) }).set(auth());
      expect(response.status).toBe(200);
      const body: z.infer<typeof pageSchema> = surface === "project" ? pageSchema.parse(response.body) : workPageSchema.parse(response.body);
      seen.push(...body.data.map(row => row.id));
      cursor = body.pagination.nextCursor;
      if (!body.pagination.hasMore) break;
      expect(cursor).not.toBeNull();
    }
    expect(seen).toHaveLength(f.ticketIds.length);
    expect(new Set(seen).size).toBe(f.ticketIds.length);
    expect([...seen].sort((a, b) => a - b)).toEqual([...f.ticketIds].sort((a, b) => a - b));
  });

  it.each([["all", "asc"], ["all", "desc"], ["mine", "asc"], ["mine", "desc"]] as const)("paginates %s work with null due dates in %s order", async (scope, orderDir) => {
    await f.seeded.seedDb.update(tickets).set({ dueDate: null, assigneeMembershipId: f.home.members.manager.membershipId }).where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, f.ticketIds)));
    await f.seeded.seedDb.update(tickets).set({ dueDate: "2026-09-10" }).where(eq(tickets.id, f.ticketIds[0]));
    await f.seeded.seedDb.update(tickets).set({ dueDate: "2026-09-11" }).where(eq(tickets.id, f.ticketIds[1]));
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 7; page++) {
      const response = await api().get("/build/all-work").set(auth()).query({ scope, orderBy: "dueDate", orderDir, limit: 1, projectIds: String(f.projectId), ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      const body = workPageSchema.parse(response.body);
      seen.push(...body.data.map(row => row.id));
      cursor = body.pagination.nextCursor;
      if (!body.pagination.hasMore) break;
      expect(cursor).not.toBeNull();
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort((a, b) => a - b)).toEqual([...f.ticketIds].sort((a, b) => a - b));
    expect(orderDir === "asc" ? seen.slice(0, 2) : seen.slice(-2)).toEqual(orderDir === "asc" ? f.ticketIds.slice(0, 2) : f.ticketIds.slice(0, 2).reverse());
  });

  it("creates, updates, archives and deletes a project through the real API", async () => {
    const created = await api().post("/build").set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ name: "Lifecycle project", key: "LIFECYCLE" });
    expect(created.status).toBe(201);
    const { id } = idSchema.parse(created.body);
    expect((await api().patch(`/build/${id}`).set(auth()).send({ name: "Lifecycle renamed", status: "ARCHIVED" })).status).toBe(200);
    const [row] = await f.seeded.seedDb.select({ name: projects.name, status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(row).toEqual({ name: "Lifecycle renamed", status: "ARCHIVED" });
    expect((await api().delete(`/build/${id}`).set(auth())).status).toBe(204);
    expect((await api().get(`/build/${id}`).set(auth())).status).toBe(404);
  });

  it("creates an assigned ticket, updates it and soft-deletes it", async () => {
    const created = await api().post(`/build/${f.projectId}/tickets`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ title: "Lifecycle assigned ticket", assigneeId: f.home.members.limited.userId, status: "TODO" });
    expect(created.status).toBe(201);
    const { id } = idSchema.parse(created.body);
    expect((await api().patch(ticketPath(id)).set(auth()).send({ title: "Lifecycle ticket updated" })).status).toBe(200);
    const [row] = await f.seeded.seedDb.select({ title: tickets.title, assigneeMembershipId: tickets.assigneeMembershipId }).from(tickets).where(eq(tickets.id, id));
    expect(row).toEqual({ title: "Lifecycle ticket updated", assigneeMembershipId: f.home.members.limited.membershipId });
    expect((await api().delete(ticketPath(id)).set(auth())).status).toBe(204);
    expect((await api().get(ticketPath(id)).set(auth())).status).toBe(404);
  });

  it("rejects foreign ticket creation and foreign assignment without writing", async () => {
    expect((await api().post(`/build/${f.foreignProjectId}/tickets`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ title: "Foreign create" })).status).toBe(404);
    expect((await api().post(`/build/${f.projectId}/tickets`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ title: "Foreign assignment", assigneeId: f.neighbour.members.manager.userId })).status).toBe(404);
  });

  it("rejects a mixed-tenant bulk update atomically", async () => {
    const response = await api().post(`/build/${f.projectId}/tickets/bulk`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: [f.ticketIds[0], f.foreignTicketId], priority: "URGENT" });
    expect(response.status).toBe(404);
    const rows = await f.seeded.seedDb.select({ priority: tickets.priority }).from(tickets).where(inArray(tickets.id, [f.ticketIds[0], f.foreignTicketId]));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.priority !== "URGENT")).toBe(true);
  });

  it("rejects own-scope bulk mutations of another reporter's ticket", async () => {
    const response = await api().post(`/build/${f.projectId}/tickets/bulk`).set("Authorization", `Bearer ${f.limitedToken}`).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: [f.ticketIds[0]], priority: "URGENT" });
    expect(response.status).toBe(403);
  });

  it("rejects unknown and foreign bulk assignees with 404", async () => {
    for (const assigneeId of [crypto.randomUUID(), f.neighbour.members.manager.userId]) {
      const response = await api().post(`/build/${f.projectId}/tickets/bulk`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: [f.ticketIds[0]], assigneeId });
      expect(response.status).toBe(404);
    }
  });

  it("bulk assignment keeps primary and secondary assignments aligned and advances versions", async () => {
    const ids = f.ticketIds.slice(0, 2);
    const before = await f.seeded.seedDb.select({ id: tickets.id, version: tickets.version }).from(tickets).where(inArray(tickets.id, ids));
    const response = await api().post(`/build/${f.projectId}/tickets/bulk`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: ids, assigneeId: f.home.members.limited.userId, priority: "HIGH" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ updated: 2, ticketIds: expect.arrayContaining(ids) });
    const after = await f.seeded.seedDb.select({ id: tickets.id, version: tickets.version, assigneeMembershipId: tickets.assigneeMembershipId }).from(tickets).where(inArray(tickets.id, ids));
    for (const row of after) {
      expect(row.assigneeMembershipId).toBe(f.home.members.limited.membershipId);
      expect(row.version).toBe((before.find(previous => previous.id === row.id)?.version ?? 0) + 1);
    }
    const assignees = await f.seeded.seedDb.select({ ticketId: ticketAssignees.ticketId, membershipId: ticketAssignees.membershipId }).from(ticketAssignees).where(and(eq(ticketAssignees.orgId, f.home.orgId), inArray(ticketAssignees.ticketId, ids)));
    expect(assignees).toHaveLength(2);
    expect(assignees.every(row => row.membershipId === f.home.members.limited.membershipId)).toBe(true);
    const listed = await api().get(`/build/${f.projectId}/tickets`).query({ assigneeId: f.home.members.limited.userId }).set(auth());
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ data: expect.arrayContaining(ids.map(id => expect.objectContaining({
      id, assigneeMembershipId: f.home.members.limited.membershipId,
      assigneeId: f.home.members.limited.userId,
      assignee: expect.objectContaining({ id: f.home.members.limited.userId }),
      assignees: expect.arrayContaining([expect.objectContaining({ userId: f.home.members.limited.userId })]),
    }))) });
  });

  it("answers 410 on every Sprints route and leaves the stored sprint row untouched, because Cycles are the only iteration identity", async () => {
    const [existing] = await f.seeded.seedDb.insert(sprints).values({ orgId: f.home.orgId, projectId: f.projectId, name: "Frozen sprint", startDate: new Date("2026-09-09"), endDate: new Date("2026-09-23") }).returning({ id: sprints.id });
    if (!existing) throw new Error("Frozen sprint fixture missing");

    expect((await api().get(`/build/${f.projectId}/sprints`).set(auth())).status).toBe(410);
    expect((await api().post(`/build/${f.projectId}/sprints`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send(sprintInput)).status).toBe(410);
    expect((await api().get(`/build/${f.projectId}/sprints/${existing.id}`).set(auth())).status).toBe(410);
    expect((await api().patch(`/build/${f.projectId}/sprints/${existing.id}`).set(auth()).send({ status: "ACTIVE" })).status).toBe(410);
    expect((await api().delete(`/build/${f.projectId}/sprints/${existing.id}`).set(auth())).status).toBe(410);

    const [row] = await f.seeded.seedDb.select({ status: sprints.status, deletedAt: sprints.deletedAt }).from(sprints).where(eq(sprints.id, existing.id));
    expect(row).toEqual({ status: "PLANNED", deletedAt: null });
  });

  it("rejects sprintId on the ticket bulk body and the ticket list query with 400, because both contracts are strict and no longer declare the field", async () => {
    const bulk = await api().post(`/build/${f.projectId}/tickets/bulk`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: [f.ticketIds[0]], sprintId: 1 });
    expect(bulk.status).toBe(400);
    expect((await api().get(`/build/${f.projectId}/tickets`).query({ sprintId: 1 }).set(auth())).status).toBe(400);
  });

  it("binds a ticket to a cycle through the bulk route and filters the ticket list by that cycleId", async () => {
    const [cycle] = await f.seeded.seedDb.insert(cycles).values({ orgId: f.home.orgId, projectId: f.projectId, name: "Lifecycle cycle", startDate: "2026-09-09", endDate: "2026-09-23", status: "active", createdBy: f.home.members.manager.userId }).returning({ id: cycles.id });
    if (!cycle) throw new Error("Lifecycle cycle fixture missing");

    const assigned = await api().post(`/build/${f.projectId}/tickets/bulk`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: [f.ticketIds[0]], cycleId: cycle.id });
    expect(assigned.status).toBe(200);

    const cycleTickets = await api().get(`/build/${f.projectId}/tickets`).query({ cycleId: String(cycle.id) }).set(auth());
    expect(cycleTickets.status).toBe(200);
    expect(pageSchema.parse(cycleTickets.body).data.map(row => row.id)).toEqual([f.ticketIds[0]]);
  });

  it("serializes concurrent moves into the same gap without duplicate ranks", async () => {
    for (const [index, id] of f.ticketIds.entries())
      await f.seeded.seedDb.update(tickets).set({ rank: String((index + 1) * 1000) }).where(eq(tickets.id, id));
    const [beforeTicketId, afterTicketId, first, second] = f.ticketIds;
    const results = await Promise.all([first, second].map(id => api().patch(`${ticketPath(id)}/rank`).set(auth()).send({ beforeTicketId, afterTicketId })));
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    const ranks = await f.seeded.seedDb.select({ rank: tickets.rank }).from(tickets).where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, f.ticketIds)));
    expect(new Set(ranks.map(row => row.rank)).size).toBe(f.ticketIds.length);
  });

  it("rejects foreign rank neighbors and leaves the target rank intact", async () => {
    const [before] = await f.seeded.seedDb.select({ rank: tickets.rank }).from(tickets).where(eq(tickets.id, f.ticketIds[0]));
    const response = await api().patch(`${ticketPath(f.ticketIds[0])}/rank`).set(auth()).send({ afterTicketId: f.foreignTicketId });
    expect(response.status).toBe(404);
    const [after] = await f.seeded.seedDb.select({ rank: tickets.rank }).from(tickets).where(eq(tickets.id, f.ticketIds[0]));
    expect(after).toEqual(before);
  });

  it("preserves exact numeric ranks above JavaScript's safe integer range", async () => {
    const rows = await f.seeded.seedDb.insert(tickets).values(["9007199254740992", "9007199254740993", "9007199254740994"].map((rank, index) => ({
      orgId: f.home.orgId, projectId: f.projectId, ticketNumber: 1000 + index,
      title: `Precision rank ${index}`, status: "TODO", rank, reporterId: f.home.members.manager.userId,
    }))).returning({ id: tickets.id });
    const [before, after, target] = rows;
    expect(rows).toHaveLength(3);
    const response = await api().patch(`${ticketPath(target.id)}/rank`).set(auth()).send({ beforeTicketId: before.id, afterTicketId: after.id });
    expect(response.status).toBe(200);
    const result = z.object({ rank: z.string() }).parse(response.body);
    expect(result.rank).toMatch(/^9007199254740992\.50*$/);
    const [persisted] = await f.seeded.seedDb.select({ rank: tickets.rank }).from(tickets).where(eq(tickets.id, target.id));
    expect(persisted?.rank).toBe(result.rank);
  });

  it("admits only one of two concurrent moves into a column with one remaining WIP slot", async () => {
    const statusWhere = and(eq(projectStatuses.orgId, f.home.orgId), eq(projectStatuses.projectId, f.projectId), eq(projectStatuses.name, "IN_PROGRESS"));
    await f.seeded.seedDb.update(projectStatuses).set({ wipLimit: 1 }).where(statusWhere);
    try {
      const responses = await Promise.all(f.ticketIds.slice(0, 2).map(id => api().post(`/build/${f.projectId}/tickets/bulk`).set(auth()).set("Idempotency-Key", crypto.randomUUID()).send({ ticketIds: [id], status: "IN_PROGRESS" })));
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const occupied = await f.seeded.seedDb.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.orgId, f.home.orgId), eq(tickets.projectId, f.projectId), eq(tickets.status, "IN_PROGRESS")));
      expect(occupied).toHaveLength(1);
    } finally {
      await f.seeded.seedDb.update(tickets).set({ status: "TODO" }).where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, f.ticketIds.slice(0, 2))));
      await f.seeded.seedDb.update(projectStatuses).set({ wipLimit: null }).where(statusWhere);
    }
  });

  it("changes the project report revision transactionally and rolls it back with its write", async () => {
    const [before] = await f.seeded.seedDb.select({ revision: projects.reportRevision }).from(projects).where(eq(projects.id, f.projectId));
    if (!before) throw new Error("Report revision project missing");
    const rollback = new Error("roll back report revision probe");
    await expect(f.seeded.seedDb.transaction(async tx => {
      await tx.update(tickets).set({ title: "Rolled back report input" }).where(eq(tickets.id, f.ticketIds[0]));
      const [inside] = await tx.select({ revision: projects.reportRevision }).from(projects).where(eq(projects.id, f.projectId));
      expect(inside?.revision).toBeGreaterThan(before.revision);
      throw rollback;
    })).rejects.toBe(rollback);
    const [after] = await f.seeded.seedDb.select({ revision: projects.reportRevision }).from(projects).where(eq(projects.id, f.projectId));
    expect(after).toEqual(before);
  });

  it("bumps report revision once per bulk statement and only for the affected project", async () => {
    const before = await f.seeded.seedDb.select({ id: projects.id, revision: projects.reportRevision }).from(projects).where(inArray(projects.id, [f.projectId, f.foreignProjectId]));
    await f.seeded.seedDb.update(tickets).set({ points: 3 }).where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, f.ticketIds)));
    const after = await f.seeded.seedDb.select({ id: projects.id, revision: projects.reportRevision }).from(projects).where(inArray(projects.id, [f.projectId, f.foreignProjectId]));
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    for (const row of after)
      expect(row.revision).toBe((before.find(project => project.id === row.id)?.revision ?? -1) + (row.id === f.projectId ? 1 : 0));
  });

  it("refreshes a warm velocity report after committed sprint and ticket writes", async () => {
    const path = `/build/${f.projectId}/reports/velocity`;
    const cold = await api().get(path).set(auth());
    expect(cold.status).toBe(200);
    expect(cold.body).toEqual([]);
    const warm = await api().get(path).set(auth());
    expect(warm.status).toBe(200);
    expect(warm.body).toEqual(cold.body);
    const [cycle] = await f.seeded.seedDb.insert(cycles).values({ orgId: f.home.orgId, projectId: f.projectId, name: "Report refresh cycle", startDate: "2026-09-09", endDate: "2026-09-23", status: "active", createdBy: f.home.members.manager.userId }).returning({ id: cycles.id });
    if (!cycle) throw new Error("Report cycle missing");
    const added = await api().get(path).set(auth());
    expect(added.status).toBe(200);
    expect(added.body).toEqual([expect.objectContaining({ cycleId: cycle.id, committedCount: 0, committedPoints: 0 })]);
    await f.seeded.seedDb.update(tickets).set({ cycleId: cycle.id, storyPoints: 8 }).where(eq(tickets.id, f.ticketIds[0]));
    const updated = await api().get(path).set(auth());
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual([expect.objectContaining({ cycleId: cycle.id, committedCount: 1, committedPoints: 8 })]);
  });

  it.each(["burnup", "cfd", "critical-path", "cycle-time", "lead-time"])("serves the %s report and rejects a foreign project", async report => {
    expect((await api().get(`/build/${f.projectId}/reports/${report}`).set(auth())).status).toBe(200);
    expect((await api().get(`/build/${f.foreignProjectId}/reports/${report}`).set(auth())).status).toBe(404);
    expect((await api().get(`/build/${f.projectId}/reports/${report}`).set("Authorization", `Bearer ${f.limitedToken}`)).status).toBe(403);
  });

  it("snapshots the real project and refuses a foreign project", async () => {
    expect((await api().post(`/build/${f.projectId}/reports/snapshot`).set(auth())).status).toBe(200);
    expect((await api().post(`/build/${f.foreignProjectId}/reports/snapshot`).set(auth())).status).toBe(404);
    expect((await api().post(`/build/${f.projectId}/reports/snapshot`).set("Authorization", `Bearer ${f.limitedToken}`)).status).toBe(403);
  });

  it.each(["parentTicketId", "epicId"] as const)("rejects concurrent inverse %s edges after both requests wait for the project lock", async field => {
    const [first, second] = f.ticketIds;
    if (first === undefined || second === undefined) throw new Error("Two tickets are required");
    let release = () => {};
    let announce = () => {};
    const released = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { announce = resolve; });
    const key = `build:tickets:${f.home.orgId}:${f.projectId}`;
    const blocker = f.seeded.seedDb.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      announce();
      await released;
    });
    await Promise.race([acquired, blocker]);
    const responses = Promise.all([
      api().patch(ticketPath(first)).set(auth()).send({ [field]: second }),
      api().patch(ticketPath(second)).set(auth()).send({ [field]: first }),
    ]);
    try {
      let waiting = 0;
      const deadline = Date.now() + 5000;
      while (waiting < 2 && Date.now() < deadline) {
        const [row] = await f.seeded.seedDb.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
            AND objid = (hashtextextended(${key}, 0) & 4294967295)::oid
        `);
        waiting = Number(row?.waiting ?? 0);
        if (waiting < 2) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(2);
      release();
      await blocker;
      expect((await responses).map(response => response.status).sort()).toEqual([200, 400]);
      const details = await Promise.all([api().get(ticketPath(first)).set(auth()), api().get(ticketPath(second)).set(auth())]);
      expect(details.map(response => response.status)).toEqual([200, 200]);
      const edge = z.object({ parentTicketId: z.number().nullable(), epicId: z.number().nullable() });
      expect(details.map(response => edge.parse(response.body)[field]).filter(value => value !== null)).toHaveLength(1);
    } finally {
      release();
      await blocker;
      await responses;
      await f.seeded.seedDb.update(tickets).set({ parentTicketId: null, epicId: null })
        .where(and(eq(tickets.orgId, f.home.orgId), inArray(tickets.id, [first, second])));
    }
  }, 30_000);

  it("records local HTTP latency for tickets, board counts and velocity without claiming an SLA", async () => {
    const measurements: Record<string, number[]> = {};
    for (const [name, suffix] of [["tickets", "tickets"], ["boardCounts", "tickets/column-counts"], ["velocity", "reports/velocity"]]) {
      measurements[name] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = performance.now();
        const response = await api().get(`/build/${f.projectId}/${suffix}`).set(auth());
        measurements[name].push(Math.round((performance.now() - start) * 100) / 100);
        expect(response.status).toBe(200);
      }
    }
    process.stdout.write(`[build-local-http-latency-ms] ${JSON.stringify(measurements)}\n`);
  });
});
