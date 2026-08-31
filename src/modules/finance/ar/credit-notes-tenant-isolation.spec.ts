import type { Db } from "../../../db/drizzle.module";
import { CreditNotesService } from "./credit-notes.service";

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

describe("CreditNotesService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
    const where = jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    });
    const db = { select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }) } as unknown as Db;
    return { db, where };
  }

  it("scopes list to the requesting org (tenant isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new CreditNotesService(db, {} as never, {} as never, {} as never);

    await svc.list(ATTACKER_ORG, { limit: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns items for the owning org (same-tenant control)", async () => {
    const { db } = makeDb([{ id: 1, orgId: OWNER_ORG }]);
    const svc = new CreditNotesService(db, {} as never, {} as never, {} as never);

    const result = await svc.list(OWNER_ORG, { limit: 20 });

    expect(result.data).toHaveLength(1);
  });

  it("includes invoiceId in the SQL predicate when provided", async () => {
    const { db, where } = makeDb([]);
    const svc = new CreditNotesService(db, {} as never, {} as never, {} as never);

    await svc.list(OWNER_ORG, { limit: 20, invoiceId: 42 });

    expect(where).toHaveBeenCalledTimes(1);
    const predicateValues = sqlValues(where.mock.calls[0]?.[0]);
    expect(predicateValues).toContain(42);
    expect(predicateValues).toContain(OWNER_ORG);
  });

  it("does not include invoiceId in predicate when omitted", async () => {
    const { db, where } = makeDb([]);
    const svc = new CreditNotesService(db, {} as never, {} as never, {} as never);

    await svc.list(OWNER_ORG, { limit: 20 });

    expect(where).toHaveBeenCalledTimes(1);
    const predicateValues = sqlValues(where.mock.calls[0]?.[0]);
    expect(predicateValues).not.toContain(42);
  });

  it("never returns a cross-tenant credit note even when invoiceId matches another org", async () => {
    const CROSS_TENANT_ROW = { id: 99, orgId: "org-other", invoiceId: 7 };
    const { db, where } = makeDb([CROSS_TENANT_ROW]);
    const svc = new CreditNotesService(db, {} as never, {} as never, {} as never);

    await svc.list(ATTACKER_ORG, { limit: 20, invoiceId: 7 });

    expect(where).toHaveBeenCalledTimes(1);
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    expect(sqlValues(where.mock.calls[0]?.[0])).not.toContain("org-other");
  });
});
