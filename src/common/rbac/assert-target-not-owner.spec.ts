import { BadRequestException } from "@nestjs/common";
import { assertNoOwnerAmongTargets, assertTargetNotOwner } from "./assert-target-not-owner";
import type { DbOrTx } from "./access-invalidate";

function makeDb(rows: Record<string, unknown>[]): { db: DbOrTx; where: jest.Mock } {
  const where = jest.fn();
  interface SelectChain {
    from: jest.Mock<SelectChain, []>;
    where: jest.Mock<SelectChain, [unknown]>;
    limit: jest.Mock<Promise<Record<string, unknown>[]>, []>;
  }
  const chain: SelectChain = {
    from: jest.fn((): SelectChain => chain),
    where: jest.fn((condition: unknown): SelectChain => {
      where(condition);
      return chain;
    }),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  return { db: { select: jest.fn(() => chain) } as unknown as DbOrTx, where };
}

describe("assertTargetNotOwner", () => {
  it("rejects a role change aimed at the organization owner", async () => {
    const { db } = makeDb([{ isOwner: true }]);
    await expect(assertTargetNotOwner(db, "org-1", "user-owner")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("names the ownership transfer flow so the caller knows the way out", async () => {
    const { db } = makeDb([{ isOwner: true }]);
    await expect(assertTargetNotOwner(db, "org-1", "user-owner")).rejects.toThrow(
      /ownership transfer/i,
    );
  });

  it("allows a role change aimed at an ordinary member", async () => {
    const { db } = makeDb([{ isOwner: false }]);
    await expect(assertTargetNotOwner(db, "org-1", "user-member")).resolves.toBeUndefined();
  });

  it("allows the change when the target has no membership row to read", async () => {
    const { db } = makeDb([]);
    await expect(assertTargetNotOwner(db, "org-1", "ghost")).resolves.toBeUndefined();
  });
});

describe("assertNoOwnerAmongTargets", () => {
  it("rejects a bulk change when any target is the owner", async () => {
    const { db } = makeDb([{ userId: "user-owner" }]);
    await expect(
      assertNoOwnerAmongTargets(db, "org-1", ["user-a", "user-owner", "user-b"]),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows a bulk change when no target is the owner", async () => {
    const { db } = makeDb([]);
    await expect(
      assertNoOwnerAmongTargets(db, "org-1", ["user-a", "user-b"]),
    ).resolves.toBeUndefined();
  });

  it("does not query at all for an empty target list", async () => {
    const { db } = makeDb([]);
    await assertNoOwnerAmongTargets(db, "org-1", []);
    expect(db.select).not.toHaveBeenCalled();
  });
});
