import type { Db } from "../../../db/drizzle.module";
import { InputsService } from "./inputs.service";

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

describe("InputsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  function makeDb(runRows: unknown[], inputRows: unknown[] = []) {
    const inputOffset = jest.fn().mockResolvedValue(inputRows);
    const inputLimit = jest.fn().mockReturnValue({ offset: inputOffset });
    const inputOrderBy = jest.fn().mockReturnValue({ limit: inputLimit });
    const inputWhere = jest.fn().mockReturnValue({ orderBy: inputOrderBy });
    const inputInnerJoin = jest.fn().mockReturnValue({ where: inputWhere });
    const inputFrom = jest.fn().mockReturnValue({ innerJoin: inputInnerJoin });

    const runLimit = jest.fn()
      .mockResolvedValueOnce(runRows)
      .mockResolvedValue(inputRows);
    const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
    const runFrom = jest.fn().mockReturnValue({ where: runWhere });

    const select = jest.fn()
      .mockReturnValueOnce({ from: runFrom })
      .mockReturnValue({ from: inputFrom });

    return { db: { select } as unknown as Db, runWhere };
  }

  it("returns null for listInputs when run belongs to a different org (cross-tenant isolation)", async () => {
    const { db, runWhere } = makeDb([]);
    const svc = new InputsService(db);
    const result = await svc.listInputs(ATTACKER_ORG, 99, {} as never, "all", "u1");
    expect(result).toBeNull();
    expect(sqlValues(runWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("returns inputs for the owning org (same-tenant control)", async () => {
    const run = { id: 1, status: "DRAFT" };
    const input = { id: 1, orgId: OWNER_ORG, runId: 1, userId: "u1" };
    const { db } = makeDb([run], [input]);
    const svc = new InputsService(db);
    const result = await svc.listInputs(OWNER_ORG, 1, {} as never, "all", "u1");
    expect(result).not.toBeNull();
  });
});
