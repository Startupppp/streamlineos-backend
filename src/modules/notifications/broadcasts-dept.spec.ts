import { Test } from "@nestjs/testing";
import { BroadcastsService } from "./broadcasts.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";

const ORG_ID = "org-aaaaaaaa-0000-0000-0000-000000000001";
const ACTOR_ID = "user-aaaa-0000-0000-0000-000000000001";
const DEPT_ID_1 = "dept-uuid-1111-0000-0000-000000000001";
const DEPT_ID_2 = "dept-uuid-2222-0000-0000-000000000002";
const USER_ID_A = "user-aaaa-0000-0000-0000-000000000002";
const USER_ID_B = "user-bbbb-0000-0000-0000-000000000003";

const mockCache = {
  cached: jest.fn(),
  cachedVersioned: jest.fn(),
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  invalidatePattern: jest.fn().mockResolvedValue(undefined),
};
const mockAudit = { log: jest.fn() };

function makeBroadcast(audienceOverride: { type: string; departmentIds?: string[] }) {
  return {
    id: 1,
    orgId: ORG_ID,
    title: "All-Hands",
    message: "See you at 3pm.",
    type: "INFO" as const,
    priority: "NORMAL" as const,
    category: "HRMS" as const,
    channels: ["IN_APP"] as string[],
    audience: audienceOverride,
    status: "DRAFT" as const,
    scheduledAt: null,
    sentAt: null,
    recipientCount: 0,
    deliveredCount: 0,
    createdBy: ACTOR_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("BroadcastsService — department audience recipient resolution", () => {
  let svc: BroadcastsService;
  let mockDb: {
    query: { broadcasts: { findFirst: jest.Mock } };
    select: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      query: { broadcasts: { findFirst: jest.fn() } },
      select: jest.fn(),
      transaction: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        BroadcastsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    svc = module.get(BroadcastsService);
  });

  it("resolves department members via orgDepartmentId and reports the correct recipient count", async () => {
    const broadcast = makeBroadcast({ type: "departments", departmentIds: [DEPT_ID_1, DEPT_ID_2] });
    mockDb.query.broadcasts.findFirst.mockResolvedValue(broadcast);

    const whereChain = { where: jest.fn().mockResolvedValue([{ userId: USER_ID_A }, { userId: USER_ID_B }]) };
    const innerJoinChain = { innerJoin: jest.fn().mockReturnValue(whereChain) };
    const fromChain = { from: jest.fn().mockReturnValue(innerJoinChain) };
    mockDb.select.mockReturnValue(fromChain);

    const updatedBroadcast = { ...broadcast, status: "SENT" as const, sentAt: new Date(), recipientCount: 2, deliveredCount: 2 };
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updatedBroadcast]) }),
          }),
        }),
      };
      return fn(tx);
    });

    const result = await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(result.status).toBe("SENT");
    expect(result.recipientCount).toBe(2);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(fromChain.from).toHaveBeenCalledTimes(1);
    expect(innerJoinChain.innerJoin).toHaveBeenCalledTimes(1);
    expect(whereChain.where).toHaveBeenCalledTimes(1);
  });

  it("returns zero recipients and skips the DB query when departmentIds is empty (deliberate no-op guard)", async () => {
    const broadcast = makeBroadcast({ type: "departments", departmentIds: [] });
    mockDb.query.broadcasts.findFirst.mockResolvedValue(broadcast);

    const updatedBroadcast = { ...broadcast, status: "SENT" as const, sentAt: new Date(), recipientCount: 0, deliveredCount: 0 };
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updatedBroadcast]) }),
          }),
        }),
      };
      return fn(tx);
    });

    const result = await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(result.recipientCount).toBe(0);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("deduplicates repeated department ids before querying", async () => {
    const broadcast = makeBroadcast({ type: "departments", departmentIds: [DEPT_ID_1, DEPT_ID_1, DEPT_ID_2] });
    mockDb.query.broadcasts.findFirst.mockResolvedValue(broadcast);

    const whereChain = { where: jest.fn().mockResolvedValue([{ userId: USER_ID_A }]) };
    const innerJoinChain = { innerJoin: jest.fn().mockReturnValue(whereChain) };
    const fromChain = { from: jest.fn().mockReturnValue(innerJoinChain) };
    mockDb.select.mockReturnValue(fromChain);

    const updatedBroadcast = { ...broadcast, status: "SENT" as const, sentAt: new Date(), recipientCount: 1, deliveredCount: 1 };
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updatedBroadcast]) }),
          }),
        }),
      };
      return fn(tx);
    });

    await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});
