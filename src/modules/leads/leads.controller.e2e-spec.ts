import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../../app.module";
import { AllExceptionsFilter } from "../../common/http/all-exceptions.filter";
import { signToken } from "../../../test/helpers/sign-token";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import {
  accessVersions,
  leads,
  organizationMembers,
  organizations,
  permissions,
  roleAssignments,
  rolePermissionGrants,
  roles,
  users,
} from "../../db/schema";
import { eq } from "drizzle-orm";

describe("Leads PermissionGuard wiring (e2e, no DB required)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
    process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = ref.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });
  afterAll(async () => app.close());

  it("401 on GET /leads without a token", async () => {
    const res = await request(app.getHttpServer()).get("/leads");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("403 on GET /leads when the crm module is disabled for the org", async () => {
    const token = await signToken({ enabledModules: ["hr"], isOrgOwner: false });
    const res = await request(app.getHttpServer()).get("/leads").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Module not available on this plan" });
  });

  it("403 on POST /leads when the crm module is disabled for the org", async () => {
    const token = await signToken({ enabledModules: ["hr"], isOrgOwner: false });
    const res = await request(app.getHttpServer())
      .post("/leads")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", phone: "1", source: "other", priority: "WARM" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Module not available on this plan" });
  });

  it("403 on DELETE /leads/1 when the crm module is disabled for the org", async () => {
    const token = await signToken({ enabledModules: ["hr"], isOrgOwner: false });
    const res = await request(app.getHttpServer())
      .delete("/leads/1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Module not available on this plan" });
  });
});

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

