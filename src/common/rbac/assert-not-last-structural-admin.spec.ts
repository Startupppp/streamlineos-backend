import { ForbiddenException } from "@nestjs/common";
import { drizzle } from "drizzle-orm/pg-proxy";
import { assertNotLastStructuralAdmin } from "./assert-not-last-structural-admin";
import type { DbOrTx } from "./access-invalidate";

function txReturning(remaining: number): DbOrTx {
  const adminIds = Array.from({ length: remaining + 1 }, (_, i) =>
    i === 0 ? MEMBERSHIP : MEMBERSHIP + i,
  );
  const chain = {
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    for: jest.fn().mockResolvedValue(adminIds.map((id) => ({ id }))),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
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

describe("assertNotLastStructuralAdmin serialisation", () => {
  it("emits FOR UPDATE with ORDER BY id to serialise concurrent demotions", async () => {
    const captured: string[] = [];
    const db = drizzle(async (sql: string) => {
      captured.push(sql);
      return { rows: [[MEMBERSHIP], [MEMBERSHIP + 1]] };
    });

    await assertNotLastStructuralAdmin(
      db as unknown as DbOrTx,
      ORG,
      MEMBERSHIP,
      "ORG_ADMIN",
      "MEMBER",
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("for update");
    expect(captured[0]).toContain("order by");
  });

  it("counts only the rows whose id differs from the target membership", async () => {
    const captured: string[] = [];
    const db = drizzle(async (sql: string) => {
      captured.push(sql);
      return { rows: [[MEMBERSHIP]] };
    });

    await expect(
      assertNotLastStructuralAdmin(
        db as unknown as DbOrTx,
        ORG,
        MEMBERSHIP,
        "ORG_ADMIN",
        "MEMBER",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
