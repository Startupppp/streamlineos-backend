import { loadShares } from "./whiteboard-board-helpers";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";
import type { Db } from "../../../db/drizzle.module";

describe("loadShares", () => {
  it("applies PAGE_SIZE_CAP to the share list query — unbounded scan is bounded by the house cap", async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const where = jest.fn().mockReturnValue({ limit });
    const innerJoin2 = jest.fn().mockReturnValue({ where });
    const innerJoin1 = jest.fn().mockReturnValue({ innerJoin: innerJoin2 });
    const from = jest.fn().mockReturnValue({ innerJoin: innerJoin1 });
    const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;

    await loadShares(db, 42);

    expect(limit).toHaveBeenCalledWith(PAGE_SIZE_CAP);
  });
});
