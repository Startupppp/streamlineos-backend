import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  timesheets,
  users,
} from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

describeWithDb(
  "Timesheets scope enforcement (e2e, requires RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;
    let accessService: AccessService;

    const ORG_ID = "org_ts_scope_e2e";
    const U = {
      admin: "u_ts_admin",
      member: "u_ts_member",
      other: "u_ts_other",
    };
    const entryIds = { admin: 0, member: 0 };

    async function cleanup(): Promise<void> {
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

        await tx
          .insert(organizationMembers)
          .values([
            { id: ownerMembershipId, userId: U.admin, orgId: ORG_ID, isOwner: true },
            { userId: U.member, orgId: ORG_ID, isOwner: false },
            { userId: U.other, orgId: ORG_ID, isOwner: false },
          ])
          .onConflictDoNothing();

        const inserted = await tx
          .insert(timesheets)
          .values([
            { orgId: ORG_ID, userId: U.admin, date: "2024-01-10", hours: "2" },
            { orgId: ORG_ID, userId: U.member, date: "2024-01-11", hours: "1" },
          ])
          .onConflictDoNothing()
          .returning({ id: timesheets.id, userId: timesheets.userId });

        for (const row of inserted) {
          if (row.userId === U.admin) entryIds.admin = row.id;
          if (row.userId === U.member) entryIds.member = row.id;
        }
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

    afterEach(() => {
      jest.restoreAllMocks();
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
      const ids = (res.body as Array<{ id: number }>).map((e) => e.id);
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
      const returned = res.body as Array<{ id: number; userId: string }>;
      expect(returned.length).toBeGreaterThan(0);
      expect(returned.every((e) => e.userId === U.member)).toBe(true);
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
      expect(res.body).toEqual([]);
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
      const ids = (res.body as Array<{ id: number }>).map((e) => e.id);
      expect(ids).toEqual(expect.arrayContaining([entryIds.admin, entryIds.member]));
    });
  },
);
