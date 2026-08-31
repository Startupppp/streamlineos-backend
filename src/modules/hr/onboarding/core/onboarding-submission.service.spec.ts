import { NotFoundException } from "@nestjs/common";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { onboardingAnalyticsEvents, users } from "../../../../db/schema";
import { OnboardingSubmissionService } from "./onboarding-submission.service";

type PrivateService = {
  completeFinalReview: (tx: unknown, orgId: string, userId: string) => Promise<void>;
  initializeLeaveBalances: (tx: unknown, orgId: string, userId: string) => Promise<void>;
  completeFlowSession: (tx: unknown, orgId: string, userId: string) => Promise<void>;
};

function makeSelectChain(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "where", "limit", "orderBy"]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.for = jest.fn().mockResolvedValue(rows);
  return chain;
}

function makeUpdateChain() {
  const where = jest.fn().mockResolvedValue([]);
  const set = jest.fn().mockReturnValue({ where });
  return { set, where };
}

function makeService(membershipRows: unknown[] = [{ id: "membership-1" }]) {
  const usersUpdateChain = makeUpdateChain();
  const otherUpdateChain = makeUpdateChain();

  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    select: jest.fn().mockReturnValue(makeSelectChain(membershipRows)),
    update: jest.fn().mockImplementation((table: unknown) =>
      table === users ? usersUpdateChain : otherUpdateChain,
    ),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  };

  const db = {
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb(tx);
    }),
  };

  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const service = new OnboardingSubmissionService(db as never, cache as never, audit as never);

  return { service, tx, db, cache, audit, usersUpdateChain };
}

function stubPrivateMethods(service: OnboardingSubmissionService): void {
  jest
    .spyOn(service as unknown as PrivateService, "completeFinalReview")
    .mockResolvedValue(undefined);
  jest
    .spyOn(service as unknown as PrivateService, "initializeLeaveBalances")
    .mockResolvedValue(undefined);
  jest
    .spyOn(service as unknown as PrivateService, "completeFlowSession")
    .mockResolvedValue(undefined);
}

describe("OnboardingSubmissionService.submit", () => {
  afterEach(() => jest.restoreAllMocks());

  it("stamps users.onboardingCompletedAt inside the transaction so the wizard gate self-heals on any device without a cookie", async () => {
    const { service, tx, usersUpdateChain } = makeService();
    stubPrivateMethods(service);

    await service.submit("org-1", "user-1");

    expect(tx.update).toHaveBeenCalledWith(users);
    expect(usersUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingCompletedAt: expect.any(Date) }),
    );
  });

  it("invalidates the userSession cache after the transaction commits", async () => {
    const { service, cache } = makeService();
    stubPrivateMethods(service);

    await service.submit("org-1", "user-1");

    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("user-1"));
  });

  it("raises NotFoundException when the user has no active membership and does not stamp users", async () => {
    const { service, usersUpdateChain } = makeService([]);
    stubPrivateMethods(service);

    await expect(service.submit("org-1", "unknown-user")).rejects.toThrow(NotFoundException);
    expect(usersUpdateChain.set).not.toHaveBeenCalled();
  });

  it("inserts an analytics event in the same transaction", async () => {
    const { service, tx } = makeService();
    stubPrivateMethods(service);

    const insertedTables: unknown[] = [];
    tx.insert.mockImplementation((table: unknown) => {
      insertedTables.push(table);
      return { values: jest.fn().mockResolvedValue([]) };
    });

    await service.submit("org-1", "user-1");

    expect(insertedTables).toContain(onboardingAnalyticsEvents);
  });
});
