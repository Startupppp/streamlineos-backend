import { ForbiddenException } from "@nestjs/common";
import { assertNotLastStructuralAdmin } from "./assert-not-last-structural-admin";
import type { DbOrTx } from "./access-invalidate";

function txReturning(remaining: number): DbOrTx {
  const chain = {
    from: jest.fn(),
    where: jest.fn().mockResolvedValue([{ value: remaining }]),
  };
  chain.from.mockReturnValue(chain);
  return { select: jest.fn().mockReturnValue(chain) } as unknown as DbOrTx;
}

const ORG = "org-1";
const MEMBERSHIP = 42;

describe("assertNotLastStructuralAdmin", () => {
  it("refuses to demote the last administrator of an owner-less organization", async () => {
    await expect(
      assertNotLastStructuralAdmin(txReturning(0), ORG, MEMBERSHIP, "ORG_ADMIN", "MEMBER"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows the demotion while another administrator remains", async () => {
    await expect(
      assertNotLastStructuralAdmin(txReturning(1), ORG, MEMBERSHIP, "ORG_ADMIN", "MEMBER"),
    ).resolves.toBeUndefined();
  });

  it("ignores a change that keeps the member an administrator", async () => {
    const tx = txReturning(0);
    await expect(
      assertNotLastStructuralAdmin(tx, ORG, MEMBERSHIP, "ORG_ADMIN", "ORG_ADMIN"),
    ).resolves.toBeUndefined();
    expect(tx.select).not.toHaveBeenCalled();
  });

  it("ignores a member who was never an administrator", async () => {
    const tx = txReturning(0);
    await expect(
      assertNotLastStructuralAdmin(tx, ORG, MEMBERSHIP, "MEMBER", "MEMBER"),
    ).resolves.toBeUndefined();
    expect(tx.select).not.toHaveBeenCalled();
  });
});
