import { eq } from "drizzle-orm";
import request from "supertest";
import {
  projectStatuses,
  roleAssignments,
  rolePermissionGrants,
  roles,
  tickets,
} from "src/db/schema";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";
import type { Db } from "src/db/drizzle.module";
import {
  createSeededE2eApp,
  signSeededToken,
  type SeededE2eApp,
} from "test/helpers/seeded-e2e-app";
import { seedOrg, type SeededFixture } from "test/helpers/seed-builder";

/**
 * First seeded-database Build spec in this repository.
 *
 * The existing mocked Build suites under `src/modules/build/core/` assert that
 * SQL predicates are BUILT correctly but cannot ask Postgres to enforce them.
 * This file asks the remaining question: two seeded organisations, real guards,
 * the real RBAC resolver, and a real Postgres.
 *
 * What this file proves:
 *   fixture     two orgs, two projects, three tickets are properly isolated
 *   scope=all   a member whose build:manage grant carries scope "all" sees ALL
 *               tickets in the project list, regardless of reporter
 *   scope=own   a member whose build:manage grant carries scope "own" sees ONLY
 *               tickets where they are the reporter — not the teammate's ticket
 *   cross-tenant a member of org A asking for org B's ticket id by GET returns
 *               404, not 403 — a 403 would confirm the record exists (§4)
 *   integrity   after the cross-tenant probe, org B's row is re-read from the
 *               database and is still present with the correct orgId
 *
 * What this file does NOT prove, measured rather than assumed:
 *   Deleting the orgId predicate from the ticket detail service leaves this file
 *   GREEN if the build.tickets table carries an RLS policy using
 *   app.current_org_id() — the app role cannot see another tenant's rows even
 *   without a service-level predicate. Attribution of the cross-tenant refusal
 *   to the service predicate belongs to the unit tests in
 *   src/modules/build/core/ that compile the predicate and assert the tenant
 *   binding. The SCOPE leg below is what this file can attribute on its own:
 *   removing the scopeClause from ProjectsTicketsReadService.listTickets turns
 *   the scope=own test red here and nowhere else.
 *
 * Route surface exercised:
 *   GET /build/:projectId/tickets         (build:tickets:view, DataScope via build:manage)
 *   GET /build/:projectId/tickets/:ticketId (build:tickets:view, tenant scope)
 *
 * Note: createRoleGrant in seed-builder.ts hard-codes scope: "all". A member
 * needing scope "own" must be granted via the insertScopedGrant helper below,
 * which replicates the same role/grant/assignment pattern with a custom scope.
 * The helper is NOT a modification of seed-builder.ts.
 */

async function insertScopedGrant(
  db: Db,
  orgId: string,
  membershipId: number,
  permissionKey: string,
  scope: "all" | "team" | "own" | "none",
): Promise<void> {
  const slug = `seeded-scope-${crypto.randomUUID().slice(0, 12)}`;
  const [roleRow] = await db
    .insert(roles)
    .values({ name: slug, slug, orgId, rank: 40 })
    .returning({ id: roles.id });
  if (!roleRow) throw new Error(`scope-grant: role creation failed for org ${orgId}`);
  await db.insert(rolePermissionGrants).values({
    orgId,
    roleId: roleRow.id,
    permissionKey,
    scope,
  });
  await db.insert(roleAssignments).values({
    orgId,
    organizationMembershipId: membershipId,
    roleId: roleRow.id,
  });
  await bumpPermissionsVersion(db, orgId);
  await new Promise<void>((resolve) => setTimeout(resolve, 1_400));
}

function extractIds(body: unknown): number[] {
  if (typeof body !== "object" || body === null) return [];
  const dataField: unknown = (body as Record<string, unknown>)["data"];
  if (!Array.isArray(dataField)) return [];
  const ids: number[] = [];
  for (const item of dataField as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const idField: unknown = (item as Record<string, unknown>)["id"];
    if (typeof idField === "number") ids.push(idField);
  }
  return ids;
}

