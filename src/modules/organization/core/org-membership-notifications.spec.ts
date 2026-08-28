import { Test } from "@nestjs/testing";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { SessionsService } from "../../sessions/sessions.service";
import { OrgMembershipService } from "./org-membership.service";
import { AblyService } from "../../realtime/ably.service";

const ORG = "org-a";
const ACTOR = "actor-1";
const MEMBER = "member-1";

/**
 * `filterOrgMemberIds` only resolves ACTIVE memberships, so an access-loss
 * notice must never be routed through the dispatch engine — it would be
 * silently dropped for exactly the people it is meant to reach.
 */
describe("OrgMembershipService access notifications", () => {
  const memberFindFirst = jest.fn();
  const orgFindFirst = jest.fn();
  const userFindFirst = jest.fn();
  const selectWhere = jest.fn();
  const emit = jest.fn();
  const sendMembershipRemovedEmail = jest.fn();
  const sendMembershipSuspendedEmail = jest.fn();

  /** `.for("update")` is awaited directly in some paths and chained with `.limit()` in others. */
  const forUpdate = () =>
    Object.assign(Promise.resolve([]), { limit: jest.fn().mockResolvedValue([]) });

  const joinChain: Record<string, jest.Mock> = {
    innerJoin: jest.fn(),
    leftJoin: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn().mockResolvedValue([]),
  };
  joinChain.innerJoin.mockReturnValue({ where: selectWhere });
  joinChain.leftJoin.mockReturnValue(joinChain);
  joinChain.where.mockReturnValue({
    for: jest.fn().mockImplementation(forUpdate),
    limit: jest.fn().mockResolvedValue([]),
    orderBy: jest.fn().mockResolvedValue([]),
  });

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue(joinChain),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue(Object.assign(Promise.resolve([]), { returning: jest.fn().mockResolvedValue([]) })) }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
        onConflictDoNothing: jest.fn().mockResolvedValue([]),
      }),
    }),
  };

  const db = {
    query: {
      organizationMembers: { findFirst: memberFindFirst },
      organizations: { findFirst: orgFindFirst },
      users: { findFirst: jest.fn().mockResolvedValue({ email: "member@example.com" }) },
      users: { findFirst: userFindFirst },
    },
    select: tx.select,
    update: tx.update,
    transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  let svc: OrgMembershipService;

  beforeEach(async () => {
    jest.clearAllMocks();
    selectWhere.mockResolvedValue([]);
    orgFindFirst.mockResolvedValue({ name: "Alpha" });
    userFindFirst.mockResolvedValue({
      email: "member@example.com",
      name: "Mo Member",
      firstName: "Mo",
    });
    emit.mockResolvedValue(undefined);
    sendMembershipRemovedEmail.mockResolvedValue(undefined);
    sendMembershipSuspendedEmail.mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        { provide: AblyService, useValue: { revokeUserTokens: jest.fn().mockResolvedValue(undefined) } },
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: SessionsService, useValue: { revokeAllForUser: jest.fn() } },
        { provide: AccessService, useValue: {} },
        {
          provide: EmailService,
          useValue: { sendMembershipRemovedEmail, sendMembershipSuspendedEmail },
        },
        { provide: NotificationDispatchService, useValue: { emit } },
      ],
    }).compile();

    svc = moduleRef.get(OrgMembershipService);
  });

  async function flushPendingNotifications(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it("emails a suspended member instead of dispatching an in-app notification", async () => {
    memberFindFirst.mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 5 });

    await svc.suspendMember(ORG, ACTOR, MEMBER);
    await flushPendingNotifications();

    expect(sendMembershipSuspendedEmail).toHaveBeenCalledWith(
      "member@example.com",
      "Mo",
      "Alpha",
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("dispatches an in-app notification when a member is reactivated", async () => {
    memberFindFirst.mockResolvedValue({ isOwner: false, status: "SUSPENDED", id: 5 });

    await svc.reactivateMember(ORG, ACTOR, MEMBER);
    await flushPendingNotifications();

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "organization.member.reactivated",
        orgId: ORG,
        targetUserIds: [MEMBER],
      }),
    );
    expect(sendMembershipSuspendedEmail).not.toHaveBeenCalled();
  });

  it("does not fail the suspension when the notice email cannot be delivered", async () => {
    memberFindFirst.mockResolvedValue({ isOwner: false, status: "ACTIVE", id: 5 });
    sendMembershipSuspendedEmail.mockRejectedValue(new Error("smtp down"));

    await expect(svc.suspendMember(ORG, ACTOR, MEMBER)).resolves.toEqual({
      success: true,
    });
    await flushPendingNotifications();
  });
});
