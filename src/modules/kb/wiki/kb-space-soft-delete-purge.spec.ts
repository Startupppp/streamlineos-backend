import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { kbArticles } from "../../../db/schema";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbSpacesService } from "./kb-spaces.service";

const ORG = "org-kb-purge-1";
const SPACE = 77;
const BATCH = 500;

interface Emitted {
  eventType: string;
  organizationId: string;
  payload: { contentType: string; contentId: number };
}

interface SelectChain {
  orderBy: () => SelectChain;
  limit: (n: number) => Promise<{ id: number }[]>;
}

const dialect = new PgDialect();

/** `gt(id, afterId)` is the last bound parameter of the keyset predicate. */
function cursorOf(condition: SQL | undefined): number {
  if (condition === undefined) throw new Error("the space content select ran with no WHERE clause");
  const { params } = dialect.sqlToQuery(condition);
  return Number(params[params.length - 1]);
}

function makeTx(
  emitted: Emitted[],
  articleIds: number[],
  pageIds: number[],
  cursors: number[],
  deleted = true,
) {
  return {
    execute: jest.fn().mockResolvedValue([]),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(deleted ? [{ id: SPACE }] : []),
        }),
      }),
    }),
    select: (projection: { id: unknown }) => {
      const ids = projection.id === kbArticles.id ? articleIds : pageIds;
      return {
        from: () => ({
          where: (condition: SQL | undefined) => {
            const afterId = cursorOf(condition);
            cursors.push(afterId);
            if (cursors.length > 12)
              throw new Error(`keyset loop never advanced past ${afterId}`);
            const remaining = ids.filter((id) => id > afterId);
            const chain: SelectChain = {
              orderBy: () => chain,
              limit: (n: number) => Promise.resolve(remaining.slice(0, n).map((id) => ({ id }))),
            };
            return chain;
          },
        }),
      };
    },
    insert: () => ({
      values: (row: Emitted | Emitted[]) => {
        for (const one of Array.isArray(row) ? row : [row]) emitted.push(one);
        return Promise.resolve([]);
      },
    }),
  };
}

function makeService(emitted: Emitted[], articleIds: number[], pageIds: number[]) {
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const cursors: number[] = [];
  const db = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn(makeTx(emitted, articleIds, pageIds, cursors)),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  const access = {
    invalidateAccessibleSpaceIds: invalidate,
  } as unknown as KbAccessService;
  const indexing = {} as unknown as KbIndexingService;
  return {
    svc: new KbSpacesService(db, access, indexing, {} as never),
    invalidate,
    cursors,
  };
}

describe("KB space soft delete purges the space's chunks", () => {
  it("emits one kb.content.delete per article and page in the space", async () => {
    const emitted: Emitted[] = [];
    const { svc, invalidate } = makeService(emitted, [11, 12], [21]);

    await expect(svc.remove(ORG, SPACE)).resolves.toEqual({ success: true });

    const deletes = emitted.filter((e) => e.eventType === "kb.content.delete");
    expect(deletes).toHaveLength(3);
    expect(deletes.map((e) => e.payload)).toEqual([
      { contentType: "article", contentId: 11 },
      { contentType: "article", contentId: 12 },
      { contentType: "page", contentId: 21 },
    ]);
    for (const one of deletes) expect(one.organizationId).toBe(ORG);
    expect(invalidate).toHaveBeenCalledWith(ORG);
  });

  it("emits nothing for an empty space but still soft-deletes it", async () => {
    const emitted: Emitted[] = [];
    const { svc, cursors } = makeService(emitted, [], []);

    await expect(svc.remove(ORG, SPACE)).resolves.toEqual({ success: true });
    expect(emitted.filter((e) => e.eventType === "kb.content.delete")).toHaveLength(0);
    expect(cursors).toEqual([0, 0]);
  });

  it("reads a large space in bounded batches instead of one unlimited select", async () => {
    const emitted: Emitted[] = [];
    const articleIds = Array.from({ length: BATCH + 3 }, (_, i) => i + 1);
    const { svc, cursors } = makeService(emitted, articleIds, []);

    await expect(svc.remove(ORG, SPACE)).resolves.toEqual({ success: true });

    expect(cursors).toEqual([0, BATCH, 0]);
    expect(emitted.filter((e) => e.eventType === "kb.content.delete")).toHaveLength(BATCH + 3);
  });

  it("bites: a space whose soft delete matched nothing emits no events at all", async () => {
    const emitted: Emitted[] = [];
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const cursors: number[] = [];
    const db = {
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn(makeTx(emitted, [11], [21], cursors, false)),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const svc = new KbSpacesService(
      db,
      { invalidateAccessibleSpaceIds: invalidate } as unknown as KbAccessService,
      {} as unknown as KbIndexingService,
      {} as never,
    );

    await expect(svc.remove(ORG, SPACE)).rejects.toThrow("Space not found");
    expect(emitted).toEqual([]);
    expect(cursors).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
