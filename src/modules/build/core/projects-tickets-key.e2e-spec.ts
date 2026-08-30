import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";
import { signToken } from "../../../../test/helpers/sign-token";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  organizationMembers,
  organizations,
  pmWorkspaces,
  projectMembers,
  projects,
  tickets,
  users,
} from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

const RBAC_E2E_DATABASE_URL = process.env.RBAC_E2E_DATABASE_URL;
const describeWithDb = RBAC_E2E_DATABASE_URL ? describe : describe.skip;

describeWithDb(
  "GET :projectId/tickets/key/:ticketNumber — allow/deny matrix (e2e, requires RBAC_E2E_DATABASE_URL)",
  () => {
    let app: INestApplication;
    let db: Db;
    let accessService: AccessService;

    const ORG_ID = "org_ticket_key_e2e";
    const OTHER_ORG_ID = "org_ticket_key_other";
    const U = {
      owner: "u_tk_owner",
      member: "u_tk_member",
      outsider: "u_tk_outsider",
    };
    const projectIds = { target: 0 };

    async function cleanup(): Promise<void> {
      await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
        await tx.delete(organizations).where(eq(organizations.id, ORG_ID));
        for (const id of Object.values(U))
          await tx.delete(users).where(eq(users.id, id));
      });
      await runInNewTenantTransaction(db, OTHER_ORG_ID, async (tx) => {
        await tx.delete(organizations).where(eq(organizations.id, OTHER_ORG_ID));
      });
    }

    async function seed(): Promise<void> {
      await runInNewTenantTransaction(db, ORG_ID, async (tx) => {
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
          .values({ id: ORG_ID, name: "Ticket Key E2E", slug: ORG_ID, ownerMembershipId })
          .onConflictDoNothing();

        await tx
          .insert(organizationMembers)
          .values([
            { id: ownerMembershipId, userId: U.owner, orgId: ORG_ID, isOwner: true },
            { userId: U.member, orgId: ORG_ID, isOwner: false },
            { userId: U.outsider, orgId: ORG_ID, isOwner: false },
          ])
          .onConflictDoNothing();

        const [ws] = await tx
          .insert(pmWorkspaces)
          .values({ orgId: ORG_ID, name: "E2E Workspace", slug: `ws-${ORG_ID}`, isDefault: true })
          .returning({ pmWorkspaceId: pmWorkspaces.pmWorkspaceId });

        const inserted = await tx
          .insert(projects)
          .values([
            { orgId: ORG_ID, name: "Key Test Project", key: "KTP", managerId: U.owner, pmWorkspaceId: ws.pmWorkspaceId },
          ])
          .onConflictDoNothing()
          .returning({ id: projects.id });

        projectIds.target = inserted[0]?.id ?? 0;

        await tx
          .insert(projectMembers)
          .values({ orgId: ORG_ID, projectId: projectIds.target, userId: U.member })
          .onConflictDoNothing();

        const ticketRows = Array.from({ length: 101 }, (_, i) => ({
          orgId: ORG_ID,
          projectId: projectIds.target,
          title: `Ticket ${i + 1}`,
          ticketNumber: i + 1,
          status: "TODO",
        }));
        await tx.insert(tickets).values(ticketRows).onConflictDoNothing();
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

    function grantTicketView(): void {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(new Map<string, DataScope>([["build:tickets:view", "all"]]));
    }

    async function tokenFor(sub: string, orgId: string, isOrgOwner: boolean): Promise<string> {
      return signToken({ sub, orgId, role: isOrgOwner ? "OWNER" : "MEMBER", enabledModules: ["build"], isOrgOwner });
    }

    it("owner fetches ticket #1 by key — 200", async () => {
      grantTicketView();
      const token = await tokenFor(U.owner, ORG_ID, true);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/tickets/key/1`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ticketNumber).toBe(1);
    });

    it("ticket #101 opens — regression for the beyond-100 bug", async () => {
      grantTicketView();
      const token = await tokenFor(U.owner, ORG_ID, true);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/tickets/key/101`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ticketNumber).toBe(101);
    });

    it("actor without build:tickets:view permission is denied — 403", async () => {
      jest
        .spyOn(accessService, "resolveUserPermissions")
        .mockResolvedValue(new Map<string, DataScope>());
      const token = await tokenFor(U.member, ORG_ID, false);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/tickets/key/1`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("unknown ticket key returns 404", async () => {
      grantTicketView();
      const token = await tokenFor(U.owner, ORG_ID, true);
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/tickets/key/99999`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });

    it("unauthenticated request returns 401", async () => {
      const res = await request(app.getHttpServer())
        .get(`/build/${projectIds.target}/tickets/key/1`);
      expect(res.status).toBe(401);
    });
  },
);
