import { INestApplication } from "@nestjs/common";
import { configureBuildDatabaseAccess } from "test/build/configure-build-database-access";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  users,
} from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { AccessService } from "../../../access/access.service";
import type { DataScope } from "../../../access/access.types";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

import { describeWithDb, RBAC_E2E_DATABASE_URL } from "test/helpers/db-describe";

describeWithDb(
  "Projects sub-resource access enforcement (e2e, requires RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;
    let accessService: AccessService;

    const ORG_ID = "org_proj_access_e2e";
    const U = {
      owner: "u_pa_owner",
      member: "u_pa_member",
      outsider: "u_pa_outsider",
    };
    const projectIds = { target: 0 };
    const membershipIds = { owner: 0, member: 0, outsider: 0 };

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
            { id: U.owner, email: `${U.owner}@e2e.test`, name: "Owner" },
            { id: U.member, email: `${U.member}@e2e.test`, name: "Member" },
            { id: U.outsider, email: `${U.outsider}@e2e.test`, name: "Outsider" },
          ])
          .onConflictDoNothing();

        await tx
          .insert(organizations)
          .values({ id: ORG_ID, name: "Proj Access E2E", slug: ORG_ID, ownerMembershipId })
          .onConflictDoNothing();

        const insertedMembers = await tx
          .insert(organizationMembers)
          .values([
            { id: ownerMembershipId, userId: U.owner, orgId: ORG_ID, isOwner: true },
            { userId: U.member, orgId: ORG_ID, isOwner: false },
            { userId: U.outsider, orgId: ORG_ID, isOwner: false },
          ])
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id, userId: organizationMembers.userId });
        for (const member of insertedMembers) {
          if (member.userId === U.owner) membershipIds.owner = member.id;
          if (member.userId === U.member) membershipIds.member = member.id;
          if (member.userId === U.outsider) membershipIds.outsider = member.id;
        }

        const inserted = await tx
          .insert(projects)
          .values([
            { orgId: ORG_ID, name: "Target Project", key: "PATGT", managerMembershipId: membershipIds.owner },
          ])
          .onConflictDoNothing()
          .returning({ id: projects.id, name: projects.name });

        for (const row of inserted) {
          if (row.name === "Target Project") projectIds.target = row.id;
        }

        await tx
          .insert(projectMembers)
          .values({ orgId: ORG_ID, projectId: projectIds.target, membershipId: membershipIds.member })
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

    function grantViewOnly(): void {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(new Map<string, DataScope>([["build:view", "all"]]));
    }

    async function tokenFor(
      sub: string,
      isOrgOwner: boolean,
    ): Promise<string> {
      return signToken({
        sub,
        orgId: ORG_ID,
        role: isOrgOwner ? "OWNER" : "MEMBER",
        enabledModules: ["build"],
        isOrgOwner,
      });
    }

    it("a project member can read the member list", async () => {
      grantViewOnly();
      const token = await tokenFor(U.member, false);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/members`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("a non-member is denied the member list (403)", async () => {
      grantViewOnly();
      const token = await tokenFor(U.outsider, false);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/members`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("a non-member is denied the custom states (403)", async () => {
      grantViewOnly();
      const token = await tokenFor(U.outsider, false);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/custom-states`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("a non-member is denied the automations list (403)", async () => {
      grantViewOnly();
      const token = await tokenFor(U.outsider, false);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/automations`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("the org owner can read the member list of any project", async () => {
      const token = await tokenFor(U.owner, true);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/members`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  },
);
