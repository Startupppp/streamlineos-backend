import { notifications } from "../../../../db/schema";
import { MembershipResolvingDispatchDouble } from "../../../notifications/notification-recipient-membership.spec-fixtures";
import { OnboardingAdminService } from "./onboarding-admin.service";

const ORG_ID = "org-onboarding-reminders";
const LAGGARD_USER = "user-new-joiner";
const LAGGARD_MEMBERSHIP_ID = 6601;
const SECOND_USER = "user-second-joiner";
const SECOND_MEMBERSHIP_ID = 6602;

function recipient(userId: string, pendingTasks: number) {
  return {
    userId,
    userName: `Name of ${userId}`,
    userEmail: `${userId}@example.test`,
    totalTasks: 6,
    pendingTasks,
  };
}

function buildService(page: ReturnType<typeof recipient>[]) {
  const insertedTables: unknown[] = [];
  const select = jest
    .fn()
    .mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            groupBy: () => ({ having: () => ({ orderBy: () => ({ limit: async () => page }) }) }),
          }),
        }),
      }),
    })
    .mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            groupBy: () => ({ having: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
          }),
        }),
      }),
    });
  const db = {
    select,
    insert: (table: unknown) => {
      insertedTables.push(table);
      return { values: async () => undefined };
    },
  };
  const dispatch = new MembershipResolvingDispatchDouble([
    { userId: LAGGARD_USER, membershipId: LAGGARD_MEMBERSHIP_ID },
    { userId: SECOND_USER, membershipId: SECOND_MEMBERSHIP_ID },
  ]);
  const service = new OnboardingAdminService(
    db as never,
    { enqueueForDelivery: jest.fn(async (messages: readonly unknown[]) => messages.length) } as never,
    dispatch as never,
  );
  return { service, dispatch, insertedTables };
}

describe("OnboardingAdminService.sendReminders — the reminder lands in the joiner's own inbox", () => {
  it("addresses every reminded employee by membership id", async () => {
    const { service, dispatch } = buildService([recipient(LAGGARD_USER, 2), recipient(SECOND_USER, 4)]);

    await service.sendReminders(ORG_ID);

    expect(dispatch.rows).toEqual([
      { orgId: ORG_ID, eventKey: "hr.onboarding.task_reminder", userId: LAGGARD_USER, membershipId: LAGGARD_MEMBERSHIP_ID },
      { orgId: ORG_ID, eventKey: "hr.onboarding.task_reminder", userId: SECOND_USER, membershipId: SECOND_MEMBERSHIP_ID },
    ]);
  });

  it("never inserts into notifications itself, because a hand-built row leaves membership_id null and no reader can see it", async () => {
    const { service, insertedTables } = buildService([recipient(LAGGARD_USER, 2)]);

    await service.sendReminders(ORG_ID);

    expect(insertedTables.filter((table) => table === notifications)).toHaveLength(0);
  });

  it("keeps each employee's own pending-task count in their own message, which one batched emit would have flattened", async () => {
    const { service, dispatch } = buildService([recipient(LAGGARD_USER, 2), recipient(SECOND_USER, 4)]);

    await service.sendReminders(ORG_ID);

    expect(dispatch.inputs[0]?.message).toContain("2 pending");
    expect(dispatch.inputs[1]?.message).toContain("4 pending");
  });

  it("emits nothing when no employee has a pending onboarding task", async () => {
    const { service, dispatch } = buildService([]);

    await expect(service.sendReminders(ORG_ID)).resolves.toEqual({ sent: 0, total: 0 });
    expect(dispatch.inputs).toEqual([]);
  });
});
