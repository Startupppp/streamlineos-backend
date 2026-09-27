import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { KbSpaceLifecycleService } from "./kb-space-lifecycle.service";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";

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

function cursorOf(condition: SQL | undefined): number {
  if (condition === undefined) throw new Error("the space content select ran with no WHERE clause");
  const { params } = dialect.sqlToQuery(condition);
  return Number(params[params.length - 1]);
}

function renderOf(condition: SQL | undefined): string {
  if (condition === undefined) throw new Error("the space content select ran with no WHERE clause");
  return dialect.sqlToQuery(condition).sql;
}

function makeTx(
  emitted: Emitted[],
  articleIds: number[],
  pageIds: number[],
  cursors: number[],
  predicates: string[],
  deleted = true,
) {
  let batch = 0;
  return {
    execute: jest.fn().mockResolvedValue([]),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(deleted ? [{ id: SPACE }] : []),
        }),
      }),
    }),
    select: () => {
      return {
        from: () => ({
          where: (condition: SQL | undefined) => {
            const ids = batch === 0 ? articleIds : pageIds;
            const afterId = cursorOf(condition);
            cursors.push(afterId);
            predicates.push(renderOf(condition));
            if (cursors.length > 12)
              throw new Error(`keyset loop never advanced past ${afterId}`);
            const remaining = ids.filter((id) => id > afterId);
            const chain: SelectChain = {
              orderBy: () => chain,
              limit: (n: number) => {
                const rows = remaining.slice(0, n);
                if (rows.length < n) batch += 1;
                return Promise.resolve(rows.map((id) => ({ id })));
              },
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
  const predicates: string[] = [];
  const tx = makeTx(emitted, articleIds, pageIds, cursors, predicates);
  const authz = {
    visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
    resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [], accessibleProjectIds: [], roleSlugs: [], membershipId: 1 }),
    resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }),
    invalidateSpaceScope: invalidate,
    assertSpaceAccess: jest.fn().mockResolvedValue(undefined),
  };
  const lifecycle = new KbSpaceLifecycleService(tx as never, authz as never);
  return {
    svc: {
      remove: (orgId: string, spaceId: number) =>
        runWithTenantContext({ orgId, audience: "INTERNAL" as const, tx: tx as never }, () => lifecycle.remove(orgId, spaceId)),
    },
    invalidate,
    cursors,
    predicates,
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

  it("reads both content families from kb_pages and separates them by content_type, not by table", async () => {
    const emitted: Emitted[] = [];
    const { svc, predicates } = makeService(emitted, [11], [21]);

    await svc.remove(ORG, SPACE);

    expect(predicates).toHaveLength(2);
    for (const predicate of predicates) {
      expect(predicate).toContain(`"kb_pages"`);
      expect(predicate).toContain("content_type");
    }
    expect(predicates[0]).not.toEqual(predicates[1]);
  });

  it("bites: a space whose soft delete matched nothing emits no events at all", async () => {
    const emitted: Emitted[] = [];
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const cursors: number[] = [];
    const tx = makeTx(emitted, [11], [21], cursors, [], false);
    const lifecycle = new KbSpaceLifecycleService(tx as never, {
      visiblePagePredicate: jest.fn().mockResolvedValue(undefined),
      resolveStanding: jest.fn().mockResolvedValue({ accessibleSpaceIds: [], accessibleProjectIds: [], roleSlugs: [], membershipId: 1 }),
      resolveAccessibleSpaces: jest.fn().mockResolvedValue({ spaceIds: [], outcome: "hit" }),
      invalidateSpaceScope: invalidate,
      assertSpaceAccess: jest.fn().mockResolvedValue(undefined),
    } as never);

    const remove = (orgId: string, spaceId: number) =>
      runWithTenantContext({ orgId, audience: "INTERNAL" as const, tx: tx as never }, () => lifecycle.remove(orgId, spaceId));

    await expect(remove(ORG, SPACE)).rejects.toThrow("Space not found");
    expect(emitted).toEqual([]);
    expect(cursors).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
