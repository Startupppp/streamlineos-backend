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

function makeBroadcast() {
  return {
    id: 1,
    orgId: ORG_ID,
    title: "All-Hands",
    message: "See you at 3pm.",
    type: "INFO" as const,
    priority: "NORMAL" as const,
    category: "HRMS" as const,
    channels: ["IN_APP"] as string[],
    // SCH-017: the JSONB is still written, but resolution reads audienceType plus the
    // junction table. Left populated here precisely so a regression back onto the JSONB
    // path would still fail these tests rather than quietly pass.
    audience: { type: "departments", departmentIds: [DEPT_ID_1, DEPT_ID_2] },
    audienceType: "departments" as const,
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
  let memberWhere: jest.Mock;

  /**
   * Two reads now happen: the audience targets, then the members those targets expand
   * to. The member query is the one with the join, so asserting on it distinguishes
   * "resolved nobody" from "never asked".
   */
  function mockReads(targetIds: string[], members: Array<{ userId: string }>) {
    memberWhere = jest.fn().mockResolvedValue(members);
    const junctionWhere = jest.fn().mockResolvedValue(targetIds.map((targetId) => ({ targetId })));
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: junctionWhere,
        innerJoin: jest.fn().mockReturnValue({ where: memberWhere }),
      }),
    });
    return { junctionWhere };
  }

  function mockPublishTransaction(recipientCount: number) {
    const updated = {
      ...makeBroadcast(),
      status: "SENT" as const,
      sentAt: new Date(),
      recipientCount,
      deliveredCount: recipientCount,
    };
    mockDb.transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([]) }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updated]) }),
          }),
        }),
      }),
    );
  }

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
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast());
    mockReads([DEPT_ID_1, DEPT_ID_2], [{ userId: USER_ID_A }, { userId: USER_ID_B }]);
    mockPublishTransaction(2);

    const result = await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(result.status).toBe("SENT");
    expect(result.recipientCount).toBe(2);
    expect(memberWhere).toHaveBeenCalledTimes(1);
  });

  it("returns zero recipients and skips the member query when the audience has no targets", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast());
    mockReads([], []);
    mockPublishTransaction(0);

    const result = await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(result.recipientCount).toBe(0);
    // The junction is still read; the expensive members join is not reached.
    expect(memberWhere).not.toHaveBeenCalled();
  });

  it("deduplicates repeated department ids before querying", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast());
    mockReads([DEPT_ID_1, DEPT_ID_1, DEPT_ID_2], [{ userId: USER_ID_A }]);
    mockPublishTransaction(1);

    await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(memberWhere).toHaveBeenCalledTimes(1);
  });
});
