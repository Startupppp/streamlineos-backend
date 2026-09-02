import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { DepreciationReverseService } from "./depreciation-reverse.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

function makeUser(orgId: string): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s1",
    tokenScopes: null,
    principal: {} as never,
  };
}

describe("DepreciationReverseService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  it("throws NotFoundException when the run belongs to a different org (cross-tenant isolation)", async () => {
    const p = Object.assign(Promise.resolve([] as unknown[]), {
      limit: jest.fn().mockResolvedValue([]),
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(p) }),
      }),
    } as unknown as Db;
    const posting = {} as never;
    const audit = { log: jest.fn() } as never;

    const svc = new DepreciationReverseService(db, posting, audit);
    await expect(svc.reverseRun(makeUser(ATTACKER_ORG), 99)).rejects.toThrow(NotFoundException);
  });

  it("completes reversal for the owning org (same-tenant control)", async () => {
    const run = { id: 99, orgId: OWNER_ORG, status: "POSTED", journalEntryId: 5, periodKey: "2024-01" };
    let selectIdx = 0;
    const makeChain = () => {
      const i = selectIdx++;
      const rows: unknown[] = i === 0 ? [run] : [];
      const p = Object.assign(Promise.resolve(rows), {
        limit: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn().mockReturnValue(Promise.resolve(rows)),
      });
      const src: { where: jest.Mock; innerJoin: jest.Mock } = {
        where: jest.fn().mockReturnValue(p),
        innerJoin: jest.fn(),
      };
      src.innerJoin.mockReturnValue(src);
      return { from: jest.fn().mockReturnValue(src) };
    };
    const txFn = jest.fn().mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: jest.fn().mockImplementation(() => {
            const tp = Object.assign(Promise.resolve([] as unknown[]), {
              limit: jest.fn().mockResolvedValue([]),
            });
            return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(tp) }) };
          }),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
          }),
        }),
    );
    const db = {
      select: jest.fn().mockImplementation(makeChain),
      transaction: txFn,
    } as unknown as Db;
    const posting = {
      persistJournalEntry: jest.fn().mockResolvedValue({ id: 50, entryNumber: "REV-001" }),
    } as never;
    const audit = { log: jest.fn() } as never;

    const svc = new DepreciationReverseService(db, posting, audit);
    const result = await svc.reverseRun(makeUser(OWNER_ORG), 99);
    expect(result.runId).toBe(99);
    expect(result.reversalEntryId).toBe(50);
  });
});
