import { NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { KbPageTrashQueryService } from "./kb-page-trash-query.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-1";

const userInOrg = {
  userId: "user-1",
  orgId: ORG_ID,
  isOrgOwner: false,
} as CurrentUserContext;

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
  const allSubtreeIds = new Set<number>();
  for (const { id } of visibleRows) {
    for (const sid of subtreesByRoot[id] ?? [id]) {
      allSubtreeIds.add(sid);
    }
  }
  return {
    select: jest.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(visibleRows) }),
      }),
    })),
    transaction: jest.fn().mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          execute: jest.fn().mockResolvedValue(
            [...allSubtreeIds].map((id) => ({ id })),
          ),
        }),
    ),
  } as unknown as Db;
}

function service(db: Db, auth: ReturnType<typeof makeAuth>): KbPageTrashQueryService {
  return new KbPageTrashQueryService(db, auth as never);
}

describe("KbPageTrashQueryService.purgeImpact — dependency impact before a destructive purge", () => {
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

  it("refuses the whole preview with 404 when one requested id is another organisation's or hidden, instead of counting only the visible ones", async () => {
    const db = makeDb([{ id: 1 }], { 1: [1] });
    const subtreeWalk = jest.spyOn(db, "transaction");
    const svc = service(db, makeAuth());

    await expect(svc.purgeImpact(userInOrg, { pageIds: [1, 999] })).rejects.toBeInstanceOf(NotFoundException);
    expect(subtreeWalk).not.toHaveBeenCalled();
  });

  it("answers an all-foreign list with the same 404 as a mixed one, so the refusal is not an existence oracle", async () => {
    const db = makeDb([], {});
    const svc = service(db, makeAuth());

    await expect(svc.purgeImpact(userInOrg, { pageIds: [999] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("previews a list whose every id is the caller's own, duplicates included", async () => {
    const db = makeDb([{ id: 1 }, { id: 2 }], { 1: [1, 10], 2: [2] });
    const svc = service(db, makeAuth());

    const result = await svc.purgeImpact(userInOrg, { pageIds: [1, 2, 2] });

    expect(result).toEqual({ pageCount: 2, descendantCount: 1 });
  });

  it("opens exactly one transaction for a ten-page batch — not one BEGIN per page id", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1);
    const subtreesByRoot: Record<number, number[]> = {};
    for (const id of ids) subtreesByRoot[id] = [id];
    const db = makeDb(
      ids.map((id) => ({ id })),
      subtreesByRoot,
    );
    const svc = service(db, makeAuth());

    await svc.purgeImpact(userInOrg, { pageIds: ids });

    expect((db as unknown as { transaction: jest.Mock }).transaction).toHaveBeenCalledTimes(1);
  });
});
