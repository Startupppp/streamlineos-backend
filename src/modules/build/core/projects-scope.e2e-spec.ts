import { INestApplication } from "@nestjs/common";
import { configureBuildDatabaseAccess } from "test/build/configure-build-database-access";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  users,
} from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

import { describeWithDb, RBAC_E2E_DATABASE_URL } from "test/helpers/db-describe";

describeWithDb(
  "Projects list scope enforcement (e2e, requires RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;
    let accessService: AccessService;

    const ORG_ID = "org_proj_scope_e2e";
    const U = {
      admin: "u_proj_admin",
      member: "u_proj_member",
      outsider: "u_proj_outsider",
    };
    const projectIds = { managed: 0, member: 0, other: 0 };
    const membershipIds = { admin: 0, member: 0, outsider: 0 };

    async function cleanup(): Promise<void> {
      await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
        // org first: guard_owner_membership blocks deletion of the owner membership while the org row still names it;
        // cascade removes org_members, projects, and project_members
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
            { id: U.outsider, email: `${U.outsider}@e2e.test`, name: "Outsider" },
          ])
          .onConflictDoNothing();

        await tx
          .insert(organizations)
          .values({ id: ORG_ID, name: "Proj Scope E2E", slug: ORG_ID, ownerMembershipId })
          .onConflictDoNothing();

        const insertedMembers = await tx
          .insert(organizationMembers)
          .values([
            { id: ownerMembershipId, userId: U.admin, orgId: ORG_ID, isOwner: true },
            { userId: U.member, orgId: ORG_ID, isOwner: false },
            { userId: U.outsider, orgId: ORG_ID, isOwner: false },
          ])
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id, userId: organizationMembers.userId });
        for (const member of insertedMembers) {
          if (member.userId === U.admin) membershipIds.admin = member.id;
          if (member.userId === U.member) membershipIds.member = member.id;
          if (member.userId === U.outsider) membershipIds.outsider = member.id;
        }

        const inserted = await tx
          .insert(projects)
          .values([
            { orgId: ORG_ID, name: "Managed Project", key: "PSMGD", managerMembershipId: membershipIds.member },
            { orgId: ORG_ID, name: "Member Project", key: "PSMEM", managerMembershipId: membershipIds.admin },
            { orgId: ORG_ID, name: "Other Project", key: "PSOTH", managerMembershipId: membershipIds.admin },
          ])
          .onConflictDoNothing()
          .returning({ id: projects.id, name: projects.name });

        for (const row of inserted) {
          if (row.name === "Managed Project") projectIds.managed = row.id;
          if (row.name === "Member Project") projectIds.member = row.id;
          if (row.name === "Other Project") projectIds.other = row.id;
        }

        await tx
          .insert(projectMembers)
          .values({ orgId: ORG_ID, projectId: projectIds.member, membershipId: membershipIds.member })
          .onConflictDoNothing();
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

    it("scope=all — sees every project in the org", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(
          new Map<string, DataScope>([["build:view", "all"], ["build:manage", "all"]]),
        );

      const token = await signToken({
        sub: U.member,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: number }>).map((p) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining([projectIds.managed, projectIds.member, projectIds.other]),
      );
    });

    it("scope=own — sees only projects where the user is manager or member", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(
          new Map<string, DataScope>([["build:view", "all"], ["build:manage", "own"]]),
        );

      const token = await signToken({
        sub: U.member,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: number }>).map((p) => p.id);
      expect(ids).toContain(projectIds.managed);
      expect(ids).toContain(projectIds.member);
      expect(ids).not.toContain(projectIds.other);
    });

    it("scope=none — returns an empty list", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(new Map<string, DataScope>([["build:view", "all"]]));

      const token = await signToken({
        sub: U.outsider,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/build")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.hasMore).toBe(false);
    });

    it("org owner always sees all projects regardless of permissions resolution", async () => {
      const token = await signToken({
        sub: U.admin,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: true,
      });

      const res = await request(app.getHttpServer())
        .get("/build")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: number }>).map((p) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining([projectIds.managed, projectIds.member, projectIds.other]),
      );
    });
  },
);