describeWithDb(
  "Leads RBAC data-row scope and parity (requires migration 0119 applied and seeded in RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;

    const ORG_ID = "org_rbac_leads_e2e";
    const U = {
      owner: "u_rbac_owner",
      own: "u_rbac_own",
      sales: "u_rbac_sales",
      denied: "u_rbac_denied",
    };
    const leadIds = { own: 0, sales: 0, other: 0 };

    async function cleanup(): Promise<void> {
      await db.delete(leads).where(eq(leads.orgId, ORG_ID));
      await db.delete(rolePermissionGrants).where(eq(rolePermissionGrants.orgId, ORG_ID));
      await db.delete(accessVersions).where(eq(accessVersions.orgId, ORG_ID));
      await db.delete(roles).where(eq(roles.orgId, ORG_ID));
      await db.delete(organizationMembers).where(eq(organizationMembers.orgId, ORG_ID));
      await db.delete(organizations).where(eq(organizations.id, ORG_ID));
      for (const id of Object.values(U)) {
        await db.delete(users).where(eq(users.id, id));
      }
    }

    async function seed(): Promise<void> {
      await db
        .insert(permissions)
        .values({ name: "crm:leads:view", resource: "crm:leads", action: "view" })
        .onConflictDoNothing({ target: permissions.name });

      await db
        .insert(organizations)
        .values({ id: ORG_ID, name: "RBAC Leads E2E", slug: ORG_ID })
        .onConflictDoNothing();

      await db
        .insert(users)
        .values([
          { id: U.owner, email: `${U.owner}@e2e.test`, name: "Owner", role: "OWNER" },
          { id: U.own, email: `${U.own}@e2e.test`, name: "Own Scope", role: "SALES_REP" },
          { id: U.sales, email: `${U.sales}@e2e.test`, name: "Sales", role: "SALES" },
          { id: U.denied, email: `${U.denied}@e2e.test`, name: "Denied", role: "VIEWER_NONE" },
        ])
        .onConflictDoNothing();

      await db
        .insert(organizationMembers)
        .values([
          { userId: U.owner, orgId: ORG_ID, role: "OWNER", isOwner: true },
          { userId: U.own, orgId: ORG_ID, role: "SALES_REP", isOwner: false },
          { userId: U.sales, orgId: ORG_ID, role: "SALES", isOwner: false },
          { userId: U.denied, orgId: ORG_ID, role: "VIEWER_NONE", isOwner: false },
        ])
        .onConflictDoNothing();

      const ownRole = await db
        .insert(roles)
        .values({ name: "Leads Own", slug: "leads_own", orgId: ORG_ID, isSystem: false })
        .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
        .returning({ id: roles.id });
      const salesRole = await db
        .insert(roles)
        .values({ name: "Sales", slug: "SALES", orgId: ORG_ID, isSystem: true })
        .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
        .returning({ id: roles.id });
      const deniedRole = await db
        .insert(roles)
        .values({ name: "Viewer None", slug: "viewer_none", orgId: ORG_ID, isSystem: false })
        .onConflictDoNothing({ target: [roles.slug, roles.orgId] })
        .returning({ id: roles.id });

      const ownRoleId = ownRole[0].id;
      const salesRoleId = salesRole[0].id;
      const deniedRoleId = deniedRole[0].id;

      const membershipRows = await db
        .select({ id: organizationMembers.id, userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, ORG_ID));
      const memberIdByUserId = new Map(membershipRows.map((m) => [m.userId, m.id]));
      const getMembershipId = (userId: string): number => {
        const id = memberIdByUserId.get(userId);
        if (id === undefined) throw new Error(`Membership not found for user ${userId}`);
        return id;
      };

      await db
        .insert(roleAssignments)
        .values([
          { orgId: ORG_ID, organizationMembershipId: getMembershipId(U.own), roleId: ownRoleId },
          { orgId: ORG_ID, organizationMembershipId: getMembershipId(U.sales), roleId: salesRoleId },
          { orgId: ORG_ID, organizationMembershipId: getMembershipId(U.denied), roleId: deniedRoleId },
        ])
        .onConflictDoNothing();

      await db
        .insert(rolePermissionGrants)
        .values([
          { orgId: ORG_ID, roleId: ownRoleId, permissionKey: "crm:leads:view", scope: "own" },
          { orgId: ORG_ID, roleId: salesRoleId, permissionKey: "crm:leads:view", scope: "all" },
        ])
        .onConflictDoNothing();

      await db
        .insert(accessVersions)
        .values({ orgId: ORG_ID, permissionsVersion: 1 })
        .onConflictDoNothing();

      const inserted = await db
        .insert(leads)
        .values([
          { orgId: ORG_ID, name: "Own Lead", assignedToId: U.own },
          { orgId: ORG_ID, name: "Sales Lead", assignedToId: U.sales },
          { orgId: ORG_ID, name: "Other Lead", assignedToId: U.owner },
        ])
        .returning({ id: leads.id, assignedToId: leads.assignedToId });

      for (const row of inserted) {
        if (row.assignedToId === U.own) leadIds.own = row.id;
        if (row.assignedToId === U.sales) leadIds.sales = row.id;
        if (row.assignedToId === U.owner) leadIds.other = row.id;
      }
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = RBAC_E2E_DATABASE_URL;
      process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);
      const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = ref.createNestApplication();
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();
      db = app.get<Db>(DRIZZLE);
      await cleanup();
      await seed();
    });

    afterAll(async () => {
      if (db) await cleanup();
      if (app) await app.close();
    });

    it("denies a user whose role has no crm:leads:view grant (403)", async () => {
      const token = await signToken({
        sub: U.denied,
        orgId: ORG_ID,
        role: "VIEWER_NONE",
        enabledModules: ["crm"],
        isOrgOwner: false,
      });
      const res = await request(app.getHttpServer()).get("/leads").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("own-scope user sees only leads assigned to themselves", async () => {
      const token = await signToken({
        sub: U.own,
        orgId: ORG_ID,
        role: "SALES_REP",
        enabledModules: ["crm"],
        isOrgOwner: false,
      });
      const res = await request(app.getHttpServer()).get("/leads").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const returned = res.body.leads as Array<{ id: number; assignedToId: string | null }>;
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.every((lead) => lead.assignedToId === U.own)).toBe(true);
    });

    it("org owner sees all leads in the org", async () => {
      const token = await signToken({
        sub: U.owner,
        orgId: ORG_ID,
        role: "OWNER",
        enabledModules: ["crm"],
        isOrgOwner: true,
      });
      const res = await request(app.getHttpServer()).get("/leads").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const ids = (res.body.leads as Array<{ id: number }>).map((lead) => lead.id);
      expect(ids).toEqual(expect.arrayContaining([leadIds.own, leadIds.sales, leadIds.other]));
    });

    it("parity: a SALES user keeps access and stays narrowed to their own leads", async () => {
      const token = await signToken({
        sub: U.sales,
        orgId: ORG_ID,
        role: "SALES",
        enabledModules: ["crm"],
        isOrgOwner: false,
      });
      const res = await request(app.getHttpServer()).get("/leads").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const returned = res.body.leads as Array<{ id: number; assignedToId: string | null }>;
      expect(returned.every((lead) => lead.assignedToId === U.sales)).toBe(true);
    });
  },
);
