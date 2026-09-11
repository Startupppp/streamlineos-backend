import request from "supertest";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";
import { rolePermissionGrants, ticketActivityLog } from "src/db/schema";
import { createBuildWorkflowFixture, type BuildWorkflowFixture } from "./build-workflow-fixtures";

describe("[seeded-e2e] Build ticket activity access", () => {
  let f: BuildWorkflowFixture;

  beforeAll(async () => { f = await createBuildWorkflowFixture(); }, 180_000);
  afterAll(async () => { if (f) await f.close(); }, 120_000);

  it("denies another same-tenant ticket activity under own scope", async () => {
    const response = await request(f.seeded.app.getHttpServer())
      .get(`/build/${f.projectId}/tickets/${f.ticketIds[0]}/activity`)
      .set("Authorization", `Bearer ${f.limitedToken}`);
    expect(response.status).toBe(403);
  });

  it("allows own activity and all-scope activity but returns exact foreign 404", async () => {
    const cases = [
      { ticketId: f.ticketIds[5], token: f.limitedToken, status: 200 },
      { ticketId: f.ticketIds[0], token: f.managerToken, status: 200 },
      { ticketId: f.foreignTicketId, token: f.limitedToken, status: 404 },
      { ticketId: f.foreignTicketId, token: f.managerToken, status: 404 },
    ];
    for (const sample of cases) {
      const response = await request(f.seeded.app.getHttpServer())
        .get(`/build/${f.projectId}/tickets/${sample.ticketId}/activity`)
        .set("Authorization", `Bearer ${sample.token}`);
      expect(response.status).toBe(sample.status);
    }
  });

  it("applies team scope to activity with the same visible-ticket boundary", async () => {
    const [grant] = await f.seeded.seedDb.select({ roleId: rolePermissionGrants.roleId }).from(rolePermissionGrants)
      .where(and(eq(rolePermissionGrants.orgId, f.home.orgId), eq(rolePermissionGrants.permissionKey, "build:manage"), eq(rolePermissionGrants.scope, "own")));
    if (!grant) throw new Error("Limited Build grant missing");
    const target = and(eq(rolePermissionGrants.orgId, f.home.orgId), eq(rolePermissionGrants.roleId, grant.roleId), eq(rolePermissionGrants.permissionKey, "build:manage"));
    try {
      await f.seeded.seedDb.update(rolePermissionGrants).set({ scope: "team" }).where(target);
      await bumpPermissionsVersion(f.seeded.seedDb, f.home.orgId);
      for (const [ticketId, status] of [[f.ticketIds[0], 403], [f.ticketIds[5], 200], [f.foreignTicketId, 404]]) {
        const response = await request(f.seeded.app.getHttpServer())
          .get(`/build/${f.projectId}/tickets/${ticketId}/activity`)
          .set("Authorization", `Bearer ${f.limitedToken}`);
        expect(response.status).toBe(status);
      }
    } finally {
      await f.seeded.seedDb.update(rolePermissionGrants).set({ scope: "own" }).where(target);
      await bumpPermissionsVersion(f.seeded.seedDb, f.home.orgId);
    }
  });

  it("traverses tied activity timestamps exactly once through cursor pages", async () => {
    const activities: (typeof ticketActivityLog.$inferInsert)[] = Array.from({ length: 5 }, () => ({
      orgId: f.home.orgId, ticketId: f.ticketIds[5], action: "created", createdAt: new Date("2026-09-09T00:00:00Z"),
    }));
    const inserted = await f.seeded.seedDb.insert(ticketActivityLog).values(activities).returning({ id: ticketActivityLog.id });
    const pageSchema = z.object({ data: z.array(z.object({ id: z.number() })), pagination: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }) });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const response = await request(f.seeded.app.getHttpServer())
        .get(`/build/${f.projectId}/tickets/${f.ticketIds[5]}/activity`)
        .query({ limit: 2, ...(cursor ? { cursor } : {}) }).set("Authorization", `Bearer ${f.limitedToken}`);
      expect(response.status).toBe(200);
      const body = pageSchema.parse(response.body);
      seen.push(...body.data.map(row => row.id));
      cursor = body.pagination.nextCursor;
      if (!body.pagination.hasMore) break;
      expect(cursor).not.toBeNull();
    }
    expect(seen).toEqual(inserted.map(row => row.id).sort((left, right) => right - left));
  });
});