describe("[seeded-e2e] Build tickets — DataScope and cross-tenant isolation", () => {
  let seeded: SeededE2eApp;
  let home: SeededFixture;
  let neighbour: SeededFixture;
  let homeProjectId = 0;
  let neighbourProjectId = 0;
  let homeTicketAId = 0;
  let homeTicketBId = 0;
  let neighbourTicketId = 0;
  let managerToken = "";
  let limitedToken = "";
  let server: unknown;

  beforeAll(async () => {
    seeded = await createSeededE2eApp();
    server = seeded.app.getHttpServer();

    home = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("build")
      .addMember("manager", {
        permissionKeys: ["build:tickets:view", "build:manage"],
      })
      .addMember("limited", { permissionKeys: ["build:tickets:view"] })
      .addProject("main")
      .build();

    await insertScopedGrant(
      seeded.seedDb,
      home.orgId,
      home.members.limited.membershipId,
      "build:manage",
      "own",
    );

    neighbour = await seedOrg(seeded.seedDb)
      .onPlan("PAID")
      .withModules("build")
      .addMember("manager", {
        permissionKeys: ["build:tickets:view", "build:manage"],
      })
      .addProject("nbr")
      .build();

    homeProjectId = home.projects.main.projectId;
    neighbourProjectId = neighbour.projects.nbr.projectId;

    await seeded.seedDb.insert(projectStatuses).values({
      orgId: home.orgId,
      projectId: homeProjectId,
      name: "TODO",
    });
    await seeded.seedDb.insert(projectStatuses).values({
      orgId: neighbour.orgId,
      projectId: neighbourProjectId,
      name: "TODO",
    });

    const [ticketA] = await seeded.seedDb
      .insert(tickets)
      .values({
        orgId: home.orgId,
        projectId: homeProjectId,
        ticketNumber: 1,
        title: "manager-owned ticket",
        status: "TODO",
        reporterId: home.members.manager.userId,
      })
      .returning({ id: tickets.id });
    homeTicketAId = ticketA?.id ?? 0;

    const [ticketB] = await seeded.seedDb
      .insert(tickets)
      .values({
        orgId: home.orgId,
        projectId: homeProjectId,
        ticketNumber: 2,
        title: "limited-owned ticket",
        status: "TODO",
        reporterId: home.members.limited.userId,
      })
      .returning({ id: tickets.id });
    homeTicketBId = ticketB?.id ?? 0;

    const [ticketN] = await seeded.seedDb
      .insert(tickets)
      .values({
        orgId: neighbour.orgId,
        projectId: neighbourProjectId,
        ticketNumber: 1,
        title: "neighbour ticket",
        status: "TODO",
        reporterId: neighbour.members.manager.userId,
      })
      .returning({ id: tickets.id });
    neighbourTicketId = ticketN?.id ?? 0;

    managerToken = await signSeededToken(
      seeded,
      home.members.manager.userId,
      home.orgId,
    );
    limitedToken = await signSeededToken(
      seeded,
      home.members.limited.userId,
      home.orgId,
    );
  }, 180_000);

  afterAll(async () => {
    if (homeTicketAId > 0)
      await seeded.seedDb.delete(tickets).where(eq(tickets.id, homeTicketAId));
    if (homeTicketBId > 0)
      await seeded.seedDb.delete(tickets).where(eq(tickets.id, homeTicketBId));
    if (neighbourTicketId > 0)
      await seeded.seedDb.delete(tickets).where(eq(tickets.id, neighbourTicketId));
    if (home) await home.teardown();
    if (neighbour) await neighbour.teardown();
    if (seeded) await seeded.close();
  }, 120_000);

  it("fixture check — two orgs, two projects and three tickets are distinct", () => {
    expect(home.orgId).not.toBe(neighbour.orgId);
    expect(homeProjectId).toBeGreaterThan(0);
    expect(neighbourProjectId).toBeGreaterThan(0);
    expect(homeProjectId).not.toBe(neighbourProjectId);
    expect(homeTicketAId).toBeGreaterThan(0);
    expect(homeTicketBId).toBeGreaterThan(0);
    expect(neighbourTicketId).toBeGreaterThan(0);
    expect(homeTicketAId).not.toBe(homeTicketBId);
    expect(homeTicketAId).not.toBe(neighbourTicketId);
    expect(homeTicketBId).not.toBe(neighbourTicketId);
  });

  it("ALLOW scope=all — manager (build:manage all) sees both tickets in the project list", async () => {
    const response = await request(server as never)
      .get(`/build/${String(homeProjectId)}/tickets`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
    const ids = extractIds(response.body);
    expect(ids).toContain(homeTicketAId);
    expect(ids).toContain(homeTicketBId);
  });

  it("DENY scope=own — limited (build:manage own) sees only their own ticket, not the manager's", async () => {
    const response = await request(server as never)
      .get(`/build/${String(homeProjectId)}/tickets`)
      .set("Authorization", `Bearer ${limitedToken}`);

    expect(response.status).toBe(200);
    const ids = extractIds(response.body);
    expect(ids).toContain(homeTicketBId);
    expect(ids).not.toContain(homeTicketAId);
  });

  it("CROSS-TENANT read — org A member asking for org B's ticket by id answers 404, not 403 or 200", async () => {
    const response = await request(server as never)
      .get(
        `/build/${String(homeProjectId)}/tickets/${String(neighbourTicketId)}`,
      )
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(404);
  });

  it("integrity — after the cross-tenant probe org B's ticket is still present in the database with the correct orgId", async () => {
    const [row] = await seeded.seedDb
      .select({ id: tickets.id, orgId: tickets.orgId })
      .from(tickets)
      .where(eq(tickets.id, neighbourTicketId));

    expect(row?.id).toBe(neighbourTicketId);
    expect(row?.orgId).toBe(neighbour.orgId);
  });
});
