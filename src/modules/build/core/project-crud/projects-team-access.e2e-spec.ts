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
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  projects,
  users,
} from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { AccessService } from "../../../access/access.service";
import type { DataScope } from "../../../access/access.types";
import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";

import { describeWithDb, RBAC_E2E_DATABASE_URL } from "test/helpers/db-describe";

describeWithDb(
  "Projects team-based access inheritance (e2e, requires RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;
    let accessService: AccessService;

    const ORG_ID = "org_team_access_e2e";
    const U = {
      owner: "u_ta_owner",
      teamMember: "u_ta_team",
      outsider: "u_ta_outsider",
    };
    const ids = { projectId: 0, teamId: 0 };
    const membershipIds = { owner: 0, teamMember: 0, outsider: 0 };

    async function cleanup(): Promise<void> {
      await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
        // org first: guard_owner_membership blocks deletion of the owner membership while the org row still names it;
        // cascade removes org_members, projects, project_teams, and their dependents
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
            { id: U.teamMember, email: `${U.teamMember}@e2e.test`, name: "Team Member" },
            { id: U.outsider, email: `${U.outsider}@e2e.test`, name: "Outsider" },
          ])
          .onConflictDoNothing();

        await tx
          .insert(organizations)
          .values({ id: ORG_ID, name: "Team Access E2E", slug: ORG_ID, ownerMembershipId })
          .onConflictDoNothing();

        const insertedMembers = await tx
          .insert(organizationMembers)
          .values([
            { id: ownerMembershipId, userId: U.owner, orgId: ORG_ID, isOwner: true },
            { userId: U.teamMember, orgId: ORG_ID, isOwner: false },
            { userId: U.outsider, orgId: ORG_ID, isOwner: false },
          ])
          .onConflictDoNothing()
          .returning({ id: organizationMembers.id, userId: organizationMembers.userId });
        for (const member of insertedMembers) {
          if (member.userId === U.owner) membershipIds.owner = member.id;
          if (member.userId === U.teamMember) membershipIds.teamMember = member.id;
          if (member.userId === U.outsider) membershipIds.outsider = member.id;
        }

        const [project] = await tx
          .insert(projects)
          .values({ orgId: ORG_ID, name: "Team Project", key: "TAP", managerMembershipId: membershipIds.owner })
          .returning({ id: projects.id });
        ids.projectId = project.id;

        const [team] = await tx
          .insert(projectTeams)
          .values({ orgId: ORG_ID, name: "Engineering", key: "ENG" })
          .returning({ id: projectTeams.id });
        ids.teamId = team.id;

        await tx
          .insert(projectTeamMembers)
          .values({ orgId: ORG_ID, teamId: ids.teamId, membershipId: membershipIds.teamMember })
          .onConflictDoNothing();
        await tx
          .insert(projectTeamAssignments)
          .values({ orgId: ORG_ID, teamId: ids.teamId, projectId: ids.projectId })
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

    function grantViewPerms(): void {
      jest.spyOn(accessService, "resolveUserPermissions").mockResolvedValue(
        new Map<string, DataScope>([
          ["build:view", "all"],
          ["build:tickets:view", "all"],
        ]),
      );
    }

    async function tokenFor(sub: string): Promise<string> {
      return signToken({
        sub,
        orgId: ORG_ID,
        enabledModules: ["build"],
        isOrgOwner: false,
      });
    }

    it("a member of an assigned team can open the project", async () => {
      grantViewPerms();
      const token = await tokenFor(U.teamMember);
      const res = await request(app.getHttpServer())
        .get(`/build/${ids.projectId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("a member of an assigned team can list the project's tickets", async () => {
      grantViewPerms();
      const token = await tokenFor(U.teamMember);
      const res = await request(app.getHttpServer())
        .get(`/build/${ids.projectId}/tickets`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("the team member appears in the project's effective roster", async () => {
      grantViewPerms();
      const token = await tokenFor(U.teamMember);
      const res = await request(app.getHttpServer())
        .get(`/build/${ids.projectId}/roster`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const memberIds = (res.body.members as Array<{ id: string }>).map(
        (m) => m.id,
      );
      expect(memberIds).toContain(U.teamMember);
    });

    it("a user not on any assigned team is denied the project", async () => {
      grantViewPerms();
      const token = await tokenFor(U.outsider);
      const res = await request(app.getHttpServer())
        .get(`/build/${ids.projectId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  },
);
