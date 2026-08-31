import type { Db } from "../../../db/drizzle.module";
import { KbCommentsService } from "./kb-comments.service";

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

function makeChain(rows: unknown[] = []): object {
  return Object.assign(Promise.resolve(rows), {
    limit: jest.fn().mockImplementation(() => makeChain(rows)),
    offset: jest.fn().mockImplementation(() => makeChain(rows)),
    orderBy: jest.fn().mockImplementation(() => makeChain(rows)),
  });
}

describe("KbCommentsService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  it("scopes comment list to the requesting org (tenant isolation)", async () => {
    const allWhereArgs: unknown[] = [];
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((arg: unknown) => {
            allWhereArgs.push(arg);
            return makeChain([]);
          }),
        }),
      })),
    } as unknown as Db;
    const svc = new KbCommentsService(db);

    await svc.list(ATTACKER_ORG, 1);

    expect(allWhereArgs.length).toBeGreaterThan(0);
    const allVals = allWhereArgs.flatMap(w => sqlValues(w));
    expect(allVals).toContain(ATTACKER_ORG);
  });

  it("returns comments for the owning org (same-tenant control)", async () => {
    const comment = { id: 1, orgId: OWNER_ORG, articleId: 1, content: "Hello", authorId: "u1" };
    const db = {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue(makeChain([comment])),
        }),
      })),
    } as unknown as Db;
    const svc = new KbCommentsService(db);

    const result = await svc.list(OWNER_ORG, 1);

    expect(result).toHaveLength(1);
  });
});
