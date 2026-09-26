import type { Db } from "../../../db/drizzle.module";
import { ProjectsAutomationsService } from "./projects-automations.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("ProjectsAutomationsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;

  function makeDb(autoRows: unknown[]) {
    const orderByLimit = { orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(autoRows) }) };
    const where = jest.fn().mockReturnValue(orderByLimit);
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as unknown as Db, where };
  }

  it("scopes automations to the attacker's org — returns empty for other org (cross-tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const members = { assertProjectAccess: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new ProjectsAutomationsService(db, planLimits, members);
    const u = { orgId: ATTACKER_ORG, userId: "u1" } as never;
    const result = await svc.listAutomations(u, 1);
    expect(result).toHaveLength(0);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns automations for the owning org (same-tenant control)", async () => {
    const auto = { id: 1, orgId: OWNER_ORG, projectId: 1, name: "Auto1" };
    const { db } = makeDb([auto]);
    const members = { assertProjectAccess: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new ProjectsAutomationsService(db, planLimits, members);
    const u = { orgId: OWNER_ORG, userId: "u1" } as never;
    const result = await svc.listAutomations(u, 1);
    expect(result).toHaveLength(1);
  });
});

describe("ProjectsAutomationsService — cross-project isolation (project-scoped manager, same org)", () => {
  const ORG = "org-1";

  const planLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;
  const members = { assertCanManageProject: jest.fn().mockResolvedValue(undefined) } as never;

  function makeMutationDb(returningRows: unknown[]) {
    const where = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(returningRows) });
    const set = jest.fn().mockReturnValue({ where });
    const update = jest.fn().mockReturnValue({ set });
    const deleteWhere = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue(returningRows) });
    const del = jest.fn().mockReturnValue({ where: deleteWhere });
    return { db: { update, delete: del } as unknown as Db, where, deleteWhere };
  }

  it("updateAutomation cannot reach an automation belonging to a different project in the same org", async () => {
    const { db, where } = makeMutationDb([]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);
    const u = { orgId: ORG, userId: "u1" } as never;

    await expect(svc.updateAutomation(u, 1, 99, { name: "renamed" } as never)).rejects.toThrow(
      "Automation not found",
    );

    const predicate = where.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(1);
  });

  it("deleteAutomation cannot reach an automation belonging to a different project in the same org", async () => {
    const { db, deleteWhere } = makeMutationDb([]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);
    const u = { orgId: ORG, userId: "u1" } as never;

    await expect(svc.deleteAutomation(u, 1, 99)).rejects.toThrow("Automation not found");

    const predicate = deleteWhere.mock.calls[0]?.[0];
    expect(sqlValues(predicate)).toContain(1);
  });

  it("updateAutomation still succeeds when the automation genuinely belongs to the named project", async () => {
    const auto = { id: 99, orgId: ORG, projectId: 1, name: "renamed" };
    const { db } = makeMutationDb([auto]);
    const svc = new ProjectsAutomationsService(db, planLimits, members);
    const u = { orgId: ORG, userId: "u1" } as never;

    const result = await svc.updateAutomation(u, 1, 99, { name: "renamed" } as never);
    expect(result).toEqual(auto);
  });
});
