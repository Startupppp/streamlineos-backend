import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { PersonEmploymentSyncService } from "../person-employment-sync.service";
import { PersonEmploymentBackfillService } from "../person-employment-backfill.service";
import type { EnsureManyRow } from "../person-employment-sync-batch.types";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn((
    db: unknown,
    _orgId: string,
    operation: (tx: unknown) => Promise<unknown>,
  ) => operation(db)),
}));

const mockedRunInNewTenantTransaction = jest.mocked(runInNewTenantTransaction);

type MemberRow = {
  membershipId: number;
  userId: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
  phone: string | null;
};

function memberRow(membershipId: number): MemberRow {
  return {
    membershipId,
    userId: `u${membershipId}`,
    firstName: `First${membershipId}`,
    lastName: `Last${membershipId}`,
    name: null,
    email: `member${membershipId}@example.com`,
    phone: null,
  };
}

function ensuredRow(
  userId: string,
  flags: { createdPerson: boolean; createdEmployment: boolean },
): EnsureManyRow {
  const ordinal = Number(userId.slice(1));
  return {
    userId,
    personId: ordinal,
    employmentId: ordinal,
    employeeNumber: `EMP-${userId.toUpperCase()}`,
    ...flags,
  };
}

function highWatermarkQuery(highWatermark: number | null) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest
            .fn()
            .mockResolvedValue(
              highWatermark === null ? [] : [{ membershipId: highWatermark }],
            ),
        }),
      }),
    }),
  };
}

function memberBatchQuery(rows: MemberRow[]) {
  return {
    from: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  };
}

describe("PersonEmploymentSyncService.ensureFromUserId", () => {
  beforeEach(() => {
    mockedRunInNewTenantTransaction.mockClear();
  });

  it("fails closed before reading a global user when active tenant membership is absent", async () => {
    const usersFindFirst = jest.fn();
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue(undefined),
        },
        users: { findFirst: usersFindFirst },
      },
    };
    const service = new PersonEmploymentSyncService(
      db as never,
      { log: jest.fn() } as never,
    );

    await expect(
      service.ensureFromUserId("org-1", "actor-1", "global-user-1"),
    ).resolves.toBeNull();
    expect(usersFindFirst).not.toHaveBeenCalled();
  });
});

describe("PersonEmploymentBackfillService.backfillOrg", () => {
  beforeEach(() => {
    mockedRunInNewTenantTransaction.mockClear();
  });

  it("prefetches active tenant members and aggregates create counts through one batched write", async () => {
    const rows = [memberRow(1), memberRow(2), memberRow(3)];
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(3))
      .mockReturnValueOnce(memberBatchQuery(rows));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const syncService = new PersonEmploymentSyncService({ select } as never, audit as never);
    const service = new PersonEmploymentBackfillService({ select } as never, audit as never, syncService);
    const ensureFromUserId = jest.spyOn(syncService, "ensureFromUserId");
    const ensureFromUser = jest.spyOn(syncService, "ensureFromUser");
    const ensureManyFromUsers = jest
      .spyOn(syncService, "ensureManyFromUsers")
      .mockResolvedValue([
        ensuredRow("u1", { createdPerson: true, createdEmployment: true }),
        ensuredRow("u2", { createdPerson: false, createdEmployment: false }),
        ensuredRow("u3", { createdPerson: false, createdEmployment: true }),
      ]);

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(result).toEqual({
      scanned: 3,
      createdPeople: 1,
      createdEmployments: 2,
      skipped: 1,
      errors: [],
    });
    expect(select).toHaveBeenCalledTimes(2);
    expect(ensureFromUserId).not.toHaveBeenCalled();
    expect(ensureFromUser).not.toHaveBeenCalled();
    expect(ensureManyFromUsers).toHaveBeenCalledTimes(1);
    expect(ensureManyFromUsers).toHaveBeenCalledWith(
      "org-1",
      "actor-1",
      [
        expect.objectContaining({ userId: "u1", workEmail: "member1@example.com", lifecycleStatus: "ACTIVE" }),
        expect.objectContaining({ userId: "u2", workEmail: "member2@example.com", lifecycleStatus: "ACTIVE" }),
        expect.objectContaining({ userId: "u3", workEmail: "member3@example.com", lifecycleStatus: "ACTIVE" }),
      ],
      expect.anything(),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        after: expect.objectContaining({ errorCount: 0, scanned: 3 }),
      }),
    );
    expect(
      mockedRunInNewTenantTransaction.mock.calls.every((call) => call[1] === "org-1"),
    ).toBe(true);
  });

  it("reports every member of a failed page generically and never returns raw failure details", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => memberRow(index + 1));
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(6))
      .mockReturnValueOnce(memberBatchQuery(rows));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const syncService = new PersonEmploymentSyncService({ select } as never, audit as never);
    const service = new PersonEmploymentBackfillService({ select } as never, audit as never, syncService);
    jest
      .spyOn(syncService, "ensureManyFromUsers")
      .mockRejectedValue(
        new Error("duplicate value includes member3@example.com and private data"),
      );

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(result).toEqual({
      scanned: 6,
      createdPeople: 0,
      createdEmployments: 0,
      skipped: 0,
      errors: rows.map((row) => ({
        userId: row.userId,
        message: "Member synchronization failed",
      })),
    });
    expect(JSON.stringify(result.errors)).not.toContain("member3@example.com");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ errorCount: 6, scanned: 6 }),
      }),
    );
  });

  it("reports a member the batch returned no row for instead of counting it as skipped", async () => {
    const rows = [memberRow(1), memberRow(2)];
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(2))
      .mockReturnValueOnce(memberBatchQuery(rows));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const syncService = new PersonEmploymentSyncService({ select } as never, audit as never);
    const service = new PersonEmploymentBackfillService({ select } as never, audit as never, syncService);
    jest
      .spyOn(syncService, "ensureManyFromUsers")
      .mockResolvedValue([ensuredRow("u1", { createdPerson: false, createdEmployment: false })]);

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual([
      { userId: "u2", message: "Member synchronization failed" },
    ]);
  });

  it("walks a fixed high-water mark through one batched transaction per keyset page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => memberRow(index + 1));
    const secondPage = [memberRow(101)];
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(101))
      .mockReturnValueOnce(memberBatchQuery(firstPage))
      .mockReturnValueOnce(memberBatchQuery(secondPage));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const syncService = new PersonEmploymentSyncService({ select } as never, audit as never);
    const service = new PersonEmploymentBackfillService({ select } as never, audit as never, syncService);
    const ensureManyFromUsers = jest
      .spyOn(syncService, "ensureManyFromUsers")
      .mockImplementation((_orgId, _actorId, inputs) =>
        Promise.resolve(
          inputs.map((input) =>
            ensuredRow(input.userId, { createdPerson: false, createdEmployment: false }),
          ),
        ),
      );

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(result.scanned).toBe(101);
    expect(result.skipped).toBe(101);
    expect(select).toHaveBeenCalledTimes(3);
    expect(ensureManyFromUsers).toHaveBeenCalledTimes(2);
  });
});
