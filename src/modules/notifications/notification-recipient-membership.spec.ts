import { notifications, notificationDeliveries, organizationMembers, users, userPreferences, notificationPreferences } from "../../db/schema";
import { NotificationDispatchPersistenceService } from "./notification-dispatch-persistence.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { notificationEvent } from "./notification-event-factory";
import { MembershipResolvingDispatchDouble } from "./notification-recipient-membership.spec-fixtures";
import type { DispatchEventInput } from "./notification.types";

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: <T,>(_db: unknown, _orgId: string, fn: () => Promise<T>) => fn(),
}));

const ORG_ID = "org-membership-contract";
const MEMBER_USER = "user-member";
const MEMBER_MEMBERSHIP_ID = 5011;
const STRANGER_USER = "user-not-in-this-org";

const DEFINITION = notificationEvent("crm.lead.assigned", "crm", "CRM", "Lead assigned to you");

function dispatchInput(overrides: Partial<DispatchEventInput> = {}): DispatchEventInput {
  return {
    eventKey: "crm.lead.assigned",
    orgId: ORG_ID,
    targetUserIds: [MEMBER_USER],
    title: "Lead assigned to you",
    message: "You have been assigned a lead",
    ...overrides,
  };
}

function selectingDb(memberRows: Array<{ userId: string; id: number }>) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === organizationMembers) return memberRows;
          if (table === users) return memberRows.map((row) => ({ id: row.userId, email: `${row.userId}@example.test` }));
          if (table === userPreferences) return [];
          if (table === notificationPreferences) return [];
          return [];
        },
      }),
    }),
  };
}

describe("the recipient a notification is addressed to is a membership, not a user id", () => {
  it("stamps organization_members.id on the recipient the real dispatcher hands to persistence", async () => {
    const persistForUser = jest.fn().mockResolvedValue({
      createdInApp: true,
      queued: 0,
      suppressed: 0,
      deduped: false,
      pushHandledByEngine: false,
    });
    const routingResult = {
      priority: "NORMAL",
      createInApp: true,
      channels: [{ channel: "IN_APP", action: "SEND" }],
      reasonText: null,
    };

    const service = new NotificationDispatchService(
      selectingDb([{ userId: MEMBER_USER, id: MEMBER_MEMBERSHIP_ID }]) as never,
      { resolveDefinition: async () => ({ definition: DEFINITION, enabled: true }) } as never,
      { routeMany: async () => new Map([[MEMBER_USER, routingResult]]) } as never,
      { announce: jest.fn() } as never,
      { canSee: async () => true } as never,
      { loadTemplates: async () => new Map() } as never,
      { enqueue: jest.fn() } as never,
      { persistForUser, recordAccessSuppression: jest.fn() } as never,
    );

    const result = await service.emitNow(dispatchInput());

    expect(result.notified).toBe(1);
    expect(persistForUser).toHaveBeenCalledTimes(1);
    expect(persistForUser.mock.calls[0]?.[3]).toBe(MEMBER_MEMBERSHIP_ID);
  });

  it("writes that membership id onto the notifications row itself, which is the column every read path filters on", async () => {
    const notificationValues: Array<Record<string, unknown>> = [];
    const tx = {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => {
          if (table === notifications) {
            notificationValues.push(value);
            return { returning: async () => [{ id: 77, createdAt: new Date() }] };
          }
          if (table === notificationDeliveries) {
            return {
              onConflictDoNothing: () => ({ returning: async () => [{ id: 1 }] }),
            };
          }
          return { returning: async () => [] };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    const persistence = new NotificationDispatchPersistenceService({
      transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as never);

    await persistence.persistForUser(
      dispatchInput(),
      DEFINITION,
      MEMBER_USER,
      MEMBER_MEMBERSHIP_ID,
      {
        priority: "NORMAL",
        createInApp: true,
        channels: [{ channel: "IN_APP", action: "SEND" }],
        reasonText: null,
      } as never,
      null,
      new Map(),
    );

    expect(notificationValues).toHaveLength(1);
    expect(notificationValues[0]?.["membershipId"]).toBe(MEMBER_MEMBERSHIP_ID);
  });
});

describe("MembershipResolvingDispatchDouble mirrors the dispatcher rules the call-site specs rely on", () => {
  it("stamps the same membership id the real dispatcher resolved for the same member", async () => {
    const double = new MembershipResolvingDispatchDouble([
      { userId: MEMBER_USER, membershipId: MEMBER_MEMBERSHIP_ID },
    ]);

    await double.emit(dispatchInput());

    expect(double.rowsFor(MEMBER_USER)).toEqual([
      {
        orgId: ORG_ID,
        eventKey: "crm.lead.assigned",
        userId: MEMBER_USER,
        membershipId: MEMBER_MEMBERSHIP_ID,
      },
    ]);
  });

  it("drops a target with no membership in the org, the way filterOrgMemberIds does, rather than inventing one", async () => {
    const double = new MembershipResolvingDispatchDouble([
      { userId: MEMBER_USER, membershipId: MEMBER_MEMBERSHIP_ID },
    ]);

    await double.emit(dispatchInput({ targetUserIds: [MEMBER_USER, STRANGER_USER] }));

    expect(double.rowsFor(STRANGER_USER)).toEqual([]);
    expect(double.rows).toHaveLength(1);
  });

  it("drops the actor from their own notification unless notifySelf says otherwise", async () => {
    const double = new MembershipResolvingDispatchDouble([
      { userId: MEMBER_USER, membershipId: MEMBER_MEMBERSHIP_ID },
    ]);

    await double.emit(dispatchInput({ actorUserId: MEMBER_USER }));
    expect(double.rows).toEqual([]);

    await double.emit(dispatchInput({ actorUserId: MEMBER_USER, notifySelf: true }));
    expect(double.rows).toHaveLength(1);
  });
});
