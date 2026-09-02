import { SupportKbGapDetectionService } from "./support-kb-gap-detection.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function makeSearchGapDb(gapRows: unknown[]): { db: Db; gapWhere: jest.Mock; executeMock: jest.Mock } {
  const gapLimit = jest.fn().mockResolvedValue(gapRows);
  const gapOrderBy = jest.fn().mockReturnValue({ limit: gapLimit });
  const gapGroupBy = jest.fn().mockReturnValue({ orderBy: gapOrderBy });
  const gapWhere = jest.fn().mockReturnValue({ groupBy: gapGroupBy });
  const gapFrom = jest.fn().mockReturnValue({ where: gapWhere });
  const executeMock = jest.fn().mockResolvedValue([]);

  const db = {
    execute: executeMock,
    select: jest.fn().mockReturnValue({ from: gapFrom }),
    query: {
      supportKnowledgeGaps: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  } as unknown as Db;

  return { db, gapWhere, executeMock };
}

describe("SupportKbGapDetectionService — cross-tenant isolation", () => {
  describe("detectGaps", () => {
    it("scopes the embedding cluster query to the caller's org (DENY — cross-tenant isolation)", async () => {
      const { db, gapWhere, executeMock } = makeSearchGapDb([]);

      const svc = new SupportKbGapDetectionService(db);
      const result = await svc.detectGaps(ATTACKER_ORG);

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);

      const executedSqlVals = sqlValues(executeMock.mock.calls[0]?.[0]);
      expect(executedSqlVals).toContain(ATTACKER_ORG);
      expect(executedSqlVals).not.toContain(OWNER_ORG);

      const searchWhereVals = sqlValues(gapWhere.mock.calls[0]?.[0]);
      expect(searchWhereVals).toContain(ATTACKER_ORG);
      expect(searchWhereVals).not.toContain(OWNER_ORG);
    });

    it("creates a gap for the owning org when a search gap is detected (CONTROL — same-tenant access works)", async () => {
      const gapRow = { query: "how to reset password", count: 5, lastOccurredAt: new Date() };
      const { db, gapWhere } = makeSearchGapDb([gapRow]);

      const svc = new SupportKbGapDetectionService(db);
      const result = await svc.detectGaps(OWNER_ORG);

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);

      const searchWhereVals = sqlValues(gapWhere.mock.calls[0]?.[0]);
      expect(searchWhereVals).toContain(OWNER_ORG);
    });
  });
});
