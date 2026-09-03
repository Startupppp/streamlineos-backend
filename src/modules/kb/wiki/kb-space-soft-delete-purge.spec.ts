import type { Db } from "../../../db/drizzle.module";
import type { KbAccessService } from "../core/kb-access.service";
import type { KbIndexingService } from "../retrieval/kb-indexing.service";
import { KbSpacesService } from "./kb-spaces.service";

const ORG = "org-kb-purge-1";
const SPACE = 77;

interface Emitted {
  eventType: string;
  organizationId: string;
  payload: { contentType: string; contentId: number };
}

function makeTx(emitted: Emitted[], articleIds: number[], pageIds: number[], deleted = true) {
  let selectCall = 0;
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve(deleted ? [{ id: SPACE }] : []),
        }),
      }),
    }),
    select: () => {
      selectCall += 1;
      const rows = selectCall === 1 ? articleIds : pageIds;
      return { from: () => ({ where: () => Promise.resolve(rows.map((id) => ({ id }))) }) };
    },
    insert: () => ({
      values: (row: Emitted | Emitted[]) => {
        for (const one of Array.isArray(row) ? row : [row]) emitted.push(one);
        return Promise.resolve([]);
      },
    }),
  };
  return tx;
}

function makeService(emitted: Emitted[], articleIds: number[], pageIds: number[]) {
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const db = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx(emitted, articleIds, pageIds)),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  const access = {
    invalidateAccessibleSpaceIds: invalidate,
  } as unknown as KbAccessService;
  const indexing = {} as unknown as KbIndexingService;
  return { svc: new KbSpacesService(db, access, indexing), invalidate };
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
    const { svc } = makeService(emitted, [], []);

    await expect(svc.remove(ORG, SPACE)).resolves.toEqual({ success: true });
    expect(emitted.filter((e) => e.eventType === "kb.content.delete")).toHaveLength(0);
  });
});
