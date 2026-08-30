import { runInNewTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { PersonEmploymentSyncService } from "../person-employment-sync.service";

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

describe("PersonEmploymentSyncService.backfillOrg", () => {
  beforeEach(() => {
    mockedRunInNewTenantTransaction.mockClear();
  });

  it("prefetches active tenant members and aggregates create counts without per-member identity reads", async () => {
    const rows = [memberRow(1), memberRow(2), memberRow(3)];
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(3))
      .mockReturnValueOnce(memberBatchQuery(rows));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PersonEmploymentSyncService({ select } as never, audit as never);
    const ensureFromUserId = jest.spyOn(service, "ensureFromUserId");
    const ensureFromUser = jest
      .spyOn(service, "ensureFromUser")
      .mockResolvedValueOnce({
        personId: 1,
        employmentId: 1,
        createdPerson: true,
        createdEmployment: true,
      })
      .mockResolvedValueOnce({
        personId: 2,
        employmentId: 2,
        createdPerson: false,
        createdEmployment: false,
      })
      .mockResolvedValueOnce({
        personId: 3,
        employmentId: 3,
        createdPerson: false,
        createdEmployment: true,
      });

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
    expect(ensureFromUser).toHaveBeenCalledTimes(3);
    expect(ensureFromUser).toHaveBeenNthCalledWith(
      1,
      "org-1",
      "actor-1",
      expect.objectContaining({
        userId: "u1",
        workEmail: "member1@example.com",
        lifecycleStatus: "ACTIVE",
      }),
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

  it("limits concurrent member work and never returns raw failure details", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => memberRow(index + 1));
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(6))
      .mockReturnValueOnce(memberBatchQuery(rows));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PersonEmploymentSyncService({ select } as never, audit as never);
    let active = 0;
    let maxActive = 0;

    jest.spyOn(service, "ensureFromUser").mockImplementation(async (_orgId, _actorId, input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      if (input.userId === "u3")
        throw new Error("duplicate value includes member3@example.com and private data");
      return {
        personId: Number(input.userId.slice(1)),
        employmentId: Number(input.userId.slice(1)),
        createdPerson: true,
        createdEmployment: true,
      };
    });

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(maxActive).toBe(4);
    expect(result).toEqual({
      scanned: 6,
      createdPeople: 5,
      createdEmployments: 5,
      skipped: 0,
      errors: [{ userId: "u3", message: "Member synchronization failed" }],
    });
    expect(JSON.stringify(result.errors)).not.toContain("member3@example.com");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ errorCount: 1, scanned: 6 }),
      }),
    );
  });

  it("walks a fixed high-water mark through bounded keyset pages", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => memberRow(index + 1));
    const secondPage = [memberRow(101)];
    const select = jest
      .fn()
      .mockReturnValueOnce(highWatermarkQuery(101))
      .mockReturnValueOnce(memberBatchQuery(firstPage))
      .mockReturnValueOnce(memberBatchQuery(secondPage));
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new PersonEmploymentSyncService({ select } as never, audit as never);
    jest.spyOn(service, "ensureFromUser").mockResolvedValue({
      personId: 1,
      employmentId: 1,
      createdPerson: false,
      createdEmployment: false,
    });

    const result = await service.backfillOrg("org-1", "actor-1");

    expect(result.scanned).toBe(101);
    expect(result.skipped).toBe(101);
    expect(select).toHaveBeenCalledTimes(3);
  });
});
