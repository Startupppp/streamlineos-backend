import { MembershipResolvingDispatchDouble } from "../../../notifications/notification-recipient-membership.spec-fixtures";
import { OnboardingAdminService } from "./onboarding-admin.service";

interface ReminderRecipientFixture {
  userId: string;
  userName: string;
  userEmail: string | null;
  totalTasks: number;
  pendingTasks: number;
}

function createReminderRecipient(
  recipientIndex: number,
  userEmail: string | null = `employee-${recipientIndex}@example.com`,
): ReminderRecipientFixture {
  const userSuffix = String(recipientIndex).padStart(3, "0");
  return {
    userId: `employee-${userSuffix}`,
    userName: `Employee ${recipientIndex}`,
    userEmail,
    totalTasks: 5,
    pendingTasks: 2,
  };
}

function createReminderPageQuery(rows: ReminderRecipientFixture[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const having = jest.fn().mockReturnValue({ orderBy });
  const groupBy = jest.fn().mockReturnValue({ having });
  const where = jest.fn().mockReturnValue({ groupBy });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });

  return {
    from,
    groupBy,
    having,
    innerJoin,
    limit,
    orderBy,
    where,
  };
}

function createService(reminderPages: ReminderRecipientFixture[][]) {
  const pageQueries = reminderPages.map(createReminderPageQuery);
  const select = jest.fn();
  for (const pageQuery of pageQueries) {
    select.mockReturnValueOnce({ from: pageQuery.from });
  }

  const insertValues = jest.fn().mockResolvedValue(undefined);
  const database = {
    select,
    insert: jest.fn().mockReturnValue({ values: insertValues }),
  };
  const enqueueForDelivery = jest.fn(
    async (emailMessages: readonly unknown[]) => emailMessages.length,
  );
  const dispatch = new MembershipResolvingDispatchDouble(
    reminderPages
      .flat()
      .map((recipient, index) => ({ userId: recipient.userId, membershipId: 90000 + index })),
  );
  const service = new OnboardingAdminService(
    database as never,
    { enqueueForDelivery } as never,
    dispatch as never,
  );

  return {
    database,
    dispatch,
    enqueueForDelivery,
    insertValues,
    pageQueries,
    service,
  };
}

describe("OnboardingAdminService.sendReminders", () => {
  it("keyset-pages recipients and dispatches one notification per recipient alongside one email batch per page", async () => {
    const recipients = Array.from(
      { length: 101 },
      (_unusedValue, recipientIndex) =>
        createReminderRecipient(recipientIndex),
    );
    const testContext = createService([
      recipients.slice(0, 101),
      recipients.slice(100),
    ]);

    await expect(
      testContext.service.sendReminders("organization-one"),
    ).resolves.toEqual({ sent: 101, total: 101 });

    expect(testContext.database.select).toHaveBeenCalledTimes(2);
    expect(testContext.database.insert).not.toHaveBeenCalled();
    expect(testContext.enqueueForDelivery).toHaveBeenCalledTimes(2);
    expect(testContext.pageQueries[0]?.limit).toHaveBeenCalledWith(101);
    expect(testContext.pageQueries[1]?.limit).toHaveBeenCalledWith(101);

    const emailBatchSizes = testContext.enqueueForDelivery.mock.calls.map(
      ([emailBatch]) => emailBatch.length,
    );
    expect(testContext.dispatch.inputs).toHaveLength(101);
    expect(testContext.dispatch.batchSizes).toEqual([100, 1]);
    expect(emailBatchSizes).toEqual([100, 1]);
  });

  it("tenant-scopes every notification and durable email queued by the batch", async () => {
    const recipients = [
      createReminderRecipient(1),
      createReminderRecipient(2, null),
    ];
    const testContext = createService([recipients]);

    await expect(
      testContext.service.sendReminders("organization-two"),
    ).resolves.toEqual({ sent: 1, total: 2 });

    expect(testContext.dispatch.inputs).toEqual([
      expect.objectContaining({ orgId: "organization-two", targetUserIds: ["employee-001"] }),
      expect.objectContaining({ orgId: "organization-two", targetUserIds: ["employee-002"] }),
    ]);

    const emailBatch = testContext.enqueueForDelivery.mock.calls[0]?.[0];
    expect(emailBatch).toEqual([
      expect.objectContaining({
        organizationId: "organization-two",
        subject: "Onboarding reminder — pending tasks",
        to: "employee-1@example.com",
      }),
    ]);
  });

  it("avoids notification and outbox writes when no reminders are due", async () => {
    const testContext = createService([[]]);

    await expect(
      testContext.service.sendReminders("organization-empty"),
    ).resolves.toEqual({ sent: 0, total: 0 });

    expect(testContext.database.select).toHaveBeenCalledTimes(1);
    expect(testContext.database.insert).not.toHaveBeenCalled();
    expect(testContext.dispatch.inputs).toEqual([]);
    expect(testContext.enqueueForDelivery).not.toHaveBeenCalled();
  });
});
