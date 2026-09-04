import { and, eq, gt } from "drizzle-orm";
import { kbArticles } from "../../../db/schema";
import { KbArticleReindexService } from "../../kb/retrieval/kb-article-reindex.service";
import { SupportKbController } from "./support-kb.controller";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

/**
 * PRD-C077 — "Apply statement/query timeouts and cancellation propagation to interactive
 * work; move reports, exports, reindexing and wide aggregates to resumable jobs."
 *
 * `KbArticleReindexService.reindexAll` has always paged at REINDEX_BATCH_SIZE = 100 and
 * returned a `nextArticleId`. `SupportKbController.reindexAll` accepted no cursor, so
 * `afterArticleId` defaulted to 0 on every call: the reindex was batched but NOT resumable,
 * and no article past the first hundred was reachable through the API. The returned handle
 * had nowhere to go back in. `kb-page-indexing.controller.ts` has taken its cursor all along.
 *
 * Two halves are pinned here:
 *   1. the controller forwards the cursor, and its query schema validates one;
 *   2. the service's SQL actually carries that cursor, so following the handle advances.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = { orgId: ORG, userId: "u1" } as CurrentUserContext;

/** The parameters drizzle bound into a where-clause, in order. */
function boundParams(node: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (rec.queryChunks !== undefined) {
      walk(rec.queryChunks);
      return;
    }
    if ("value" in rec && "encoder" in rec) {
      out.push(rec.value);
      return;
    }
  };
  walk(node);
  return out;
}

describe("support KB reindex is resumable (PRD-C077)", () => {
  describe("the controller's cursor", () => {
    const reindex = { reindexAll: jest.fn() };
    const controller = new SupportKbController(
      {} as never,
      {} as never,
      {} as never,
      reindex as unknown as KbArticleReindexService,
    );

    beforeEach(() => reindex.reindexAll.mockReset());

    it("forwards the cursor the previous page returned", () => {
      controller.reindexAll({ afterArticleId: 137 }, USER);
      expect(reindex.reindexAll).toHaveBeenCalledWith(ORG, 137);
    });

    it("starts at 0 when no cursor is given", () => {
      controller.reindexAll({ afterArticleId: 0 }, USER);
      expect(reindex.reindexAll).toHaveBeenCalledWith(ORG, 0);
    });

    it("does NOT drop the cursor on the floor", () => {
      controller.reindexAll({ afterArticleId: 900 }, USER);
      const [, cursor] = reindex.reindexAll.mock.calls[0] as [string, number];
      expect(cursor).toBe(900);
      expect(cursor).not.toBe(0);
    });
  });

  describe("the service's SQL carries the cursor", () => {
    it("binds afterArticleId into the where clause and pages past the first batch", async () => {
      const ARTICLES = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));
      const seenCursors: number[] = [];

      const selectChain = (rows: { id: number }[]) => {
        let cursor = 0;
        let limit = rows.length;
        const chain = {
          from: () => chain,
          where: (predicate: unknown) => {
            const params = boundParams(predicate);
            const numeric = params.filter((p): p is number => typeof p === "number");
            cursor = numeric.length > 0 ? (numeric[numeric.length - 1] as number) : 0;
            return chain;
          },
          orderBy: () => chain,
          limit: (n: number) => {
            limit = n;
            return chain;
          },
          then: (resolve: (v: { id: number }[]) => void) => {
            seenCursors.push(cursor);
            resolve(rows.filter((r) => r.id > cursor).slice(0, limit));
          },
        };
        return chain;
      };

      const countChain = {
        from: () => countChain,
        where: () => countChain,
        then: (resolve: (v: { chunks: number }[]) => void) => resolve([{ chunks: 0 }]),
      };

      let selectCall = 0;
      const db = {
        select: (shape: Record<string, unknown>) =>
          "id" in shape ? selectChain(ARTICLES) : ((selectCall += 1), countChain),
        query: {
          kbArticles: { findFirst: async () => ({ id: 1 }) },
          kbArticleAttachments: { findMany: async () => [] },
        },
      };

      const service = new KbArticleReindexService(
        db as never,
        { indexArticle: async () => undefined } as never,
        { indexAttachment: async () => ({ warning: null }) } as never,
      );

      const first = await service.reindexAll(ORG, 0);
      expect(first.total).toBe(100);
      expect(first.nextArticleId).toBe(100);

      const second = await service.reindexAll(ORG, first.nextArticleId ?? 0);
      expect(second.total).toBe(100);
      expect(second.nextArticleId).toBe(200);

      const third = await service.reindexAll(ORG, second.nextArticleId ?? 0);
      expect(third.total).toBe(50);
      expect(third.nextArticleId).toBeNull();

      // Without a cursor reaching the SQL, every page would start at 0 and articles
      // 101-250 would be unreachable however many times the endpoint is called.
      expect(seenCursors).toEqual([0, 100, 200]);
      expect(selectCall).toBeGreaterThan(0);
    });

    it("boundParams actually sees a gt() cursor — the assertion above is not vacuous", () => {
      const where = and(
        eq(kbArticles.orgId, ORG),
        eq(kbArticles.status, "published"),
        gt(kbArticles.id, 137),
      );
      expect(boundParams(where)).toContain(137);
    });
  });
});
