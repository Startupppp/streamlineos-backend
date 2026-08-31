import { KbCandidateService } from "./kb-candidate.service";

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

function makeDb(annReturnsRows: boolean) {
  const annId = { id: 42 };
  const execute = jest.fn().mockImplementation((sqlNode: unknown) => {
    const text = extractSqlStrings(sqlNode).join(" ");
    if (text.includes("SET LOCAL")) return Promise.resolve([]);
    if (text.includes("kb_article_chunks")) return Promise.resolve(annReturnsRows ? [annId] : []);
    if (text.includes("search_kb_chunk_ids")) return Promise.resolve([{ id: 99 }]);
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

describe("KB vectorChunkIds — hnsw.iterative_scan = relaxed_order (BITE TEST)", () => {
  describe("non-starvation path (ANN returns rows)", () => {
    let execute: jest.Mock;
    let sqls: string[];

    beforeEach(async () => {
      const { db, execute: ex } = makeDb(true);
      execute = ex;
      const svc = new KbCandidateService(db as never);
      await svc.vectorChunkIds("[0.1,0.2]", 20);
      sqls = (execute.mock.calls as Array<[unknown]>).map(makeSqlStr);
    });

    it("issues SET LOCAL hnsw.iterative_scan = relaxed_order as the first execute call", () => {
      expect(sqls[0]).toContain("SET LOCAL");
      expect(sqls[0]).toContain("hnsw.iterative_scan");
      expect(sqls[0]).toContain("relaxed_order");
    });

    it("issues the plain ANN query (ORDER BY embedding) as the second execute call", () => {
      expect(sqls[1]).toContain("kb_article_chunks");
      expect(sqls[1]).toContain("ORDER BY");
      expect(sqls[1]).toContain("embedding");
    });

    it("SET LOCAL precedes the ANN query (same db handle — both route to context.tx in production)", () => {
      const setLocalIdx = sqls.findIndex((s) => s.includes("SET LOCAL"));
      const annIdx = sqls.findIndex((s) => s.includes("kb_article_chunks"));
      expect(setLocalIdx).toBeGreaterThanOrEqual(0);
      expect(annIdx).toBeGreaterThanOrEqual(0);
      expect(setLocalIdx).toBeLessThan(annIdx);
    });

    it("does NOT call the fence (search_kb_chunk_ids) when ANN returns rows", () => {
      const fenceCalls = sqls.filter((s) => s.includes("search_kb_chunk_ids"));
      expect(fenceCalls).toHaveLength(0);
    });

    it("returns the ANN row ids", async () => {
      const { db } = makeDb(true);
      const svc = new KbCandidateService(db as never);
      const ids = await svc.vectorChunkIds("[0.1,0.2]", 20);
      expect(ids).toEqual([42]);
    });
  });

  describe("starvation path (ANN returns nothing)", () => {
    let execute: jest.Mock;
    let sqls: string[];

    beforeEach(async () => {
      const { db, execute: ex } = makeDb(false);
      execute = ex;
      const svc = new KbCandidateService(db as never);
      await svc.vectorChunkIds("[0.1,0.2]", 20);
      sqls = (execute.mock.calls as Array<[unknown]>).map(makeSqlStr);
    });

    it("still issues SET LOCAL before the ANN attempt", () => {
      const setLocalIdx = sqls.findIndex((s) => s.includes("SET LOCAL"));
      const annIdx = sqls.findIndex((s) => s.includes("kb_article_chunks"));
      expect(setLocalIdx).toBeGreaterThanOrEqual(0);
      expect(setLocalIdx).toBeLessThan(annIdx);
    });

    it("falls back to the fence (search_kb_chunk_ids) when ANN returns nothing", () => {
      const fenceCalls = sqls.filter((s) => s.includes("search_kb_chunk_ids"));
      expect(fenceCalls).toHaveLength(1);
    });

    it("returns the fence row ids", async () => {
      const { db } = makeDb(false);
      const svc = new KbCandidateService(db as never);
      const ids = await svc.vectorChunkIds("[0.1,0.2]", 20);
      expect(ids).toEqual([99]);
    });
  });

  describe("cap=0 short-circuit", () => {
    it("returns [] immediately without any execute calls when cap is 0", async () => {
      const { db, execute } = makeDb(false);
      const svc = new KbCandidateService(db as never);
      const ids = await svc.vectorChunkIds("[0.1,0.2]", 0);
      expect(ids).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
