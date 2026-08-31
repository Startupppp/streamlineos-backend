import type { Db } from "../../db/drizzle.module";
import { LeadConversionService } from "./lead-conversion.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("LeadConversionService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeService(crmRows: unknown[]) {
    const where = jest.fn().mockResolvedValue(crmRows);
    const builder = {
      from: jest.fn(),
      where,
      groupBy: jest.fn(),
      limit: jest.fn(),
      leftJoin: jest.fn(),
      innerJoin: jest.fn(),
    };
    builder.from.mockReturnValue(builder);
    builder.groupBy.mockReturnValue(builder);
    builder.limit.mockReturnValue(builder);
    builder.leftJoin.mockReturnValue(builder);
    builder.innerJoin.mockReturnValue(builder);
    where.mockReturnValue(builder);

    const db = {
      select: jest.fn().mockReturnValue(builder),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    } as unknown as Db;

    const access = { membersWithPermission: jest.fn().mockResolvedValue([{ userId: "u1" }]) };
    const dispatch = { emit: jest.fn() };
    const merges = { mergeLead: jest.fn() };
    const svc = new LeadConversionService(db, access as never, dispatch as never, merges as never);
    return { svc, where, db };
  }

  it("scopes assignee lookup query to the requesting org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const lead = { id: 1, orgId: ATTACKER, name: "Test", email: null, phone: null, company: null, designation: null, city: null, potentialValue: null, assignedToId: null, status: "new", source: "web", priority: "medium" };
    await svc.convert(ATTACKER, "user-1", lead as never, { status: "converted" } as never).catch(() => {});
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(ATTACKER);
  });

  it("uses the owning org for assignee lookup (control)", async () => {
    const { svc, where } = makeService([]);
    const lead = { id: 1, orgId: OWNER, name: "Owner Lead", email: null, phone: null, company: null, designation: null, city: null, potentialValue: null, assignedToId: null, status: "new", source: "web", priority: "medium" };
    await svc.convert(OWNER, "user-1", lead as never, { status: "converted" } as never).catch(() => {});
    const allVals = where.mock.calls.flat().flatMap((c: unknown) => sqlValues(c));
    expect(allVals).toContain(OWNER);
  });
});
