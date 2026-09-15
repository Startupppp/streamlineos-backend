import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CACHE_KEYS } from "../../../../common/cache/cache-keys";
import { onboardingAnalyticsEvents, organizationMembers, users } from "../../../../db/schema";
import { OnboardingSubmissionService } from "./onboarding-submission.service";

const dialect = new PgDialect();

type PrivateService = {
  completeFinalReview: (tx: unknown, orgId: string, userId: string) => Promise<void>;
  initializeLeaveBalances: (tx: unknown, orgId: string, userId: string) => Promise<number>;
  completeFlowSession: (tx: unknown, orgId: string, userId: string) => Promise<void>;
};

function makeSelectChain(rows: unknown[], capturedWheres: SQL[]) {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "limit", "orderBy"]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.where = jest.fn().mockImplementation((condition: SQL) => {
    capturedWheres.push(condition);
    return chain;
  });
  chain.for = jest.fn().mockResolvedValue(rows);
  return chain;
}

function makeUpdateChain() {
  const capturedWheres: SQL[] = [];
  const where = jest.fn().mockImplementation((condition: SQL) => {
    capturedWheres.push(condition);
    return Promise.resolve([]);
  });
  const set = jest.fn().mockReturnValue({ where });
  return { set, where, capturedWheres };
}

function renderParams(condition: SQL | undefined): unknown[] {
  if (!condition) throw new Error("expected a WHERE condition");
  return dialect.sqlToQuery(condition).params;
}

function renderSql(condition: SQL | undefined): string {
  if (!condition) throw new Error("expected a WHERE condition");
  return dialect.sqlToQuery(condition).sql;
}

function makeService(membershipRows: unknown[] = [{ id: "membership-1" }]) {
  const usersUpdateChain = makeUpdateChain();
  const membersUpdateChain = makeUpdateChain();
  const otherUpdateChain = makeUpdateChain();
  const selectWheres: SQL[] = [];

  const tx = {
    execute: jest.fn().mockResolvedValue(undefined),
    select: jest.fn().mockReturnValue(makeSelectChain(membershipRows, selectWheres)),
    update: jest.fn().mockImplementation((table: unknown) => {
      if (table === users) return usersUpdateChain;
      if (table === organizationMembers) return membersUpdateChain;
      return otherUpdateChain;
    }),
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
  };

  const db = {
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb(tx);
    }),
  };

  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
  const service = new OnboardingSubmissionService(db as never, cache as never, audit as never);

  return {
    service,
    tx,
    db,
    cache,
    audit,
    usersUpdateChain,
    membersUpdateChain,
    selectWheres,
  };
}

function stubPrivateMethods(service: OnboardingSubmissionService): void {
  jest
    .spyOn(service as unknown as PrivateService, "completeFinalReview")
    .mockResolvedValue(undefined);
  jest
    .spyOn(service as unknown as PrivateService, "initializeLeaveBalances")
    .mockResolvedValue(0);
  jest
    .spyOn(service as unknown as PrivateService, "completeFlowSession")
    .mockResolvedValue(undefined);
}

describe("OnboardingSubmissionService.submit", () => {
  afterEach(() => jest.restoreAllMocks());

  it("stamps organizationMembers.onboardingCompletedAt as the tenant-scoped completion authority — this is the field the wizard gate reads via session.userOnboardingCompletedAt", async () => {
    const { service, tx, membersUpdateChain } = makeService();
    stubPrivateMethods(service);

    await service.complete("org-1", "user-1");

    expect(tx.update).toHaveBeenCalledWith(organizationMembers);
    expect(membersUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingCompletedAt: expect.any(Date) }),
    );
  });

  it("stamps users.onboardingCompletedAt as a legacy signal — completion in one org does not bypass the wizard in a second org because the gate reads the membership column, not this global one", async () => {
    const { service, tx, usersUpdateChain } = makeService();
    stubPrivateMethods(service);

    await service.complete("org-1", "user-1");

    expect(tx.update).toHaveBeenCalledWith(users);
    expect(usersUpdateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingCompletedAt: expect.any(Date) }),
    );
  });

  it("stamps only the membership of the organization being onboarded, so the same account joining a second organization still faces that organization's wizard", async () => {
    const { service, selectWheres, membersUpdateChain } = makeService();
    stubPrivateMethods(service);

    await service.complete("org-1", "user-1");

    const membershipLookup = selectWheres[0];
    expect(renderSql(membershipLookup)).toContain('"org_id"');
    expect(renderParams(membershipLookup)).toEqual(
      expect.arrayContaining(["org-1", "user-1"]),
    );

    expect(membersUpdateChain.capturedWheres).toHaveLength(1);
    expect(renderParams(membersUpdateChain.capturedWheres[0])).toEqual([
      "membership-1",
    ]);
  });

  it("invalidates the userSession cache after the transaction commits", async () => {
    const { service, cache } = makeService();
    stubPrivateMethods(service);

    await service.complete("org-1", "user-1");

    expect(cache.invalidate).toHaveBeenCalledWith(CACHE_KEYS.userSession("user-1"));
  });

  it("raises NotFoundException when the user has no active membership and does not stamp users", async () => {
    const { service, usersUpdateChain } = makeService([]);
    stubPrivateMethods(service);

    await expect(service.complete("org-1", "unknown-user")).rejects.toThrow(NotFoundException);
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

    await service.complete("org-1", "user-1");

    expect(insertedTables).toContain(onboardingAnalyticsEvents);
  });
});
