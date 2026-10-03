import { INestApplication } from "@nestjs/common";
import { configureBuildDatabaseAccess } from "test/build/configure-build-database-access";
import { timesheetEntrySchema, timesheetPageSchema } from "./dto/timesheets-response.schemas";
import { z } from "zod";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  projects,
  projectStatuses,
  tickets,
  timesheets,
  users,
} from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

import { describeWithDb, RBAC_E2E_DATABASE_URL } from "test/helpers/db-describe";

const scopePageSchema = timesheetPageSchema.extend({ items: z.array(timesheetEntrySchema.pick({ id: true })) });

describeWithDb(
  "Timesheets scope enforcement (e2e, requires RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;
    let accessService: AccessService;

    const ORG_ID = "org_ts_scope_e2e";
    const FOREIGN_ORG_ID = "org_ts_scope_foreign_e2e";
    const target = { projectId: 0, ticketId: 0, foreignProjectId: 0, foreignTicketId: 0, otherMembershipId: 0 };
    const U = {
      admin: "u_ts_admin",
      member: "u_ts_member",
      other: "u_ts_other",
    };
    const entryIds = { admin: 0, member: 0 };

    async function cleanup(): Promise<void> {
      await runInNewTenantTransaction(db, FOREIGN_ORG_ID, async (tx) => {
        await tx.delete(organizations).where(eq(organizations.id, FOREIGN_ORG_ID));
      });
      await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
        // org first: guard_owner_membership blocks deletion of the owner membership while the org row still names it;
        // cascade removes org_members and timesheets
        await tx.delete(organizations).where(eq(organizations.id, ORG_ID));
        for (const id of Object.values(U)) {
          await tx.delete(users).where(eq(users.id, id));
        }
      });
    }

    async function seed(): Promise<void> {
      await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
        // organizations.owner_membership_id is NOT NULL behind a DEFERRABLE deferred FK onto
        // (organization_members.org_id, id) — allocate the id first and write both in one transaction
        const seqRows = await tx.execute(
          sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
        );
        const ownerMembershipId = Number(seqRows[0].id);

        await tx
          .insert(users)
          .values([
            { id: U.admin, email: `${U.admin}@e2e.test`, name: "Admin" },
            { id: U.member, email: `${U.member}@e2e.test`, name: "Member" },
            { id: U.other, email: `${U.other}@e2e.test`, name: "Other" },
          ])
          .onConflictDoNothing();

        await tx
          .insert(organizations)
          .values({ id: ORG_ID, name: "TS Scope E2E", slug: ORG_ID, ownerMembershipId })
          .onConflictDoNothing();

        const memberRows = await tx
          .insert(organizationMembers)
          .values([
            { id: ownerMembershipId, userId: U.admin, orgId: ORG_ID, isOwner: true },
            { userId: U.member, orgId: ORG_ID, isOwner: false },
            { userId: U.other, orgId: ORG_ID, isOwner: false },
          ])
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id, userId: organizationMembers.userId });

        const adminMembId = memberRows.find((m) => m.userId === U.admin)?.id ?? ownerMembershipId;
        const memberMembId = memberRows.find((m) => m.userId === U.member)?.id ?? 0;
        target.otherMembershipId = memberRows.find((m) => m.userId === U.other)?.id ?? 0;
        const [project] = await tx.insert(projects).values({ orgId: ORG_ID, name: "Timesheet project", key: "TSC" }).returning();
        await tx.insert(projectStatuses).values({ orgId: ORG_ID, projectId: project.id, name: "TODO" });
        const [ticket] = await tx.insert(tickets).values({ orgId: ORG_ID, projectId: project.id, title: "Timesheet ticket", ticketNumber: 1 }).returning();
        target.projectId = project.id;
        target.ticketId = ticket.id;

        const inserted = await tx
          .insert(timesheets)
          .values([
            { orgId: ORG_ID, userMembershipId: adminMembId, projectId: project.id, ticketId: ticket.id, date: "2024-01-11", hours: "2" },
            { orgId: ORG_ID, userMembershipId: memberMembId, projectId: project.id, ticketId: ticket.id, date: "2024-01-11", hours: "1" },
          ])
          .onConflictDoNothing()
          .returning({ id: timesheets.id, userMembershipId: timesheets.userMembershipId });

        for (const row of inserted) {
          if (row.userMembershipId === adminMembId) entryIds.admin = row.id;
          if (row.userMembershipId === memberMembId) entryIds.member = row.id;
        }
      });
      await runInNewTenantTransaction(db, FOREIGN_ORG_ID, async (tx) => {
        const [sequence] = await tx.execute(sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`);
        const membershipId = Number(sequence.id);
        await tx.insert(organizations).values({ id: FOREIGN_ORG_ID, name: "Foreign timesheet org", slug: FOREIGN_ORG_ID, ownerMembershipId: membershipId });
        await tx.insert(organizationMembers).values({ id: membershipId, orgId: FOREIGN_ORG_ID, userId: U.admin, isOwner: true });
        const [project] = await tx.insert(projects).values({ orgId: FOREIGN_ORG_ID, name: "Foreign project", key: "FTS" }).returning();
        await tx.insert(projectStatuses).values({ orgId: FOREIGN_ORG_ID, projectId: project.id, name: "TODO" });
        const [ticket] = await tx.insert(tickets).values({ orgId: FOREIGN_ORG_ID, projectId: project.id, title: "Foreign ticket", ticketNumber: 1 }).returning();
        target.foreignProjectId = project.id;
        target.foreignTicketId = ticket.id;
      });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = RBAC_E2E_DATABASE_URL;
      app = await createE2eApp();
      db = app.get<Db>(DRIZZLE);
      accessService = app.get(AccessService);
      await cleanup();
      await seed();
    });

    afterAll(async () => {
      if (db) await cleanup();
      if (app) await app.close();
    });

    beforeEach(() => configureBuildDatabaseAccess(app, db));

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it.each(["list", "team", "ticket"])("%s cursor traverses tied dates once despite a concurrent insert", async (kind) => {
      const token = await signToken({ sub: U.admin, orgId: ORG_ID, enabledModules: ["build"], isOrgOwner: true });
      const path = kind === "ticket" ? `/build/${target.projectId}/tickets/${target.ticketId}/time-entries` : `/build/time-entries${kind === "team" ? "/team" : ""}`;
      const first = await request(app.getHttpServer()).get(path).query({ limit: 1 }).set("Authorization", `Bearer ${token}`);
      expect(first.status).toBe(200);
      const firstIds = scopePageSchema.parse(first.body).items.map((row) => row.id);
      expect(firstIds).toEqual([entryIds.member]);
      const cursor = kind === "ticket" ? first.headers["x-next-cursor"] : scopePageSchema.parse(first.body).nextCursor;
      expect(cursor).toBeTruthy();
      if (kind === "ticket") {
        expect(first.headers["x-has-more"]).toBe("true");
        expect(first.headers["link"]).toContain('rel="next"');
        expect(first.headers["access-control-expose-headers"]).toContain("X-Next-Cursor");
      }
      const insertedId = await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
        const [row] = await tx.insert(timesheets).values({ orgId: ORG_ID, userMembershipId: target.otherMembershipId, projectId: target.projectId, ticketId: target.ticketId, date: "2024-01-11", hours: "1" }).returning({ id: timesheets.id });
        return row.id;
      });
      try {
        const second = await request(app.getHttpServer()).get(path).query({ limit: 1, cursor }).set("Authorization", `Bearer ${token}`);
        expect(second.status).toBe(200);
        const secondIds = scopePageSchema.parse(second.body).items.map((row) => row.id);
        expect(secondIds).toEqual([entryIds.admin]);
        expect(kind === "ticket" ? second.headers["x-has-more"] : String(scopePageSchema.parse(second.body).hasMore)).toBe("false");
      } finally {
        await runInNewTenantTransaction(db, ORG_ID, async (tx) => { await tx.delete(timesheets).where(eq(timesheets.id, insertedId)); });
      }
    });

    it("rejects foreign project and ticket filters with 404 and malformed pagination with 400", async () => {
      const token = await signToken({ sub: U.admin, orgId: ORG_ID, enabledModules: ["build"], isOrgOwner: true });
      for (const query of [{ projectId: target.foreignProjectId }, { ticketId: target.foreignTicketId }]) {
        const response = await request(app.getHttpServer()).get("/build/time-entries").query(query).set("Authorization", `Bearer ${token}`);
        expect(response.status).toBe(404);
      }
      const foreign = await request(app.getHttpServer()).get(`/build/${target.foreignProjectId}/tickets/${target.foreignTicketId}/time-entries`).set("Authorization", `Bearer ${token}`);
      expect(foreign.status).toBe(404);
      for (const query of [{ page: 2 }, { cursor: "invalid" }]) {
        const response = await request(app.getHttpServer()).get("/build/time-entries").query(query).set("Authorization", `Bearer ${token}`);
        expect(response.status).toBe(400);
      }
    });

    it("scope=all — sees every time entry in the org", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(
          new Map<string, DataScope>([["build:timesheets:view", "all"], ["build:timesheets:manage", "all"]]),
        );

      const token = await signToken({
        sub: U.member,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build/time-entries")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const ids = scopePageSchema.parse(res.body).items.map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([entryIds.admin, entryIds.member]));
    });

    it("scope=own — sees only own time entries", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(
          new Map<string, DataScope>([["build:timesheets:view", "all"], ["build:timesheets:manage", "own"]]),
        );

      const token = await signToken({
        sub: U.member,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build/time-entries")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const returned = scopePageSchema.parse(res.body).items;
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.map((e) => e.id)).toEqual([entryIds.member]);
      expect(returned.map((e) => e.id)).not.toContain(entryIds.admin);
    });

    it("view without manage falls back to own — a caller with no entries sees an empty list", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(new Map<string, DataScope>([["build:timesheets:view", "all"]]));

      const token = await signToken({
        sub: U.other,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build/time-entries")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(scopePageSchema.parse(res.body).items).toEqual([]);
    });

    it("403 before any scope is resolved when the caller holds no timesheets permission", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(new Map<string, DataScope>());

      const token = await signToken({
        sub: U.other,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build/time-entries")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "Permission denied" });
    });

    it("org owner always sees all entries regardless of permissions resolution", async () => {
      const token = await signToken({
        sub: U.admin,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: true,
      });

      const res = await request(app.getHttpServer())
        .get("/build/time-entries")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const ids = scopePageSchema.parse(res.body).items.map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([entryIds.admin, entryIds.member]));
    });
  },
);
