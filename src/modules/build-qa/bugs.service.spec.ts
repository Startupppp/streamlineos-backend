import { NotFoundException } from "@nestjs/common";
import { BugsService } from "./bugs.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { Db } from "../../db/drizzle.module";

type MockDb = {
  query: {
    bugs: { findFirst: jest.Mock };
  };
  select: jest.Mock;
  transaction: jest.Mock;
  update: jest.Mock;
};

function makeSelectChain(rows: unknown[]) {
  const whereChain = {
    where: jest.fn().mockReturnValue({
      limit: jest.fn().mockResolvedValue(rows),
    }),
  };
  const fromChain = { from: jest.fn().mockReturnValue(whereChain) };
  return jest.fn().mockReturnValue(fromChain);
}

function makeMockDb(): MockDb {
  return {
    query: {
      bugs: { findFirst: jest.fn() },
    },
    select: jest.fn(),
    transaction: jest.fn(),
    update: jest.fn(),
  };
}

const mockAudit = { log: jest.fn() } as unknown as AuditService;

beforeEach(() => {
  jest.resetAllMocks();
});

describe("BugsService.listBugs — tenant scoping", () => {
  it("throws NotFoundException when project does not exist for the given orgId (BOLA guard)", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit);
    mockDb.select = makeSelectChain([]);

    await expect(svc.listBugs("org-attacker", 1, {})).rejects.toThrow(NotFoundException);
  });

  it("calls select with both projectId and orgId to enforce tenant scope", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit);
    mockDb.select = makeSelectChain([]);

    await expect(svc.listBugs("org-1", 99, {})).rejects.toThrow(NotFoundException);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe("BugsService.createBug — bugNumber sequencing", () => {
  it("assigns bugNumber = maxExisting + 1 within the transaction", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit);

    mockDb.select = makeSelectChain([{ id: 1 }]);

    let capturedBugNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 5 }]),
            }),
          }),
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: { bugNumber?: number }) => {
              capturedBugNumber = vals.bugNumber;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 10,
                    bugNumber: vals.bugNumber,
                    title: "Test Bug",
                    orgId: "org-1",
                    projectId: 1,
                    status: "new",
                    severity: "major",
                    priority: "medium",
                    reporterId: "user-1",
                    createdBy: "user-1",
                    deletedAt: null,
                    reopenCount: 0,
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    const result = await svc.createBug("org-1", "user-1", 1, { title: "Test Bug" });
    expect(capturedBugNumber).toBe(6);
    expect(result).toMatchObject({ bugNumber: 6 });
  });

  it("assigns bugNumber = 1 when no bugs exist yet for the project", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit);

    mockDb.select = makeSelectChain([{ id: 1 }]);

    let capturedBugNumber: number | undefined;
    mockDb.transaction.mockImplementation(
      async (cb: (tx: unknown) => Promise<unknown>) => {
        const txMock = {
          execute: jest.fn().mockResolvedValue(undefined),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ maxNum: 0 }]),
            }),
          }),
          insert: jest.fn().mockImplementation(() => ({
            values: jest.fn().mockImplementation((vals: { bugNumber?: number }) => {
              capturedBugNumber = vals.bugNumber;
              return {
                returning: jest.fn().mockResolvedValue([
                  {
                    id: 1,
                    bugNumber: vals.bugNumber,
                    title: "First Bug",
                    orgId: "org-1",
                    projectId: 1,
                    status: "new",
                    severity: "major",
                    priority: "medium",
                    reporterId: "user-1",
                    createdBy: "user-1",
                    deletedAt: null,
                    reopenCount: 0,
                  },
                ]),
              };
            }),
          })),
        };
        return cb(txMock);
      },
    );

    await svc.createBug("org-1", "user-1", 1, { title: "First Bug" });
    expect(capturedBugNumber).toBe(1);
  });

  it("throws NotFoundException when project is not found for the given orgId before inserting", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit);
    mockDb.select = makeSelectChain([]);

    await expect(
      svc.createBug("org-attacker", "user-1", 1, { title: "Injection attempt" }),
    ).rejects.toThrow(NotFoundException);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});

describe("BugsService.getBug — cross-tenant isolation", () => {
  it("throws NotFoundException when bug belongs to a different org", async () => {
    const mockDb = makeMockDb();
    const svc = new BugsService(mockDb as unknown as Db, mockAudit);
    mockDb.query.bugs.findFirst.mockResolvedValue(undefined);

    await expect(svc.getBug("org-attacker", 1, 99)).rejects.toThrow(NotFoundException);
  });
});
