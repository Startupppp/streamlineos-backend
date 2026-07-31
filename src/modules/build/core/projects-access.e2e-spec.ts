import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { AllExceptionsFilter } from "../../../common/http/all-exceptions.filter";
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
import { eq } from "drizzle-orm";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

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

    async function cleanup(): Promise<void> {
      const existing = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.orgId, ORG_ID));
      for (const row of existing) {
        await db
          .delete(projectMembers)
          .where(eq(projectMembers.projectId, row.id));
      }
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
        .values({ id: ORG_ID, name: "Proj Access E2E", slug: ORG_ID , ownerMembershipId: 9001 })
        .onConflictDoNothing();

      await db
        .insert(users)
        .values([
          { id: U.owner, email: `${U.owner}@e2e.test`, name: "Owner", role: "OWNER" },
          {
            id: U.member,
            email: `${U.member}@e2e.test`,
            name: "Member",
            role: "MEMBER",
          },
          {
            id: U.outsider,
            email: `${U.outsider}@e2e.test`,
            name: "Outsider",
            role: "MEMBER",
          },
        ])
        .onConflictDoNothing();

      await db
        .insert(organizationMembers)
        .values([
          { userId: U.owner, orgId: ORG_ID, role: "OWNER", isOwner: true },
          { userId: U.member, orgId: ORG_ID, role: "MEMBER", isOwner: false },
          { userId: U.outsider, orgId: ORG_ID, role: "MEMBER", isOwner: false },
        ])
        .onConflictDoNothing();

      const inserted = await db
        .insert(projects)
        .values([
          {
            orgId: ORG_ID,
            name: "Target Project",
            key: "PATGT",
            managerId: U.owner,
          },
        ])
        .onConflictDoNothing()
        .returning({ id: projects.id, name: projects.name });

      for (const row of inserted) {
        if (row.name === "Target Project") projectIds.target = row.id;
      }

      await db
        .insert(projectMembers)
        .values({ orgId: ORG_ID, projectId: projectIds.target, userId: U.member })
        .onConflictDoNothing();
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = RBAC_E2E_DATABASE_URL;
      process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
      const ref = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = ref.createNestApplication();
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();
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
        .get(`/projects/${projectIds.target}/members`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it("a non-member is denied the member list (403)", async () => {
      grantViewOnly();
      const token = await tokenFor(U.outsider, false);
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectIds.target}/members`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("a non-member is denied the custom states (403)", async () => {
      grantViewOnly();
      const token = await tokenFor(U.outsider, false);
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectIds.target}/custom-states`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("a non-member is denied the automations list (403)", async () => {
      grantViewOnly();
      const token = await tokenFor(U.outsider, false);
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectIds.target}/automations`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("the org owner can read the member list of any project", async () => {
      const token = await tokenFor(U.owner, true);
      const res = await request(app.getHttpServer())
        .get(`/projects/${projectIds.target}/members`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  },
);
