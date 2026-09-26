import { sql } from "drizzle-orm";
import { KbPageTrashService } from "./kb-page-trash.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-1";

const userInOrg = {
  userId: "user-1",
  orgId: ORG_ID,
  isOrgOwner: false,
} as CurrentUserContext;

const auditMock = { log: jest.fn() };
const storageMock = {} as never;
const configMock = { R2_KB_BUCKET_NAME: "test-bucket" } as never;
const treeMock = { restore: jest.fn() } as never;

function makeAuth(predicateResult: ReturnType<typeof sql> = sql`true`) {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(predicateResult),
    assertPageAccess: jest.fn(),
  };
}

function makeDb(
  visibleRows: Array<{ id: number }>,
  subtreesByRoot: Record<number, number[]>,
): Db {
  return {
    select: jest.fn().mockImplementation(() => ({
      from: () => ({
        where: () => Promise.resolve(visibleRows),
      }),
    })),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb({
        execute: jest.fn().mockImplementation((query: { queryChunks?: unknown[] }) => {
          const rootId = (query.queryChunks ?? []).find(
            (chunk): chunk is number => typeof chunk === "number",
          ) ?? null;
          const ids = rootId !== null ? subtreesByRoot[rootId] ?? [rootId] : [];
          return Promise.resolve(ids.map((id) => ({ id })));
        }),
      });
      return result;
    }),
  } as unknown as Db;
}

function service(db: Db, auth: ReturnType<typeof makeAuth>): KbPageTrashService {
  return new KbPageTrashService(db, auditMock as never, storageMock, configMock, auth as never, treeMock);
}

describe("KbPageTrashService.purgeImpact — dependency impact before a destructive purge", () => {
  it("reports the selected page count plus descendants that would also be purged", async () => {
    const db = makeDb(
      [{ id: 1 }, { id: 2 }],
      { 1: [1, 10, 11], 2: [2] },
    );
    const svc = service(db, makeAuth());

    const result = await svc.purgeImpact(userInOrg, { pageIds: [1, 2] });

    expect(result).toEqual({ pageCount: 2, descendantCount: 2 });
  });

  it("reports zero descendants when none of the selected pages have children", async () => {
    const db = makeDb([{ id: 5 }], { 5: [5] });
    const svc = service(db, makeAuth());

    const result = await svc.purgeImpact(userInOrg, { pageIds: [5] });

    expect(result).toEqual({ pageCount: 1, descendantCount: 0 });
  });

  it("excludes a page hidden from the actor from both counts, so impact cannot confirm a hidden page's existence", async () => {
    const db = makeDb([{ id: 1 }], { 1: [1] });
    const svc = service(db, makeAuth());

    const result = await svc.purgeImpact(userInOrg, { pageIds: [1, 999] });

    expect(result).toEqual({ pageCount: 1, descendantCount: 0 });
  });
});
