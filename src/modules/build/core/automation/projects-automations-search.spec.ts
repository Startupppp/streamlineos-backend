import type { Db } from "../../../../db/drizzle.module";
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

function makeDb() {
  const capturedWhereConds: unknown[] = [];
  const limit = jest.fn().mockResolvedValue([]);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockImplementation((cond: unknown) => {
    capturedWhereConds.push(cond);
    return { orderBy };
  });
  const leftJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ leftJoin });
  const select = jest.fn().mockReturnValue({ from });
  const db = { select } as unknown as Db;
  return { db, capturedWhereConds };
}

const planLimits = { assertWithinLimit: jest.fn() } as never;
const members = { assertProjectAccess: jest.fn().mockResolvedValue(undefined) } as never;
const u = { orgId: "org-1", userId: "user-1" } as never;

describe("ProjectsAutomationsService — server-side search predicate (B10)", () => {
  it("with search term — WHERE carries the trimmed term so a page 2 match is not missed by client filter (BE-134 failing first)", async () => {
    const { db, capturedWhereConds } = makeDb();
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await svc.listAutomations(u, 1, { limit: 50, search: "notify" });

    const allValues = capturedWhereConds.flatMap((c) => sqlValues(c));
    expect(allValues.some((v) => typeof v === "string" && v.includes("notify"))).toBe(true);
  });

  it("without search term — WHERE does not carry a name-match literal (BE-141 positive control)", async () => {
    const { db, capturedWhereConds } = makeDb();
    const svc = new ProjectsAutomationsService(db, planLimits, members);

    await svc.listAutomations(u, 1, { limit: 50 });

    const allValues = capturedWhereConds.flatMap((c) => sqlValues(c));
    expect(allValues.every((v) => typeof v !== "string" || !v.endsWith("%"))).toBe(true);
  });
});
