import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  users,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

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

    async function cleanup(): Promise<void> {
      const existing = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.orgId, ORG_ID));
      for (const row of existing) {
        await db.delete(projectMembers).where(eq(projectMembers.projectId, row.id));
      }
      await db.delete(projects).where(eq(projects.orgId, ORG_ID));
      await db.delete(organizationMembers).where(eq(organizationMembers.orgId, ORG_ID));
      await db.delete(organizations).where(eq(organizations.id, ORG_ID));
      for (const id of Object.values(U)) {
        await db.delete(users).where(eq(users.id, id));
      }
    }

    async function seed(): Promise<void> {
      await db
        .insert(organizations)
        .values({ id: ORG_ID, name: "Proj Scope E2E", slug: ORG_ID })
        .onConflictDoNothing();

      await db
        .insert(users)
        .values([
          { id: U.admin, email: `${U.admin}@e2e.test`, name: "Admin", role: "CEO" },
          { id: U.member, email: `${U.member}@e2e.test`, name: "Member", role: "MEMBER" },
          { id: U.outsider, email: `${U.outsider}@e2e.test`, name: "Outsider", role: "MEMBER" },
        ])
        .onConflictDoNothing();

      await db
        .insert(organizationMembers)
        .values([
          { userId: U.admin, orgId: ORG_ID, role: "CEO", isOwner: true },
          { userId: U.member, orgId: ORG_ID, role: "MEMBER", isOwner: false },
          { userId: U.outsider, orgId: ORG_ID, role: "MEMBER", isOwner: false },
        ])
        .onConflictDoNothing();

      const inserted = await db
        .insert(projects)
        .values([
          {
            orgId: ORG_ID,
            name: "Managed Project",
            key: "PSMGD",
            managerId: U.member,
          },
          {
            orgId: ORG_ID,
            name: "Member Project",
            key: "PSMEM",
            managerId: U.admin,
          },
          {
            orgId: ORG_ID,
            name: "Other Project",
            key: "PSOTH",
            managerId: U.admin,
          },
        ])
        .onConflictDoNothing()
        .returning({ id: projects.id, name: projects.name });

      for (const row of inserted) {
        if (row.name === "Managed Project") projectIds.managed = row.id;
        if (row.name === "Member Project") projectIds.member = row.id;
        if (row.name === "Other Project") projectIds.other = row.id;
      }

      await db
        .insert(projectMembers)
        .values({ projectId: projectIds.member, userId: U.member })
        .onConflictDoNothing();
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = RBAC_E2E_DATABASE_URL;
      process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
      const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

    it("scope=all — sees every project in the org", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(
          new Map<string, DataScope>([["projects:manage", "all"]]),
        );

      const token = await signToken({
        sub: U.member,
        orgId: ORG_ID,
        role: "MEMBER",
        enabledModules: ["projects"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/projects")
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
          new Map<string, DataScope>([["projects:manage", "own"]]),
        );

      const token = await signToken({
        sub: U.member,
        orgId: ORG_ID,
        role: "MEMBER",
        enabledModules: ["projects"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/projects")
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
        .mockResolvedValue(new Map<string, DataScope>());

      const token = await signToken({
        sub: U.outsider,
        orgId: ORG_ID,
        role: "MEMBER",
        enabledModules: ["projects"],
        isOrgOwner: false,
      });

      const res = await request(app.getHttpServer())
        .get("/projects")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("org owner always sees all projects regardless of permissions resolution", async () => {
      const token = await signToken({
        sub: U.admin,
        orgId: ORG_ID,
        role: "CEO",
        enabledModules: ["projects"],
        isOrgOwner: true,
      });

      const res = await request(app.getHttpServer())
        .get("/projects")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: number }>).map((p) => p.id);
      expect(ids).toEqual(
        expect.arrayContaining([projectIds.managed, projectIds.member, projectIds.other]),
      );
    });
  },
);
