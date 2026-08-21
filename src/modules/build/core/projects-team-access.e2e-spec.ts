import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  projectTeamAssignments,
  projectTeamMembers,
  projectTeams,
  projects,
  users,
} from "../../../db/schema";
import { eq } from "drizzle-orm";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

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

    async function cleanup(): Promise<void> {
      const teamRows = await db
        .select({ id: projectTeams.id })
        .from(projectTeams)
        .where(eq(projectTeams.orgId, ORG_ID));
      for (const t of teamRows) {
        await db
          .delete(projectTeamMembers)
          .where(eq(projectTeamMembers.teamId, t.id));
        await db
          .delete(projectTeamAssignments)
          .where(eq(projectTeamAssignments.teamId, t.id));
      }
      await db.delete(projectTeams).where(eq(projectTeams.orgId, ORG_ID));
      await db.delete(projects).where(eq(projects.orgId, ORG_ID));
      await db
        .delete(organizationMembers)
        .where(eq(organizationMembers.orgId, ORG_ID));
      await db.delete(organizations).where(eq(organizations.id, ORG_ID));
      for (const id of Object.values(U)) {
        await db.delete(users).where(eq(users.id, id));
      }
    }

    async function seed(): Promise<void> {
      await db
        .insert(organizations)
        .values({ id: ORG_ID, name: "Team Access E2E", slug: ORG_ID , ownerMembershipId: 9001 })
        .onConflictDoNothing();
      await db
        .insert(users)
        .values([
          { id: U.owner, email: `${U.owner}@e2e.test`, name: "Owner" },
          {
            id: U.teamMember,
            email: `${U.teamMember}@e2e.test`,
            name: "Team Member",
          },
          {
            id: U.outsider,
            email: `${U.outsider}@e2e.test`,
            name: "Outsider",
          },
        ])
        .onConflictDoNothing();
      await db
        .insert(organizationMembers)
        .values([
          { userId: U.owner, orgId: ORG_ID, isOwner: true },
          { userId: U.teamMember, orgId: ORG_ID, isOwner: false },
          { userId: U.outsider, orgId: ORG_ID, isOwner: false },
        ])
        .onConflictDoNothing();

      const [project] = await db
        .insert(projects)
        .values({
          orgId: ORG_ID,
          name: "Team Project",
          key: "TAP",
          managerId: U.owner,
        })
        .returning({ id: projects.id });
      ids.projectId = project.id;

      const [team] = await db
        .insert(projectTeams)
        .values({ orgId: ORG_ID, name: "Engineering", key: "ENG" })
        .returning({ id: projectTeams.id });
      ids.teamId = team.id;

      await db
        .insert(projectTeamMembers)
        .values({ orgId: ORG_ID, teamId: ids.teamId, userId: U.teamMember })
        .onConflictDoNothing();
      await db
        .insert(projectTeamAssignments)
        .values({ orgId: ORG_ID, teamId: ids.teamId, projectId: ids.projectId })
        .onConflictDoNothing();
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
        .get(`/projects/${ids.projectId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("a member of an assigned team can list the project's tickets", async () => {
      grantViewPerms();
      const token = await tokenFor(U.teamMember);
      const res = await request(app.getHttpServer())
        .get(`/projects/${ids.projectId}/tickets`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("the team member appears in the project's effective roster", async () => {
      grantViewPerms();
      const token = await tokenFor(U.teamMember);
      const res = await request(app.getHttpServer())
        .get(`/projects/${ids.projectId}/roster`)
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
        .get(`/projects/${ids.projectId}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  },
);
