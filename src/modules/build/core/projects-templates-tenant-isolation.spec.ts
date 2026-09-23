import type { Db } from "../../../db/drizzle.module";
import { ProjectsTemplatesService } from "./projects-templates.service";
import type { PlanLimitsService } from "../../billing/core/plan-limits.service";

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

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

function makeDeps() {
  const planLimits = {} as unknown as PlanLimitsService;
  return { planLimits };
}

describe("ProjectsTemplatesService — cross-tenant isolation", () => {
  it("listTemplates scopes findMany WHERE to the requesting org (cross-tenant isolation)", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const db = {
      query: { projectTemplates: { findMany } },
    } as unknown as Db;
    const { planLimits } = makeDeps();
    const svc = new ProjectsTemplatesService(db, planLimits);

    const result = await svc.listTemplates(ATTACKER_ORG);

    expect(findMany).toHaveBeenCalled();
    const opts = findMany.mock.calls[0]?.[0] as { where?: unknown } | undefined;
    expect(sqlValues(opts?.where)).toContain(ATTACKER_ORG);
    expect(sqlValues(opts?.where)).not.toContain(OWNER_ORG);
    expect(result).toHaveLength(0);
  });

  it("listTemplates returns templates for the owning org (control — same-tenant access works)", async () => {
    const fakeTemplate = { id: 1, orgId: OWNER_ORG, name: "Sprint", tickets: [] };
    const db = {
      query: { projectTemplates: { findMany: jest.fn().mockResolvedValue([fakeTemplate]) } },
    } as unknown as Db;
    const { planLimits } = makeDeps();
    const svc = new ProjectsTemplatesService(db, planLimits);

    const result = await svc.listTemplates(OWNER_ORG);
    expect(result).toHaveLength(1);
  });
});
