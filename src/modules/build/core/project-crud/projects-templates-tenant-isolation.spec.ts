import type { Db } from "../../../../db/drizzle.module";
import { ProjectsTemplatesService } from "./projects-templates.service";
import type { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { encodeCursor } from "../../../../common/pagination/cursor";

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

interface SelectBuilder {
  from: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function makeSelectDb(rows: unknown[]) {
  const where = jest.fn();
  const builder: SelectBuilder = {
    from: jest.fn(() => builder),
    where: jest.fn((condition: unknown) => {
      where(condition);
      return builder;
    }),
    orderBy: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  const db = { select: jest.fn(() => builder) } as unknown as Db;
  return { db, where };
}

describe("ProjectsTemplatesService — cross-tenant isolation", () => {
  it("listTemplates scopes the select WHERE to the requesting org (cross-tenant isolation)", async () => {
    const { db, where } = makeSelectDb([]);
    const { planLimits } = makeDeps();
    const svc = new ProjectsTemplatesService(db, planLimits);

    const result = await svc.listTemplates(ATTACKER_ORG, {});

    expect(where).toHaveBeenCalled();
    const condition = where.mock.calls[0]?.[0];
    expect(sqlValues(condition)).toContain(ATTACKER_ORG);
    expect(sqlValues(condition)).not.toContain(OWNER_ORG);
    expect(result.data).toHaveLength(0);
  });

  it("listTemplates returns templates for the owning org (control — same-tenant access works)", async () => {
    const fakeTemplate = { id: 1, orgId: OWNER_ORG, name: "Sprint" };
    const { db } = makeSelectDb([fakeTemplate]);
    const { planLimits } = makeDeps();
    const svc = new ProjectsTemplatesService(db, planLimits);

    const result = await svc.listTemplates(OWNER_ORG, {});

    expect(result.data).toHaveLength(1);
    expect(result.pagination.hasMore).toBe(false);
  });

  it("listTemplates carries the cursor id into the WHERE so page two cannot silently restart at page one", async () => {
    const { db, where } = makeSelectDb([]);
    const { planLimits } = makeDeps();
    const svc = new ProjectsTemplatesService(db, planLimits);

    const cursor = encodeCursor({ sortValue: new Date(0).toISOString(), id: "42" });
    await svc.listTemplates(OWNER_ORG, { cursor });

    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(42);
  });
});
