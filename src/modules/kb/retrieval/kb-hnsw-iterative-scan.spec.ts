/**
 * The SQL `vectorChunkIds` issues, and — the part that matters — WHEN it issues the second,
 * exact pass.
 *
 * This spec used to assert only that `SET LOCAL hnsw.iterative_scan = relaxed_order` was
 * sent and that the fence fired when the ANN pass returned *nothing*. It stayed green while
 * production returned 50 of the 240 candidates it asked for, because 50 > 0 took the early
 * return. A mock cannot measure recall — `kb-vector-recall.db.spec.ts` does that against a
 * real HNSW index — but it can pin the branch that swallowed the shortfall, so the
 * threshold here is `>= cap`, not `> 0`.
 */
import { KbCandidateService } from "./kb-candidate.service";

const ORG = "org-hnsw";

function extractSqlStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") { out.push(node); return out; }
  if (!node || typeof node !== "object") return out;
  for (const v of Object.values(node as Record<string, unknown>))
    extractSqlStrings(v, out);
  return out;
}

function makeSqlStr(call: [unknown]): string {
  return extractSqlStrings(call[0]).join(" ");
}

function isAnn(text: string): boolean {
  return text.includes("kb_article_chunks") && !text.includes("OFFSET") && !text.includes("SET LOCAL");
}

function isExact(text: string): boolean {
  return text.includes("kb_article_chunks") && text.includes("OFFSET");
}

/** `annRows` ids come back from the ANN pass; `exactRows` from the exact second pass. */
function makeDb(annRows: number, exactRows: number) {
  const execute = jest.fn().mockImplementation((sqlNode: unknown) => {
    const text = extractSqlStrings(sqlNode).join(" ");
    if (text.includes("SET LOCAL")) return Promise.resolve([]);
    if (isExact(text))
      return Promise.resolve(Array.from({ length: exactRows }, (_, i) => ({ id: 1000 + i })));
    if (isAnn(text))
      return Promise.resolve(Array.from({ length: annRows }, (_, i) => ({ id: 42 + i })));
    return Promise.resolve([]);
  });
  const chain = {
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  return { db: { select: jest.fn().mockReturnValue(chain), execute }, execute };
}

describe("KB vectorChunkIds — ANN pass then exact pass", () => {
  describe("the ANN pool is full (annRows === cap)", () => {
    let execute: jest.Mock;
    let sqls: string[];

    beforeEach(async () => {
      const { db, execute: ex } = makeDb(20, 20);
      execute = ex;
      const svc = new KbCandidateService(db as never);
      await svc.vectorChunkIds(ORG, "[0.1,0.2]", 20);
      sqls = (execute.mock.calls as Array<[unknown]>).map(makeSqlStr);
    });

    it("issues SET LOCAL hnsw.iterative_scan = relaxed_order as the first execute call", () => {
      expect(sqls[0]).toContain("SET LOCAL");
      expect(sqls[0]).toContain("hnsw.iterative_scan");
      expect(sqls[0]).toContain("relaxed_order");
    });

    it("issues the ANN query (ORDER BY embedding) as the second execute call", () => {
      expect(sqls[1]).toContain("kb_article_chunks");
      expect(sqls[1]).toContain("ORDER BY");
      expect(sqls[1]).toContain("embedding");
    });

    it("scopes the ANN query to the organisation rather than leaving it to RLS", () => {
      expect(sqls[1]).toContain("org_id");
    });

    it("SET LOCAL precedes the ANN query (same db handle — both route to context.tx in production)", () => {
      const setLocalIdx = sqls.findIndex((s) => s.includes("SET LOCAL"));
      const annIdx = sqls.findIndex((s) => isAnn(s));
      expect(setLocalIdx).toBeGreaterThanOrEqual(0);
      expect(annIdx).toBeGreaterThanOrEqual(0);
      expect(setLocalIdx).toBeLessThan(annIdx);
    });

    it("does NOT run the exact pass when the ANN pool is full", () => {
      expect(sqls.filter(isExact)).toHaveLength(0);
    });

    it("returns the ANN row ids", async () => {
      const { db } = makeDb(3, 3);
      const svc = new KbCandidateService(db as never);
      const ids = await svc.vectorChunkIds(ORG, "[0.1,0.2]", 3);
      expect(ids).toEqual([42, 43, 44]);
    });
  });

  describe("the ANN pool is SHORT but not empty — the shape that shipped", () => {
    let sqls: string[];
    let ids: number[];

    beforeEach(async () => {
      const { db, execute } = makeDb(5, 20);
      const svc = new KbCandidateService(db as never);
      ids = await svc.vectorChunkIds(ORG, "[0.1,0.2]", 20);
      sqls = (execute.mock.calls as Array<[unknown]>).map(makeSqlStr);
    });

    it("runs the exact pass — a partial pool is not an answer", () => {
      expect(sqls.filter(isExact)).toHaveLength(1);
    });

    it("fences the exact pass with OFFSET 0 so the planner cannot push the ORDER BY back into the index", () => {
      const exact = sqls.find(isExact) ?? "";
      expect(exact).toContain("OFFSET");
      expect(exact).toContain("org_id");
      expect(exact).toContain("ORDER BY");
    });

    it("returns the exact pass's ids, not the short ANN pool", () => {
      expect(ids).toHaveLength(20);
      expect(ids[0]).toBe(1000);
    });
  });

  describe("the ANN pass returns nothing", () => {
    it("still issues SET LOCAL before the ANN attempt", async () => {
      const { db, execute } = makeDb(0, 4);
      const svc = new KbCandidateService(db as never);
      await svc.vectorChunkIds(ORG, "[0.1,0.2]", 20);
      const sqls = (execute.mock.calls as Array<[unknown]>).map(makeSqlStr);
      const setLocalIdx = sqls.findIndex((s) => s.includes("SET LOCAL"));
      const annIdx = sqls.findIndex((s) => isAnn(s));
      expect(setLocalIdx).toBeGreaterThanOrEqual(0);
      expect(setLocalIdx).toBeLessThan(annIdx);
    });

    it("falls through to the exact pass and returns its ids", async () => {
      const { db } = makeDb(0, 2);
      const svc = new KbCandidateService(db as never);
      const ids = await svc.vectorChunkIds(ORG, "[0.1,0.2]", 20);
      expect(ids).toEqual([1000, 1001]);
    });
  });

  describe("cap=0 short-circuit", () => {
    it("returns [] immediately without any execute calls when cap is 0", async () => {
      const { db, execute } = makeDb(0, 0);
      const svc = new KbCandidateService(db as never);
      const ids = await svc.vectorChunkIds(ORG, "[0.1,0.2]", 0);
      expect(ids).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
