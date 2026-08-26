import { Test } from "@nestjs/testing";
import { BroadcastsService } from "./broadcasts.service";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
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
const mockDispatch = { emit: jest.fn().mockResolvedValue({ notified: 0, deferred: true }) };

function makeBroadcast(channels: string[] = ["IN_APP"]) {
  return {
    id: 1,
    orgId: ORG_ID,
    title: "All-Hands",
    message: "See you at 3pm.",
    type: "INFO" as const,
    priority: "NORMAL" as const,
    category: "HRMS" as const,
    channels,
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
    update: jest.Mock;
  };
  let memberWhere: jest.Mock;

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

  function mockPublish(recipientCount: number) {
    const updated = {
      ...makeBroadcast(),
      status: "SENT" as const,
      sentAt: new Date(),
      recipientCount,
      deliveredCount: 0,
    };
    mockDb.update.mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updated]),
        }),
      }),
    });
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    mockDispatch.emit.mockResolvedValue({ notified: 0, deferred: true });

    mockDb = {
      query: { broadcasts: { findFirst: jest.fn() } },
      select: jest.fn(),
      update: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        BroadcastsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: CacheService, useValue: mockCache },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationDispatchService, useValue: mockDispatch },
      ],
    }).compile();

    svc = module.get(BroadcastsService);
  });

  it("resolves department members via orgDepartmentId and reports the correct recipient count", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast());
    mockReads([DEPT_ID_1, DEPT_ID_2], [{ userId: USER_ID_A }, { userId: USER_ID_B }]);
    mockPublish(2);

    const result = await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(result.status).toBe("SENT");
    expect(result.recipientCount).toBe(2);
    expect(memberWhere).toHaveBeenCalledTimes(1);
  });

  it("returns zero recipients and skips the member query when the audience has no targets", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast());
    mockReads([], []);
    mockPublish(0);

    const result = await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(result.recipientCount).toBe(0);
    expect(memberWhere).not.toHaveBeenCalled();
  });

  it("deduplicates repeated department ids before querying", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast());
    mockReads([DEPT_ID_1, DEPT_ID_1, DEPT_ID_2], [{ userId: USER_ID_A }]);
    mockPublish(1);

    await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(memberWhere).toHaveBeenCalledTimes(1);
  });

  it("does not call dispatch.emit when the broadcast has only IN_APP channel", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast(["IN_APP"]));
    mockReads([DEPT_ID_1], [{ userId: USER_ID_A }]);
    mockPublish(1);

    await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(mockDispatch.emit).not.toHaveBeenCalled();
  });

  it("calls dispatch.emit when the broadcast includes EMAIL", async () => {
    mockDb.query.broadcasts.findFirst.mockResolvedValue(makeBroadcast(["IN_APP", "EMAIL"]));
    mockReads([DEPT_ID_1], [{ userId: USER_ID_A }]);
    mockPublish(1);

    await svc.publish(ORG_ID, ACTOR_ID, 1);

    expect(mockDispatch.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "notification.broadcast.published",
        targetUserIds: [USER_ID_A],
      }),
    );
  });
});
