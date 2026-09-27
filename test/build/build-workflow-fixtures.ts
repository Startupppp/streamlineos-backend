import { eq } from "drizzle-orm";
import { auditLogs, projectStatuses, roles, roleAssignments, rolePermissionGrants, tickets } from "src/db/schema";
import { bumpPermissionsVersion } from "src/common/rbac/access-invalidate";
import { seedOrg } from "test/helpers/seed-builder";
import { createSeededE2eApp, signSeededToken } from "test/helpers/seeded-e2e-app";

const permissions = [
  "build:view", "build:create", "build:update", "build:delete", "build:manage",
  "build:tickets:view", "build:tickets:create", "build:tickets:update", "build:tickets:delete",
  "build:cycles:view", "build:cycles:manage", "build:workspace:manage",
];

export async function createBuildWorkflowFixture() {
  const seeded = await createSeededE2eApp();
  const home = await seedOrg(seeded.seedDb).onPlan("PAID").withModules("build")
    .addMember("manager", { permissionKeys: permissions })
    .addMember("limited", { permissionKeys: ["build:view", "build:tickets:view", "build:tickets:update"] })
    .addMember("denied")
    .addProject("main").addProjectMember("main", "manager", "MANAGER")
    .addProjectMember("main", "limited").addProject("private").build();
  const neighbour = await seedOrg(seeded.seedDb).onPlan("PAID").withModules("build")
    .addMember("manager", { permissionKeys: permissions }).addProject("foreign").build();
  const projectId = home.projects.main.projectId;
  const foreignProjectId = neighbour.projects.foreign.projectId;
  const slug = `scope-${crypto.randomUUID()}`;
  const [role] = await seeded.seedDb.insert(roles).values({ orgId: home.orgId, name: slug, slug, rank: 40 }).returning();
  if (!role) throw new Error("Build scope fixture role missing");
  await seeded.seedDb.insert(rolePermissionGrants).values({ orgId: home.orgId, roleId: role.id, permissionKey: "build:manage", scope: "own" });
  await seeded.seedDb.insert(roleAssignments).values({ orgId: home.orgId, roleId: role.id, organizationMembershipId: home.members.limited.membershipId });
  await bumpPermissionsVersion(seeded.seedDb, home.orgId);
  for (const [orgId, id] of [[home.orgId, projectId], [neighbour.orgId, foreignProjectId]] as const)
    await seeded.seedDb.insert(projectStatuses).values(["TODO", "IN_PROGRESS", "DONE"].map(name => ({ orgId, projectId: id, name })));
  const ownTickets = await seeded.seedDb.insert(tickets).values(
    Array.from({ length: 6 }, (_, index) => ({
      orgId: home.orgId, projectId, ticketNumber: index + 1, title: `workflow ticket ${index}`,
      status: "TODO", rank: String((index + 1) * 1000),
      reporterId: index === 5 ? home.members.limited.userId : home.members.manager.userId,
      reporterMembershipId: index === 5 ? home.members.limited.membershipId : home.members.manager.membershipId,
    })),
  ).returning({ id: tickets.id });
  const [foreign] = await seeded.seedDb.insert(tickets).values({
    orgId: neighbour.orgId, projectId: foreignProjectId, ticketNumber: 1, title: "foreign workflow ticket",
    status: "TODO", reporterId: neighbour.members.manager.userId,
  }).returning({ id: tickets.id });
  if (!foreign || ownTickets.length !== 6) throw new Error("Build ticket fixture incomplete");
  const managerToken = await signSeededToken(seeded, home.members.manager.userId, home.orgId);
  const limitedToken = await signSeededToken(seeded, home.members.limited.userId, home.orgId);
  const deniedToken = await signSeededToken(seeded, home.members.denied.userId, home.orgId);
  return {
    seeded, home, neighbour, projectId, foreignProjectId, managerToken, limitedToken, deniedToken,
    ticketIds: ownTickets.map(ticket => ticket.id), foreignTicketId: foreign.id,
    async close() {
      try {
        await seeded.seedDb.delete(tickets).where(eq(tickets.orgId, home.orgId));
        await seeded.seedDb.delete(tickets).where(eq(tickets.orgId, neighbour.orgId));
        for (const fixture of [home, neighbour]) {
          const audit = await seeded.seedDb.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.orgId, fixture.orgId)).limit(1);
          // Audited tenants remain in disposable scratch: append-only audit rows forbid tenant deletion.
          if (audit.length === 0) await fixture.teardown();
        }
      } finally {
        await seeded.close();
      }
    },
  };
}

export type BuildWorkflowFixture = Awaited<ReturnType<typeof createBuildWorkflowFixture>>;
